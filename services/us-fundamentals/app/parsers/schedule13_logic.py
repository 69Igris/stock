"""Schedules 13D/13G -> ``us_beneficial_ownership``. PURE — no I/O, no clock.

ONE ROW PER REPORTING PERSON, because that is what the schedule reports: a
filing by four affiliated entities is four positions with four different voting
and dispositive breakdowns, and collapsing them to one loses the structure that
makes a 13D readable.

``hasStructuredData`` IS THE POINT OF THIS MODULE. Structured XML became
mandatory on 2024-12-18. Everything before that is HTML, so there is no
machine-readable percent, share count or voting split — and without the flag a
null ``percentOfClass`` on a 2019 filing is indistinguishable from a real zero.
The legacy branch still stores the identities, because a cover page pairing a
CUSIP with a subject CIK is the FIRST and only primary-source tier of the CUSIP
map, and identities are exactly what it needs.

WHAT IS DROPPED, on purpose: ``Schedule13Row.citizenship`` has no column in
``UsBeneficialOwnership``. It is left unwritten rather than folded into another
field — a value stored somewhere it does not belong is worse than a value not
stored, because the next reader believes the field name.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from typing import Any

from app.parsers import SOURCE, as_datetime
from app.sec.adapter_types import Schedule13Cover, Schedule13Row

#: The 2024-12-18 XML mandate. Before it, 13D/G filings are HTML and yield
#: identities only. Recorded as a constant because the flag it produces is the
#: difference between "not machine-readable" and "zero".
STRUCTURED_DATA_MANDATE = date(2024, 12, 18)

#: Both spellings, and both matter. The live feed emits ``SCHEDULE 13D`` since
#: the mandate; the whole of history before it is ``SC 13D``. A classifier that
#: knows one silently drops half the filings.
SCHEDULE13_FORMS: frozenset[str] = frozenset(
    {
        "SC 13D",
        "SC 13D/A",
        "SC 13G",
        "SC 13G/A",
        "SCHEDULE 13D",
        "SCHEDULE 13D/A",
        "SCHEDULE 13G",
        "SCHEDULE 13G/A",
    }
)


def expects_structured_data(filed_at: date | datetime | None) -> bool:
    """Whether a filing of this date SHOULD have carried structured XML.

    Compared against what the parse actually found, this separates "old filing,
    HTML by law" from "recent filing whose XML we failed to read" — two states
    that produce identical rows and need completely different responses.
    """
    if filed_at is None:
        return False
    day = filed_at.date() if isinstance(filed_at, datetime) else filed_at
    return day >= STRUCTURED_DATA_MANDATE


def build_rows(
    cover: Schedule13Cover,
    rows: Sequence[Schedule13Row],
    *,
    accession: str,
    filed_at: date | datetime | None = None,
    symbol: str | None = None,
    parser_version: str,
) -> list[dict[str, Any]]:
    """One ``us_beneficial_ownership`` document per reporting person.

    ``filed_at`` falls back to the cover's own date. The column is NOT nullable
    in the schema, so a filing whose header carried neither is a parse failure
    and is raised as one rather than stored with a fabricated date.
    """
    filed = as_datetime(filed_at if filed_at is not None else cover.filed_at)
    if filed is None:
        raise ValueError(f"{accession}: 13D/G has no filing date; refusing to invent one")

    event = as_datetime(cover.event_date)
    documents: list[dict[str, Any]] = []
    for row in rows:
        documents.append(
            {
                "accession": accession,
                "rowIndex": row.row_index,
                "schedule": cover.schedule,
                # As filed, so the pre/post-mandate spelling survives.
                "form": cover.form,
                "isAmendment": cover.is_amendment,
                "amendmentNumber": cover.amendment_number,
                "subjectCik10": cover.subject_cik10,
                "subjectName": cover.subject_name,
                "cusip": cover.cusip,
                "symbol": symbol,
                "filerCik10": row.filer_cik10,
                "filerName": row.filer_name,
                "percentOfClass": row.percent_of_class,
                "sharesOwned": row.shares_owned,
                "soleVoting": row.sole_voting,
                "sharedVoting": row.shared_voting,
                "soleDispositive": row.sole_dispositive,
                "sharedDispositive": row.shared_dispositive,
                "typeOfReportingPerson": row.type_of_reporting_person,
                "eventDate": event,
                "filedAt": filed,
                "purposeText": cover.purpose_text,
                # Straight from the adapter. Hard-coding this True is the
                # defect the flag exists to prevent: every legacy filing would
                # then claim a machine-readable zero it never carried.
                "hasStructuredData": cover.has_structured_data,
                "source": SOURCE,
                "parserVersion": parser_version,
            }
        )
    return documents


def cusip_seed(cover: Schedule13Cover) -> dict[str, Any] | None:
    """The (CUSIP, subject CIK, subject name) triple this filing contributes.

    Tier (a) of the CUSIP map, and the only tier that is primary-source in the
    strict sense: the filer wrote both identifiers on one cover page, under
    penalty of perjury, about a company we already know by CIK.

    ``None`` when the cover carries no CUSIP — which is most legacy filings,
    since the pre-mandate HTML has no machine-readable CUSIP at all.
    """
    cusip = (cover.cusip or "").strip().upper()
    if not cusip or not cover.subject_cik10:
        return None
    return {
        "cusip": cusip,
        "cik10": cover.subject_cik10,
        "issuerName": cover.subject_name or None,
    }
