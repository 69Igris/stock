"""The SEC client: classification, retry policy, headers, and the egress gate.

Driven against ``respx``-mocked httpx, so the REAL :class:`SecClient` runs — the
real retry loop, the real header set, the real gate ordering. Nothing here
re-implements a decision.

**No test in this file may reach sec.gov.** ``respx`` fails a request it has no
route for, which is the belt; the egress gate is the braces.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx

from app.sec import archive
from app.sec import client as client_module
from app.sec import limiter as limiter_module
from app.sec.client import SecClient, bundle_url
from app.sec.errors import (
    LimiterUnavailable,
    SecArchiveAbsent,
    SecEgressDisabled,
    SecError,
    SecForbidden,
    SecIdentityRejected,
    SecNotFound,
    SecRateLimited,
    SecTransportError,
    classify_sec_response,
)

IDENTITY = "UseMoney deepshaswat@gmail.com"
URL = "https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/0000320193-25-000073.txt"
APPLE = "0000320193"
ACC = "0000320193-25-000073"

# ── Real SEC 403 bodies (the two pages that share a status code) ────────────

UNDECLARED_BODY = b"""<html><head><title>SEC.gov | Request Rate Threshold Exceeded</title></head>
<body><h1>Your Request Originates from an Undeclared Automated Tool</h1>
<p>To allow for equitable access to all users, SEC reserves the right to limit requests
originating from undeclared automated tools. Your request has been identified as part of a
network of automated tools outside of the acceptable policy and will be managed until action
is taken to declare your traffic.</p>
<p>Please declare your traffic by updating your user agent to include company specific
information.</p>
<p>Reference ID: 0.5d5d3717.1756123456.1a2b3c4d</p></body></html>"""

RATE_BODY = b"""<html><head><title>SEC.gov | Request Rate Threshold Exceeded</title></head>
<body><h1>Request Rate Threshold Exceeded</h1>
<p>Your request rate has exceeded the SEC's traffic limit of 10 requests per second.
Please reduce your request rate. Access will be restored automatically once request
rates have dropped below the threshold for 10 minutes.</p></body></html>"""

GENERIC_403_BODY = (
    b"<html><body><h1>Forbidden</h1><p>Access denied by edge policy.</p></body></html>"
)


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def egress_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """This process may reach SEC. Read per call by ``app.settings.sec_egress``."""
    monkeypatch.setenv("SEC_EGRESS", "archive")


@pytest.fixture
def egress_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SEC_EGRESS", "off")


class Recorder:
    """Counts limiter acquisitions and captures sleep durations."""

    def __init__(self) -> None:
        self.acquires = 0
        self.sleeps: list[float] = []

    def acquire(self) -> None:
        self.acquires += 1

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)


@pytest.fixture
def rec() -> Recorder:
    return Recorder()


@pytest.fixture
def client(rec: Recorder) -> Iterator[SecClient]:
    made = SecClient(IDENTITY, acquire=rec.acquire, sleep=rec.sleep, jitter=lambda: 0.0)
    yield made
    made.close()


# ── The classification table, as a pure function ────────────────────────────


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (200, b"<xbrl/>", None),
        (204, b"", None),
        (403, UNDECLARED_BODY, SecIdentityRejected),
        (403, RATE_BODY, SecRateLimited),
        (403, GENERIC_403_BODY, SecForbidden),
        (403, b"", SecForbidden),
        (404, b"<html>Not Found</html>", SecNotFound),
        (429, b"slow down", SecRateLimited),
        (500, b"oops", SecTransportError),
        (503, b"<html>Service Unavailable</html>", SecTransportError),
        (503, RATE_BODY, SecRateLimited),
        (410, b"gone", SecError),
        (400, b"bad", SecError),
    ],
)
def test_the_classification_table(status: int, body: bytes, expected: type | None) -> None:
    assert classify_sec_response(status, body) is expected


def test_the_undeclared_page_wins_even_when_it_ALSO_carries_rate_wording() -> None:
    # SEC serves the UA-rejection page under the title "Request Rate Threshold
    # Exceeded". Matching rate text first would classify a deterministic
    # identity failure as transient, sleep ten minutes, and then keep going.
    assert b"Request Rate Threshold" in UNDECLARED_BODY
    assert classify_sec_response(403, UNDECLARED_BODY) is SecIdentityRejected


def test_classification_is_case_insensitive() -> None:
    assert classify_sec_response(
        403, b"YOUR REQUEST ORIGINATES FROM AN UNDECLARED AUTOMATED TOOL"
    ) is (SecIdentityRejected)


# ── Headers: identification, never impersonation ────────────────────────────


@respx.mock
def test_the_user_agent_is_EXACTLY_the_identity_and_nothing_impersonates_a_browser(
    client: SecClient, egress_on: None
) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, content=b"ok"))

    assert client.get(URL) == b"ok"

    # The set we CONSTRUCT, as a literal. The wire assertion below cannot stand
    # alone: httpx's own default Accept-Encoding is "gzip, deflate" whenever
    # brotli and zstandard are absent, so it coincides with ours and a mutation
    # that deleted our header from this dict still went green on the wire check.
    assert client.headers() == {"User-Agent": IDENTITY, "Accept-Encoding": "gzip, deflate"}

    sent = route.calls[0].request.headers
    assert sent["user-agent"] == IDENTITY
    assert sent["accept-encoding"] == "gzip, deflate"
    for banned in client_module.IMPERSONATION_HEADERS:
        assert banned not in sent, f"{banned} must never be sent to sec.gov"


# ── The egress gate ─────────────────────────────────────────────────────────


@respx.mock
def test_egress_off_raises_BEFORE_any_request_is_issued(
    client: SecClient, rec: Recorder, egress_off: None
) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(200, content=b"ok"))

    with pytest.raises(SecEgressDisabled):
        client.get(URL)

    assert route.call_count == 0
    assert len(respx.calls) == 0
    # And nothing was spent on the way to failing: no Redis round trip either.
    assert rec.acquires == 0


@respx.mock
def test_every_method_goes_through_the_same_gate(client: SecClient, egress_off: None) -> None:
    respx.get(URL).mock(return_value=httpx.Response(200, content=b"ok"))
    respx.head(URL).mock(return_value=httpx.Response(200))

    for call in (
        lambda: client.get(URL),
        lambda: client.head(URL),
        lambda: client.stream_to_gcs(URL, "edgar/bulk/companyfacts/2026-08-29/companyfacts.zip"),
    ):
        with pytest.raises(SecEgressDisabled):
            call()

    assert len(respx.calls) == 0


@respx.mock
def test_fetch_bundle_still_reads_the_ARCHIVE_when_egress_is_off(
    client: SecClient, egress_off: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The QA arrangement: archive hits are served, a miss is loud, and neither
    # touches the network.
    monkeypatch.setattr(archive, "read_bytes", lambda key: b"ARCHIVED BUNDLE")
    assert client.fetch_bundle(APPLE, ACC) == b"ARCHIVED BUNDLE"

    monkeypatch.setattr(archive, "read_bytes", lambda key: None)
    with pytest.raises(SecEgressDisabled):
        client.fetch_bundle(APPLE, ACC)
    assert len(respx.calls) == 0


# ── Retry policy ────────────────────────────────────────────────────────────


@respx.mock
def test_an_identity_rejection_is_NEVER_retried(
    client: SecClient, rec: Recorder, egress_on: None
) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(403, content=UNDECLARED_BODY))

    with pytest.raises(SecIdentityRejected):
        client.get(URL)

    assert route.call_count == 1
    assert rec.sleeps == []


@respx.mock
def test_a_404_is_not_retried(client: SecClient, egress_on: None) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(404, content=b"nope"))

    with pytest.raises(SecNotFound):
        client.get(URL)

    assert route.call_count == 1


@respx.mock
def test_an_unclassified_403_is_its_own_value_and_is_not_retried(
    client: SecClient, egress_on: None
) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(403, content=GENERIC_403_BODY))

    with pytest.raises(SecForbidden):
        client.get(URL)

    assert route.call_count == 1


@respx.mock
def test_a_5xx_is_retried_five_times_with_exponential_backoff(
    client: SecClient, rec: Recorder, egress_on: None
) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(503, content=b"unavailable"))

    with pytest.raises(SecTransportError):
        client.get(URL)

    assert route.call_count == client_module.MAX_ATTEMPTS == 5
    # jitter() -> 0.0, so each delay is exactly half its base: 1, 2, 4, 8.
    assert rec.sleeps == [0.5, 1.0, 2.0, 4.0]
    # One limiter slot per ATTEMPT, not per call: a retry is a request too.
    assert rec.acquires == 5


@respx.mock
def test_a_transient_5xx_recovers_without_the_caller_knowing(
    client: SecClient, rec: Recorder, egress_on: None
) -> None:
    route = respx.get(URL).mock(
        side_effect=[
            httpx.Response(503, content=b"unavailable"),
            httpx.Response(200, content=b"the filing"),
        ]
    )

    assert client.get(URL) == b"the filing"
    assert route.call_count == 2
    assert rec.sleeps == [0.5]


@respx.mock
def test_a_connect_error_is_retryable(client: SecClient, egress_on: None) -> None:
    route = respx.get(URL).mock(side_effect=httpx.ConnectError("no route to host"))

    with pytest.raises(SecTransportError):
        client.get(URL)

    assert route.call_count == 5


def test_backoff_is_jittered_and_capped(rec: Recorder) -> None:
    high = SecClient(IDENTITY, acquire=rec.acquire, sleep=rec.sleep, jitter=lambda: 1.0)
    low = SecClient(IDENTITY, acquire=rec.acquire, sleep=rec.sleep, jitter=lambda: 0.0)
    try:
        assert [high._backoff(n) for n in (1, 2, 3, 4)] == [1.5, 3.0, 6.0, 12.0]
        assert [low._backoff(n) for n in (1, 2, 3, 4)] == [0.5, 1.0, 2.0, 4.0]
        # Capped, so a long chain cannot wander into hours.
        assert low._backoff(20) == client_module.BACKOFF_CAP_SECONDS * 0.5
    finally:
        high.close()
        low.close()


# ── The rate block: sleep once, then stop ───────────────────────────────────


@respx.mock
def test_a_rate_block_sleeps_the_documented_ten_minutes_ONCE_then_raises(
    client: SecClient, rec: Recorder, egress_on: None
) -> None:
    route = respx.get(URL).mock(return_value=httpx.Response(403, content=RATE_BODY))

    with pytest.raises(SecRateLimited):
        client.get(URL)

    # Exactly one request and exactly one sleep: a retry after the cooldown is a
    # coin flip on whether the whole fleet went quiet, and losing it restarts
    # SEC's ten minutes.
    assert route.call_count == 1
    assert rec.sleeps == [600.0]


@respx.mock
def test_a_retry_after_header_may_LENGTHEN_the_cooldown_but_never_shorten_it(
    client: SecClient, rec: Recorder, egress_on: None
) -> None:
    respx.get(URL).mock(
        return_value=httpx.Response(429, content=b"slow down", headers={"Retry-After": "900"})
    )
    with pytest.raises(SecRateLimited):
        client.get(URL)
    assert rec.sleeps == [900.0]

    rec.sleeps.clear()
    respx.get(URL).mock(
        return_value=httpx.Response(429, content=b"slow down", headers={"Retry-After": "30"})
    )
    with pytest.raises(SecRateLimited):
        client.get(URL)
    assert rec.sleeps == [600.0]


@respx.mock
def test_an_http_date_retry_after_reads_as_absent(
    client: SecClient, rec: Recorder, egress_on: None
) -> None:
    respx.get(URL).mock(
        return_value=httpx.Response(
            429, content=b"slow", headers={"Retry-After": "Fri, 29 Aug 2026 04:00:00 GMT"}
        )
    )
    with pytest.raises(SecRateLimited):
        client.get(URL)
    assert rec.sleeps == [600.0]


# ── The limiter is wired for real ───────────────────────────────────────────


@respx.mock
def test_the_DEFAULT_client_acquires_from_the_shared_limiter_and_fails_closed(
    egress_on: None,
) -> None:
    # No `acquire=` injection here: this is the production wiring. With no shared
    # limiter installed, the client must refuse to issue the request at all —
    # not fall back to an unmetered one.
    limiter_module.reset_installed_limiter()
    route = respx.get(URL).mock(return_value=httpx.Response(200, content=b"ok"))

    with SecClient(IDENTITY) as unwired, pytest.raises(LimiterUnavailable):
        unwired.get(URL)

    assert route.call_count == 0


@respx.mock
def test_the_client_uses_the_installed_limiter_when_there_is_one(
    egress_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []

    class FakeLimiter:
        def try_acquire(self, name: str, weight: int = 1, blocking: bool = True) -> bool:
            calls.append(weight)
            return True

    monkeypatch.setattr(limiter_module, "_installed", FakeLimiter())
    respx.get(URL).mock(return_value=httpx.Response(200, content=b"ok"))

    with SecClient(IDENTITY) as wired:
        assert wired.get(URL) == b"ok"

    assert calls == [1]


# ── HEAD, bundles, streaming ────────────────────────────────────────────────


@respx.mock
def test_head_returns_the_validators_the_bulk_jobs_compare(
    client: SecClient, egress_on: None
) -> None:
    respx.head(URL).mock(
        return_value=httpx.Response(
            200,
            headers={
                "Last-Modified": "Fri, 29 Aug 2026 03:49:00 GMT",
                "ETag": '"abc123"',
                "Content-Length": "1407685214",
                "Accept-Ranges": "bytes",
            },
        )
    )

    assert client.head(URL) == {
        "status": 200,
        "lastModified": "Fri, 29 Aug 2026 03:49:00 GMT",
        "etag": '"abc123"',
        "contentLength": 1407685214,
        "acceptRanges": "bytes",
    }


def test_bundle_url_renders_the_accession_BOTH_ways_and_unpads_the_cik() -> None:
    assert bundle_url(APPLE, ACC) == (
        "https://www.sec.gov/Archives/edgar/data/320193/000032019325000073/0000320193-25-000073.txt"
    )


@respx.mock
def test_fetch_bundle_serves_the_archive_without_touching_sec(
    client: SecClient, egress_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(archive, "read_bytes", lambda key: b"<SEC-DOCUMENT>")
    writes: list[tuple[str, bytes, str]] = []
    monkeypatch.setattr(
        archive,
        "write_bytes",
        lambda key, data, *, content_type: writes.append((key, data, content_type)),
    )

    assert client.fetch_bundle(APPLE, ACC) == b"<SEC-DOCUMENT>"
    assert len(respx.calls) == 0
    assert writes == []


@respx.mock
def test_fetch_bundle_archives_what_it_fetched_on_a_miss(
    client: SecClient, egress_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(archive, "read_bytes", lambda key: None)
    writes: list[tuple[str, bytes, str]] = []
    monkeypatch.setattr(
        archive,
        "write_bytes",
        lambda key, data, *, content_type: writes.append((key, data, content_type)),
    )
    respx.get(bundle_url(APPLE, ACC)).mock(
        return_value=httpx.Response(200, content=b"<SEC-DOCUMENT>fresh")
    )

    assert client.fetch_bundle(APPLE, ACC) == b"<SEC-DOCUMENT>fresh"
    # Raw-first: the bytes are in the archive BEFORE any parser sees them, so a
    # reparse never re-hits SEC.
    assert writes == [
        (
            f"edgar/filings/{APPLE}/{ACC}/submission.txt",
            b"<SEC-DOCUMENT>fresh",
            archive.BUNDLE_CONTENT_TYPE,
        )
    ]


@respx.mock
def test_stream_to_gcs_writes_through_in_chunks_and_hashes_what_it_wrote(
    client: SecClient, egress_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib

    payload = bytes(range(256)) * 400  # 102_400 B
    key = "edgar/bulk/companyfacts/2026-08-29/companyfacts.zip"

    class Sink:
        def __init__(self) -> None:
            self.blocks: list[int] = []
            self.data = bytearray()
            self.closed = False

        def write(self, block: bytes) -> int:
            self.blocks.append(len(block))
            self.data.extend(block)
            return len(block)

        def __enter__(self) -> Sink:
            return self

        def __exit__(self, *_exc: object) -> None:
            self.closed = True

    sink = Sink()
    opened: list[dict[str, Any]] = []

    def fake_open(k: str, *, content_type: str, chunk: int) -> Sink:
        opened.append({"key": k, "content_type": content_type, "chunk": chunk})
        return sink

    monkeypatch.setattr(archive, "open_blob_writer", fake_open)
    respx.get(URL).mock(
        return_value=httpx.Response(
            200,
            content=payload,
            headers={"ETag": '"zip-etag"', "Last-Modified": "Fri, 29 Aug 2026 03:49:00 GMT"},
        )
    )

    result = client.stream_to_gcs(URL, key, chunk=16_384)

    assert opened == [{"key": key, "content_type": "application/zip", "chunk": 16_384}]
    assert bytes(sink.data) == payload
    assert sink.closed is True
    assert len(sink.blocks) > 1, "the body must arrive in chunks, not as one buffered blob"
    assert result["bytes"] == len(payload)
    assert result["sha256"] == hashlib.sha256(payload).hexdigest()
    assert result["etag"] == '"zip-etag"'
    assert result["lastModified"] == "Fri, 29 Aug 2026 03:49:00 GMT"


@respx.mock
def test_stream_to_gcs_classifies_a_failure_and_opens_no_blob(
    client: SecClient, egress_on: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(
        archive,
        "open_blob_writer",
        lambda key, **_kw: opened.append(key),
    )
    respx.get(URL).mock(return_value=httpx.Response(403, content=UNDECLARED_BODY))

    with pytest.raises(SecIdentityRejected):
        client.stream_to_gcs(URL, "edgar/bulk/companyfacts/2026-08-29/companyfacts.zip")

    # No half-written object: an aborted stream must leave nothing rather than a
    # truncated zip that reads back as a complete one.
    assert opened == []


# ── Construction ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", ["", "   "])
def test_an_empty_identity_is_refused_at_construction(bad: str) -> None:
    with pytest.raises(ValueError, match="EDGAR_IDENTITY"):
        SecClient(bad)


def test_from_settings_refuses_to_run_unidentified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EDGAR_IDENTITY", raising=False)
    with pytest.raises(ValueError, match="EDGAR_IDENTITY"):
        SecClient.from_settings()

    monkeypatch.setenv("EDGAR_IDENTITY", IDENTITY)
    built = SecClient.from_settings(acquire=lambda: None)
    try:
        assert built.identity == IDENTITY
    finally:
        built.close()


def test_an_error_message_carries_a_short_excerpt_not_a_whole_html_page(
    client: SecClient, egress_on: None
) -> None:
    with respx.mock:
        respx.get(URL).mock(return_value=httpx.Response(403, content=UNDECLARED_BODY))
        with pytest.raises(SecIdentityRejected) as caught:
            client.get(URL)

    message = str(caught.value)
    assert "403" in message
    assert "Undeclared Automated Tool" in message
    assert "\n" not in message
    assert len(message) < 500


# ── MONEY-1279: the THIRD meaning of 403 ────────────────────────────────────
#
# Captured 2026-08-29 from
# /Archives/edgar/daily-index/2021/QTR3/form.20210906.idx — Labor Day. The same
# User-Agent gets 200 for 09-03 and 09-07, so this is not a block on us: the
# bucket denies ListBucket, so a key that does not exist answers AccessDenied
# instead of NoSuchKey.
HOLIDAY_403_BODY = (
    b'<?xml version="1.0" encoding="UTF-8"?>\n'
    b"<Error><Code>AccessDenied</Code><Message>Access Denied</Message>"
    b"<RequestId>94S9KK0YK39QKB2W</RequestId>"
    b"<HostId>UkgEIxmYvEx6+GYlxAFpk/xRZqiKCXnLENXcilhizwhoHwsdWAWWPKiGQ4hBjxF997aCqf+LQ6c=</HostId>"
    b"</Error>"
)


def test_a_holiday_403_from_the_archive_is_ABSENCE_not_a_refusal() -> None:
    # The defect: this returned SecForbidden, which the ownership walk treats as
    # an upstream refusal and stops on. ~50 market holidays sit in a 5-year
    # window, so the backfill died at the first one on every attempt.
    assert classify_sec_response(403, HOLIDAY_403_BODY) is SecArchiveAbsent


def test_archive_absence_is_a_SecNotFound_so_existing_callers_need_no_change() -> None:
    # The subclassing is the mechanism, not an accident: `default_fetch_index`
    # and both PER_FILING_SEC_ERRORS tuples already spell absence as
    # SecNotFound. If this stops holding, three call sites change meaning at
    # once and nothing else in the suite says so.
    assert issubclass(SecArchiveAbsent, SecNotFound)


def test_a_REAL_block_is_never_downgraded_to_absence() -> None:
    # The ordering that makes mapping a 403 to "nothing published" safe. If the
    # archive marker were tested before the block markers, a rate block during a
    # walk would be recorded as "SEC published nothing that day" and the run
    # would sail past it writing zeros — silently, and permanently for any day
    # it checkpointed.
    both = UNDECLARED_BODY + HOLIDAY_403_BODY
    assert classify_sec_response(403, both) is SecIdentityRejected

    both_rate = RATE_BODY + HOLIDAY_403_BODY
    assert classify_sec_response(403, both_rate) is SecRateLimited


def test_an_unclassifiable_403_is_still_SecForbidden() -> None:
    # Absence must not become the catch-all. "Could not determine" stays its own
    # state, non-retryable, run stops.
    assert classify_sec_response(403, GENERIC_403_BODY) is SecForbidden
