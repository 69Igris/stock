"""The I/O shell + middleware around the Pub/Sub dedupe — MONEY-979.

Port of ``workers/src/lib/pubsub-dedupe.ts``. Everything branchy is in
:mod:`app.dedupe_logic`; this module holds pymongo and the request wrapper.

## Behaviour under SIMULTANEOUS redelivery — the whole point of this code

Two deliveries of the same messageId land on two Cloud Run instances at the same
instant. Both call :meth:`DedupeStore.claim`. Both issue the SAME insert against
a collection with ``unique: True`` on ``messageId``. MongoDB serialises them on
the index: exactly one document is written. The winner sees ``{"n": 1}`` ->
``RUN``. The loser sees a duplicate key, reads the marker, and gets
``RETRY_LATER`` because the lease is live — so it nacks and Pub/Sub redelivers
after the backoff. Nothing double-runs, nothing is dropped, and there is no
read-then-write window anywhere.

The three other reachable states are each resolved by a compare-and-swap that is
itself atomic (``findAndModify`` touches ONE document):

* ``COMPLETED``      -> ``SKIP_COMPLETED``; ack, do not re-run.
* ``FAILED``         -> CAS ``FAILED -> IN_FLIGHT``. Only one of N concurrent
  retries matches; the rest get ``RETRY_LATER``.
* lease ``EXPIRED``  -> CAS filtered on the OLD ``leaseExpiresAt``, so only one
  stealer matches. A crashed job is retryable and still cannot be claimed twice.
"""

from __future__ import annotations

import os
import time
from collections.abc import Awaitable, Callable
from typing import Any, Literal, Protocol

from app.dedupe_logic import (
    DEDUPE_COLLECTION,
    ClaimDecision,
    DedupeMarker,
    build_claim_document,
    build_release_update,
    build_steal_filter,
    build_steal_update,
    decide_on_existing_marker,
    decide_on_store_error,
    dedupe_index_specs,
    extract_delivery_id,
    http_response_for,
    is_duplicate_key_error,
    resolve_lease_ms,
    route_key,
    should_release_completed,
    to_marker,
)
from app.logging_setup import log_error


def _now_ms() -> int:
    return int(time.time() * 1000)


def _lease_ms() -> int:
    """Read the lease override PER CALL — a module const would freeze at import."""
    return resolve_lease_ms(os.environ.get("PUBSUB_DEDUPE_LEASE_MS"))


class DedupeCollection(Protocol):
    """The three pymongo operations the store uses.

    Declared structurally so a test can drive the REAL store against a fake
    collection that implements a real unique index — the only way to exercise
    the claim protocol's CONCURRENCY behaviour without a live cluster.
    """

    def insert_one(self, document: dict[str, Any]) -> Any: ...

    def find_one(self, filter: dict[str, Any]) -> dict[str, Any] | None: ...

    def find_one_and_update(
        self, filter: dict[str, Any], update: dict[str, Any], **kwargs: Any
    ) -> dict[str, Any] | None: ...

    def update_one(self, filter: dict[str, Any], update: dict[str, Any]) -> Any: ...

    def create_indexes(self, indexes: Any) -> Any: ...


class DedupeStore:
    """Atomic claim/release over one Mongo collection. NEVER raises."""

    def __init__(
        self,
        collection: DedupeCollection,
        *,
        now: Callable[[], int] = _now_ms,
        lease: Callable[[], int] = _lease_ms,
    ) -> None:
        self._collection = collection
        self._now = now
        self._lease = lease

    # ── claim ────────────────────────────────────────────────────────────

    def claim(self, message_id: str, route: str) -> ClaimDecision:
        try:
            now = self._now()
            document = build_claim_document(message_id, route, now, self._lease())

            try:
                self._collection.insert_one(document)
                return ClaimDecision("RUN", "claimed", 1)
            except Exception as err:
                # A duplicate key reaches us as a RAISE and, on a raw insert
                # command, inside an `ok: 1` response. Only the first can happen
                # through insert_one, but the classifier handles both because
                # `BulkWriteError.details` carries the writeErrors form.
                if not is_duplicate_key_error(err):
                    raise

            marker = self._read_marker(message_id)
            decision = decide_on_existing_marker(marker, self._now())
            if decision.action != "RUN" or marker is None:
                return decision

            # We believe the marker is stealable. Prove it atomically.
            if self._steal(message_id, route, marker):
                return decision

            return ClaimDecision("RETRY_LATER", "steal_lost_race", decision.attempts)
        except Exception as err:
            log_error("[pubsub-dedupe] claim failed; running untracked", err)
            return decide_on_store_error()

    def _read_marker(self, message_id: str) -> DedupeMarker | None:
        return to_marker(self._collection.find_one({"messageId": message_id}))

    def _steal(self, message_id: str, route: str, marker: DedupeMarker) -> bool:
        now = self._now()
        result = self._collection.find_one_and_update(
            build_steal_filter(message_id, marker),
            build_steal_update(route, marker, now, self._lease()),
        )
        return result is not None

    # ── release ──────────────────────────────────────────────────────────

    def release(self, message_id: str, outcome: Literal["COMPLETED", "FAILED"]) -> None:
        """Mark a claim terminal. Never raises.

        A release failure must not turn a SUCCESSFUL job into a 500. The cost of
        a lost release is one lease period of 409s on that one messageId —
        exactly the state the lease exists to bound.
        """
        try:
            self._collection.update_one(
                {"messageId": message_id},
                build_release_update(outcome, self._now()),
            )
        except Exception as err:
            log_error(f"[pubsub-dedupe] release({outcome}) failed", err)

    # ── boot ─────────────────────────────────────────────────────────────

    def ensure_indexes(self) -> bool:
        """Create the unique + TTL indexes. Returns False on failure, never raises.

        "Already exists" is success. A failure here is NOT fatal: the store
        fails open, so a service that cannot create the index degrades to
        at-least-once delivery rather than refusing to start.
        """
        try:
            from pymongo import IndexModel

            self._collection.create_indexes(
                [
                    IndexModel(
                        list(spec["key"].items()),
                        name=spec["name"],
                        **{k: v for k, v in spec.items() if k not in ("key", "name")},
                    )
                    for spec in dedupe_index_specs()
                ]
            )
            return True
        except Exception as err:
            log_error("[pubsub-dedupe] could not ensure indexes", err)
            return False


def get_dedupe_collection() -> DedupeCollection | None:
    """The live ``pubsub_message_dedupe`` collection, or ``None`` if unavailable."""
    from app.db import get_database

    database = get_database()
    if database is None:
        return None
    return database[DEDUPE_COLLECTION]


# ── The middleware itself ───────────────────────────────────────────────────

#: Runs the wrapped handler and returns ``(body, status_code)``.
DedupeNext = Callable[[], Awaitable[tuple[Any, int]]]

#: Routes that opt OUT of the generic middleware. Empty here — this service has
#: no dead-letter consumer of its own (it shares the workers' ``dead-letter``
#: subscription), so there is nothing that must convert every outcome to an ACK.
SELF_DEDUPING_ROUTES: tuple[str, ...] = ()


def create_dedupe_middleware(
    store_factory: Callable[[], DedupeStore | None],
    *,
    skip_paths: tuple[str, ...] = SELF_DEDUPING_ROUTES,
    log: Callable[[str], None] | None = None,
):
    """Build the ``/jobs/*`` idempotency middleware.

    A FACTORY for the same reason the auth gate is one: extracting the decision
    function alone leaves the CALL SITE untested, and the call site is where a
    dedupe silently degrades. ``if decision.action == "RUN"`` flipped to an
    unconditional run keeps every :func:`decide_on_existing_marker` unit test
    green while the dedupe does nothing.

    ORDERING: this must be registered so it runs AFTER the OIDC gate. Claiming a
    messageId for an unauthenticated request would let an attacker burn the
    dedupe key for a legitimate message — a denial-of-job with no auth required.
    """
    skip = set(skip_paths)
    emit = log or (lambda _message: None)

    async def pubsub_dedupe(path: str, body: Any, call_next: DedupeNext) -> tuple[Any, int]:
        route = route_key(path)
        if route in skip:
            return await call_next()

        message_id = extract_delivery_id(body)
        if not message_id:
            # Direct JSON body: local dev, a manual curl, or a pull subscriber.
            # No real messageId, so no claim — see `extract_delivery_id`.
            return await call_next()

        store = store_factory()
        if store is None:
            emit(
                f"[pubsub-dedupe] no store route={route} messageId={message_id} — running untracked"
            )
            return await call_next()

        decision = store.claim(message_id, route)

        short_circuit = http_response_for(decision)
        if short_circuit is not None:
            emit(
                f"[pubsub-dedupe] duplicate:true route={route} messageId={message_id} "
                f"reason={decision.reason} attempts={decision.attempts or 0}"
            )
            return short_circuit

        tracked = decision.action == "RUN"
        if not tracked:
            emit(
                f"[pubsub-dedupe] untracked route={route} messageId={message_id} "
                f"reason={decision.reason} — running WITHOUT a claim (fail-open)"
            )

        try:
            body_out, status = await call_next()
        except BaseException:
            # Release BEFORE re-raising, or a raising handler leaves an
            # IN_FLIGHT marker that blocks every redelivery until the lease
            # expires — turning one transient error into an hour of 409s.
            if tracked:
                store.release(message_id, "FAILED")
            raise

        if tracked:
            store.release(message_id, "COMPLETED" if should_release_completed(status) else "FAILED")
        return body_out, status

    return pubsub_dedupe
