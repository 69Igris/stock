"""The one-off that clears the legacy `extractionStatus` population — MONEY-1351.

`scripts/backfill_extraction_status.py` is two Mongo filters and an
`update_many`. The filters are the whole risk surface, and both sit on the
absent-vs-null trap that has now cost MONEY-1050, 1234 and 1235 — in OPPOSITE
directions, which is exactly why they are asserted as spellings rather than as
outcomes.
"""

from __future__ import annotations

from scripts.backfill_extraction_status import BINARY_TYPES, backfill_plan


def plan() -> dict[str, dict]:
    return {status: criteria for status, criteria in backfill_plan()}


def test_READY_asks_for_a_STRING_and_never_for_not_null() -> None:
    """`{"$ne": None}` over a field a `db push` never created returns ZERO from
    BOTH directions.

    `$type: "string"` asks the question that is actually meant — is there a
    pointer here — and answers it the same way whether the field is null or
    absent.
    """
    criteria = plan()["READY"]

    assert criteria == {"textPath": {"$type": "string"}}
    assert "$ne" not in str(criteria), "the spelling that returns zero from both sides"


def test_FAILED_uses_the_INCLUSIVE_null_match_on_purpose() -> None:
    """In Mongo `{"textPath": None}` matches null AND ABSENT.

    That is the inclusive half of the same trap and is what is wanted here: a
    row with no pointer, however it came to have none, is a row whose extraction
    produced nothing.
    """
    criteria = plan()["FAILED"]

    assert criteria["textPath"] is None


def test_images_are_EXCLUDED_from_FAILED_using_the_parser_s_own_deny_set() -> None:
    """An env where `purge_image_documents.py` has not run yet must not have
    1,847 GRAPHIC rows restamped from "never processed" to "extraction failed" —
    a permanent claim that we tried, over documents that were never enqueued.

    The set is IMPORTED from the parser rather than restated, so a purge and a
    backfill can never disagree about what an image is.
    """
    from app.parsers.eightk_logic import BINARY_MEDIA_TYPES

    criteria = plan()["FAILED"]

    assert criteria["documentType"] == {"$nin": BINARY_TYPES}
    assert sorted(BINARY_MEDIA_TYPES) == BINARY_TYPES
    assert "GRAPHIC" in BINARY_TYPES


def test_the_two_filters_are_DISJOINT_so_run_order_cannot_matter() -> None:
    """A `textPath` cannot be both a string and null, so no row can be claimed
    by both statuses and a repeat run rewrites the same value."""
    ready, failed = plan()["READY"], plan()["FAILED"]

    assert ready["textPath"] == {"$type": "string"}
    assert failed["textPath"] is None
    assert ready["textPath"] != failed["textPath"]


def test_neither_filter_narrows_on_extractionStatus_itself() -> None:
    """`{"extractionStatus": "PENDING"}` looks tidier and would MISS every row
    where the field is absent.

    Both filters are idempotent, so the guard buys nothing and costs the rows it
    silently skips.
    """
    assert all("extractionStatus" not in criteria for _, criteria in backfill_plan())


def test_the_statuses_written_are_the_parser_s_own_constants() -> None:
    """A third spelling of READY/FAILED here would drift from the parser's, and
    the drift would look like a half-finished backfill rather than a typo."""
    from app.parsers.eightk_logic import EXTRACTION_FAILED, EXTRACTION_READY

    assert [status for status, _ in backfill_plan()] == [EXTRACTION_READY, EXTRACTION_FAILED]
