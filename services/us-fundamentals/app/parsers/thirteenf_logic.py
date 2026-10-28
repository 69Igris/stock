"""13F -> ``us_13f_filings`` + ``us_13f_holdings``. PURE — no I/O, no clock.

THE UNIT RULE LIVES HERE, and it is the single most consequential decision in
this service. SEC Release 34-95148 moved Form 13F's value column from THOUSANDS
of dollars to WHOLE DOLLARS for every report **FILED** on or after 2023-01-03.
Keyed on the FILING date, not the period — so a 2023-filed amendment of a 2022
quarter is in dollars while the original report of that same quarter was in
thousands, and a rule written against ``periodOfReport`` gets exactly those
filings wrong.

A 1000x error here does not crash anything. It produces a plausible-looking
portfolio: Berkshire's September-2022 report totals 296,096,640 as filed, which
is either $296 million (wrong, and unremarkable for a fund) or $296 billion
(right). Nothing downstream can tell. That is why:

* the adapter returns the RAW filed number and never converts;
* the applied rule is stored in ``valueUnitRule`` on every filing row;
* edgartools' own heuristic — which infers the unit from implied price per
  share, a different mechanism entirely — is stored beside it in
  ``libraryUnitVerdict``, so a DISAGREEMENT is a column rather than a silence.

AMENDMENTS. ``amendmentType`` is ``RESTATEMENT`` (this report replaces the
original's holdings) or ``NEW HOLDINGS`` (it adds to them). Applying the wrong
one either doubles a portfolio or erases most of it, so the effect is computed
here, recorded on the filing row as filed, and reported in the parse outcome.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any

from app.parsers import SOURCE, as_datetime
from app.sec.adapter_types import ThirteenFCover, ThirteenFRow

#: SEC Release 34-95148. Reports FILED on or after this date carry WHOLE
#: DOLLARS; everything before it is THOUSANDS. This is a boundary on the FILING
#: date and there is no grace period — the first filing of 2023-01-03 is in
#: dollars and the last of 2023-01-02 is in thousands.
UNIT_RULE_CUTOVER = date(2023, 1, 3)

#: The two values ``UsThirteenFFiling.valueUnitRule`` may hold.
RULE_DOLLARS = "DOLLARS"
RULE_THOUSANDS = "THOUSANDS"

#: What a THOUSANDS filing's value column has to be multiplied by.
THOUSANDS_MULTIPLIER = 1000.0

#: Forms this parser owns. ``13F-NT`` is deliberately ABSENT — see
#: :func:`is_notice`.
THIRTEENF_FORMS: frozenset[str] = frozenset({"13F-HR", "13F-HR/A"})


def value_unit_rule(filed_at: date | datetime) -> str:
    """``DOLLARS`` / ``THOUSANDS`` from the FILING date. Never the period.

    The comparison is ``>=``: Release 34-95148 applies to reports filed ON
    2023-01-03 as well as after it.
    """
    day = filed_at.date() if isinstance(filed_at, datetime) else filed_at
    return RULE_DOLLARS if day >= UNIT_RULE_CUTOVER else RULE_THOUSANDS


def to_usd(value_as_filed: float, rule: str) -> float:
    """The filed number as whole US dollars under ``rule``.

    ``UsThirteenFHolding.valueUsd`` is ALWAYS whole dollars whatever the filing
    said; the conversion happens exactly once, here, and the rule that decided
    it is stored on the parent filing row so the arithmetic is reproducible from
    what was written.
    """
    return float(value_as_filed) * (THOUSANDS_MULTIPLIER if rule == RULE_THOUSANDS else 1.0)


def unit_rule_disagrees(rule: str, library_verdict: str | None) -> bool:
    """True when our rule and edgartools' heuristic reached different answers.

    ``None`` is NOT a disagreement: the library declines to guess on an empty
    information table and the private helper it uses can move on an upgrade.
    "No opinion" and "the opposite opinion" are different facts, and folding
    them together would make the disagreement counter fire on every 13F-NT.
    """
    return library_verdict is not None and library_verdict != rule


def is_notice(form: str | None, report_type: str | None = None) -> bool:
    """True for a 13F NOTICE — a filing that reports no holdings at all.

    A 13F-NT says "my positions are reported on another manager's report". It
    carries a cover page and no information table, so it must be stamped
    UNSUPPORTED, never FAILED: FAILED means we could not read a filing we
    should have been able to read, and a queue full of NT filings marked FAILED
    is a permanently red parser with nothing wrong with it.

    Both spellings are checked because they arrive from different places — the
    form comes from the detector's message or the SGML header, the report type
    from the parsed cover page — and a filing only has to say it once.
    """
    if form and form.strip().upper().startswith("13F-NT"):
        return True
    return bool(report_type and "NOTICE" in report_type.strip().upper())


def amendment_effect(cover: ThirteenFCover) -> str:
    """``ORIGINAL`` | ``RESTATEMENT`` | ``NEW_HOLDINGS`` | ``UNKNOWN``.

    ``UNKNOWN`` is a real answer and is kept separate from the other three: an
    amendment whose cover page omits ``amendmentType`` exists, and treating it
    as a restatement would delete a quarter of holdings on the strength of a
    missing element.
    """
    if not cover.is_amendment:
        return "ORIGINAL"
    declared = (cover.amendment_type or "").strip().upper()
    if declared.startswith("RESTATE"):
        return "RESTATEMENT"
    if "NEW HOLDINGS" in declared:
        return "NEW_HOLDINGS"
    return "UNKNOWN"


def supersede_filter(cover: ThirteenFCover, accession: str) -> dict[str, Any] | None:
    """The rows a RESTATEMENT replaces, as a query — or ``None`` for everything else.

    Scoped to ONE manager and ONE period, excluding this filing's own rows, and
    bounded by ``filedAt`` so a restatement can never remove holdings filed
    AFTER it. Returned as data rather than executed here because this module is
    pure; :mod:`app.parsers.dispatch` applies it, and only when armed.

    ``NEW_HOLDINGS`` and ``UNKNOWN`` return ``None`` — a union adds rows and
    removes none, and an amendment that did not say what it is does not get to
    delete a quarter.
    """
    if amendment_effect(cover) != "RESTATEMENT":
        return None
    return {
        "managerCik10": cover.manager_cik10,
        "periodOfReport": as_datetime(cover.period_of_report),
        "accession": {"$ne": accession},
        "filedAt": {"$lte": as_datetime(cover.filed_at)},
    }


def build_filing_row(
    cover: ThirteenFCover,
    *,
    accession: str,
    parser_version: str,
) -> dict[str, Any]:
    """The ``us_13f_filings`` cover row.

    ``totalValueUsd`` is converted under the same rule as the holdings, so the
    summary page and the sum of the rows are denominated alike. They will not be
    EQUAL — a manager's summary counts each position once while the table
    repeats an issuer per other-manager combination — but they must at least be
    in the same units.
    """
    rule = value_unit_rule(cover.filed_at)
    return {
        "accession": accession,
        # From the FILING, not the cover page: a 13F cover carries only a name
        # and an address, and a name-keyed join would merge every "Capital
        # Management LLC" in the country.
        "managerCik10": cover.manager_cik10,
        "managerName": cover.manager_name,
        "periodOfReport": as_datetime(cover.period_of_report),
        "filedAt": as_datetime(cover.filed_at),
        "form": cover.form,
        "isAmendment": cover.is_amendment,
        "amendmentType": cover.amendment_type,
        "amendmentNumber": cover.amendment_number,
        "totalValueUsd": to_usd(cover.total_value_as_filed, rule),
        "totalHoldings": cover.total_holdings,
        "otherManagersCount": cover.other_managers_count,
        # HOT until the evictor (T9) archives the period and proves the shard
        # readable. Nothing here ever writes COLD.
        "tier": "HOT",
        "coldPath": None,
        "valueUnitRule": rule,
        "libraryUnitVerdict": cover.library_unit_verdict,
        "source": SOURCE,
        "parserVersion": parser_version,
    }


def build_holding_rows(
    cover: ThirteenFCover,
    rows: Sequence[ThirteenFRow],
    *,
    accession: str,
    parser_version: str,
    cusip_hits: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """One ``us_13f_holdings`` document per information-table row.

    ``cusip_hits`` maps CUSIP -> an existing ``us_cusip_map`` row. It is READ
    ONLY and may be empty: a holding whose CUSIP has not been resolved stores
    ``symbol: None`` and ``resolvedBy: None``, which is visibly unresolved
    rather than looking like a company with no ticker.
    """
    rule = value_unit_rule(cover.filed_at)
    period = as_datetime(cover.period_of_report)
    filed = as_datetime(cover.filed_at)
    hits = cusip_hits or {}

    documents: list[dict[str, Any]] = []
    for row in rows:
        hit = hits.get(row.cusip) or {}
        documents.append(
            {
                "accession": accession,
                "rowIndex": row.row_index,
                "managerCik10": cover.manager_cik10,
                "periodOfReport": period,
                "filedAt": filed,
                "cusip": row.cusip,
                # Optional on the form since EDGAR Release 22.4.1 and genuinely
                # absent in practice — Berkshire omits it on all 89 rows of its
                # 2026 filing — so this is null far more often than not.
                "figi": row.figi,
                "issuerName": row.issuer_name,
                "titleOfClass": row.title_of_class,
                "valueUsd": to_usd(row.value_as_filed, rule),
                "shares": row.shares,
                "sharesType": row.shares_type,
                "putCall": row.put_call,
                "investmentDiscretion": row.investment_discretion,
                "otherManagers": list(row.other_managers),
                "votingSole": row.voting_sole,
                "votingShared": row.voting_shared,
                "votingNone": row.voting_none,
                "symbol": hit.get("symbol"),
                "issuerCik10": hit.get("cik10"),
                "resolvedBy": hit.get("source") if hit.get("symbol") else None,
                "source": SOURCE,
                "parserVersion": parser_version,
            }
        )
    return documents
