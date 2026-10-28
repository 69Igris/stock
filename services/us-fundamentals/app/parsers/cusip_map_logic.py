"""CUSIP -> ticker: the decisions. PURE — no I/O, no clock, no network.

13F reports positions by CUSIP and nothing else, and no official SEC file maps
one to a ticker. So resolution is LAYERED, and the order is deliberate: three
primary/in-house tiers before any third party.

``SEC_13DG``     a 13D/G cover page publishes the subject's CUSIP and the
                 subject's CIK together, filed by the person who owns the stake.
                 Primary source in the strict sense, and ours already.
``TIINGO_FIGI``  the 13F ``figi`` column equals ``UsInstrument.openFIGIComposite``.
                 MEASURED WEAK: the column has been optional since EDGAR Release
                 22.4.1 and Berkshire omits it on all 89 rows of its 2026
                 filing, so this tier will resolve very little. Its hit-rate is
                 REPORTED per run rather than assumed, because a tier that
                 quietly resolves nothing looks exactly like a tier that was
                 never reached.
``SEC_FTD``      SEC's Fails-to-Deliver files pair CUSIP with SYMBOL directly —
                 but only for securities with an open fail, so coverage is
                 partial and rolls with the market.
``OPENFIGI``     Bloomberg's free mapping API. The FIGI identifiers are a
                 public-domain dedication: storable and redistributable.

A LOWER TIER MAY NEVER OVERWRITE A HIGHER ONE. That is the whole reason
``UsCusipMap.source`` exists — a wrong mapping has to be traceable to the
mechanism that produced it, and a nightly OpenFIGI sweep silently replacing a
13D/G-sourced row would erase exactly that.

UNRESOLVED IS A ROW. A CUSIP nobody could map, recorded with an ``attempts``
count, is retried weekly and reported as a coverage number. The same CUSIP not
recorded at all is retried by every sweep forever and is invisible in both.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from typing import Any

#: Strongest first. Position in this tuple IS the precedence.
TIER_ORDER: tuple[str, ...] = ("SEC_13DG", "TIINGO_FIGI", "SEC_FTD", "OPENFIGI")

#: Not a tier. The recorded absence of an answer.
UNRESOLVED = "UNRESOLVED"

#: ``UsCusipMap.confidence``. 1.0 for the identifier-joined tiers; OpenFIGI's
#: ``exchCode: "US"`` match is a venue match rather than an identifier match, so
#: it is flagged lower — never to PICK between tiers (the order does that), only
#: to mark a row for review.
TIER_CONFIDENCE: Mapping[str, float] = {
    "SEC_13DG": 1.0,
    "TIINGO_FIGI": 1.0,
    "SEC_FTD": 1.0,
    "OPENFIGI": 0.9,
}

#: OpenFIGI's ``/v3/mapping`` accepts 100 jobs per request with an API key and
#: 10 without one. Sending 100 unkeyed is a 400 for the whole batch, so the
#: batch size is derived from whether a key exists rather than fixed.
KEYED_BATCH_JOBS = 100
UNKEYED_BATCH_JOBS = 10

#: Rate ceilings, as documented and as measured: 25 requests per 6 seconds with
#: a key, 25 per minute without. This is a SEPARATE host from sec.gov and must
#: never consume the shared SEC budget — the two limits protect two different
#: upstreams and merging them would either throttle us to SEC's pace on OpenFIGI
#: or, far worse, spend SEC's per-IP allowance on Bloomberg.
KEYED_RATE = (25, 6.0)
UNKEYED_RATE = (25, 60.0)

#: A CUSIP is 9 characters: 8 of issue plus a check digit, alphanumeric.
_CUSIP_RE = re.compile(r"^[0-9A-Z]{9}$")

#: OpenFIGI spells share classes with a SLASH (``BRK/B``) where our security
#: master uses a dash (``BRK-B``). Verified against prod: OpenFIGI returns
#: ticker ``BRK/B`` and compositeFIGI ``BBG000DWG505`` for CUSIP 084670702,
#: while ``us_instruments`` holds ``BRK-B``. Without this rewrite the tier
#: resolves the FIGI and then fails to find the symbol, which reads as "OpenFIGI
#: has no answer" rather than as a spelling difference.
_TICKER_SEPARATORS = re.compile(r"[./\s]+")


def normalise_cusip(value: str | None) -> str | None:
    """Trimmed, upper-cased, validated. ``None`` when it is not a CUSIP.

    Rejecting rather than storing keeps ``us_cusip_map`` from accumulating rows
    keyed on truncated or blank identifiers, each of which would be retried
    weekly forever and counted against coverage.
    """
    if not value:
        return None
    text = value.strip().upper()
    return text if _CUSIP_RE.match(text) else None


def normalise_ticker(value: str | None) -> str | None:
    """``BRK/B`` -> ``BRK-B``. See ``_TICKER_SEPARATORS``."""
    if not value:
        return None
    text = _TICKER_SEPARATORS.sub("-", value.strip().upper())
    return text or None


def tier_rank(source: str | None) -> int:
    """Lower is stronger. Anything unknown — including ``UNRESOLVED`` — ranks LAST.

    Unknown-ranks-last is the same rule as ``FINANCIALS_AUTHORITY`` on the India
    side, and for the same reason: a tier added later can fill a gap but can
    never displace a primary source just by existing.
    """
    try:
        return TIER_ORDER.index(source or "")
    except ValueError:
        return len(TIER_ORDER)


def may_overwrite(existing_source: str | None, new_source: str) -> bool:
    """Whether ``new_source`` is allowed to replace ``existing_source``.

    Equal ranks pass: that is the same tier re-resolving, which is a refresh.
    A strictly weaker tier is refused. An absent or ``UNRESOLVED`` existing row
    is replaceable by anything, which is what turns a recorded failure into a
    resolution instead of a duplicate.
    """
    return tier_rank(new_source) <= tier_rank(existing_source)


def chunk(items: Sequence[str], size: int) -> Iterator[list[str]]:
    """Fixed-size batches. Raises on a non-positive size rather than looping forever."""
    if size <= 0:
        raise ValueError(f"batch size must be positive, got {size}")
    for start in range(0, len(items), size):
        yield list(items[start : start + size])


def batch_size(has_key: bool) -> int:
    return KEYED_BATCH_JOBS if has_key else UNKEYED_BATCH_JOBS


def rate_limit(has_key: bool) -> tuple[int, float]:
    """``(requests, per_seconds)`` for the pacer. Keyed 25/6 s, unkeyed 25/60 s."""
    return KEYED_RATE if has_key else UNKEYED_RATE


def build_jobs(cusips: Sequence[str]) -> list[dict[str, str]]:
    """The ``/v3/mapping`` request body for one batch.

    ``exchCode: "US"`` narrows to US-listed securities. It is a filter, not a
    guarantee: OpenFIGI can still return several rows (a security quoted on more
    than one US venue), which is why :func:`interpret_mapping` takes the first
    US row and marks the confidence below 1.0.
    """
    return [{"idType": "ID_CUSIP", "idValue": cusip, "exchCode": "US"} for cusip in cusips]


def interpret_mapping(entry: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """One element of OpenFIGI's response array -> a match, or ``None``.

    A MISS IS NOT AN ERROR. OpenFIGI answers an unmappable CUSIP with
    ``{"warning": "No identifier found."}`` or with an empty ``data`` array, and
    both mean "this identifier is not in the FIGI universe" — a fact, not a
    failure. Raising here would abort a batch of 100 because one delisted CUSIP
    was in it.
    """
    if not entry or "data" not in entry:
        return None
    rows = entry.get("data")
    if not isinstance(rows, list) or not rows:
        return None
    first = rows[0]
    if not isinstance(first, Mapping):
        return None
    ticker = normalise_ticker(first.get("ticker"))
    composite = first.get("compositeFIGI") or first.get("figi")
    if not ticker and not composite:
        return None
    return {
        "symbol": ticker,
        "compositeFigi": composite,
        "issuerName": first.get("name") or None,
        "securityType": first.get("securityType") or None,
    }


def resolution_row(
    cusip: str,
    *,
    source: str,
    symbol: str | None = None,
    cik10: str | None = None,
    composite_figi: str | None = None,
    issuer_name: str | None = None,
    attempts: int = 0,
    resolved_at: Any = None,
    last_tried_at: Any = None,
) -> dict[str, Any]:
    """One ``us_cusip_map`` document.

    ``resolvedAt`` is set only when something was actually resolved; an
    UNRESOLVED row carries ``lastTriedAt`` and an ``attempts`` count instead, so
    "we asked and nobody knew" is a different stored state from "we never
    asked".
    """
    resolved = source != UNRESOLVED and bool(symbol or composite_figi or cik10)
    return {
        "cusip": cusip,
        "symbol": symbol,
        "cik10": cik10,
        "compositeFigi": composite_figi,
        "issuerName": issuer_name,
        "source": source if resolved else UNRESOLVED,
        "confidence": TIER_CONFIDENCE.get(source, 0.0) if resolved else 0.0,
        "attempts": attempts,
        "resolvedAt": resolved_at if resolved else None,
        "lastTriedAt": last_tried_at,
    }


def plan_writes(
    candidates: Mapping[str, Mapping[str, Any]],
    existing: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Filter proposed rows down to the ones a stronger tier does not already own.

    ``candidates`` is CUSIP -> a row from :func:`resolution_row`; ``existing`` is
    CUSIP -> the stored row. This is the guard the module docstring is about,
    and it is expressed once, here, so that every tier goes through it rather
    than each one remembering to.
    """
    writes: list[dict[str, Any]] = []
    for cusip, candidate in candidates.items():
        stored = existing.get(cusip)
        if stored is None:
            writes.append(dict(candidate))
            continue
        if not may_overwrite(stored.get("source"), candidate["source"]):
            continue
        merged = dict(candidate)
        # `attempts` is cumulative across sweeps: a CUSIP three tiers have now
        # failed on is a different coverage story from one nobody has tried.
        merged["attempts"] = int(stored.get("attempts") or 0) + int(candidate.get("attempts") or 0)
        writes.append(merged)
    return writes


def tier_report(counts: Mapping[str, int], attempted: int) -> dict[str, Any]:
    """The per-tier hit-rate, reported rather than assumed.

    ``TIINGO_FIGI`` is the reason this exists: the plan treated it as a cheap
    early tier and T4 measured the ``figi`` column genuinely absent, so a run
    that resolves nothing through it is EXPECTED and must be distinguishable
    from a run where the join broke.
    """
    resolved = sum(counts.get(tier, 0) for tier in TIER_ORDER)
    return {
        "attempted": attempted,
        "resolved": resolved,
        "unresolved": max(attempted - resolved, 0),
        "byTier": {tier: counts.get(tier, 0) for tier in TIER_ORDER},
        "hitRate": {
            tier: (counts.get(tier, 0) / attempted if attempted else 0.0) for tier in TIER_ORDER
        },
    }


def distinct_cusips(values: Iterable[str | None]) -> list[str]:
    """Normalised, de-duplicated, order-preserving."""
    seen: dict[str, None] = {}
    for value in values:
        cusip = normalise_cusip(value)
        if cusip:
            seen.setdefault(cusip, None)
    return list(seen)
