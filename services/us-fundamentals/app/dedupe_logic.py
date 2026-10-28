"""Pub/Sub ``messageId`` idempotency — PURE decision logic.

Port of ``workers/src/lib/pubsub-dedupe-logic.ts``, deliberately field-for-field
so the two services share ONE collection and ONE marker shape.

Pub/Sub is at-least-once. Every ``/jobs/*`` processor can be handed the SAME
message twice: on an ack-deadline overrun (600 s, Pub/Sub's maximum), on a Cloud
Run instance restart mid-request, or on any 5xx. For an idempotent upsert that
is merely wasteful; for anything that appends it duplicates work.

## Why a unique-index INSERT and not a read-then-write

``find_one(messageId) -> if absent insert`` is not atomic. Two concurrent
deliveries both read "absent" and both run — exactly the failure the dedupe
exists to prevent, showing up only under the load that makes it hardest to
debug. MongoDB's UNIQUE INDEX is the atomic arbiter instead: both deliveries
attempt the same insert, the storage engine serialises them on the index,
exactly one wins and the other gets E11000. There is no window.

## Why the marker is LEASED rather than a plain "seen" flag

A bare "I have seen this messageId" marker makes a CRASHED job permanently
un-retryable: the marker says seen, the work never finished, and every
redelivery is skipped. So an ``IN_FLIGHT`` marker carries a LEASE. While the
lease holds, a second delivery is told to come back later (409, nack) — never
"skip". Once it expires the marker is stealable, so a crash costs one lease
period, not the job.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

#: Mongo collection holding the dedupe markers. SHARED with the TypeScript
#: workers — same database, same documents, same semantics.
DEDUPE_COLLECTION = "pubsub_message_dedupe"

#: Unique index that makes the claim atomic. The NAME is load-bearing: the shell
#: creates it by this name and treats "already exists" as success.
DEDUPE_UNIQUE_INDEX = "pubsubMessageId_unique"

#: TTL index name — markers are garbage, not history.
DEDUPE_TTL_INDEX = "pubsubMessageId_ttl"

#: How long a marker survives before Mongo's TTL monitor reaps it.
#:
#: Must comfortably exceed Pub/Sub's ``--message-retention-duration=7d`` (set in
#: ``workers/scripts/setup-pubsub.sh``): a marker reaped while the message can
#: still be redelivered would let that redelivery re-run the job. 14 d is 2x.
DEDUPE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

#: Default lease on an ``IN_FLIGHT`` marker.
#:
#: Lower bound: must exceed the subscription ack deadline (600 s), or a
#: legitimate redelivery of a still-running job would find an expired lease and
#: steal it — double-running the very case this protects. 1 h is 6x that.
#:
#: Upper bound: a crashed job is un-retryable for this long, so do not raise it
#: casually. Override per-deployment with ``PUBSUB_DEDUPE_LEASE_MS``.
DEFAULT_LEASE_MS = 60 * 60 * 1000

MarkerStatus = Literal["IN_FLIGHT", "COMPLETED", "FAILED"]

#: What the caller should do with this delivery.
#:
#: - ``RUN``            we hold the claim; execute the job.
#: - ``SKIP_COMPLETED`` already done; ACK (200) without re-running.
#: - ``RETRY_LATER``    someone else holds a live claim; NACK (409) so Pub/Sub
#:                      redelivers after the backoff instead of racing.
#: - ``RUN_UNTRACKED``  dedupe unavailable or not applicable; run WITHOUT a
#:                      claim. Deliberately fail-OPEN, see :func:`decide_on_store_error`.
ClaimAction = Literal["RUN", "SKIP_COMPLETED", "RETRY_LATER", "RUN_UNTRACKED"]


@dataclass(frozen=True)
class DedupeMarker:
    """The subset of a marker document the decision actually reads."""

    message_id: str
    route: str
    status: MarkerStatus
    attempts: int
    #: Epoch ms; ``None`` when the marker is terminal (COMPLETED / FAILED).
    lease_expires_at: int | None


@dataclass(frozen=True)
class ClaimDecision:
    action: ClaimAction
    #: Machine-readable reason, safe to log.
    reason: str
    #: Prior attempt count when known — surfaces "this is the 3rd try" in logs.
    attempts: int | None = None


def decide_on_existing_marker(marker: DedupeMarker | None, now_ms: int) -> ClaimDecision:
    """Decide what a delivery that LOST the insert race should do.

    ``marker`` is what the loser read back after E11000. ``None`` means the row
    vanished between the failed insert and the read — a TTL reap or a concurrent
    cleanup. That is not evidence the job ran, so we run it (at-least-once is
    the contract we are refining, not replacing).

    Every branch is chosen so that being WRONG costs a duplicate run rather than
    a dropped job. A dropped job is invisible; a duplicate run is loud.
    """
    if marker is None:
        return ClaimDecision("RUN_UNTRACKED", "marker_vanished_after_conflict")

    if marker.status == "COMPLETED":
        return ClaimDecision("SKIP_COMPLETED", "already_completed", marker.attempts)

    # FAILED: the previous attempt ran to a conclusion and lost. Pub/Sub is
    # entitled to retry it (that is what max-delivery-attempts=5 is for), so
    # this must NOT be a skip. The shell re-claims via a compare-and-swap on
    # status:FAILED so only one of N concurrent retries proceeds.
    if marker.status == "FAILED":
        return ClaimDecision("RUN", "reclaim_after_failure", marker.attempts)

    # IN_FLIGHT from here.
    #
    # A null lease on an IN_FLIGHT marker is a corrupt/legacy row. Treat it as
    # expired rather than as an eternal lock — an eternal lock is the one state
    # from which nothing recovers without manual DB surgery.
    lease = marker.lease_expires_at
    if lease is None:
        return ClaimDecision("RUN", "lease_missing", marker.attempts)
    if lease <= now_ms:
        return ClaimDecision("RUN", "lease_expired", marker.attempts)

    return ClaimDecision("RETRY_LATER", "in_flight_elsewhere", marker.attempts)


def decide_on_store_error() -> ClaimDecision:
    """What to do when the dedupe STORE itself is unreachable.

    Fail OPEN, always. Dedupe is an optimisation layered on a system that is
    already correct-but-wasteful under at-least-once delivery. Failing closed
    would convert a dedupe-store outage into a TOTAL job outage — every
    scheduled run silently 409ing while the data goes stale. The blast radius of
    the wrong choice is wildly asymmetric, so it is not a judgement call.
    """
    return ClaimDecision("RUN_UNTRACKED", "dedupe_store_unavailable")


def is_duplicate_key_error(value: Any) -> bool:
    """Identify a MongoDB duplicate-key failure.

    It reaches us TWO ways and both must be handled:

    * as a RAISED exception (pymongo's ``DuplicateKeyError`` / ``BulkWriteError``), and
    * as a ``writeErrors[]`` entry inside an ``ok: 1`` response — Mongo's
      ``insert`` command does NOT fail the command on a duplicate key, it reports
      it per-document. Checking only the raise path would silently classify every
      duplicate as a successful claim, i.e. a dedupe that never dedupes.
    """
    if value is None:
        return False
    if isinstance(value, str):
        return "E11000" in value

    if isinstance(value, BaseException):
        code = getattr(value, "code", None)
        if code in (11000, "11000"):
            return True
        details = getattr(value, "details", None)
        if isinstance(details, dict) and is_duplicate_key_error(details):
            return True
        return "E11000" in str(value)

    if isinstance(value, dict):
        if value.get("code") in (11000, "11000"):
            return True
        message = value.get("message") or value.get("errmsg")
        if isinstance(message, str) and "E11000" in message:
            return True
        write_errors = value.get("writeErrors")
        if isinstance(write_errors, list) and any(is_duplicate_key_error(e) for e in write_errors):
            return True
        for key in ("meta", "cause", "error", "details"):
            nested = value.get(key)
            if isinstance(nested, dict) and is_duplicate_key_error(nested):
                return True

    return False


def insert_succeeded(response: Any) -> bool:
    """True when a raw ``insert`` response reports the document as written.

    ``{"n": 1, "ok": 1}`` is a claim. ``{"n": 0, "writeErrors": [{"code": 11000}]}``
    is a conflict. Anything else (``n`` absent, ``ok: 0``) is treated as NOT
    written, which routes to the fail-open path rather than to a false claim.
    """
    if not isinstance(response, dict):
        return False
    write_errors = response.get("writeErrors")
    if isinstance(write_errors, list) and write_errors:
        return False
    return response.get("n") == 1


def extract_delivery_id(body: Any) -> str | None:
    """Extract the Pub/Sub delivery identity from a push body.

    Returns ``None`` for anything that is not a real push envelope with a
    non-empty ``messageId``. That is deliberate and it is NOT the same as
    :func:`app.envelope.get_message_id`'s job — deduping on a synthetic
    clock-derived id would be actively harmful: two manual triggers inside the
    same millisecond would collide and the second would be silently skipped as a
    "duplicate" of an unrelated job.

    No id -> no claim -> the job runs exactly as it would without this module.
    """
    if not isinstance(body, dict):
        return None
    message = body.get("message")
    if not isinstance(message, dict):
        return None
    raw = message.get("messageId")
    if not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    return trimmed or None


def parse_marker_date(value: Any) -> int | None:
    """Read a date out of a raw Mongo document, tolerantly. Returns epoch ms.

    A raw command response returns MongoDB Extended JSON, so a BSON Date comes
    back as ``{"$date": "2026-08-16T..."}`` or ``{"$date": {"$numberLong": "1755..."}}``
    depending on driver mode — not always a ``datetime``. A naive parse on those
    yields nothing usable, and any ``NaN <= now`` comparison is False — so a
    lease would read as permanently live and every redelivery would nack
    forever. Hence an explicit tolerant reader.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return int(value) if value == value and value not in (float("inf"), float("-inf")) else None
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return int(parsed.timestamp() * 1000)
    if isinstance(value, dict):
        inner = value.get("$date")
        if inner is None:
            return None
        if isinstance(inner, dict):
            long_value = inner.get("$numberLong")
            if isinstance(long_value, str):
                try:
                    return int(long_value)
                except ValueError:
                    return None
            return None
        return parse_marker_date(inner)
    return None


def parse_marker_status(value: Any) -> MarkerStatus:
    """Coerce a raw Mongo status field to a known status.

    Unknown/absent is treated as ``IN_FLIGHT`` so the LEASE decides, rather than
    defaulting to ``COMPLETED`` (which would skip work that never ran).
    """
    if value in ("COMPLETED", "FAILED", "IN_FLIGHT"):
        return value  # type: ignore[return-value]
    return "IN_FLIGHT"


def to_marker(doc: Any) -> DedupeMarker | None:
    """Build a typed marker from a raw document."""
    if not isinstance(doc, dict):
        return None
    message_id = doc.get("messageId")
    if not isinstance(message_id, str):
        return None
    attempts = doc.get("attempts")
    return DedupeMarker(
        message_id=message_id,
        route=doc.get("route") if isinstance(doc.get("route"), str) else "unknown",
        status=parse_marker_status(doc.get("status")),
        attempts=attempts if isinstance(attempts, int) and not isinstance(attempts, bool) else 0,
        lease_expires_at=parse_marker_date(doc.get("leaseExpiresAt")),
    )


def route_key(path: str) -> str:
    """The route key stored on the marker.

    Purely descriptive — the UNIQUE key is ``messageId`` ALONE, never
    ``(messageId, route)``. A Pub/Sub messageId is unique per topic and each
    topic has exactly one push endpoint here, so route adds nothing to identity;
    making it part of the key would only create a way for the same message to be
    claimed twice if a path ever changed.
    """
    trimmed = path.split("?")[0] or path
    return trimmed[:120]


def resolve_lease_ms(raw: str | None) -> int:
    """``PUBSUB_DEDUPE_LEASE_MS`` -> ms, falling back on anything non-finite.

    A non-numeric or non-positive override must not become a ZERO lease: a zero
    lease is expired the instant it is written, so every concurrent redelivery
    would steal the claim and the dedupe would silently stop deduping — the
    failure with no symptom. Absent, empty, ``"abc"``, ``"0"``, ``"-5"``,
    ``"NaN"`` and ``"Infinity"`` all resolve to :data:`DEFAULT_LEASE_MS`.
    """
    if raw is None:
        return DEFAULT_LEASE_MS
    try:
        value = int(str(raw).strip())
    except ValueError:
        return DEFAULT_LEASE_MS
    return value if value > 0 else DEFAULT_LEASE_MS


def dedupe_index_specs() -> list[dict[str, Any]]:
    """The two indexes, as the shell creates them. Exported so a test can pin them."""
    return [
        {"key": {"messageId": 1}, "name": DEDUPE_UNIQUE_INDEX, "unique": True},
        {"key": {"expiresAt": 1}, "name": DEDUPE_TTL_INDEX, "expireAfterSeconds": 0},
    ]


def build_claim_document(message_id: str, route: str, now_ms: int, lease_ms: int) -> dict[str, Any]:
    """The document a winning claim writes.

    ``leaseExpiresAt`` is EPOCH MS, not a BSON date. The lease is compared
    numerically on every delivery and must not depend on how a driver
    round-trips a date. ``expiresAt`` stays a real datetime because Mongo's TTL
    monitor requires one.
    """
    return {
        "messageId": message_id,
        "route": route,
        "status": "IN_FLIGHT",
        "attempts": 1,
        "leaseExpiresAt": now_ms + lease_ms,
        "claimedAt": datetime.fromtimestamp(now_ms / 1000, tz=UTC),
        "expiresAt": datetime.fromtimestamp((now_ms + DEDUPE_RETENTION_MS) / 1000, tz=UTC),
    }


def build_steal_filter(message_id: str, marker: DedupeMarker) -> dict[str, Any]:
    """Filter for the compare-and-swap that steals an abandoned marker.

    Carries the OBSERVED ``status`` AND ``leaseExpiresAt``, so this is a genuine
    CAS rather than a blind overwrite: two instances racing to steal the same
    marker both submit it, MongoDB applies them one at a time to a single
    document, and the SECOND matches nothing.

    ``None`` matches both an absent and a literally-null field — the corrupt
    marker case :func:`decide_on_existing_marker` treats as expired.
    """
    return {
        "messageId": message_id,
        "status": marker.status,
        "leaseExpiresAt": marker.lease_expires_at,
    }


def build_steal_update(
    route: str, marker: DedupeMarker, now_ms: int, lease_ms: int
) -> dict[str, Any]:
    return {
        "$set": {
            "status": "IN_FLIGHT",
            "route": route,
            "attempts": marker.attempts + 1,
            "leaseExpiresAt": now_ms + lease_ms,
            "claimedAt": datetime.fromtimestamp(now_ms / 1000, tz=UTC),
            "expiresAt": datetime.fromtimestamp((now_ms + DEDUPE_RETENTION_MS) / 1000, tz=UTC),
        }
    }


def build_release_update(outcome: Literal["COMPLETED", "FAILED"], now_ms: int) -> dict[str, Any]:
    """Both outcomes CLEAR the lease.

    ``COMPLETED`` so nothing can steal a finished marker; ``FAILED`` so the next
    delivery is immediately retryable rather than blocked for the remainder of a
    lease it no longer holds.
    """
    return {
        "$set": {
            "status": outcome,
            "leaseExpiresAt": None,
            "completedAt": datetime.fromtimestamp(now_ms / 1000, tz=UTC),
        }
    }


def http_response_for(decision: ClaimDecision) -> tuple[dict[str, Any], int] | None:
    """The short-circuit HTTP answer for a decision, or ``None`` to run the job.

    ``SKIP_COMPLETED`` -> 200 ``{"success": true, "duplicate": true}``.
    ``RETRY_LATER``    -> 409, NOT 200: the first delivery is still running and
    may yet fail. Acking here would leave a job silently undone with Pub/Sub
    believing it was handled.
    """
    if decision.action == "SKIP_COMPLETED":
        return {"success": True, "duplicate": True}, 200
    if decision.action == "RETRY_LATER":
        return {"error": "Duplicate delivery in flight", "duplicate": True}, 409
    return None


def should_release_completed(status_code: int) -> bool:
    """Only a 2xx counts as done.

    A route that returns 500 (every processor catches its own errors and returns
    500 rather than raising) must stay RETRYABLE, so it releases ``FAILED``.
    """
    return 200 <= status_code < 300


#: Injected clock, epoch ms.
NowMs = Callable[[], int]
