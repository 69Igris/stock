"""The OpenFIGI client — MONEY-979 T7.

Three properties, and the first is the one that keeps us inside somebody else's
rate limit AND out of SEC's:

1. THE PACER NEVER EXCEEDS ITS RATE. Asserted against a VIRTUAL clock over a
   sliding window, not by measuring wall time — a rate limiter tested with a
   stopwatch on a loaded CI box tests the box.
2. ``api.openfigi.com`` IS NOT ``sec.gov``. This client must never touch the
   shared SEC limiter: that budget protects a per-IP fair-access policy, and
   spending it on Bloomberg would throttle the SEC pipeline to pay for
   something SEC does not care about.
3. A MISS IS NOT AN ERROR. OpenFIGI answers an unmappable CUSIP with
   ``{"warning": ...}`` or an empty ``data`` array. Raising would abort a batch
   of 100 because one delisted CUSIP was in it.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
import pytest

from app.openfigi import API_KEY_HEADER, MAPPING_URL, OpenFigiClient, RatePacer
from app.parsers import cusip_map_logic as logic

APPLE = "037833100"
BERKSHIRE_B = "084670702"


class VirtualClock:
    """A clock that only moves when something sleeps on it."""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# ── the pacer ───────────────────────────────────────────────────────────────


def assert_window_never_exceeds(
    starts: list[float], requests_allowed: int, per_seconds: float
) -> None:
    """The property, stated over EVERY window rather than over the total."""
    for index, start in enumerate(starts):
        in_window = [other for other in starts[: index + 1] if start - other < per_seconds]
        assert len(in_window) <= requests_allowed, (
            f"{len(in_window)} requests inside one {per_seconds}s window at t={start}"
        )
    assert starts == sorted(starts)


@pytest.mark.parametrize("requests_allowed, per_seconds", [(25, 6.0), (25, 60.0), (3, 1.0)])
def test_no_window_of_the_period_ever_holds_more_than_the_allowance(
    requests_allowed: int, per_seconds: float
) -> None:
    clock = VirtualClock()
    pacer = RatePacer(requests_allowed, per_seconds, clock=clock.time, sleep=clock.sleep)
    assert_window_never_exceeds(
        [pacer.acquire() for _ in range(requests_allowed * 4)], requests_allowed, per_seconds
    )


def test_the_window_slides_rather_than_resetting_in_bulk() -> None:
    """A FIXED window survives the burst test above and still doubles the rate.

    That test starts every request at t=0, so a limiter that CLEARS its window
    when the oldest entry expires behaves identically to one that pops a single
    entry — the whole window expires at once. The difference only appears when
    arrivals are SPREAD, which is what real request latency does.

    Here: one request at t=0, then 24 at t=5.5 after a slow first call. Sliding,
    the 26th waits for t=0 to expire, retires ONLY that one, and the 24 at
    t=5.5 keep holding the window shut. Clearing, all 25 are retired at once and
    25 more fire immediately — 49 requests inside half a second.
    """
    clock = VirtualClock()
    pacer = RatePacer(25, 6.0, clock=clock.time, sleep=clock.sleep)

    starts = [pacer.acquire()]
    clock.now = 5.5  # the first request took 5.5 s to come back
    starts += [pacer.acquire() for _ in range(24)]
    starts += [pacer.acquire() for _ in range(25)]

    assert_window_never_exceeds(starts, 25, 6.0)


def test_the_pacer_does_not_sleep_while_the_window_has_room() -> None:
    clock = VirtualClock()
    pacer = RatePacer(25, 6.0, clock=clock.time, sleep=clock.sleep)
    for _ in range(25):
        pacer.acquire()
    assert clock.sleeps == []
    # The 26th has to wait out the oldest.
    pacer.acquire()
    assert clock.sleeps == [6.0]


def test_a_nonsensical_rate_raises_instead_of_running_unlimited() -> None:
    with pytest.raises(ValueError, match="nonsensical rate"):
        RatePacer(0, 6.0)
    with pytest.raises(ValueError, match="nonsensical rate"):
        RatePacer(25, 0)


# ── keyed versus keyless ────────────────────────────────────────────────────


def test_a_key_buys_a_bigger_batch_and_a_faster_pace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keyed: 25 requests / 6 s, 100 jobs each. Keyless: 25 / 60 s, 10 jobs.

    Sending 100 jobs unkeyed is a 400 for the WHOLE batch, so the size is
    derived from whether a key exists rather than fixed.
    """
    monkeypatch.setenv("OPENFIGI_API_KEY", "secret-key")
    keyed = OpenFigiClient()
    assert keyed.has_key is True
    assert keyed.batch_jobs == 100
    assert (keyed.pacer.requests, keyed.pacer.per_seconds) == (25, 6.0)

    monkeypatch.delenv("OPENFIGI_API_KEY", raising=False)
    keyless = OpenFigiClient()
    assert keyless.has_key is False
    assert keyless.batch_jobs == 10
    assert (keyless.pacer.requests, keyless.pacer.per_seconds) == (25, 60.0)


def test_the_key_is_read_per_construction_not_at_import(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A module-scope read freezes before any test or deploy-time secret
    injection can change it — the same freeze that bit ``bse-client.ts``."""
    monkeypatch.delenv("OPENFIGI_API_KEY", raising=False)
    assert OpenFigiClient().has_key is False
    monkeypatch.setenv("OPENFIGI_API_KEY", "late-arrival")
    assert OpenFigiClient().has_key is True


def test_the_key_header_is_present_only_when_there_is_a_key() -> None:
    assert API_KEY_HEADER not in OpenFigiClient(api_key=None).headers()
    assert OpenFigiClient(api_key="k").headers()[API_KEY_HEADER] == "k"
    assert OpenFigiClient(api_key="k").headers()["Content-Type"] == "application/json"


# ── requests ────────────────────────────────────────────────────────────────


def test_the_request_body_is_ID_CUSIP_scoped_to_US() -> None:
    assert logic.build_jobs([APPLE, BERKSHIRE_B]) == [
        {"idType": "ID_CUSIP", "idValue": APPLE, "exchCode": "US"},
        {"idType": "ID_CUSIP", "idValue": BERKSHIRE_B, "exchCode": "US"},
    ]


def test_it_posts_to_openfigi_and_never_to_sec_gov() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=[{"data": [{"ticker": "AAPL", "compositeFIGI": "BBG1"}]}])

    client = OpenFigiClient(api_key="k", http_client=mock_client(handler))
    client.map_cusips([APPLE])

    assert str(seen[0].url) == MAPPING_URL
    assert seen[0].url.host == "api.openfigi.com"
    assert "sec.gov" not in str(seen[0].url)
    assert seen[0].headers[API_KEY_HEADER] == "k"


def test_it_does_not_consume_the_shared_sec_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """A SEPARATE HOST NEEDS A SEPARATE PACER. Borrowing the SEC limiter would
    either throttle us to SEC's pace on Bloomberg or, far worse, spend SEC's
    per-IP allowance on it."""
    from app.sec import limiter as sec_limiter

    calls: list[int] = []
    monkeypatch.setattr(sec_limiter, "try_acquire", lambda *a, **k: calls.append(1))

    client = OpenFigiClient(
        api_key="k",
        http_client=mock_client(lambda request: httpx.Response(200, json=[{"data": []}])),
    )
    client.map_cusips([APPLE, BERKSHIRE_B])
    assert calls == []


def test_batches_are_split_at_the_job_limit() -> None:
    batches: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        jobs = json.loads(request.content)
        batches.append(len(jobs))
        return httpx.Response(200, json=[{"data": []} for _ in jobs])

    clock = VirtualClock()
    client = OpenFigiClient(
        api_key="k", http_client=mock_client(handler), clock=clock.time, sleep=clock.sleep
    )
    client.map_cusips([f"{index:09d}" for index in range(250)])
    assert batches == [100, 100, 50]
    assert client.requests_made == 3


# ── responses ───────────────────────────────────────────────────────────────


def test_a_ticker_is_normalised_from_openfigi_s_slash_spelling() -> None:
    """VERIFIED against prod: OpenFIGI returns ``BRK/B`` and compositeFIGI
    ``BBG000DWG505`` while ``us_instruments`` holds ``BRK-B``."""
    match = logic.interpret_mapping(
        {
            "data": [
                {
                    "ticker": "BRK/B",
                    "compositeFIGI": "BBG000DWG505",
                    "name": "BERKSHIRE HATHAWAY INC-CL B",
                    "securityType": "Common Stock",
                }
            ]
        }
    )
    assert match == {
        "symbol": "BRK-B",
        "compositeFigi": "BBG000DWG505",
        "issuerName": "BERKSHIRE HATHAWAY INC-CL B",
        "securityType": "Common Stock",
    }


@pytest.mark.parametrize(
    "raw",
    [
        {"warning": "No identifier found."},
        {"data": []},
        {},
        None,
        {"data": "not a list"},
        {"data": [{}]},
    ],
)
def test_a_miss_is_a_miss_and_not_an_exception(raw: dict[str, Any] | None) -> None:
    """ "This identifier is not in the FIGI universe" is a FACT, not a failure."""
    assert logic.interpret_mapping(raw) is None


def test_a_miss_inside_a_batch_does_not_lose_the_hits() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {"warning": "No identifier found."},
                {"data": [{"ticker": "AAPL", "compositeFIGI": "BBG000B9XRY4"}]},
            ],
        )

    client = OpenFigiClient(api_key="k", http_client=mock_client(handler))
    result = client.map_cusips([BERKSHIRE_B, APPLE])
    assert set(result) == {APPLE}
    assert result[APPLE]["symbol"] == "AAPL"
    assert client.transport_failures == 0


def test_a_response_shorter_than_the_batch_does_not_shift_every_answer() -> None:
    """``zip(strict=False)`` pairs by POSITION, so a truncated array must drop
    the tail rather than slide the wrong ticker onto the wrong CUSIP."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"data": [{"ticker": "AAPL", "compositeFIGI": "B"}]}])

    client = OpenFigiClient(api_key="k", http_client=mock_client(handler))
    result = client.map_cusips([APPLE, BERKSHIRE_B])
    assert set(result) == {APPLE}


def test_a_non_200_is_a_transport_failure_and_the_key_never_reaches_the_log(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """``httpx`` puts the Request on its exceptions and a rendered request
    carries ``X-OPENFIGI-APIKEY``. Nothing here logs a request, a response or an
    exception object."""
    clock = VirtualClock()
    client = OpenFigiClient(
        api_key="super-secret-key",
        http_client=mock_client(lambda request: httpx.Response(500, text="upstream on fire")),
        clock=clock.time,
        sleep=clock.sleep,
    )
    with caplog.at_level(logging.ERROR):
        assert client.map_cusips([APPLE]) == {}
    assert client.transport_failures == 1
    assert "super-secret-key" not in caplog.text
    assert "500" in caplog.text


def test_a_429_is_retried_and_then_given_up_on() -> None:
    """Undocumented but real. The pacer should make it unreachable; reaching it
    means the ceiling moved, so back off and say so rather than hammering."""
    attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(429, text="slow down")

    clock = VirtualClock()
    client = OpenFigiClient(
        api_key="k", http_client=mock_client(handler), clock=clock.time, sleep=clock.sleep
    )
    assert client.map_cusips([APPLE]) == {}
    assert len(attempts) == 3
    assert client.transport_failures == 1


def test_a_transport_error_is_retried_before_it_is_counted() -> None:
    """Counted AFTER the call it counts, and only once the retry ladder is
    exhausted: a retried blip is not a failure, and a counter bumped early
    reports a full number for a source that answered nothing."""
    attempts: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        raise httpx.ConnectError("no route to host")

    clock = VirtualClock()
    client = OpenFigiClient(
        api_key="k", http_client=mock_client(handler), clock=clock.time, sleep=clock.sleep
    )
    assert client.map_cusips([APPLE]) == {}
    assert len(attempts) == 3
    assert client.transport_failures == 1
    assert client.requests_made == 0


def test_a_body_that_is_not_json_is_a_transport_failure_not_a_crash() -> None:
    client = OpenFigiClient(
        api_key="k",
        http_client=mock_client(lambda request: httpx.Response(200, text="<html>maintenance")),
    )
    assert client.map_cusips([APPLE]) == {}
    assert client.transport_failures == 1


def test_requests_made_counts_only_delivered_requests() -> None:
    """A run that resolved nothing because OpenFIGI was down must be
    distinguishable from one where every CUSIP was genuinely unmapped."""
    client = OpenFigiClient(
        api_key="k",
        http_client=mock_client(lambda request: httpx.Response(200, json=[{"data": []}])),
    )
    client.map_cusips([APPLE])
    assert client.requests_made == 1
    assert client.transport_failures == 0


# ── batching helpers ────────────────────────────────────────────────────────


def test_chunk_is_exact_and_refuses_a_zero_size() -> None:
    assert list(logic.chunk(["a", "b", "c"], 2)) == [["a", "b"], ["c"]]
    assert list(logic.chunk([], 5)) == []
    with pytest.raises(ValueError, match="must be positive"):
        list(logic.chunk(["a"], 0))
