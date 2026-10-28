"""Selecting already-INDEXED filings for a re-publish — MONEY-1352. PURE.

No Mongo, no Pub/Sub, no clock. `scripts/enqueue_indexed_financials.py` is the
I/O around these decisions, so every rule below is driven by a test against the
real implementation rather than a second declaration of it.

## What this exists for

Measured 2026-09-05: 584 of 7,112 CIK-bearing active US stocks have NO
`us_fundamentals` row at all, and ~430 of them have XBRL FINANCIALS filings
sitting `INDEXED` and unparsed — 221 10-Q, 136 20-F, 52 40-F, 10 20-F/A and 11
non-XBRL 10-K. Nothing in this repo could enqueue one: `us_filings` rows reach a
parser only through LIVE DETECTION, which publishes as it discovers and never
looks back. A filing that was indexed by a bulk walk, or whose publish failed
once, is therefore parked forever with no operator path to it.

## Three rules the filter encodes

1. **`isXbrl: True` IS PART OF THE SELECTION, not a nicety.** The financials
   parser reads the XBRL instance out of the submission bundle and answers
   `UNSUPPORTED` when there is none (`dispatch._parse_financials`). Publishing
   the 11 non-XBRL 10-Ks would spend a SEC fetch each to reach a verdict already
   derivable from the row, and would restamp them from INDEXED to UNSUPPORTED —
   losing the fact that they are still waiting for a parser that could read them.
2. **The status is `INDEXED` and nothing else.** `DETECTED` means "claimed and
   published, awaiting a parser" (`app/store/models.py`), so re-publishing one
   doubles a message that is already in flight; `PARSED` / `FAILED` /
   `UNSUPPORTED` / `NO_PARSER` are all terminal answers this script has no new
   evidence against.
3. **A fiscal-year floor reuses `backfill_logic`'s window rule**, including
   "`None` never passes". A 10-K is filed two to three months after the year it
   reports on, so `filedAt` alone both invents a year and loses one — which is
   why `fiscal_year_of` prefers `periodOfReport`.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from datetime import date
from typing import Any

from app.bulk.backfill_logic import fiscal_year_of, in_fy_window
from app.store.models import PARSE_CLASS_FINANCIALS, STATUS_INDEXED

#: A floor with no ceiling still needs one to reuse :func:`in_fy_window`, which
#: is the only place the "`None` never passes" rule is stated.
MAX_FISCAL_YEAR = date.max.year


def indexed_financials_filter(
    *,
    forms: Sequence[str] | None = None,
    ciks: Sequence[str] | None = None,
) -> dict[str, Any]:
    """The `us_filings` query for XBRL FINANCIALS filings nobody has parsed.

    `forms` and `ciks` are OMITTED when empty rather than written as an empty
    `$in`: `{"$in": []}` matches NOTHING, so an operator who passed `--forms ""`
    would get a clean, confident run over zero filings — the shape that has cost
    this repo a release more than once.
    """
    criteria: dict[str, Any] = {
        "parseClass": PARSE_CLASS_FINANCIALS,
        "status": STATUS_INDEXED,
        "isXbrl": True,
    }
    if forms:
        criteria["form"] = {"$in": list(forms)}
    if ciks:
        criteria["cik10"] = {"$in": list(ciks)}
    return criteria


def passes_fiscal_floor(row: Mapping[str, Any], from_fy: int | None) -> bool:
    """Whether a filing row is at or after `from_fy`. No floor passes everything.

    Applied in Python rather than in the query because the fiscal year is
    DERIVED — `periodOfReport` when present, `filedAt` otherwise — and encoding
    that as two Mongo date ranges would be a second copy of
    :func:`~app.bulk.backfill_logic.fiscal_year_of`'s rule that can disagree
    with it.
    """
    if from_fy is None:
        return True
    return in_fy_window(
        fiscal_year_of(_as_date(row.get("periodOfReport")), _as_date(row.get("filedAt"))),
        from_fy,
        MAX_FISCAL_YEAR,
    )


def _as_date(value: Any) -> date | None:
    """A `date` from whatever pymongo handed back, or `None` for anything else.

    A `datetime` passes straight through — it IS a `date`, and `fiscal_year_of`
    reads only `.year`, which the two spell identically. An earlier version of
    this function unwrapped it with `.date()`; that was inert, and a mutation
    test proved it by surviving the removal, so it is gone rather than left as a
    line nothing can grade.

    The isinstance guard is NOT inert. `us_filings` is written by several jobs
    and a `filedAt` that ever arrives as a STRING would raise `AttributeError`
    inside a selection whose only job is to decide what to publish — one
    malformed row taking down the whole run. Unparseable is treated as
    undatable, which the floor already refuses.
    """
    return value if isinstance(value, date) else None


def ciks_without_fundamentals(
    active_ciks: Iterable[str], fundamentals_ciks: Iterable[str]
) -> list[str]:
    """Active-stock CIKs with no `us_fundamentals` row, sorted and deduped.

    A SET DIFFERENCE over two distinct-value lists, kept pure and sorted so the
    selection is reproducible: an unordered difference hands `--limit` a
    different few hundred filers on every run, and two operators comparing notes
    see two different answers to one question.

    Both sides are normalised to a STRIPPED STRING first, and neither is
    re-padded. `us_instruments.cik` already holds a zero-padded 10-character
    string ("0001708055") and `us_fundamentals.cik10` is the same shape, so
    padding here would only mask a real upstream drift: if one side ever stops
    padding, the difference reports that filer as uncovered forever, which is a
    visible wrong answer rather than a silent join failure.
    """
    have = {str(value).strip() for value in fundamentals_ciks if str(value).strip()}
    return sorted({str(value).strip() for value in active_ciks if str(value).strip()} - have)
