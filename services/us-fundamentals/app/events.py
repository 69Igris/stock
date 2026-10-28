"""The SEC producer's half of C1 — MONEY-1507, transport replaced by MONEY-1520.

The detect loop claims a filing in ``us_filings`` and then tells the TypeScript
side about it, so that one unified ``InstrumentEvent`` reaches the alert
evaluator, the chart, the events tab and the lake.

## WHAT THIS SENDS, AND WHAT IT DELIBERATELY DOES NOT

FACTS ONLY — the ``us_filings`` row we just wrote. No event id, no event type,
no severity, no listing id. Every one of those is DERIVED on the other side, in
``packages/core/src/events/event-types.ts``, because a second implementation of
a rule in a second language is a rule that has to agree forever and will not.
This repo has paid that bill twice already: a ``mimeType`` matched EXACTLY in
one place and by SUBSTRING in another (MONEY-1255), and a concept vocabulary
keyed in two of edgartools' three naming schemes (MONEY-979).

## IT IS PUB/SUB, AND IT USED TO BE HTTP — MONEY-1520

The original C1 wiring POSTed this payload to ``/internal/events`` on
``stockbook-workers-{env}`` with an OIDC token. **It answered 404 on every call
from the day it shipped**, and the reason is a networking fact that no amount of
code review would have found: ``stockbook-workers-{env}`` carries
``run.googleapis.com/ingress: internal`` and ``us-fundamentals-{env}`` has no
VPC egress, so the request left over the public internet and Cloud Run rejected
it AT THE EDGE — before Hono, before the ``jobsAuth`` middleware, which has no
404 path at all and would have answered 401. An internal-ingress service answers
an external caller 404 precisely so it does not reveal that it exists.

Pub/Sub push is not external traffic, which is the whole reason the ~55 other
job routes reach that same service without trouble. So the payload is now a
Pub/Sub message on ``us-filing-events-{env}`` and the consumer is the SAME
route, remounted at ``/jobs/us-filing-events``.

Nothing about the PAYLOAD changed. ``workers/src/processors/internal-events-logic.ts``
validates the identical zod schema, and the route already decoded a push
envelope (``parsePubSubMessage`` falls back to the bare body), so both shapes
were always acceptable to it.

## FAIL-SOFT, ALWAYS — BUT NEVER SILENT

A failure here is logged and COUNTED and never raised. The detect loop's product
is the CLAIM — the row in ``us_filings`` and the message on the parse topic —
and an events outage must not stop a walk whose Atom window rolls in minutes and
whose misses are unrecoverable.

What MONEY-1520 changed is the second half of that sentence. The failure count
is now folded into ``stats.failed``, so ``[job-outcome]`` reports it instead of
reporting ``failed: 0`` while every event on the floor. Fail-soft was never the
defect; fail-soft AND unreported was.

## THE EVENT IS A DERIVED PROJECTION, SO A DROP IS RECOVERABLE

``buildEventId(source, sourceRecordKey)`` is ``sha1(source + NUL + accession)``
— a pure function, enforced by the event contract's own ``.refine``. The
accession is SEC's primary key and is unique in ``us_filings``, and the filing
row is written every run whether or not the emit lands. So a dropped event is
re-derived from the row onto the IDENTICAL id and ``publishEvents``' upsert
collapses it. That is what makes an outbox, a two-phase claim or a
reconciliation loop unnecessary here — and it is also why a DUPLICATE delivery
is free.

THE REBUILD IS ``{"mode": "event-backfill"}`` on ``edgar-detect`` (MONEY-1532),
and until that ticket it did not exist. This paragraph and ``_emit_events``
both said "a backfill re-derives any dropped event" for two releases while
nothing did — first naming ``scripts/jobs/filing-registry-sync.ts``, which
writes ``lake_silver.filing_registry`` and emits no events, then no job at all.
It reads the rows a detector CLAIMED (``detectedAt`` set) and publishes them
through the SAME ``build_requests`` path as the live emission.

## ``observedAt`` IS THE CLAIM INSTANT, SENT — MONEY-1532

Each entry carries ``observedAt`` = the row's ``detectedAt``. The workers
stamped the envelope's ``publishTime`` instead, which is wrong twice: live, it
is up to a whole 420 s run later than the claim (the emit is in ``handle``'s
``finally``); for a BACKFILLED filing it is TODAY, so a filing claimed a week
ago would arrive as new — restating point-in-time history and firing every
alert on it at once. ``detectedAt`` is insert-only on ``us_filings``, so every
re-emission of one filing also carries the same instant.

## ONE MESSAGE PER RUN, NOT PER FILING

A detect run fans out at most a few dozen filings. One message carrying the
batch costs one publish inside a handler that is already bounded by a 420 s
budget inside a 600 s ack deadline. The chunk size is the route's own ceiling,
so the consumer never has to refuse a batch for being too large.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from app.publish import iso_timestamp

#: The Pub/Sub topic BASE name. ``app.publish.topic_name`` appends ``-{env}``.
#:
#: It MUST equal the path segment after ``/jobs/`` on the workers side:
#: ``workers/scripts/setup-pubsub.sh`` builds every push endpoint as
#: ``${SERVICE_URL}/jobs/${BASE_TOPIC}``, and
#: ``workers/__tests__/route-registration-coverage.test.ts`` joins the two lists
#: in both directions. A name that disagrees 404s every delivery and
#: dead-letters after five attempts — which reads as a failing job rather than a
#: misrouted topic (MONEY-1257), and is one layer removed from the edge 404 this
#: whole transport change exists to fix.
EVENTS_TOPIC = "us-filing-events"

#: The route refuses a larger batch (`MAX_FILINGS_PER_REQUEST`), so chunk to it.
MAX_FILINGS_PER_REQUEST = 500


@dataclass(frozen=True)
class EmitResult:
    """What one emission did. Counted, never raised."""

    sent: int = 0
    failed: int = 0
    skipped_reason: str | None = None


def _iso_date(value: Any) -> str | None:
    """``date`` | ``datetime`` -> the ISO spelling the TypeScript side parses.

    A bare ``date`` is widened to UTC midnight rather than sent as ``YYYY-MM-DD``:
    ``new Date("2026-08-29")`` is midnight UTC and ``new Date("2026-08-29T..")``
    respects its own offset, so sending the short form for one field and the
    long form for another would put two of this row's clocks on different
    conventions. ``filedAt`` is a ``date`` and ``acceptedAt`` a ``datetime``, so
    that mixture is the NORMAL case here, not an edge.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return iso_timestamp(value)
    if isinstance(value, date):
        return f"{value.isoformat()}T00:00:00.000Z"
    return None


def build_filing_payload(document: dict[str, Any]) -> dict[str, Any] | None:
    """One ``us_filings`` document -> one message entry, or ``None``.

    ``None`` when the document lacks an accession or a CIK. Both are REQUIRED by
    the route's schema and both are the join keys everything downstream uses, so
    sending a row without one costs a zod rejection for the WHOLE batch — which
    would drop the good rows beside it, and now costs five Pub/Sub delivery
    attempts as well.
    """
    accession = document.get("accession")
    cik10 = document.get("cik10")
    form = document.get("form")
    if not (isinstance(accession, str) and isinstance(cik10, str) and isinstance(form, str)):
        return None

    items = document.get("items") or []
    payload: dict[str, Any] = {
        "accession": accession,
        "cik10": cik10,
        "form": form,
        "items": [str(i) for i in items],
    }
    # Only NON-NULL clocks are sent. The route's schema is `nullish`, so a null
    # would be accepted — but omitting keeps "the source never stated one"
    # distinguishable from "we sent something unparseable", which is the
    # distinction `_iso_date` returning None actually means.
    accepted = _iso_date(document.get("acceptedAt"))
    if accepted:
        payload["acceptedAt"] = accepted
    filed = _iso_date(document.get("filedAt"))
    if filed:
        payload["filedAt"] = filed
    # WHEN WE SAW IT — see "observedAt IS THE CLAIM INSTANT" above. A row read
    # back from Mongo carries a NAIVE datetime (BSON stores UTC without a zone);
    # `iso_timestamp` reads naive as UTC, so a backfilled row and the live
    # document it was inserted from render the same string.
    observed = _iso_date(document.get("detectedAt"))
    if observed:
        payload["observedAt"] = observed
    return payload


def build_requests(
    documents: Sequence[dict[str, Any]],
    *,
    max_per_request: int = MAX_FILINGS_PER_REQUEST,
) -> list[dict[str, Any]]:
    """Message bodies for a batch of claimed filings. Pure.

    Documents that cannot be described are DROPPED here rather than sent, and an
    all-dropped batch yields zero messages rather than one empty message: the
    route refuses an empty `filings` array on purpose, so publishing one would
    turn "nothing to say" into a poison message that dead-letters.
    """
    if max_per_request < 1:
        raise ValueError("max_per_request must be >= 1")
    entries = [p for p in (build_filing_payload(d) for d in documents) if p is not None]
    return [
        {"filings": entries[i : i + max_per_request]}
        for i in range(0, len(entries), max_per_request)
    ]
