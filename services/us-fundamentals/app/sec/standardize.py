"""Raw us-gaap tag -> edgartools STANDARD TAG, for the companyfacts fallback.

## Why this module exists

``us_fundamentals.standardized`` is read by ONE table on the TypeScript side
(`US_CONCEPT_TO_STATEMENT_FIELD`), so the column has to speak ONE vocabulary.
It did not. Two writers filled it from two different places:

* the per-filing parse stored ``StatementLine.standard_concept`` — edgartools'
  ``standard_tags`` vocabulary (``NetIncome``, ``CommonEquity``);
* the ``companyfacts.zip`` fallback stored ``entry.concept`` — the RAW us-gaap
  tag straight out of SEC's JSON (``NetIncomeLoss``, ``StockholdersEquity``).

Measured: exactly 13 of the reader's 26 concepts are spellable as raw us-gaap
tags, so HALF of every companyfacts-sourced statement was unreadable — including
all of the cash-flow statement, equity, and working capital. It did not look
like a bug, it looked like a thin filer.

That matters more than the row count suggests: companyfacts is the fallback for
periods NO per-filing parse has reached, so it is the only source for exactly
the historical periods the backfill exists to provide.

## What it does NOT do

It does not parse, and it never touches a filing. It reads one data file that
ships inside the pinned wheel and answers a dictionary lookup. ``asReported``
keeps the RAW concept, which is what "as reported" means — this maps only the
standardized view.

The file is pinned by ``tests/test_edgartools_pin.py``
(``PINNED_GAAP_MAPPINGS_SHA256``), so an upgrade that moves a concept between
buckets fails there rather than silently restating a number here.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from edgar.xbrl import standardization


def _mappings_path() -> Path:
    """``gaap_mappings.json`` inside the INSTALLED wheel."""
    return Path(standardization.__file__).parent / "gaap_mappings.json"


#: Buckets where the statistically dominant feeder is a COMPONENT, not the total.
#:
#: `occurrence_rate` measures how COMMON a tag is, never how COMPLETE, and
#: `is_total` cannot break these ties because upstream flags both candidates as
#: totals. Measured from `gaap_mappings.json`, both at confidence 1.00:
#:
#:   SellingGeneralAndAdminExpenses
#:     GeneralAndAdministrativeExpense           occ 0.531  <- a COMPONENT
#:     SellingGeneralAndAdministrativeExpense    occ 0.285  <- the total
#:   Revenue
#:     RevenueFromContractWithCustomerExcluding… occ 0.385  <- ASC-606 subtotal
#:     Revenues                                  occ 0.346  <- the total
#:
#: A filer tagging both lines of either pair got the smaller one. For a bank or
#: insurer with material non-contract revenue, that understates revenue outright.
#:
#: This list is deliberately SHORT and every entry is measured. It is not a
#: general override mechanism: the statistical rank is right almost everywhere,
#: and a long hand-maintained preference table would rot silently against a file
#: upstream regenerates every release. Add an entry only with the numbers that
#: justify it, and only when `is_total` genuinely cannot decide.
CANONICAL_FEEDER: dict[str, str] = {
    "SellingGeneralAndAdminExpenses": "SellingGeneralAndAdministrativeExpense",
    "Revenue": "Revenues",
}

#: One candidate's claim on a bucket. HIGHER WINS.
#:
#: Everything after the first element ships inside ``gaap_mappings.json`` — this
#: invents nothing. ``confidence`` is upstream's own certainty that the tag
#: belongs in the bucket (1.0 for a canonical tag, 0.5 for a plausible one);
#: ``occurrence_rate`` is the share of filers using it; ``is_total``
#: distinguishes a total from a component.
#:
#: ``is_canonical`` leads, because it is the only element that encodes
#: COMPLETENESS. The other three measure popularity and upstream confidence, and
#: a component can beat a total on all three at once — see
#: :data:`CANONICAL_FEEDER`.
ConceptRank = tuple[int, float, float, int, str]


@lru_cache(maxsize=1)
def _concept_index() -> dict[str, tuple[str, ConceptRank]]:
    """``{us-gaap tag: (standard tag, rank)}``. Loaded ONCE, ~3.7 MB of JSON.

    Memoised rather than read at import: a module-scope read freezes at import
    time, which in this repo has hidden a kill switch and a limiter config. A
    cached function is re-entrant, testable with ``cache_clear()``, and costs the
    read exactly once per process — which for a bulk job over 800k filers is the
    difference between one parse and one per call.

    A tag with SEVERAL ``standard_tags`` takes the FIRST, matching edgartools'
    own ordering. The alternative — dropping ambiguous tags — would silently
    delete concepts that do have a usable primary bucket. Measured: 207 of 2,924
    concepts carry more than one tag, and only four have a first tag outside the
    reader's buckets and a later one inside — all at confidence 0.5 and used by
    under 0.8% of filers.
    """
    payload: dict[str, Any] = json.loads(_mappings_path().read_bytes())
    index: dict[str, tuple[str, ConceptRank]] = {}
    for concept, entry in payload.items():
        tags = entry.get("standard_tags") or []
        if not tags:
            continue
        bucket = str(tags[0])
        rank: ConceptRank = (
            1 if CANONICAL_FEEDER.get(bucket) == concept else 0,
            float(entry.get("confidence") or 0.0),
            float(entry.get("occurrence_rate") or 0.0),
            1 if entry.get("is_total") else 0,
            # Lexical LAST, and only to make ties total: two candidates with
            # identical upstream statistics must not resolve differently between
            # runs. It is a tie-breaker, never a preference.
            concept,
        )
        index[concept] = (bucket, rank)
    return index


def standard_tag_for(concept: str) -> str | None:
    """The standard tag for a raw us-gaap concept, or ``None`` when unmapped.

    ``None`` is a real answer, not a failure: ``gaap_mappings.json`` covers 2,924
    tags and SEC's taxonomy is larger, and a company EXTENSION concept
    (``aapl:SomethingSpecific``) has no standard bucket by definition. The caller
    drops it from the standardized view and counts it; it remains in
    ``asReported``, which is where an unmapped concept belongs.
    """
    found = _concept_index().get(concept)
    return found[0] if found else None


def standardize_concepts(values: dict[str, float]) -> tuple[dict[str, float], int, int]:
    """``(standardized, unmapped, collisions)`` for one statement's raw facts.

    ## Collisions are resolved by UPSTREAM CONFIDENCE, not by arrival order

    The buckets are wide: 130 us-gaap tags collapse into ``Revenue``, 58 into
    ``CashAndMarketableSecurities``. A filer routinely tags several of them, so a
    rule is unavoidable — and an ARBITRARY rule silently decides reported
    numbers.

    This was first written as first-wins over the sorted concepts. Measured, that
    picks ``AdmissionsRevenue`` over ``Revenues`` for revenue,
    ``AssetBackedSecuritiesAtCarryingValue`` over
    ``CashAndCashEquivalentsAtCarryingValue`` for cash, and
    ``IncomeLossAttributableToParent`` over ``NetIncomeLoss`` (confidence 1.0,
    used by 86% of filers) for net income. Alphabetical order is deterministic
    and means nothing; determinism is not correctness.

    So the winner is the highest :data:`ConceptRank`, which is upstream's own
    ``confidence`` / ``occurrence_rate`` / ``is_total``, with the concept name
    last purely to make ties total. Every losing candidate is COUNTED.
    """
    index = _concept_index()
    best: dict[str, tuple[ConceptRank, float]] = {}
    unmapped = 0
    collisions = 0
    for concept in sorted(values):
        found = index.get(concept)
        if found is None:
            unmapped += 1
            continue
        tag, rank = found
        incumbent = best.get(tag)
        if incumbent is None:
            best[tag] = (rank, values[concept])
            continue
        collisions += 1
        if rank > incumbent[0]:
            best[tag] = (rank, values[concept])
    return {tag: value for tag, (_rank, value) in best.items()}, unmapped, collisions
