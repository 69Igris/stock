"""Pub/Sub dedupe — the full decision table, the CAS steal, and the middleware.

Seven decision rows, both duplicate-key shapes, a lost steal race, a dead store,
and the two HTTP codes. Every one drives the REAL implementation; the fake
collection in ``conftest.py`` implements a genuine unique index rather than
mocking the outcome.
"""

from __future__ import annotations

import os

import pytest

from app.dedupe import DedupeStore, create_dedupe_middleware
from app.dedupe_logic import (
    DEDUPE_COLLECTION,
    DEDUPE_RETENTION_MS,
    DEDUPE_TTL_INDEX,
    DEDUPE_UNIQUE_INDEX,
    DEFAULT_LEASE_MS,
    DedupeMarker,
    build_claim_document,
    build_steal_filter,
    decide_on_existing_marker,
    decide_on_store_error,
    dedupe_index_specs,
    extract_delivery_id,
    http_response_for,
    insert_succeeded,
    is_duplicate_key_error,
    parse_marker_date,
    parse_marker_status,
    resolve_lease_ms,
    route_key,
    should_release_completed,
    to_marker,
)

NOW = 1_700_000_000_000


def marker(status: str = "IN_FLIGHT", lease: int | None = NOW + 60_000, attempts: int = 1):
    return DedupeMarker("m1", "/jobs/edgar-detect", status, attempts, lease)  # type: ignore[arg-type]


# ── The seven decision rows ─────────────────────────────────────────────────


def test_row1_marker_vanished_runs_untracked() -> None:
    """A TTL reap between the failed insert and the read is NOT evidence the job ran."""
    decision = decide_on_existing_marker(None, NOW)
    assert decision.action == "RUN_UNTRACKED"
    assert decision.reason == "marker_vanished_after_conflict"


def test_row2_completed_skips() -> None:
    decision = decide_on_existing_marker(marker("COMPLETED", None, attempts=3), NOW)
    assert decision.action == "SKIP_COMPLETED"
    assert decision.reason == "already_completed"
    assert decision.attempts == 3


def test_row3_failed_reruns() -> None:
    """FAILED must NOT be a skip: Pub/Sub is entitled to retry it."""
    decision = decide_on_existing_marker(marker("FAILED", None, attempts=2), NOW)
    assert decision.action == "RUN"
    assert decision.reason == "reclaim_after_failure"


def test_row4_in_flight_with_a_null_lease_runs() -> None:
    """A corrupt/legacy row must not become an eternal lock.

    An eternal lock is the one state from which nothing recovers without manual
    DB surgery, so a null lease reads as EXPIRED, never as live.
    """
    decision = decide_on_existing_marker(marker("IN_FLIGHT", None), NOW)
    assert decision.action == "RUN"
    assert decision.reason == "lease_missing"


def test_row5_expired_lease_runs() -> None:
    decision = decide_on_existing_marker(marker("IN_FLIGHT", NOW - 1), NOW)
    assert decision.action == "RUN"
    assert decision.reason == "lease_expired"


def test_row5b_a_lease_expiring_exactly_now_is_expired() -> None:
    """`lease <= now` — the boundary is inclusive.

    Exclusive would make an exactly-expired marker permanently RETRY_LATER for
    one clock tick on every redelivery, which is the un-retryable state row 4
    exists to prevent, just narrower.
    """
    assert decide_on_existing_marker(marker("IN_FLIGHT", NOW), NOW).action == "RUN"


def test_row6_live_lease_retries_later() -> None:
    decision = decide_on_existing_marker(marker("IN_FLIGHT", NOW + 1), NOW)
    assert decision.action == "RETRY_LATER"
    assert decision.reason == "in_flight_elsewhere"


def test_row7_store_error_fails_open() -> None:
    """Fail OPEN, always.

    Failing closed converts a dedupe-store outage into a TOTAL job outage. The
    blast radius of the wrong choice is wildly asymmetric.
    """
    decision = decide_on_store_error()
    assert decision.action == "RUN_UNTRACKED"
    assert decision.reason == "dedupe_store_unavailable"


def test_an_unknown_status_is_treated_as_in_flight_not_completed() -> None:
    """Defaulting to COMPLETED would SKIP work that never ran."""
    assert parse_marker_status(None) == "IN_FLIGHT"
    assert parse_marker_status("WEIRD") == "IN_FLIGHT"
    assert parse_marker_status("COMPLETED") == "COMPLETED"


# ── Duplicate-key detection, BOTH forms ─────────────────────────────────────


def test_duplicate_key_detected_when_RAISED() -> None:
    from pymongo.errors import DuplicateKeyError

    assert is_duplicate_key_error(DuplicateKeyError("E11000 duplicate key")) is True


def test_duplicate_key_detected_in_the_ok1_writeErrors_response() -> None:
    """Mongo's `insert` command does NOT fail the command on a duplicate key.

    It reports it per-document inside an `ok: 1` envelope. Checking only the
    raise path would classify every duplicate as a successful claim — a dedupe
    that never dedupes.
    """
    response = {"ok": 1, "n": 0, "writeErrors": [{"code": 11000, "errmsg": "E11000 dup key"}]}
    assert is_duplicate_key_error(response) is True
    assert insert_succeeded(response) is False


def test_duplicate_key_detected_inside_a_raised_BulkWriteError_details() -> None:
    from pymongo.errors import BulkWriteError

    err = BulkWriteError({"ok": 1, "n": 0, "writeErrors": [{"code": 11000, "errmsg": "E11000"}]})
    assert is_duplicate_key_error(err) is True


def test_a_successful_insert_response_is_not_a_duplicate() -> None:
    assert insert_succeeded({"n": 1, "ok": 1}) is True
    assert is_duplicate_key_error({"n": 1, "ok": 1}) is False


def test_an_unmodelled_response_is_neither_written_nor_conflicted() -> None:
    """Routes to the fail-open path rather than to a FALSE claim."""
    assert insert_succeeded({"ok": 0}) is False
    assert is_duplicate_key_error({"ok": 0}) is False


# ── Marker parsing ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, None),
        (1_700_000_000_000, 1_700_000_000_000),
        ({"$date": {"$numberLong": "1700000000000"}}, 1_700_000_000_000),
        ({"$date": "2023-11-14T22:13:20+00:00"}, 1_700_000_000_000),
        ("2023-11-14T22:13:20+00:00", 1_700_000_000_000),
        ("not a date", None),
        (float("nan"), None),
        (float("inf"), None),
    ],
)
def test_lease_dates_survive_every_extended_json_shape(raw: object, expected: int | None) -> None:
    """A lease that parses to nothing must read as ABSENT, not as live.

    An unparseable value compared numerically against `now` yields False for
    `<=`, so the lease would read as permanently LIVE and every redelivery would
    nack forever. `parse_marker_date` returns None instead, and None is row 4.
    """
    assert parse_marker_date(raw) == expected


def test_to_marker_rejects_a_document_with_no_messageId() -> None:
    assert to_marker({"status": "COMPLETED"}) is None
    assert to_marker(None) is None


def test_route_key_strips_the_query_and_caps_the_length() -> None:
    assert route_key("/jobs/edgar-detect?x=1") == "/jobs/edgar-detect"
    assert len(route_key("/jobs/" + "a" * 500)) == 120


# ── Lease resolution ────────────────────────────────────────────────────────


@pytest.mark.parametrize("raw", [None, "", "   ", "abc", "0", "-5", "NaN", "Infinity", "1.5"])
def test_a_non_finite_lease_override_falls_back_to_the_default(raw: str | None) -> None:
    """A ZERO lease is expired the instant it is written.

    Every concurrent redelivery would then steal the claim and the dedupe would
    silently stop deduping — the failure with no symptom.
    """
    assert resolve_lease_ms(raw) == DEFAULT_LEASE_MS


def test_a_valid_lease_override_is_honoured() -> None:
    assert resolve_lease_ms("900000") == 900_000


def test_the_default_lease_exceeds_the_600s_ack_deadline() -> None:
    """Lower bound, stated as a test.

    A lease shorter than the ack deadline would let a legitimate redelivery of a
    STILL-RUNNING job find an expired lease and steal it — double-running the
    exact case this protects.
    """
    assert DEFAULT_LEASE_MS > 600 * 1000


def test_retention_exceeds_pubsub_message_retention() -> None:
    """A marker reaped while the message can still be redelivered would let that
    redelivery re-run the job. Pub/Sub retention is 7d; this is 14d."""
    assert DEDUPE_RETENTION_MS >= 2 * 7 * 24 * 60 * 60 * 1000


# ── Indexes + document shape ────────────────────────────────────────────────


def test_the_two_indexes_are_named_and_shaped_as_the_workers_create_them() -> None:
    """Same collection, same index NAMES, shared with the TypeScript workers."""
    specs = dedupe_index_specs()
    assert DEDUPE_COLLECTION == "pubsub_message_dedupe"
    unique = next(s for s in specs if s["name"] == DEDUPE_UNIQUE_INDEX)
    assert unique["key"] == {"messageId": 1} and unique["unique"] is True
    ttl = next(s for s in specs if s["name"] == DEDUPE_TTL_INDEX)
    assert ttl["key"] == {"expiresAt": 1} and ttl["expireAfterSeconds"] == 0


def test_the_claim_document_stores_the_lease_as_epoch_ms_not_a_date() -> None:
    """The lease is compared NUMERICALLY on every delivery.

    Storing it as a BSON date would make the comparison depend on how a driver
    round-trips a date. `expiresAt` stays a real datetime because Mongo's TTL
    monitor requires one.
    """
    doc = build_claim_document("m1", "/jobs/x", NOW, DEFAULT_LEASE_MS)
    assert doc["leaseExpiresAt"] == NOW + DEFAULT_LEASE_MS
    assert isinstance(doc["leaseExpiresAt"], int)
    assert not isinstance(doc["expiresAt"], int)
    assert doc["status"] == "IN_FLIGHT" and doc["attempts"] == 1


def test_the_steal_filter_carries_the_observed_status_AND_lease() -> None:
    """A genuine CAS, not a blind overwrite.

    Without `leaseExpiresAt` in the filter, two instances racing to steal the
    same abandoned marker would BOTH match and both run.
    """
    observed = marker("IN_FLIGHT", NOW - 1)
    f = build_steal_filter("m1", observed)
    assert f == {"messageId": "m1", "status": "IN_FLIGHT", "leaseExpiresAt": NOW - 1}


# ── HTTP mapping ────────────────────────────────────────────────────────────


def test_skip_completed_is_200_duplicate_true() -> None:
    body, status = http_response_for(decide_on_existing_marker(marker("COMPLETED", None), NOW))
    assert status == 200
    assert body == {"success": True, "duplicate": True}


def test_retry_later_is_409_not_200() -> None:
    """409, NOT 200.

    The first delivery is still running and may yet fail. Acking here would
    leave the job silently undone with Pub/Sub believing it was handled.
    """
    body, status = http_response_for(decide_on_existing_marker(marker("IN_FLIGHT", NOW + 1), NOW))
    assert status == 409
    assert body["duplicate"] is True


def test_run_and_run_untracked_have_no_short_circuit() -> None:
    assert http_response_for(decide_on_existing_marker(marker("FAILED", None), NOW)) is None
    assert http_response_for(decide_on_store_error()) is None


@pytest.mark.parametrize(
    ("status", "completed"),
    [(200, True), (204, True), (299, True), (300, False), (409, False), (500, False)],
)
def test_only_a_2xx_releases_completed(status: int, completed: bool) -> None:
    """A route that returns 500 must stay RETRYABLE."""
    assert should_release_completed(status) is completed


# ── extract_delivery_id ─────────────────────────────────────────────────────


def test_no_messageId_means_no_claim() -> None:
    assert extract_delivery_id({"mode": "efts"}) is None
    assert extract_delivery_id({"message": {"data": "e30="}}) is None
    assert extract_delivery_id({"message": {"messageId": "   "}}) is None
    assert extract_delivery_id({"message": {"messageId": "abc"}}) == "abc"


# ── The STORE, driven against a real unique index ───────────────────────────


def test_the_first_claim_wins_and_the_second_gets_retry_later(dedupe_collection) -> None:
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)

    first = store.claim("m1", "/jobs/edgar-detect")
    second = store.claim("m1", "/jobs/edgar-detect")

    assert first.action == "RUN"
    assert second.action == "RETRY_LATER"
    assert second.reason == "in_flight_elsewhere"


def test_the_duplicate_reaches_us_as_a_writeErrors_bulk_error_too(dedupe_collection) -> None:
    dedupe_collection.duplicate_as_write_error = True
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)

    assert store.claim("m1", "/jobs/x").action == "RUN"
    assert store.claim("m1", "/jobs/x").action == "RETRY_LATER"


def test_an_expired_lease_is_stolen_by_exactly_one_claimer(dedupe_collection) -> None:
    clock = {"t": NOW}
    store = DedupeStore(dedupe_collection, now=lambda: clock["t"], lease=lambda: 1000)

    assert store.claim("m1", "/jobs/x").action == "RUN"
    clock["t"] = NOW + 5000  # lease long gone

    stolen = store.claim("m1", "/jobs/x")
    assert stolen.action == "RUN"
    assert stolen.reason == "lease_expired"
    assert dedupe_collection.docs["m1"]["attempts"] == 2


def test_the_steal_LOSES_a_race_and_answers_retry_later(dedupe_collection, monkeypatch) -> None:
    """Two stealers, one document.

    The CAS filter carries the OBSERVED lease, so the second `find_one_and_update`
    matches nothing. The loser must NOT run — it must nack.
    """
    clock = {"t": NOW}
    store = DedupeStore(dedupe_collection, now=lambda: clock["t"], lease=lambda: 1000)
    store.claim("m1", "/jobs/x")
    clock["t"] = NOW + 5000

    real_cas = dedupe_collection.find_one_and_update

    def racing_cas(filter_, update, **kwargs):
        # Simulate the rival stealer landing between our read and our CAS.
        dedupe_collection.docs["m1"]["leaseExpiresAt"] = clock["t"] + 60_000
        dedupe_collection.docs["m1"]["attempts"] = 99
        return real_cas(filter_, update, **kwargs)

    monkeypatch.setattr(dedupe_collection, "find_one_and_update", racing_cas)

    decision = store.claim("m1", "/jobs/x")
    assert decision.action == "RETRY_LATER"
    assert decision.reason == "steal_lost_race"
    assert dedupe_collection.docs["m1"]["attempts"] == 99, "the rival's claim must survive"


def test_a_completed_marker_is_skipped_not_stolen(dedupe_collection) -> None:
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    store.claim("m1", "/jobs/x")
    store.release("m1", "COMPLETED")

    decision = store.claim("m1", "/jobs/x")
    assert decision.action == "SKIP_COMPLETED"


def test_a_failed_marker_is_reclaimed(dedupe_collection) -> None:
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    store.claim("m1", "/jobs/x")
    store.release("m1", "FAILED")

    decision = store.claim("m1", "/jobs/x")
    assert decision.action == "RUN"
    assert decision.reason == "reclaim_after_failure"


def test_release_clears_the_lease_on_both_outcomes(dedupe_collection) -> None:
    """FAILED clears the lease so the next delivery is IMMEDIATELY retryable
    rather than blocked for the remainder of a lease it no longer holds."""
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    store.claim("m1", "/jobs/x")
    store.release("m1", "FAILED")
    assert dedupe_collection.docs["m1"]["leaseExpiresAt"] is None


def test_an_unreachable_store_runs_untracked_and_never_raises(dedupe_collection) -> None:
    dedupe_collection.raise_on = {"insert_one"}
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)

    decision = store.claim("m1", "/jobs/x")
    assert decision.action == "RUN_UNTRACKED"
    assert decision.reason == "dedupe_store_unavailable"


def test_a_release_failure_never_raises(dedupe_collection) -> None:
    """A release failure must not turn a SUCCESSFUL job into a 500."""
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    store.claim("m1", "/jobs/x")
    dedupe_collection.raise_on = {"update_one"}
    store.release("m1", "COMPLETED")  # must not raise


def test_the_lease_override_is_read_per_call_not_at_import(dedupe_collection) -> None:
    """A module-scope read would freeze at import and this would silently pass
    with the default."""
    os.environ["PUBSUB_DEDUPE_LEASE_MS"] = "5000"
    store = DedupeStore(dedupe_collection, now=lambda: NOW)
    store.claim("m1", "/jobs/x")
    assert dedupe_collection.docs["m1"]["leaseExpiresAt"] == NOW + 5000


# ── The MIDDLEWARE (the call site) ──────────────────────────────────────────


class _Handler:
    def __init__(self, status: int = 200, raises: bool = False) -> None:
        self.status = status
        self.raises = raises
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        if self.raises:
            raise RuntimeError("handler blew up")
        return {"ok": True}, self.status


ENVELOPE = {"message": {"data": "e30=", "messageId": "msg-1"}}


async def test_middleware_runs_the_handler_once_and_releases_completed(dedupe_collection) -> None:
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    middleware = create_dedupe_middleware(lambda: store)
    handler = _Handler()

    body, status = await middleware("/jobs/edgar-detect", ENVELOPE, handler)

    assert (body, status) == ({"ok": True}, 200)
    assert handler.calls == 1
    assert dedupe_collection.docs["msg-1"]["status"] == "COMPLETED"


async def test_middleware_answers_200_duplicate_without_re_running(dedupe_collection) -> None:
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    middleware = create_dedupe_middleware(lambda: store)
    await middleware("/jobs/edgar-detect", ENVELOPE, _Handler())

    second = _Handler()
    body, status = await middleware("/jobs/edgar-detect", ENVELOPE, second)

    assert status == 200
    assert body == {"success": True, "duplicate": True}
    assert second.calls == 0, "a completed message must NOT re-run"


async def test_middleware_answers_409_while_a_claim_is_live(dedupe_collection) -> None:
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    middleware = create_dedupe_middleware(lambda: store)
    store.claim("msg-1", "/jobs/edgar-detect")  # someone else holds it

    handler = _Handler()
    _body, status = await middleware("/jobs/edgar-detect", ENVELOPE, handler)

    assert status == 409
    assert handler.calls == 0


async def test_middleware_releases_FAILED_on_a_non_2xx(dedupe_collection) -> None:
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    middleware = create_dedupe_middleware(lambda: store)

    await middleware("/jobs/edgar-detect", ENVELOPE, _Handler(status=500))

    assert dedupe_collection.docs["msg-1"]["status"] == "FAILED"


async def test_middleware_releases_FAILED_before_re_raising(dedupe_collection) -> None:
    """Or a raising handler leaves an IN_FLIGHT marker that blocks every
    redelivery until the lease expires — one transient error becomes an hour of
    409s."""
    store = DedupeStore(dedupe_collection, now=lambda: NOW, lease=lambda: DEFAULT_LEASE_MS)
    middleware = create_dedupe_middleware(lambda: store)

    with pytest.raises(RuntimeError):
        await middleware("/jobs/edgar-detect", ENVELOPE, _Handler(raises=True))

    assert dedupe_collection.docs["msg-1"]["status"] == "FAILED"


async def test_middleware_skips_the_claim_when_the_body_has_no_messageId(dedupe_collection) -> None:
    """Local dev / a manual curl. Deduping on a synthesised id would let two
    triggers in the same millisecond collide."""
    store = DedupeStore(dedupe_collection, now=lambda: NOW)
    middleware = create_dedupe_middleware(lambda: store)
    handler = _Handler()

    await middleware("/jobs/edgar-detect", {"mode": "efts"}, handler)

    assert handler.calls == 1
    assert dedupe_collection.docs == {}
    assert dedupe_collection.calls == [], "no store call at all for an id-less body"


async def test_middleware_runs_the_handler_when_no_store_is_available() -> None:
    middleware = create_dedupe_middleware(lambda: None)
    handler = _Handler()

    _body, status = await middleware("/jobs/edgar-detect", ENVELOPE, handler)

    assert handler.calls == 1
    assert status == 200
