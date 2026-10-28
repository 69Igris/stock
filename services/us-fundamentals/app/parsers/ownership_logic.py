"""Forms 3/4/5 -> ``us_insider_transactions`` rows. PURE — no I/O, no clock.

TRANSACTIONS AND HOLDINGS, both. Form 3 is holdings almost entirely, so a parser
that stored only transactions would make an initial statement of ownership look
like a filing with nothing in it. They are distinguished by ``isHolding``,
because counting a disclosed position as a trade overstates insider activity.

THE VALUE RULE IS A COPY, NOT A COMPUTATION. ``OwnershipRow.value`` is already
``shares x price when BOTH exist, else None`` (`edgar_adapter._ownership_row`).
This module must pass it through UNTOUCHED — in particular it must never write
``value or 0.0``, which is the one-character version of this bug: a bona fide
gift (code G) has no price, and a stored ``0`` reads as a free transfer of
nothing rather than as an untold value. A REAL zero (an option exercised at a
strike of 0.00) is a different fact and stays 0.0.

``K`` AND ``V`` ARE NOT CODES. ``K`` is EDGAR appending a flag when
``<equitySwapInvolved>`` is set and lives on ``equitySwap``; ``V`` is
``<transactionTimeliness>`` E/L/empty and lives on ``timeliness``. Both come off
the adapter already separated; nothing here may fold them back into
``transactionCode``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from datetime import date, datetime
from typing import Any

from app.parsers import SOURCE, as_datetime
from app.sec.adapter_types import OwnershipCover, OwnershipRow

#: Forms this parser owns, including their amendments.
OWNERSHIP_FORMS: frozenset[str] = frozenset({"3", "4", "5", "3/A", "4/A", "5/A"})

#: Everything that is not an identifying character of a ticker. SEC writes share
#: classes with a slash (``BRK/B``), Nasdaq with a dot (``BRK.B``) and our
#: security master with a dash (``BRK-B``, and ``SPG-P-J`` for a preferred), so
#: the join has to be done on one spelling. Dash is ours.
_CLASS_SEPARATORS = re.compile(r"[./\s]+")


def normalise_symbol(value: str | None) -> str | None:
    """``BRK/B`` -> ``BRK-B``. ``None``/blank -> ``None``.

    Only separators are rewritten. Nothing is stripped: a symbol that normalises
    to a DIFFERENT security would be worse than no symbol at all, which is the
    whole reason the resolver below refuses to guess.
    """
    if value is None:
        return None
    text = _CLASS_SEPARATORS.sub("-", value.strip().upper())
    return text or None


def resolve_symbol(
    issuer_ticker: str | None,
    candidates: Sequence[Mapping[str, Any]],
) -> str | None:
    """Our symbol for this issuer, or ``None`` when it cannot be decided.

    ``candidates`` are ACTIVE ``us_instruments`` rows already filtered to the
    issuer's CIK. There are usually several: measured on prod, BAC has 16
    tickers on one CIK (common plus fifteen preferreds) and PSA has 17, so
    "the filer's CIK" does not identify a listing on its own.

    Two rules, and the second is the one that matters:

    1. The issuer's own ``issuerTradingSymbol``, normalised, wins when it names
       one of the candidates. That is the filer telling us which listing this
       filing is about.
    2. Otherwise a SINGLE candidate is unambiguous and is used; two or more are
       AMBIGUOUS and resolve to ``None``.

    Never a guess, never a "closest match". A wrong symbol attaches one
    company's insider activity to another, and the null is recoverable — the
    CIK is stored on every row, so a later pass can fill it in — while a wrong
    ticker is not, because nothing downstream can tell it from a right one.
    """
    by_symbol: dict[str, str] = {}
    for row in candidates:
        stored = row.get("symbol")
        if not isinstance(stored, str):
            continue
        key = normalise_symbol(stored)
        if key:
            by_symbol.setdefault(key, stored)

    wanted = normalise_symbol(issuer_ticker)
    if wanted and wanted in by_symbol:
        return by_symbol[wanted]
    if len(by_symbol) == 1:
        return next(iter(by_symbol.values()))
    return None


def build_rows(
    cover: OwnershipCover,
    rows: Sequence[OwnershipRow],
    *,
    accession: str,
    filed_at: date | datetime,
    accepted_at: datetime | None,
    symbol: str | None,
    parser_version: str,
) -> list[dict[str, Any]]:
    """One ``us_insider_transactions`` document per table line.

    ``rowIndex`` is the adapter's, which runs across the combined
    non-derivative then derivative tables, and it is half the storage key: a
    Form 4 legitimately reports the same security, code, date, share count and
    price twice (two lots, two footnotes), so any "natural" key over the
    economics would silently collapse them into one row.
    """
    filed = as_datetime(filed_at)
    reporting_period = as_datetime(cover.reporting_period)
    accepted = as_datetime(accepted_at)

    documents: list[dict[str, Any]] = []
    for row in rows:
        documents.append(
            {
                "accession": accession,
                "rowIndex": row.row_index,
                "issuerCik10": cover.issuer_cik10,
                "issuerName": cover.issuer_name,
                "issuerTicker": cover.issuer_ticker,
                "symbol": symbol,
                "ownerCik10": cover.owner_cik10,
                "ownerName": cover.owner_name,
                "isDirector": cover.is_director,
                "isOfficer": cover.is_officer,
                "isTenPctOwner": cover.is_ten_pct_owner,
                "isOther": cover.is_other,
                "officerTitle": cover.officer_title,
                "form": cover.form,
                "transactionDate": as_datetime(row.transaction_date),
                "reportingPeriod": reporting_period,
                "filedAt": filed,
                "acceptedAt": accepted,
                "securityTitle": row.security_title,
                "isDerivative": row.is_derivative,
                "isHolding": row.is_holding,
                "transactionCode": row.transaction_code,
                "codeMeaning": row.code_meaning,
                "timeliness": row.timeliness,
                "equitySwap": row.equity_swap,
                "acquiredDisposed": row.acquired_disposed,
                "shares": row.shares,
                "price": row.price,
                # Straight through. See the module docstring: `or 0.0` here is
                # the gift bug.
                "value": row.value,
                "sharesOwnedAfter": row.shares_owned_after,
                "directIndirect": row.direct_indirect,
                "natureOfOwnership": row.nature_of_ownership,
                "underlyingSecurity": row.underlying_security,
                "underlyingShares": row.underlying_shares,
                "exercisePrice": row.exercise_price,
                "exerciseDate": as_datetime(row.exercise_date),
                "expirationDate": as_datetime(row.expiration_date),
                "footnotes": list(row.footnotes),
                "isAmendment": cover.is_amendment,
                "source": SOURCE,
                "parserVersion": parser_version,
            }
        )
    return documents


def count_holdings(rows: Sequence[OwnershipRow]) -> tuple[int, int]:
    """``(transactions, holdings)`` — reported so the split is visible per run.

    A run whose rows are 100% holdings is a run of Form 3s, which is normal; a
    run whose rows are 100% holdings on Form 4s is a parser that stopped
    reading transaction elements, which is not. The two are only
    distinguishable if the counter exists.
    """
    holdings = sum(1 for row in rows if row.is_holding)
    return len(rows) - holdings, holdings
