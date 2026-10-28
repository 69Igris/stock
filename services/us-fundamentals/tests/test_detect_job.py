"""``/jobs/edgar-detect`` end to end, against the captured feeds — MONEY-979 (T6).

These drive the REAL :func:`app.jobs.detect.handle` — the same function
``app/main.py`` calls — with fakes injected through its keyword seam. The fakes
model the two behaviours the design depends on and nothing else:

* ``FakeFilingStore.claim_filing`` refuses a second insert of the same
  accession, because the unique index IS the fan-out guard and a fake that let
  both inserts succeed would test the opposite of the property.
* ``FakeSecClient`` records every URL, so "QA issued zero requests" and "the run
  stopped before page 2" are assertions rather than inferences.

``MongoFilingStore`` — the production store — is exercised separately at the
bottom against a collection fake that raises the driver's real
``DuplicateKeyError``, so the shipped implementation is not shadowed by the
in-memory one used above it.
"""

from __future__ import annotations

import gzip
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from app.detect_logic import (
    STOP_BUDGET_SPENT,
    STOP_CURSOR_REACHED,
    STOP_NOTHING_NEW,
    STOP_PAGE_CAP,
    STOP_PUBLISH_FAILED,
    DetectCursor,
)
from app.jobs import detect
from app.jobs.detect import (
    BLOCK_COOLDOWN_SECONDS,
    CURSOR_KEY_ATOM,
    CURSOR_KEY_EFTS,
    PUBLISH_FAILED_PREFIX,
    SKIP_COOLDOWN,
    SKIP_DATABASE_UNAVAILABLE,
    SKIP_FLAG_OFF,
    SKIP_IDENTITY_MISSING,
    STOP_EGRESS_DISABLED,
    STOP_IDENTITY_REJECTED,
    STOP_RATE_LIMITED,
    STOP_TRANSPORT_ERROR,
    MongoFilingStore,
    handle,
)
from app.events import EVENTS_TOPIC
from app.publish import PublishError, encode_message, iso_timestamp
from app.sec.edgar_adapter import parse_current_filings_atom
from app.sec.errors import (
    SecEgressDisabled,
    SecIdentityRejected,
    SecRateLimited,
    SecTransportError,
)
from app.store.outcome import (
    DETECT_LATENCY_METRIC,
    JOB_METRIC_FAILED,
    JOB_METRIC_WRITTEN,
)

FIXTURES = Path(__file__).parent / "fixtures"

EMPTY_ATOM = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<feed xmlns="http://www.w3.org/2005/Atom"><title>EDGAR</title></feed>'
)
EMPTY_EFTS = json.dumps({"hits": {"total": {"value": 0}, "hits": []}}).encode()

#: The instant the captured page's newest filing was accepted, plus 30 s. Fixing
#: the clock here is what turns the latency assertions into exact numbers.
NEWEST_ACCEPTED = datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC)
NOW = NEWEST_ACCEPTED + timedelta(seconds=30)


def _atom_bytes() -> bytes:
    return gzip.decompress((FIXTURES / "atom_getcurrent.xml.gz").read_bytes())


def _efts_bytes() -> bytes:
    return gzip.decompress((FIXTURES / "efts_8k_search.json.gz").read_bytes())


def _entries() -> list:
    return parse_current_filings_atom(_atom_bytes())


# ── Fakes ───────────────────────────────────────────────────────────────────


class FakeSecClient:
    """Routes by URL and records every call. ``close()`` is observable."""

    def __init__(self, handler) -> None:
        self._handler = handler
        self.calls: list[str] = []
        self.closed = False

    def get(self, url: str, *, timeout: float | None = None) -> bytes:
        self.calls.append(url)
        result = self._handler(url, len(self.calls) - 1)
        if isinstance(result, Exception):
            raise result
        return result

    def close(self) -> None:
        self.closed = True


def _atom_handler(*pages: bytes):
    """Serve ``pages`` by the ``start`` query parameter; anything beyond is empty."""

    def handler(url: str, _index: int):
        start = int(parse_qs(urlsplit(url).query)["start"][0])
        page = start // 100
        return pages[page] if page < len(pages) else EMPTY_ATOM

    return handler


def _one_page_handler():
    return _atom_handler(_atom_bytes())


class FakeFilingStore:
    """In-memory ``us_filings`` + ``us_edgar_cursor`` with a REAL unique key."""

    def __init__(self) -> None:
        self.filings: dict[str, dict[str, Any]] = {}
        self.claims: list[dict[str, Any]] = []
        self.failed_marks: list[tuple[str, str]] = []
        self.cursors: dict[str, dict[str, Any]] = {}
        self.cursor_writes: list[tuple[str, DetectCursor | None, dict[str, Any] | None]] = []
        self.known_queries: list[list[str]] = []

    def claim_filing(self, document: dict[str, Any]) -> bool:
        accession = document["accession"]
        if accession in self.filings:
            return False
        self.filings[accession] = dict(document)
        self.claims.append(dict(document))
        return True

    def mark_publish_failed(self, accession: str, error: str) -> None:
        self.failed_marks.append((accession, error))
        row = self.filings.get(accession)
        if row is not None:
            row.update({"status": "FAILED", "error": error})

    def known_accessions(self, accessions) -> set[str]:
        wanted = list(accessions)
        self.known_queries.append(wanted)
        return {value for value in wanted if value in self.filings}

    def read_cursor(self, key: str) -> dict[str, Any] | None:
        return self.cursors.get(key)

    def write_cursor(self, key, *, cursor, last_run_at, meta=None) -> None:
        self.cursor_writes.append((key, cursor, meta))
        doc = self.cursors.setdefault(key, {"key": key})
        doc["lastRunAt"] = last_run_at
        if cursor is not None:
            doc["lastAccession"] = cursor.last_accession
            doc["lastAcceptedAt"] = cursor.last_accepted_at
        if meta is not None:
            doc["meta"] = meta


class FakePublisher:
    """Records publishes; can fail from the Nth call onward."""

    def __init__(self, fail_from: int | None = None, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self._fail_from = fail_from
        self._error = error or PublishError("publish to topic failed: RuntimeError")
        self.published = 0

    def publish(self, base_topic: str, payload: dict[str, Any]) -> str:
        if self._fail_from is not None and len(self.calls) + 1 >= self._fail_from:
            raise self._error
        self.calls.append((base_topic, dict(payload)))
        self.published += 1
        return f"msg-{self.published}"

    def parse_calls(self) -> list[tuple[str, dict[str, Any]]]:
        """The PARSE fan-out only.

        MONEY-1520 put a second lane on this same publisher: the claimed
        filings are published to `us-filing-events` as one batch at the end of
        the run. `topics()` and `accessions()` are about the per-filing parse
        fan-out and would both choke on an events body, which carries a
        `filings` array and no top-level `accession`.
        """
        return [(t, p) for t, p in self.calls if t != EVENTS_TOPIC]

    def event_batches(self) -> list[list[dict[str, Any]]]:
        """The `filings` arrays published to the events topic, in order."""
        return [p["filings"] for t, p in self.calls if t == EVENTS_TOPIC]

    def topics(self) -> list[str]:
        return [topic for topic, _ in self.parse_calls()]

    def accessions(self) -> list[str]:
        return [payload["accession"] for _, payload in self.parse_calls()]


def _clock(moment: datetime = NOW):
    return lambda: moment


def _run(**kwargs: Any) -> dict[str, Any]:
    """Drive the real handler with production-shaped defaults."""
    kwargs.setdefault("clock", _clock())
    kwargs.setdefault("monotonic", lambda: 0.0)
    return handle(kwargs.pop("payload", {}), **kwargs)


# ── The kill switch ─────────────────────────────────────────────────────────


def test_absent_flag_is_a_named_skip_not_a_failed_run(statsd, caplog) -> None:
    """A job told not to run must not look like a job whose upstream is dark.

    ``MF_METADATA_PROVIDER`` disabled its job for months by being ABSENT, with
    every dashboard green, because nothing distinguished "nobody set it" from
    "it is deliberately off".
    """
    store = FakeFilingStore()
    client = FakeSecClient(_one_page_handler())

    with caplog.at_level("INFO"):
        result = _run(store=store, sec_client=client, publisher=FakePublisher())

    assert result["skipped"] is True
    assert result["skippedReason"] == SKIP_FLAG_OFF
    assert result["flag"] == "absent"
    assert result["selected"] == 0 and result["written"] == 0 and result["failed"] == 0
    assert client.calls == []
    assert store.claims == []
    assert store.cursor_writes == []
    assert statsd.value_of(JOB_METRIC_WRITTEN) == 0
    assert SKIP_FLAG_OFF in caplog.text


def test_flag_off_and_flag_absent_are_distinguishable(statsd) -> None:
    os.environ["EDGAR_DETECT"] = "off"
    result = _run(
        store=FakeFilingStore(),
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=FakePublisher(),
    )
    assert result["skipped"] is True
    assert result["flag"] == "off"


def test_flag_must_be_the_literal_on(statsd) -> None:
    """``bool("false")`` is ``True``; the comparison is against the exact string."""
    for value in ("true", "false", "1", "ON ", "yes"):
        os.environ["EDGAR_DETECT"] = value
        result = _run(
            store=FakeFilingStore(),
            sec_client=FakeSecClient(_one_page_handler()),
            publisher=FakePublisher(),
        )
        expected_skip = value.strip().lower() != "on"
        assert result["skipped"] is expected_skip, value


def test_unknown_mode_is_named_rather_than_silently_defaulted(statsd) -> None:
    os.environ["EDGAR_DETECT"] = "on"
    client = FakeSecClient(_one_page_handler())
    result = _run(payload={"mode": "banana"}, store=FakeFilingStore(), sec_client=client)
    assert result["skipped"] is True
    assert result["skippedReason"] == "unknown-mode:banana"
    assert client.calls == []


# ── The happy path ──────────────────────────────────────────────────────────


@pytest.fixture
def armed() -> None:
    os.environ["EDGAR_DETECT"] = "on"
    os.environ["PUBSUB_ENV"] = "prod"


def test_every_claimed_filing_is_emitted_as_an_instrument_event(armed, statsd) -> None:
    """MONEY-1507 (C1) / MONEY-1520 — the JOIN, not just the halves.

    `app/events.py` builds the payload and is unit-tested on its own, which
    proves nothing about whether the detect loop ever PUBLISHES it. Test the
    join: a claimed filing must reach the events TOPIC, in ONE message,
    carrying the row that was actually stored.

    And the topic is asserted BY NAME. The transport this replaced was pointed
    at a destination that could not be reached from this service at all — every
    POST 404'd at the Cloud Run edge for as long as it existed — so "an emitter
    was called" is not the property worth pinning. Where the bytes GO is.
    """
    store = FakeFilingStore()
    publisher = FakePublisher()

    result = _run(
        store=store,
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=publisher,
    )

    assert result["written"] == 49
    # ONE message, not 49: a publish per filing would put an unbounded number of
    # round trips inside a 420s budget that sits inside a 600s ack deadline.
    batches = publisher.event_batches()
    assert len(batches) == 1
    assert len(batches[0]) == 49
    assert sorted(f["accession"] for f in batches[0]) == sorted(store.filings)
    # The destination, spelled out. `EVENTS_TOPIC` is joined against the
    # workers' `/jobs/` mounts by
    # `workers/__tests__/us-filing-events-transport.test.ts`, so this assertion
    # plus that one is a chain from the claimed row to a route that exists.
    assert EVENTS_TOPIC == "us-filing-events"
    assert [t for t, _ in publisher.calls if t == EVENTS_TOPIC] == [EVENTS_TOPIC]


def test_each_live_event_carries_its_own_claim_instant_as_observed_at(armed, statsd) -> None:
    """MONEY-1532 — the JOIN for `observedAt`: the message carries the `detectedAt`
    the claim STORED for that filing. Not the publish instant (the emit runs in
    `handle`'s `finally`, up to a 420 s budget after the claim) and not one instant
    for the batch. The clock ticks per call, so a batch-wide stamp would collapse
    49 values into one."""
    ticks = iter(NOW + timedelta(milliseconds=i) for i in range(10_000))
    store = FakeFilingStore()
    publisher = FakePublisher()

    _run(
        store=store,
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=publisher,
        clock=lambda: next(ticks),
    )

    [batch] = publisher.event_batches()
    assert {f["accession"]: f["observedAt"] for f in batch} == {
        accession: iso_timestamp(row["detectedAt"]) for accession, row in store.filings.items()
    }
    assert len({f["observedAt"] for f in batch}) == 49


def test_a_duplicate_claim_is_not_re_emitted(armed, statsd) -> None:
    """Another run owns that filing and has already emitted it. The event id is
    deterministic, so a second emission is a redundant upsert — and, at scale, a
    second full batch per overlapping run."""
    store = FakeFilingStore()
    _run(
        store=store,
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=FakePublisher(),
    )

    # A FRESH store carrying the same rows: that is the shape a SECOND detector
    # has — the filings are already claimed, and its own cursor has not moved.
    # Re-using the first store would advance the cursor instead and select
    # nothing, which is a different property.
    rival = FakeFilingStore()
    rival.filings.update(store.filings)

    second = FakePublisher()
    again = _run(
        store=rival,
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=second,
        payload={},
    )
    assert again["written"] == 0
    assert again["duplicates"] == 49
    assert second.event_batches() == []


def test_a_publish_failure_never_fails_the_detection_and_is_COUNTED(armed, statsd) -> None:
    """MONEY-1520 — fail-soft was never the defect; fail-soft AND silent was.

    The detect loop's product is the CLAIM, and an events outage must not stop a
    walk whose Atom window rolls in minutes and whose misses are unrecoverable.
    But the run must SAY SO: for as long as the old HTTP transport 404'd, the
    ERROR line `[events] workers answered 404` fired every minute while the very
    next line read `[job-outcome] {"selected":3,"written":3,"failed":0}` — and
    `failed` is the dimension the metric carries, so nothing could alert on it.
    """

    class _ExplodingEventsPublisher(FakePublisher):
        """Parse publishes succeed; the EVENTS publish raises."""

        def publish(self, base_topic: str, payload: dict[str, Any]) -> str:
            if base_topic == EVENTS_TOPIC:
                raise PublishError("publish to topic failed: NotFound")
            return super().publish(base_topic, payload)

    publisher = _ExplodingEventsPublisher()
    with pytest.raises(PublishError):
        # PREMISE: the fake really does raise on the events topic, so the
        # assertions below are about the handler's contract and not about a
        # fake that quietly returned.
        publisher.publish(EVENTS_TOPIC, {"filings": []})

    store = FakeFilingStore()
    result = _run(
        store=store,
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=publisher,
    )

    # The walk completed: claims kept, parse fan-out intact, no skip reason.
    assert result["written"] == 49
    assert result["skippedReason"] is None
    # And the failure is IN THE OUTCOME. Without this the run reports
    # `failed: 0` with 49 events on the floor — the exact shape of MONEY-1520.
    failed = [
        value
        for kind, name, value, _tags in statsd.calls
        if kind == "increment" and name == JOB_METRIC_FAILED
    ]
    assert failed == [49], f"expected 49 failed rows reported, got {failed}"


def test_a_non_publish_exception_is_also_caught_and_counted(armed, statsd) -> None:
    """`Publisher.publish` wraps its own failures in `PublishError`, but
    `_resolve_client()` constructs `PublisherClient()` OUTSIDE that try — and
    that call resolves Application Default Credentials, which raises its own
    types. A `except PublishError` alone would let those escape the `finally`
    and turn a successful detection into a 500 plus a Pub/Sub redelivery.
    """

    class _BrokenCredentials(FakePublisher):
        def publish(self, base_topic: str, payload: dict[str, Any]) -> str:
            if base_topic == EVENTS_TOPIC:
                raise RuntimeError("could not resolve ADC")
            return super().publish(base_topic, payload)

    result = _run(
        store=FakeFilingStore(),
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=_BrokenCredentials(),
    )
    assert result["written"] == 49
    assert result["skippedReason"] is None


def test_one_page_of_the_real_feed_fans_out_forty_nine_filings(armed, statsd) -> None:
    store = FakeFilingStore()
    publisher = FakePublisher()
    client = FakeSecClient(_one_page_handler())

    result = _run(store=store, sec_client=client, publisher=publisher)

    entries = _entries()
    assert result["selected"] == 49
    assert result["written"] == 49
    assert result["failed"] == 0
    assert result["duplicates"] == 0
    # 33 ownership + 5 beneficial-ownership schedules are routed; the 11 Form
    # 144s are OTHER and are recorded without a parser.
    assert result["published"] == 38
    assert result["noParser"] == 11
    assert result["byClass"] == {"OWNERSHIP": 33, "SCHEDULE13": 5, "OTHER": 11}
    assert len(store.claims) == 49

    # The counted 11 are the same 11 the ledger holds TERMINAL, and every other
    # row is in flight. Asserted from the STORE rather than from the counter
    # alone: a count and a write that disagree is the shape of MONEY-1303.
    assert sorted(
        row["accession"] for row in store.filings.values() if row["status"] == "NO_PARSER"
    ) == sorted(entry.accession for entry in entries if entry.form == "144")
    assert sum(1 for row in store.filings.values() if row["status"] == "DETECTED") == 38
    assert publisher.accessions() == [entry.accession for entry in entries if entry.form != "144"]
    assert set(publisher.topics()) == {"edgar-parse-ownership", "edgar-parse-13dg"}

    # Two fetches: the captured page, then an empty one that ends the walk.
    assert result["pagesFetched"] == 2
    assert result["stopReason"] == STOP_NOTHING_NEW
    assert len(client.calls) == 2
    assert "start=0" in client.calls[0] and "start=100" in client.calls[1]


def test_the_claimed_row_matches_the_prisma_contract(armed, statsd) -> None:
    """Schema field names, and EXPLICIT nulls.

    A field omitted on insert is ABSENT in Mongo, and an absent field matches
    neither ``{f: null}`` nor ``{f: {$ne: null}}`` — so a parser scanning for
    ``{parsedAt: null}`` would find zero rows and report a clean, empty,
    entirely wrong result (MONEY-1050 / 1234 / 1235).
    """
    store = FakeFilingStore()
    _run(store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=FakePublisher())

    row = store.filings["0001214659-26-011109"]
    assert row["cik10"] == "0001211677"
    assert row["form"] == "4"
    assert row["parseClass"] == "OWNERSHIP"
    assert row["status"] == "DETECTED"
    assert row["source"] == "SEC_EDGAR"
    assert row["acceptedAt"] == NEWEST_ACCEPTED
    assert row["filedAt"] == datetime(2026, 8, 28, tzinfo=UTC)
    assert row["sizeBytes"] == 13312
    assert row["detectedAt"] == NOW and row["ingestedAt"] == NOW

    # `Row.to_doc()` OMITS nulls, so a freshly detected row has no `parsedAt`
    # key at all. That is the shared convention for this collection, and it is
    # why readers must filter POSITIVELY on `status` / `parseClass` — both always
    # present — and never on `{parsedAt: null}`, which in Mongo matches neither
    # absent nor set values reliably (MONEY-1050 / 1234 / 1235).
    for omitted in ("parsedAt", "error", "rawPath", "parserVersion", "primaryDocument"):
        assert omitted not in row

    expected_keys = {
        "accession", "cik10", "form", "filedAt", "acceptedAt", "items",
        "isXbrl", "isInlineXbrl", "sizeBytes", "parseClass", "status",
        "detectedAt", "source", "ingestedAt", "updatedAt",
    }  # fmt: skip
    assert set(row) == expected_keys


def test_the_row_is_built_through_the_shared_model(armed, statsd) -> None:
    """``UsFilingRow``, not a dict literal.

    ``us_filings`` is written by three paths — this detector, the nightly
    ``submissions.zip`` ledger and the parsers' status stamps — so a
    hand-written field list here would be a SECOND spelling of one collection's
    shape, which is how MONEY-1234/1235 happened. The model is also the half
    that ``schema-parity.test.ts`` grades against ``schema.prisma``.

    ``extra="forbid"`` on the model is what makes this assertable: a typo'd
    field name raises here rather than being silently dropped from every
    document.
    """
    from app.store.models import UsFilingRow

    store = FakeFilingStore()
    _run(store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=FakePublisher())

    for row in store.claims:
        assert set(row) <= set(UsFilingRow.model_fields)


def test_the_published_message_is_the_typescript_envelope(armed, statsd) -> None:
    publisher = FakePublisher()
    _run(
        store=FakeFilingStore(), sec_client=FakeSecClient(_one_page_handler()), publisher=publisher
    )

    topic, payload = publisher.calls[0]
    assert topic == "edgar-parse-ownership"
    assert payload == {
        "accession": "0001214659-26-011109",
        "cik10": "0001211677",
        "form": "4",
        "parseClass": "OWNERSHIP",
        "acceptedAt": "2026-08-29T01:53:58.000Z",
    }
    assert encode_message(payload).startswith(b'{"accession":"0001214659-26-011109"')


def test_the_result_is_json_serialisable(armed, statsd) -> None:
    """``main.py`` hands this straight to ``JSONResponse``; a datetime would 500."""
    result = _run(
        store=FakeFilingStore(),
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=FakePublisher(),
    )
    json.dumps(result)


# ── The unparseable ledger row (MONEY-1303) ─────────────────────────────────
#
# A filing whose `parseClass` routes to no topic is stored TERMINAL. It used to
# be stored `DETECTED`, and since nothing ever advances it, that made one status
# mean two opposite things: "published to a parse topic, awaiting a parser" and
# "will never be parsed". Measured on prod 2026-08-30: `OTHER DETECTED 933`,
# with DETECTED = 0 for every other class — 933 rows a genuinely backed-up parse
# topic would have been indistinguishable from.


def _atom_feed(*entries: tuple[str, str, str]) -> bytes:
    """A `getcurrent` page carrying exactly ``(accession, form, cik)`` per entry.

    Synthetic on purpose, and only here: the captured fixture is the right
    evidence for "what does SEC actually send", but it cannot express "ONE
    unroutable filing and nothing else", which is what makes the no-publish
    assertion below exact rather than a subtraction.
    """
    body = [
        """<?xml version="1.0" encoding="ISO-8859-1" ?>""",
        '<feed xmlns="http://www.w3.org/2005/Atom">',
    ]
    for accession, form, cik in entries:
        body.append(
            "<entry>"
            f"<title>{form} - FILER {cik} ({cik}) (Reporting)</title>"
            '<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-08-28 '
            f"&lt;b&gt;AccNo:&lt;/b&gt; {accession} &lt;b&gt;Size:&lt;/b&gt; 13 KB</summary>"
            "<updated>2026-08-28T21:53:58-04:00</updated>"
            f'<category scheme="https://www.sec.gov/" label="form type" term="{form}"/>'
            f"<id>urn:tag:sec.gov,2008:accession-number={accession}</id>"
            "</entry>"
        )
    body.append("</feed>")
    return "".join(body).encode()


UNROUTED = "0001214659-26-000144"
ROUTED = "0001214659-26-000004"


def _mixed_page_handler():
    return _atom_handler(_atom_feed((UNROUTED, "144", "0001211677"), (ROUTED, "4", "0001211677")))


def test_an_unroutable_filing_is_stored_terminal_and_never_published(armed, statsd) -> None:
    """The defect, stated as the two halves that have to agree.

    A Form 144 is OTHER, ``topic_for`` answers ``None`` for it BY DESIGN, and
    the row must land ``NO_PARSER`` — not ``DETECTED``, which claims a parser is
    coming for it. And nothing may be published: a class with no topic has
    nowhere for a message to go.
    """
    store = FakeFilingStore()
    publisher = FakePublisher()

    result = _run(store=store, sec_client=FakeSecClient(_mixed_page_handler()), publisher=publisher)

    assert store.filings[UNROUTED]["status"] == "NO_PARSER"
    assert store.filings[UNROUTED]["parseClass"] == "OTHER"
    # EXACT, not "fewer than two": the routed Form 4 is the only publish, so a
    # second one could only be the unroutable filing.
    assert publisher.accessions() == [ROUTED]
    assert result["published"] == 1
    assert result["noParser"] == 1


def test_a_routable_filing_on_the_same_page_is_still_stored_in_flight(armed, statsd) -> None:
    """The contrast, in the same run.

    Without this, "every row is NO_PARSER" passes the test above — and that is
    the mutation that would break every parser in the service, since a row is
    only DETECTED while something is genuinely expected to advance it.
    """
    store = FakeFilingStore()
    _run(store=store, sec_client=FakeSecClient(_mixed_page_handler()), publisher=FakePublisher())

    assert store.filings[ROUTED]["status"] == "DETECTED"
    assert store.filings[ROUTED]["parseClass"] == "OWNERSHIP"


def test_the_terminal_row_is_written_once_by_the_claim_not_patched_afterwards(
    armed, statsd
) -> None:
    """One write per filing, carrying the final status.

    The status is resolved BEFORE ``claim_filing``, so there is no window in
    which the row reads ``DETECTED`` and no second round trip to correct it.
    ``mark_publish_failed`` is the only other write this job makes to a claimed
    row, and an unroutable filing must not reach it.
    """
    store = FakeFilingStore()
    _run(store=store, sec_client=FakeSecClient(_mixed_page_handler()), publisher=FakePublisher())

    claims = [doc for doc in store.claims if doc["accession"] == UNROUTED]
    assert len(claims) == 1
    assert claims[0]["status"] == "NO_PARSER"
    assert store.failed_marks == []


def test_the_new_status_is_not_unsupported(armed, statsd) -> None:
    """``UNSUPPORTED`` is stamped by a parser that RAN and found nothing.

    A ``13F-NT`` notice reaches ``parse_13f``, which looks and records that there
    is no information table. NO_PARSER means no parser was ever asked. Spelling
    them the same way would make "we looked" and "we never looked" one query,
    and the 13F-NT population is the one that would be silently absorbed.
    """
    from app.store.models import STATUS_NO_PARSER, STATUS_UNSUPPORTED

    assert STATUS_NO_PARSER == "NO_PARSER"
    assert STATUS_NO_PARSER != STATUS_UNSUPPORTED

    store = FakeFilingStore()
    _run(store=store, sec_client=FakeSecClient(_mixed_page_handler()), publisher=FakePublisher())
    assert store.filings[UNROUTED]["status"] != STATUS_UNSUPPORTED


def test_an_unknown_parse_class_still_raises_and_claims_nothing(armed, statsd) -> None:
    """The asymmetry ``topic_for`` documents must survive this change.

    An unknown FORM is data from SEC and resolves to OTHER. An unknown parse
    CLASS can only come from our own code, and answering ``None`` for it would
    route a whole class of filings to the new terminal status — recorded as
    "deliberately not parsed" when in fact nobody decided anything. It raises,
    and because the topic is now resolved BEFORE the claim, it raises with
    nothing written.
    """
    store = FakeFilingStore()
    publisher = FakePublisher()
    original = detect.classify_form
    detect.classify_form = lambda form: "INSIDER"
    try:
        with pytest.raises(KeyError, match="INSIDER"):
            _run(
                store=store,
                sec_client=FakeSecClient(_mixed_page_handler()),
                publisher=publisher,
            )
    finally:
        detect.classify_form = original

    assert store.claims == []
    assert publisher.calls == []


def test_the_efts_reconcile_stores_the_same_terminal_status(armed, statsd) -> None:
    """Both detection paths share ``_fan_out``, and the assertion says so.

    The hourly sweep is the net under the minutely walk, so a filing it stores
    is written by the same code — but "shares a function today" is not a
    property, and an EFTS-shaped entry carries a different accession field, a
    different CIK shape and no acceptance timestamp.
    """
    hit = {
        "_source": {
            "adsh": "0001214659-26-000999",
            "ciks": ["0001211677"],
            "form": "144",
            "file_date": "2026-08-28",
        }
    }
    payload = json.dumps({"hits": {"total": {"value": 1}, "hits": [hit]}}).encode()

    def handler(url: str, index: int) -> bytes:
        query = parse_qs(urlsplit(url).query)
        if query["forms"][0].startswith("8-K") and int(query["from"][0]) == 0:
            return payload
        return EMPTY_EFTS

    store = FakeFilingStore()
    publisher = FakePublisher()
    result = _run(
        payload={"mode": "efts"},
        store=store,
        sec_client=FakeSecClient(handler),
        publisher=publisher,
    )

    assert store.filings["0001214659-26-000999"]["status"] == "NO_PARSER"
    assert publisher.parse_calls() == []
    assert result["noParser"] == 1
    assert result["published"] == 0
    # …but it IS an event. A form we have chosen not to parse is still a filing
    # the product should show, and `_fan_out` appends it to `claimed_documents`
    # before the topic lookup returns None. Scoping the line above to the PARSE
    # calls rather than deleting it keeps both halves stated.
    assert len(publisher.event_batches()) == 1


# ── Latency ─────────────────────────────────────────────────────────────────


def test_latency_is_emitted_per_new_filing_from_accepted_at(armed, statsd) -> None:
    """49 samples, and the newest is EXACTLY 30 s.

    The same filing's ``filedAt`` is a day earlier, so a histogram fed from that
    column would have a floor above 90,000 seconds instead of 30 — while still
    reporting 49 samples and still looking like a working metric.
    """
    _run(
        store=FakeFilingStore(),
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=FakePublisher(),
    )

    samples = [
        (value, tags)
        for kind, name, value, tags in statsd.calls
        if kind == "histogram" and name == DETECT_LATENCY_METRIC
    ]
    assert len(samples) == 49

    values = [value for value, _ in samples]
    assert min(values) == 30.0
    # The captured page spans about two hours of acceptances.
    assert max(values) < 7200

    _, first_tags = samples[0]
    assert "form_class:OWNERSHIP" in first_tags
    assert "mode:atom" in first_tags


def test_no_latency_sample_for_a_filing_we_did_not_claim(armed, statsd) -> None:
    """A duplicate was measured by whoever claimed it; measuring it twice skews the p95."""
    store = FakeFilingStore()
    entries = _entries()
    store.filings[entries[0].accession] = {"accession": entries[0].accession}

    _run(store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=FakePublisher())

    samples = [name for kind, name, _, _ in statsd.calls if kind == "histogram"]
    assert len(samples) == 48


# ── The fan-out guard ───────────────────────────────────────────────────────


def test_an_existing_accession_is_skipped_and_never_republished(armed, statsd) -> None:
    """THE guard. A duplicate key means another run already owns the filing.

    Publishing anyway would fan the same 13F out twice on every overlap between
    the minutely walk, a redelivery and the hourly reconcile.
    """
    store = FakeFilingStore()
    entries = _entries()
    already = entries[0].accession
    store.filings[already] = {"accession": already, "status": "DETECTED"}
    publisher = FakePublisher()

    result = _run(store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=publisher)

    assert result["duplicates"] == 1
    assert result["written"] == 48
    assert already not in publisher.accessions()
    assert len(publisher.parse_calls()) == 37


def test_a_duplicate_does_not_pin_the_cursor(armed, statsd) -> None:
    """Nothing is outstanding for a filing another run claimed, so the walk may pass it."""
    store = FakeFilingStore()
    entries = _entries()
    store.filings[entries[0].accession] = {"accession": entries[0].accession}

    result = _run(
        store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=FakePublisher()
    )

    assert result["cursor"]["lastAccession"] == entries[0].accession


# ── The cursor ──────────────────────────────────────────────────────────────


def test_cursor_advances_to_the_newest_filing_after_a_clean_run(armed, statsd) -> None:
    store = FakeFilingStore()
    entries = _entries()

    result = _run(
        store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=FakePublisher()
    )

    assert result["cursorAdvanced"] is True
    assert result["cursor"]["lastAccession"] == entries[0].accession
    assert result["cursor"]["lastAcceptedAt"] == "2026-08-29T01:53:58.000Z"
    assert store.cursors[CURSOR_KEY_ATOM]["lastAccession"] == entries[0].accession


def test_a_publish_failure_stops_the_fan_out_and_pins_the_cursor(armed, statsd) -> None:
    """The property the whole ordering exists for.

    A cursor advanced before the publish does not lose a retry — it loses the
    filing. And the fan-out STOPS at the first failure so the remainder is left
    un-inserted: exactly one row is stranded rather than forty-eight.
    """
    store = FakeFilingStore()
    entries = _entries()
    publisher = FakePublisher(fail_from=3)

    result = _run(store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=publisher)

    assert result["stopReason"] == STOP_PUBLISH_FAILED
    assert result["failed"] == 1
    assert result["published"] == 2
    assert result["cursorAdvanced"] is False
    assert result["cursor"] is None
    assert (
        CURSOR_KEY_ATOM not in store.cursors
        or "lastAccession" not in store.cursors[CURSOR_KEY_ATOM]
    )

    # Three claimed (two published, one stranded); everything older untouched.
    assert len(store.claims) == 3
    assert [entry.accession for entry in entries[3:]] == [
        entry.accession for entry in entries[3:] if entry.accession not in store.filings
    ]

    stranded = store.filings[entries[2].accession]
    assert stranded["status"] == "FAILED"
    assert stranded["error"].startswith(PUBLISH_FAILED_PREFIX)
    assert store.failed_marks[0][0] == entries[2].accession


def test_the_next_run_re_walks_everything_the_failed_run_did_not_claim(armed, statsd) -> None:
    """The pinned cursor is what makes the stop recoverable rather than lossy."""
    store = FakeFilingStore()
    entries = _entries()

    _run(
        store=store,
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=FakePublisher(fail_from=3),
    )
    assert len(store.filings) == 3

    recovered = FakePublisher()
    second = _run(store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=recovered)

    assert second["duplicates"] == 3
    assert second["written"] == 46
    assert len(store.filings) == 49
    assert second["cursor"]["lastAccession"] == entries[0].accession


def test_an_existing_cursor_stops_the_walk_mid_page(armed, statsd) -> None:
    store = FakeFilingStore()
    entries = _entries()
    store.cursors[CURSOR_KEY_ATOM] = {
        "key": CURSOR_KEY_ATOM,
        "lastAccession": entries[10].accession,
        "lastAcceptedAt": entries[10].accepted_at,
    }
    client = FakeSecClient(_one_page_handler())

    result = _run(store=store, sec_client=client, publisher=FakePublisher())

    assert result["stopReason"] == STOP_CURSOR_REACHED
    assert result["cursorReached"] is True
    assert result["selected"] == 10
    assert result["written"] == 10
    assert len(client.calls) == 1, "a walk that reached the cursor must not fetch another page"


def test_a_naive_stored_cursor_timestamp_does_not_crash_the_comparison(armed, statsd) -> None:
    """pymongo hands back NAIVE datetimes; BSON has no zone."""
    store = FakeFilingStore()
    entries = _entries()
    store.cursors[CURSOR_KEY_ATOM] = {
        "key": CURSOR_KEY_ATOM,
        "lastAccession": "not-in-this-window",
        "lastAcceptedAt": entries[10].accepted_at.replace(tzinfo=None),
    }

    result = _run(
        store=store, sec_client=FakeSecClient(_one_page_handler()), publisher=FakePublisher()
    )

    assert result["cursorReached"] is True
    assert result["selected"] == 11


# ── Walk limits ─────────────────────────────────────────────────────────────


def test_the_page_cap_stops_the_walk_and_names_itself(armed, statsd) -> None:
    """A cursor that has rolled out of the window must not become an unbounded crawl."""
    page = _atom_bytes()
    store = FakeFilingStore()

    def handler(url: str, index: int) -> bytes:
        # Every page is a DIFFERENT set of filings, so the walk never runs out.
        return page.replace(b"accession-number=00", f"accession-number={index:02d}".encode())

    result = _run(
        store=store,
        sec_client=FakeSecClient(handler),
        publisher=FakePublisher(),
        max_pages=3,
    )

    assert result["stopReason"] == STOP_PAGE_CAP
    assert result["pagesFetched"] == 3


def test_the_wall_budget_stops_the_walk_between_pages(armed, statsd) -> None:
    """Checked BETWEEN pages, so the true wall is ``budget + one page``.

    Work already collected is still fanned out: discarding it would mean a slow
    run wrote nothing at all.
    """
    ticks = iter([0.0, 0.0, 500.0, 500.0, 500.0, 500.0])
    store = FakeFilingStore()

    result = _run(
        store=store,
        sec_client=FakeSecClient(_one_page_handler()),
        publisher=FakePublisher(),
        monotonic=lambda: next(ticks, 500.0),
        budget_seconds=420.0,
    )

    assert result["stopReason"] == STOP_BUDGET_SPENT
    assert result["pagesFetched"] == 1
    assert result["written"] == 49


# ── SEC failure classes ─────────────────────────────────────────────────────


def test_egress_disabled_stops_without_counting_a_transport_failure(armed, statsd) -> None:
    """Nothing opened a socket, so there is no upstream to blame."""
    client = FakeSecClient(lambda url, index: SecEgressDisabled("SEC_EGRESS='off'"))
    store = FakeFilingStore()

    result = _run(store=store, sec_client=client, publisher=FakePublisher())

    assert result["stopReason"] == STOP_EGRESS_DISABLED
    assert result["transportFailures"] == 0
    assert result["written"] == 0
    assert store.cursors[CURSOR_KEY_ATOM]["meta"]["blockedUntil"] is None


def test_the_real_client_refuses_to_fetch_when_egress_is_off(armed, statsd) -> None:
    """Runtime proof of the PRODUCTION wiring, not of an injected fake.

    ``SecClient`` is built here by ``handle`` itself, from settings, and the
    egress gate fires before a socket exists — which is what makes "QA cannot
    reach SEC" an assertion rather than a convention.
    """
    os.environ["EDGAR_IDENTITY"] = "UseMoney Test test@example.com"
    os.environ["SEC_EGRESS"] = "off"

    result = _run(store=FakeFilingStore(), publisher=FakePublisher())

    assert result["stopReason"] == STOP_EGRESS_DISABLED
    assert result["written"] == 0


def test_missing_identity_is_a_named_skip(armed, statsd) -> None:
    """SEC answers an undeclared agent with a 403; sending a blank UA would be that."""
    result = _run(store=FakeFilingStore(), publisher=FakePublisher())
    assert result["skipped"] is True
    assert result["skippedReason"] == SKIP_IDENTITY_MISSING


@pytest.mark.parametrize(
    ("error", "stop_reason", "cooldown"),
    [
        (SecIdentityRejected("403 undeclared"), STOP_IDENTITY_REJECTED, BLOCK_COOLDOWN_SECONDS),
        (SecRateLimited("403 threshold"), STOP_RATE_LIMITED, BLOCK_COOLDOWN_SECONDS),
        (SecRateLimited("429", retry_after=1200.0), STOP_RATE_LIMITED, 1200.0),
        (SecTransportError("connect reset"), STOP_TRANSPORT_ERROR, None),
    ],
)
def test_sec_failures_stop_the_run_and_are_counted_as_transport(
    armed, statsd, error, stop_reason, cooldown
) -> None:
    """Handled, named and answered 200 — never a 500 that Pub/Sub redelivers.

    A redelivery into a rate block re-issues the request that caused it, and a
    redelivery into an identity rejection fails identically every time while
    lengthening the block.
    """
    store = FakeFilingStore()
    client = FakeSecClient(lambda url, index: error)

    result = _run(store=store, sec_client=client, publisher=FakePublisher())

    assert result["stopReason"] == stop_reason
    assert result["transportFailures"] == 1
    assert result["skipped"] is False

    blocked_until = store.cursors[CURSOR_KEY_ATOM]["meta"]["blockedUntil"]
    if cooldown is None:
        assert blocked_until is None
    else:
        assert blocked_until == NOW + timedelta(seconds=cooldown)


def test_a_recorded_block_makes_the_next_run_stand_down(armed, statsd) -> None:
    """The cooldown spans RUNS because a push handler cannot sleep it out.

    Pub/Sub's ack deadline IS SEC's 600 s remedy, so sleeping it guarantees a
    redelivery that goes straight back to the blocked host.
    """
    store = FakeFilingStore()
    _run(
        store=store,
        sec_client=FakeSecClient(lambda url, index: SecRateLimited("403 threshold")),
        publisher=FakePublisher(),
    )

    client = FakeSecClient(_one_page_handler())
    result = _run(store=store, sec_client=client, publisher=FakePublisher())

    assert result["skipped"] is True
    assert result["skippedReason"] == SKIP_COOLDOWN
    assert result["blockReason"] == STOP_RATE_LIMITED
    assert client.calls == [], "a cooling-down run must not touch SEC"


def test_an_expired_block_lets_the_run_proceed(armed, statsd) -> None:
    store = FakeFilingStore()
    store.cursors[CURSOR_KEY_ATOM] = {
        "key": CURSOR_KEY_ATOM,
        "meta": {"blockedUntil": NOW - timedelta(seconds=1), "blockReason": STOP_RATE_LIMITED},
    }
    client = FakeSecClient(_one_page_handler())

    result = _run(store=store, sec_client=client, publisher=FakePublisher())

    assert result["skipped"] is False
    assert result["written"] == 49
    assert store.cursors[CURSOR_KEY_ATOM]["meta"]["blockedUntil"] is None


def test_a_successful_run_clears_a_stale_cooldown(armed, statsd) -> None:
    store = FakeFilingStore()
    _run(
        store=store,
        sec_client=FakeSecClient(lambda url, index: SecTransportError("boom")),
        publisher=FakePublisher(),
    )
    assert store.cursors[CURSOR_KEY_ATOM]["meta"]["blockReason"] is None


def test_a_missing_database_raises_and_still_reports_the_outcome(armed, statsd, caplog) -> None:
    """An unexpected condition is a 500 and a redelivery; the dedupe stops a second copy.

    It must still be MEASURED — a job that raises before reporting is invisible
    in exactly the dimension the outcome exists to measure.
    """
    os.environ["EDGAR_IDENTITY"] = "UseMoney Test test@example.com"
    with caplog.at_level("INFO"), pytest.raises(RuntimeError):
        _run(publisher=FakePublisher())
    assert SKIP_DATABASE_UNAVAILABLE in caplog.text


# ── EFTS reconcile ──────────────────────────────────────────────────────────


def _efts_handler(url: str, index: int) -> bytes:
    query = parse_qs(urlsplit(url).query)
    forms = query["forms"][0]
    offset = int(query["from"][0])
    if forms == "8-K,6-K" and offset == 0:
        return _efts_bytes()
    return EMPTY_EFTS


def test_efts_mode_stores_what_the_live_walk_missed(armed, statsd) -> None:
    store = FakeFilingStore()
    publisher = FakePublisher()

    result = _run(
        payload={"mode": "efts"},
        store=store,
        sec_client=FakeSecClient(_efts_handler),
        publisher=publisher,
    )

    assert result["mode"] == "efts"
    assert result["hitsSeen"] == 100
    assert result["reconciledMissing"] == 100
    assert result["selected"] == 100
    assert result["written"] == 100
    # Every class it SWEPT is reported, including the ones that found nothing —
    # "we looked and there was nothing" and "we never looked" are different
    # facts, and a dict that only carried non-zero classes would spell them the
    # same way.
    assert result["reconciledByClass"] == {
        "OWNERSHIP": 0,
        "THIRTEENF": 0,
        "SCHEDULE13": 0,
        "EIGHTK": 100,
        "FINANCIALS": 0,
    }
    assert set(publisher.topics()) == {"edgar-parse-8k"}
    # The window is EDGAR's EASTERN day: 01:54 UTC is still 21:54 ET on the 28th.
    assert result["window"] == {"start": "2026-08-28", "end": "2026-08-28"}


def test_efts_emits_no_latency_because_there_is_nothing_to_measure(armed, statsd) -> None:
    """EFTS carries ``file_date`` and no acceptance timestamp.

    Substituting ``filedAt`` would emit an hours-long latency for every filing
    the reconcile touched and poison the p95 the acceptance gate reads.
    """
    _run(
        payload={"mode": "efts"},
        store=FakeFilingStore(),
        sec_client=FakeSecClient(_efts_handler),
        publisher=FakePublisher(),
    )
    histograms = [name for kind, name, _, _ in statsd.calls if kind == "histogram"]
    assert histograms == []


def test_efts_skips_filings_detection_already_stored(armed, statsd) -> None:
    """A healthy hour reads thousands of hits and finds nothing missing.

    ``selected`` is what was MISSING, not what was read — otherwise every
    healthy reconcile would trip the ``selected > 0 and written == 0`` alarm.
    """
    store = FakeFilingStore()
    from app.sec.edgar_adapter import json_loads, parse_efts_response

    hits = parse_efts_response(json_loads(_efts_bytes()))
    for hit in hits:
        store.filings[hit.accession] = {"accession": hit.accession}

    result = _run(
        payload={"mode": "efts"},
        store=store,
        sec_client=FakeSecClient(_efts_handler),
        publisher=FakePublisher(),
    )

    assert result["hitsSeen"] == 100
    assert result["reconciledMissing"] == 0
    assert result["selected"] == 0
    assert result["written"] == 0
    assert store.known_queries, "the plan must ask the store what it already holds"


def test_efts_rows_carry_the_first_cik_and_the_file_date(armed, statsd) -> None:
    store = FakeFilingStore()
    _run(
        payload={"mode": "efts"},
        store=store,
        sec_client=FakeSecClient(_efts_handler),
        publisher=FakePublisher(),
    )

    row = store.filings["0002061670-26-000083"]
    assert row["cik10"] == "0002061670"
    assert row["form"] == "8-K"
    assert row["parseClass"] == "EIGHTK"
    assert row["filedAt"] == datetime(2026, 8, 28, tzinfo=UTC)
    assert row["items"] == ["8.01"]
    # EFTS carries no acceptance timestamp, so the column is absent rather than
    # filled in from `file_date`.
    assert "acceptedAt" not in row


def test_efts_writes_its_own_cursor_row_and_never_the_atom_position(armed, statsd) -> None:
    """The reconcile does not own the ``getcurrent`` position.

    Writing it would move the live loop's stop marker to whatever the sweep
    happened to reach, and the minutely walk would skip everything in between.
    """
    store = FakeFilingStore()
    _run(
        payload={"mode": "efts"},
        store=store,
        sec_client=FakeSecClient(_efts_handler),
        publisher=FakePublisher(),
    )

    assert CURSOR_KEY_ATOM not in store.cursors
    written = store.cursors[CURSOR_KEY_EFTS]
    assert "lastAccession" not in written
    assert written["meta"]["windowStart"] == "2026-08-28"


def test_efts_queries_every_routed_class(armed, statsd) -> None:
    client = FakeSecClient(_efts_handler)
    _run(
        payload={"mode": "efts"},
        store=FakeFilingStore(),
        sec_client=client,
        publisher=FakePublisher(),
    )

    forms_asked = {parse_qs(urlsplit(url).query)["forms"][0] for url in client.calls}
    assert forms_asked == {"3,4,5", "13F-HR", "SC 13D,SC 13G", "8-K,6-K", "10-K,10-Q,20-F,40-F"}
    # `q` is omitted so the server filters to sequence=1 and returns one hit per
    # FILING rather than one per document.
    assert all("q=" not in url for url in client.calls)


# ── Client lifecycle ────────────────────────────────────────────────────────


def test_an_injected_client_is_not_closed_by_the_handler(armed, statsd) -> None:
    client = FakeSecClient(_one_page_handler())
    _run(store=FakeFilingStore(), sec_client=client, publisher=FakePublisher())
    assert client.closed is False


# ── The production store ────────────────────────────────────────────────────


class FakeCollection:
    """Enough of a pymongo collection to drive :class:`MongoFilingStore`.

    ``insert_one`` raises the driver's REAL ``DuplicateKeyError`` on a repeated
    accession, because catching that exception is not error handling in this
    design — it IS the concurrency protocol, and a fake that let both inserts
    succeed would test the opposite of the property.
    """

    def __init__(self) -> None:
        self.docs: list[dict[str, Any]] = []
        self.indexes: list[tuple[tuple[Any, ...], bool]] = []
        self.bulk_ops: list[Any] = []
        self.queries: list[tuple[dict[str, Any], Any]] = []

    def create_index(self, keys, unique: bool = False) -> str:
        self.indexes.append((tuple(tuple(key) for key in keys), unique))
        return "_".join(f"{name}_{direction}" for name, direction in keys)

    def insert_one(self, document: dict[str, Any]) -> Any:
        from pymongo.errors import DuplicateKeyError

        if any(doc.get("accession") == document.get("accession") for doc in self.docs):
            raise DuplicateKeyError("E11000 duplicate key error collection: us_filings")
        self.docs.append(dict(document))
        return object()

    def bulk_write(self, operations, ordered: bool = True) -> Any:
        from types import SimpleNamespace

        self.bulk_ops.extend(operations)
        return SimpleNamespace(matched_count=0, upserted_count=len(operations), modified_count=0)

    def find(self, filter, projection=None):
        self.queries.append((filter, projection))
        wanted = set(filter["accession"]["$in"])
        return [{"accession": doc["accession"]} for doc in self.docs if doc["accession"] in wanted]

    def find_one(self, filter):
        for doc in self.docs:
            if all(doc.get(key) == value for key, value in filter.items()):
                return doc
        return None


class FakeDatabase(dict):
    def __missing__(self, key: str) -> FakeCollection:
        collection = FakeCollection()
        self[key] = collection
        return collection


def _store() -> tuple[MongoFilingStore, FakeDatabase]:
    from app.store import writers

    # `ensure_indexes` remembers per (id(db), collection) for the life of the
    # process, and CPython reuses ids for freed objects — so without this a later
    # database could inherit an earlier one's "already ensured" marker and the
    # index assertions below would pass while ensuring nothing.
    writers.reset_index_cache()
    database = FakeDatabase()
    return MongoFilingStore(database), database


def _sets(operation) -> dict[str, Any]:
    return operation._doc["$set"]


def test_mongo_store_uses_the_mapped_collection_names() -> None:
    store, database = _store()
    store.claim_filing({"accession": "0001-26-1"})
    store.read_cursor(CURSOR_KEY_ATOM)
    assert set(database) == {"us_filings", "us_edgar_cursor"}


def test_mongo_store_ensures_the_unique_index_its_claim_depends_on() -> None:
    """The claim IS the unique index, so an unindexed collection breaks it silently.

    On a cluster where nobody has run ``prisma db push`` yet, an unindexed
    ``us_filings`` accepts every insert; ``claim_filing`` then answers ``True``
    for a filing another run already owns and detection fans the same filing out
    repeatedly with nothing reporting it.
    """
    store, database = _store()
    store.claim_filing({"accession": "0001-26-1"})
    assert ((("accession", 1),), True) in database["us_filings"].indexes


def test_mongo_store_claim_is_the_unique_index() -> None:
    store, database = _store()
    document = {"accession": "0001-26-1", "status": "DETECTED"}

    assert store.claim_filing(document) is True
    assert store.claim_filing(dict(document)) is False
    assert len(database["us_filings"].docs) == 1


def test_mongo_store_marks_a_stranded_row_without_creating_one() -> None:
    """UPDATE-ONLY. An upsert here would create a row with no ``form`` /
    ``filedAt`` / ``parseClass`` — all REQUIRED in Prisma — so it would not read
    as incomplete, it would make every Prisma query that touched it throw.
    """
    store, database = _store()
    store.claim_filing({"accession": "0001-26-1"})
    store.mark_publish_failed("0001-26-1", "publish-failed: boom")

    operation = database["us_filings"].bulk_ops[0]
    assert operation._filter == {"accession": "0001-26-1"}
    assert operation._upsert is False
    assert _sets(operation)["status"] == "FAILED"
    assert _sets(operation)["error"] == "publish-failed: boom"


def test_mongo_store_known_accessions_skips_the_query_when_asked_nothing() -> None:
    store, database = _store()
    assert store.known_accessions([]) == set()
    assert store.known_accessions(["", None]) == set()  # type: ignore[list-item]
    assert database["us_filings"].queries == []


def test_mongo_store_known_accessions_returns_only_what_exists() -> None:
    store, _ = _store()
    store.claim_filing({"accession": "A"})
    assert store.known_accessions(["A", "B"]) == {"A"}


def test_mongo_store_never_blanks_a_position_it_was_not_given() -> None:
    """``cursor=None`` means "no new position", NEVER "reset to the start of the feed".

    ``Row.to_doc()`` omits nulls, so the two position fields are left out of the
    ``$set`` entirely. Writing ``lastAccession: null`` over a real position would
    make the next walk run to the page cap and re-offer the whole rolling window.
    """
    store, database = _store()
    store.write_cursor(CURSOR_KEY_ATOM, cursor=None, last_run_at=NOW, meta={"a": 1})

    operation = database["us_edgar_cursor"].bulk_ops[0]
    assert operation._filter == {"key": CURSOR_KEY_ATOM}
    assert operation._upsert is True
    assert "lastAccession" not in _sets(operation)
    assert "lastAcceptedAt" not in _sets(operation)
    assert _sets(operation)["lastRunAt"] == NOW
    assert _sets(operation)["meta"] == {"a": 1}
    assert operation._doc["$setOnInsert"]["createdAt"] == NOW


def test_mongo_store_writes_a_position_when_given_one() -> None:
    store, database = _store()
    store.write_cursor(CURSOR_KEY_ATOM, cursor=DetectCursor("0001-26-1", NOW), last_run_at=NOW)

    operation = database["us_edgar_cursor"].bulk_ops[0]
    assert _sets(operation)["lastAccession"] == "0001-26-1"
    assert _sets(operation)["lastAcceptedAt"] == NOW


def test_mongo_store_keeps_a_cleared_block_inside_meta() -> None:
    """A cleared cooldown is ``meta.blockedUntil: None`` and must SURVIVE the write.

    ``to_doc()`` omits top-level nulls, not nulls nested inside a value — so the
    meta document is written whole and the next run reads "not blocked" rather
    than the stale block.
    """
    store, database = _store()
    store.write_cursor(
        CURSOR_KEY_ATOM,
        cursor=None,
        last_run_at=NOW,
        meta={"blockedUntil": None, "blockReason": None, "lastStopReason": "nothing-new"},
    )
    meta = _sets(database["us_edgar_cursor"].bulk_ops[0])["meta"]
    assert meta == {"blockedUntil": None, "blockReason": None, "lastStopReason": "nothing-new"}


def test_mongo_store_reads_the_cursor_by_key() -> None:
    store, database = _store()
    database["us_edgar_cursor"].docs.append({"key": CURSOR_KEY_ATOM, "lastAccession": "X"})
    assert store.read_cursor(CURSOR_KEY_ATOM) == {"key": CURSOR_KEY_ATOM, "lastAccession": "X"}
    assert store.read_cursor("nope") is None


def test_handle_is_the_module_entry_point_main_py_imports() -> None:
    """``main.py`` resolves ``app.jobs.detect`` and calls ``handle(payload)`` positionally."""
    from app.main import JOB_HANDLERS

    assert JOB_HANDLERS["edgar-detect"] == "app.jobs.detect"
    assert callable(detect.handle)
    assert handle({}) is not None
