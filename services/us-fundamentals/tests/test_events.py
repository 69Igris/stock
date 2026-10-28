"""The SEC producer's message builder — MONEY-1507 (C1), MONEY-1520.

Every case drives the REAL `app.events` symbols.

`app/events.py` is PURE now. It was an HTTP client with two injected I/O seams
until MONEY-1520 found that the POST it made answered 404 on every call from the
day it shipped — the workers service is `ingress: internal` and this service has
no VPC egress, so the request never reached Hono. The transport is a Pub/Sub
publish, it lives at the call site in `app/jobs/detect.py` (which is where
`topic-publisher-coverage.test.ts` looks for it), and its fail-soft branches are
covered in `test_detect_job.py` against a fake publisher.

What is left here is the PAYLOAD CONTRACT, which did not change at all: the
workers validate the same zod schema whether the bytes arrive in a POST body or
in a Pub/Sub message.
"""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from app.events import (
    EVENTS_TOPIC,
    MAX_FILINGS_PER_REQUEST,
    build_filing_payload,
    build_requests,
)


def _doc(**overrides) -> dict:
    base = {
        "accession": "0000320193-26-000106",
        "cik10": "0000320193",
        "form": "8-K",
        "items": ["2.02", "Item 9.01"],
        "acceptedAt": datetime(2026, 8, 29, 1, 53, 58, tzinfo=UTC),
        "filedAt": date(2026, 8, 29),
    }
    base.update(overrides)
    return base


# ── build_filing_payload ────────────────────────────────────────────────────


def test_it_sends_facts_and_nothing_derived():
    """No event id, no type, no severity, no listing — those are TypeScript's.

    A second implementation of a rule in a second language is a rule that has to
    agree forever and will not (MONEY-1255's mimeType, MONEY-979's vocabulary).
    """
    payload = build_filing_payload(_doc())
    assert set(payload) == {"accession", "cik10", "form", "items", "acceptedAt", "filedAt"}


def test_a_datetime_keeps_milliseconds_and_a_literal_Z():
    payload = build_filing_payload(_doc())
    assert payload["acceptedAt"] == "2026-08-29T01:53:58.000Z"


def test_a_bare_date_is_widened_to_utc_midnight_not_sent_short():
    """`filedAt` is a `date` and `acceptedAt` a `datetime` on the SAME row.

    Sending `YYYY-MM-DD` for one and a full timestamp for the other would put
    two of the row's clocks on different conventions.
    """
    payload = build_filing_payload(_doc())
    assert payload["filedAt"] == "2026-08-29T00:00:00.000Z"


def test_a_missing_clock_is_omitted_rather_than_sent_null():
    payload = build_filing_payload(_doc(acceptedAt=None))
    assert "acceptedAt" not in payload
    assert payload["filedAt"]


# ── observedAt (MONEY-1532) ─────────────────────────────────────────────────


def test_observed_at_is_the_rows_detected_at_not_the_publish_instant():
    """The claim instant rides in the message. Without it the workers stamp the
    envelope's publishTime — up to a 420 s run late live, and TODAY for a
    backfilled filing, which would arrive as new and fire every alert at once."""
    detected = datetime(2026, 9, 22, 14, 3, 7, 219000, tzinfo=UTC)
    payload = build_filing_payload(_doc(detectedAt=detected))
    assert payload["observedAt"] == "2026-09-22T14:03:07.219Z"


def test_a_row_read_back_from_mongo_renders_the_same_instant_as_the_live_document():
    """pymongo returns NAIVE datetimes (BSON stores UTC without a zone). The
    backfill reads rows back; the live path holds the aware document it inserted.
    Both must send the same string, or a re-emission restates observedAt."""
    aware = datetime(2026, 9, 22, 14, 3, 7, 219000, tzinfo=UTC)
    naive = aware.replace(tzinfo=None)
    assert (
        build_filing_payload(_doc(detectedAt=naive))["observedAt"]
        == build_filing_payload(_doc(detectedAt=aware))["observedAt"]
        == "2026-09-22T14:03:07.219Z"
    )


def test_a_row_without_detected_at_sends_no_observed_at():
    """Absent, not null: the workers then fall back to publishTime, which is the
    pre-MONEY-1532 behaviour and the only honest answer when we do not know."""
    assert "observedAt" not in build_filing_payload(_doc())


def test_a_row_without_an_accession_or_a_cik_is_dropped():
    """Both are the route's REQUIRED fields, so one bad row would 400 the batch
    and take the good rows beside it down."""
    assert build_filing_payload(_doc(accession=None)) is None
    assert build_filing_payload(_doc(cik10=None)) is None
    assert build_filing_payload(_doc(form=None)) is None


# ── build_requests ──────────────────────────────────────────────────────────


def test_an_all_undescribable_batch_yields_no_request_at_all():
    """The route refuses an empty `filings` array on purpose, so sending one
    would turn 'nothing to say' into a 400."""
    assert build_requests([_doc(accession=None)]) == []


def test_a_batch_is_chunked_to_the_routes_ceiling():
    docs = [_doc(accession=f"000032019{i % 10}-26-{i:06d}") for i in range(7)]
    requests = build_requests(docs, max_per_request=3)
    assert [len(r["filings"]) for r in requests] == [3, 3, 1]


def test_a_non_positive_chunk_size_is_refused():
    with pytest.raises(ValueError):
        build_requests([_doc()], max_per_request=0)
