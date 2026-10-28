"""The ONLY module in this repository allowed to ``import edgar``.

`tests/test_edgartools_pin.py` greps the tree to enforce that. The rule exists
because edgartools is a PARSER WHOSE OUTPUT WE STORE AS NUMBERS: a minor
upgrade can change a standardised concept mapping and therefore change a
reported revenue, with no test failing anywhere. Confining the import to one
file makes the blast radius one file, and makes the version pin meaningful.

WHAT THIS MODULE DOES NOT DO: fetch. Every function takes bytes, a string, or a
decoded dict and returns our own frozen dataclasses. `app/sec/client.py` owns
the network and the shared 9 req/s budget; an adapter that could fetch would be
a second, unmetered path to sec.gov.

WHERE WE USE THE LIBRARY AND WHERE WE DO NOT
--------------------------------------------
Measured against the 5.53.0 source, not inferred from its documentation. Three
of the library's parsers CANNOT be used, and two of those reach the network
from what look like pure functions:

* ``Ownership.parse_xml`` calls ``Entity(int(cik))`` for every reporting owner
  (``ownership/owners.py:114``) purely to decide whether to reverse a personal
  name — a live SEC fetch inside a function that takes a string. It also never
  parses ``transactionTimeliness`` (zero hits for the word in the whole
  package) and its transaction-code table is missing **J, K, L, V and W**
  (``ownership/models.py:86``). So Forms 3/4/5 are parsed here with lxml.
* ``parse_infotable_xml`` calls ``cusip_ticker_mapping()``
  (``thirteenf/parsers/infotable_xml.py:125``), and emits no ``figi`` column at
  all. So the 13F information table is parsed here with lxml. The library's
  COVER-PAGE parser is pure and is used.
* ``EntityFactsParser.parse_company_facts`` silently drops ``frame``
  (``entity/parser.py:177-224``; the string does not appear anywhere in the
  package) and swallows every exception into ``None``
  (``entity/parser.py:141``). ``frame`` is SEC's own answer to which fact fits
  a calendar period — the one de-duplication signal it publishes — so
  companyfacts is parsed here from the raw JSON.
* ``EightK.items`` walks ``filing.html()`` → ``filing.homepage`` → NETWORK
  (``company_reports/current_report.py:703`` → ``_filings.py:2288``), even for
  a filing built from local SGML. 8-K items are read here from the SGML
  header's ``ITEM INFORMATION`` lines and mapped through SEC's own Form 8-K
  item table.

What the library IS used for is the part that would be absurd to reimplement:
the XBRL stack. ``Filing.from_sgml_text(...).xbrl().statements`` resolves
schema, labels, presentation, calculation and definition linkbases from the
bundle's own bytes and applies a 2,924-entry standardisation map. Verified to
touch no socket when the Filing came from SGML text — `test_edgar_adapter.py`
asserts that with `socket.socket` patched to raise.

ONE CAVEAT, because it is a real hole rather than a theoretical one:
``Filing.period_of_report`` falls back to ``self.homepage`` (network) when the
SGML header carries no ``CONFORMED PERIOD OF REPORT``, and ``XBRL.from_filing``
reads it (``xbrl/xbrl.py:664``) inside a bare ``except Exception: pass``. Real
filings always carry the header line, so this never fires in practice — but it
fires SILENTLY if one ever does not, which is why the client, not this module,
must remain the only thing holding the rate limiter.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import tempfile
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from lxml import etree
from pypdf import PdfReader

from app.sec.adapter_types import (
    CompanyFactSeries,
    CompanyFactValue,
    CurrentFilingEntry,
    DailyIndexRow,
    EftsHit,
    EightKDoc,
    EightKMeta,
    FilingRef,
    OwnershipCover,
    OwnershipRow,
    Schedule13Cover,
    Schedule13Row,
    StatementLine,
    StatementSet,
    SubmissionsFiler,
    ThirteenFCover,
    ThirteenFRow,
)

# ── edgartools environment, set BEFORE the import ───────────────────────────
#
# This is the one place in this service where a module-scope environment read
# is CORRECT rather than the bug the repo conventions warn about. edgartools
# snapshots `EDGAR_LOCAL_DATA_DIR` into a module global at import
# (`settings.py:106`) and, during that same import, MKDIRS the directory and on
# a first-ever import `shutil.rmtree`s `<dir>/_tcache`
# (`__init__.py:137` -> `httpclient.py:453,490`). Setting it afterwards is
# therefore not merely ineffective — it silently writes to the wrong place, and
# under a non-root container user `~/.edgar` is not writable, so `import edgar`
# raises at import time and the whole service fails to boot.
#
# `EDGAR_IDENTITY` has a sharper failure mode: unset, `get_identity()` PROMPTS
# ON STDIN with a 60-second timer (`settings.py:152-172`). In a Cloud Run
# container that is a request that hangs for a minute and then fails.


def _bootstrap_edgar_env() -> None:
    """Populate the environment edgartools reads at import, without clobbering it.

    Every value the deployment already set wins. The defaults exist so that a
    test, a script or a mis-provisioned revision degrades to something inert
    instead of prompting on stdin or writing to a read-only home directory.
    """
    os.environ.setdefault("EDGAR_LOCAL_DATA_DIR", str(Path(tempfile.gettempdir()) / "edgar"))
    if not os.environ.get("EDGAR_IDENTITY"):
        # Deliberately NOT a generic agent string: SEC answers those with a 403
        # whose body reads "Undeclared Automated Tool". This module never
        # fetches, so the value only matters if something else in the process
        # does — but a wrong default here would be invisible until it was.
        os.environ["EDGAR_IDENTITY"] = "UseMoney/1.0 (deepshaswat@gmail.com)"
    os.environ.setdefault("EDGAR_RATE_LIMIT_PER_SEC", "9")


_bootstrap_edgar_env()

import edgar  # noqa: E402
from edgar import Filing  # noqa: E402
from edgar.beneficial_ownership import Schedule13D, Schedule13G  # noqa: E402
from edgar.thirteenf import parse_primary_document_xml  # noqa: E402

#: Bumped whenever the mapping rules in THIS file change, so a reparse is
#: identifiable and a bad parse is re-runnable rather than indistinguishable
#: from the truth. Stored on every row as `parserVersion`.
PARSER_VERSION = f"edgar_adapter/1 edgartools/{edgar.__version__}"

# ── SEC's own transaction-code table ────────────────────────────────────────
#
# From the Form 345 `TransCodeList` in SEC's EDGAR ownership XML technical
# specification — NOT from `edgar/ownership/models.py:86`, whose three separate
# copies of this table are each missing entries (`DESCRIPTIONS` lacks J, K, L,
# V and W). A missing code does not raise there; it falls through to returning
# the raw letter, so an unmapped transaction stores the string "L" as its own
# meaning and looks like data.
#
# TWO ENTRIES OF THE PRINTED 20-CODE TABLE ARE NOT CODES, and conflating them
# with codes is how a parser invents transactions that never happened:
#
#   K  EDGAR APPENDS this to a displayed code when `<equitySwapInvolved>` is
#      true. It is a FLAG on a transaction, not a transaction type, and it
#      lives on `OwnershipRow.equity_swap`.
#   V  does not exist in the XML at all. The printed form's "V" is
#      `<transactionTimeliness>` — E (early) / L (late) / empty (on time) — and
#      it lives on `OwnershipRow.timeliness`.
TRANSACTION_CODES: dict[str, str] = {
    "A": "Grant, award or other acquisition pursuant to Rule 16b-3(d)",
    "C": "Conversion of derivative security",
    "D": "Disposition to the issuer of issuer equity securities pursuant to Rule 16b-3(e)",
    "E": "Expiration of short derivative position",
    "F": "Payment of exercise price or tax liability by delivering or withholding securities",
    "G": "Bona fide gift",
    "H": "Expiration (or cancellation) of long derivative position with value received",
    "I": "Discretionary transaction in accordance with Rule 16b-3(f)",
    "J": "Other acquisition or disposition (describe transaction)",
    "L": "Small acquisition under Rule 16a-6",
    "M": "Exercise or conversion of derivative security exempted pursuant to Rule 16b-3",
    "O": "Exercise of out-of-the-money derivative security",
    "P": "Open market or private purchase of securities",
    "S": "Open market or private sale of securities",
    "U": "Disposition pursuant to a tender of shares in a change of control transaction",
    "W": "Acquisition or disposition by will or the laws of descent and distribution",
    "X": "Exercise of in-the-money or at-the-money derivative security",
    "Z": "Deposit into or withdrawal from voting trust",
}

# ── SEC's own Form 8-K item table ───────────────────────────────────────────
#
# The SGML header publishes item DESCRIPTIONS ("Results of Operations and
# Financial Condition"), while `UsFiling.items` and every downstream consumer
# use NUMBERS ("2.02"). This maps one to the other. Keys are normalised (lower
# case, punctuation stripped) because SEC's own spelling drifts between the
# header and the document body — apostrophes, ampersands and the Oxford comma
# all vary.
_EIGHTK_ITEMS: dict[str, str] = {
    "entry into a material definitive agreement": "1.01",
    "termination of a material definitive agreement": "1.02",
    "bankruptcy or receivership": "1.03",
    "mine safety reporting of shutdowns and patterns of violations": "1.04",
    "material cybersecurity incidents": "1.05",
    "completion of acquisition or disposition of assets": "2.01",
    "results of operations and financial condition": "2.02",
    "creation of a direct financial obligation or an obligation under an "
    "off-balance sheet arrangement of a registrant": "2.03",
    "triggering events that accelerate or increase a direct financial obligation or an "
    "obligation under an off-balance sheet arrangement": "2.04",
    "costs associated with exit or disposal activities": "2.05",
    "material impairments": "2.06",
    "notice of delisting or failure to satisfy a continued listing rule or standard "
    "transfer of listing": "3.01",
    "unregistered sales of equity securities": "3.02",
    "material modification to rights of security holders": "3.03",
    "changes in registrants certifying accountant": "4.01",
    "non-reliance on previously issued financial statements or a related audit report or "
    "completed interim review": "4.02",
    "changes in control of registrant": "5.01",
    "departure of directors or certain officers election of directors appointment of "
    "certain officers compensatory arrangements of certain officers": "5.02",
    "amendments to articles of incorporation or bylaws change in fiscal year": "5.03",
    "temporary suspension of trading under registrants employee benefit plans": "5.04",
    "amendments to the registrants code of ethics or waiver of a provision of the "
    "code of ethics": "5.05",
    "change in shell company status": "5.06",
    "submission of matters to a vote of security holders": "5.07",
    "shareholder director nominations": "5.08",
    "abs informational and computational material": "6.01",
    "change of servicer or trustee": "6.02",
    "change in credit enhancement or other external support": "6.03",
    "failure to make a required distribution": "6.04",
    "securities act updating disclosure": "6.05",
    "static pool": "6.06",
    "regulation fd disclosure": "7.01",
    "other events": "8.01",
    "financial statements and exhibits": "9.01",
}


def _normalise_item_label(text: str) -> str:
    cleaned = re.sub(r"[^\w\s-]", " ", text.lower())
    return re.sub(r"\s+", " ", cleaned).strip()


# ── small shared helpers ────────────────────────────────────────────────────


def cik10(value: str | int | None) -> str:
    """Zero-pad a CIK to the 10-digit form every EDGAR URL and filename uses.

    Stored padded so a join never has to guess which spelling it is looking at.
    """
    if value is None:
        return ""
    digits = re.sub(r"\D", "", str(value))
    return digits.zfill(10) if digits else ""


def _date(value: str | date | datetime | None) -> date | None:
    """Parse the four date spellings SEC uses, and nothing else.

    Returns None rather than raising: a filing with one unparseable date is a
    filing we still want, and a parser that raises turns one bad field into a
    whole lost batch.
    """
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y", "%m-%d-%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _float(value: Any) -> float | None:
    """Numeric or None — never 0.0 as a stand-in for 'absent'."""
    if value is None or value == "":
        return None
    try:
        result = float(str(value).replace(",", "").replace("$", ""))
    except (TypeError, ValueError):
        return None
    return None if result != result else result  # NaN is not a value


#: BSON stores an integer in at most 8 bytes. pymongo raises above this.
BSON_INT64_MAX = 2**63 - 1
BSON_INT64_MIN = -(2**63)


def _bson_safe_val(value: Any) -> Any:
    """One reported ``val``, in a form pymongo can actually encode.

    SEC ships ``val`` AS FILED, and some filers file nonsense — a share count of
    1e19, a figure that does not fit in eight bytes. ``companyfacts._value_doc``
    puts this straight into a Prisma ``Json`` column, so an out-of-range int
    raises ``OverflowError: MongoDB can only handle up to 8-byte ints``. That
    took the whole first production companyfacts run down at ONE filer, 4,500 of
    20,290 members in (MONEY-1284), and every retry died at the same CIK because
    the walk is deterministic.

    An out-of-range int becomes a FLOAT rather than being dropped. The precision
    lost at 1e19 is meaningless, the MAGNITUDE is the interesting part, and a
    reader who sees an absurd number learns that the filer filed an absurd
    number — whereas a dropped fact is indistinguishable from one SEC never
    published.

    NaN and infinity return ``None``, matching :func:`_float`: they are not
    values, and the caller already skips a ``None`` ``val``.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value if BSON_INT64_MIN <= value <= BSON_INT64_MAX else float(value)
    if isinstance(value, float):
        # NaN != NaN, and +/-inf survives BSON but means nothing downstream.
        return value if value == value and value not in (float("inf"), float("-inf")) else None
    return value


def _bool(value: Any) -> bool:
    """SEC spells the same boolean four ways in the same form family.

    The two Form 4 fixtures alone carry `<equitySwapInvolved>false</...>` and
    `<equitySwapInvolved>0</...>`. Anything not affirmatively true is false.
    """
    return str(value).strip().lower() in {"1", "true", "y", "yes"}


def _clean_str_tuple(value: Any) -> tuple[str, ...]:
    """An upstream array of strings, with nulls and blanks dropped.

    NOT `tuple(value or [])`: SEC puts `null` inside `exchanges` and the row
    models declare `list[str]`, so a single null aborts the whole bulk run.
    Coerces to `str` as well — a numeric ticker would fail the same way, and a
    tuple of strings is what every reader of these columns expects.
    """
    if not isinstance(value, (list, tuple)):
        return ()
    return tuple(str(v).strip() for v in value if v is not None and str(v).strip())


def _clean_str(value: Any) -> str | None:
    """A non-empty string, or None — with pandas' NaN treated as absent.

    NOT decoration. A pandas DataFrame spells "this cell has no value" as
    `float('nan')`, and `float('nan')` is TRUTHY, so the obvious
    `str(x) if x else None` yields the STRING "nan". That is the worst possible
    outcome for `standard_concept`: every dimensional segment row lands in a
    standard bucket literally named "nan", and any reader that groups by
    standard concept then sums Apple's iPhone, Mac, iPad and Services revenue
    into one plausible-looking total alongside the real one.

    Caught by the fixture assertions below, which is the only reason it is not
    still in this file.
    """
    if value is None:
        return None
    if isinstance(value, float) and value != value:  # NaN
        return None
    text = str(value).strip()
    return text if text and text.lower() != "nan" else None


def _text(node: Any) -> str | None:
    if node is None:
        return None
    value = "".join(node.itertext()).strip()
    return value or None


def _find(parent: Any, *names: str) -> Any:
    """Descend by LOCAL element name, ignoring namespaces.

    SEC's XML carries a default namespace on some forms and not on others, and
    an lxml path like `.//securityTitle` silently matches nothing on the
    namespaced half — returning "no rows" rather than an error.
    """
    node = parent
    for name in names:
        if node is None:
            return None
        found = node.find(f"{{*}}{name}")
        if found is None:
            found = node.find(name)
        node = found
    return node


def _child_text(parent: Any, *names: str) -> str | None:
    return _text(_find(parent, *names))


def _wrapped(parent: Any, *names: str) -> str | None:
    """Read `<tag><value>X</value></tag>`, tolerating a bare `<tag>X</tag>`.

    Ownership XML wraps almost every leaf in `<value>` so a `<footnoteId>` can
    sit beside it, but not consistently across form versions.
    """
    node = _find(parent, *names)
    if node is None:
        return None
    inner = _find(node, "value")
    return _text(inner) if inner is not None else _text(node)


def _footnote_ids(node: Any) -> list[str]:
    """Every `<footnoteId>` anywhere under a row, deduped, in document order."""
    seen: list[str] = []
    for ref in node.iter():
        if etree.QName(ref).localname != "footnoteId":
            continue
        fid = ref.get("id")
        if fid and fid not in seen:
            seen.append(fid)
    return seen


def _iter_local(root: Any, name: str) -> list[Any]:
    return [el for el in root.iter() if etree.QName(el).localname == name]


def _parse_xml(text: str | bytes) -> Any:
    """Recovering XML parse.

    `recover=True` because SEC accepts filings with undeclared entities and
    stray control characters, and a strict parse turns a cosmetic defect in one
    filing into a permanent gap in the table.
    """
    raw = text.encode("utf-8", "replace") if isinstance(text, str) else text
    return etree.fromstring(raw, parser=etree.XMLParser(recover=True, huge_tree=True))


def _extract_embedded_xml(sgml_text: str, root_tag: str) -> str | None:
    """Pull one embedded XML document out of a full-submission bundle by root tag."""
    match = re.search(rf"<{root_tag}[\s\S]*?</{root_tag}>", sgml_text)
    return match.group(0) if match else None


# ── companyfacts ────────────────────────────────────────────────────────────


def facts_from_companyfacts_json(payload: dict[str, Any]) -> list[CompanyFactSeries]:
    """Every fact, every taxonomy, every unit — with ``frame`` preserved.

    Parsed from the raw JSON rather than through
    ``EntityFactsParser.parse_company_facts`` for two reasons, both measured:

    1. That parser DROPS ``frame``. The key appears nowhere in the edgartools
       package, so the value is unrecoverable once it has run. ``frame``
       (``CY2024Q1I``) is SEC's own statement of which fact best fits a
       calendar period, present only when the reporting window aligns — the
       single de-duplication signal SEC publishes, and precisely what a
       "which number is THE number for Q1" question needs.
    2. It returns ``None`` on ANY exception (``entity/parser.py:141``). A
       malformed member would then be indistinguishable from a filer with no
       facts, which is exactly the "cached a failure as a success" shape the
       repo conventions forbid.

    A value with no ``val`` is skipped (SEC emits those); everything else is
    kept as filed, including several entries sharing one period — a later
    filing restates, and every 10-K carries prior-year comparatives.
    """
    cik = cik10(payload.get("cik"))
    series: list[CompanyFactSeries] = []
    for taxonomy, concepts in (payload.get("facts") or {}).items():
        for concept, meta in (concepts or {}).items():
            label = meta.get("label")
            description = meta.get("description")
            for unit, entries in (meta.get("units") or {}).items():
                values: list[CompanyFactValue] = []
                for entry in entries or []:
                    val = _bson_safe_val(entry.get("val"))
                    end = _date(entry.get("end"))
                    filed = _date(entry.get("filed"))
                    if val is None or end is None or filed is None:
                        continue
                    values.append(
                        CompanyFactValue(
                            start=_date(entry.get("start")),
                            end=end,
                            val=val,
                            accn=entry.get("accn") or "",
                            fy=entry.get("fy"),
                            fp=entry.get("fp"),
                            form=entry.get("form") or "",
                            filed=filed,
                            frame=entry.get("frame"),
                        )
                    )
                if not values:
                    continue
                values.sort(key=lambda v: (v.end, v.filed))
                series.append(
                    CompanyFactSeries(
                        cik10=cik,
                        taxonomy=taxonomy,
                        concept=concept,
                        unit=unit,
                        label=label,
                        description=description,
                        values=tuple(values),
                    )
                )
    return series


def fiscal_years_with_annual_report(series: list[CompanyFactSeries]) -> set[int]:
    """Distinct fiscal years with a 10-K / 20-F / 40-F behind them.

    The coverage denominator, computed from facts rather than assumed. A filer
    with fewer than five is not a failure — decision 5 — it is a filer whose
    coverage gate is "everything available", and that is only expressible if
    the number is measured.
    """
    annual = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}
    return {
        value.fy
        for entry in series
        for value in entry.values
        if value.form in annual and value.fy is not None
    }


# ── statements ──────────────────────────────────────────────────────────────

_NON_PERIOD_COLUMNS = frozenset(
    {
        "concept",
        "label",
        "standard_concept",
        "unit",
        "level",
        "abstract",
        "dimension",
        "is_breakdown",
        "dimension_axis",
        "dimension_member",
        "dimension_member_label",
        "dimension_label",
        "balance",
        "weight",
        "preferred_sign",
        "point_in_time",
        "parent_concept",
        "parent_abstract_concept",
    }
)


def _period_columns(columns: list[str]) -> list[str]:
    return [c for c in columns if c not in _NON_PERIOD_COLUMNS]


def _pick_primary_column(columns: list[str], period_end: date) -> str | None:
    """The column holding THIS filing's own period, not a comparative.

    Column labels are dates, sometimes suffixed: a balance sheet's instant
    columns read ``2025-09-27`` while an income statement's duration columns
    read ``2025-09-27 (FY)``. Matching on the ISO prefix covers both without
    depending on the suffix vocabulary, which is derived from day counts
    (`xbrl/statements.py:1233-1254`) and has no stable enumeration.
    """
    stamp = period_end.isoformat()
    for column in _period_columns(columns):
        if str(column).startswith(stamp):
            return column
    return None


def _statement_lines(
    statement: Any, period_end: date
) -> tuple[tuple[StatementLine, ...], tuple[str, ...]]:
    if statement is None:
        return (), ()
    frame = statement.to_dataframe(standard=True, include_unit=True)
    if frame is None or frame.empty:
        return (), ()
    columns = list(frame.columns)
    primary = _pick_primary_column(columns, period_end)
    if primary is None:
        return (), ()
    others = tuple(str(c) for c in _period_columns(columns) if c != primary)

    lines: list[StatementLine] = []
    for row in frame.to_dict("records"):
        axis = _clean_str(row.get("dimension_axis"))
        member = _clean_str(row.get("dimension_member"))
        dimensions: dict[str, str] = {}
        if axis and member:
            # Only the PRIMARY axis is exposed as columns by the library. A row
            # broken down on two axes at once keeps its first here; the full
            # set lives in `statement.get_raw_data()[i]["dimension_metadata"]`.
            # Recorded rather than silently flattened.
            dimensions[axis] = member
        lines.append(
            StatementLine(
                concept=_clean_str(row.get("concept")) or "",
                label=_clean_str(row.get("label")) or "",
                # None on a dimensional row, which is how a reader tells
                # "iPhone revenue" from "Net sales".
                standard_concept=_clean_str(row.get("standard_concept")),
                value=_float(row.get(primary)),
                unit=_clean_str(row.get("unit")),
                dimensions=dimensions,
                is_abstract=bool(row.get("abstract")),
            )
        )
    return tuple(lines), others


def statements_from_bundle(sgml_text: str) -> StatementSet | None:
    """Income, balance sheet, cash flow and equity for the filing's own period.

    Returns ``None`` — never raises — when the filing carries no XBRL. That is
    the common case for most of EDGAR (a Form 4 has no XBRL), so it is an
    answer, not an error. ``filing.xbrl()`` itself returns ``None`` rather than
    raising when there are no XBRL attachments (`xbrl/xbrl.py:606`); the
    documented ``XBRLFilingWithNoXbrlData`` is never raised in 5.53.0.

    An individual statement that the filing does not present comes back as an
    EMPTY TUPLE, which is deliberately different from ``None`` for the whole
    set: a bank's 10-Q legitimately omits a statement of equity, and "the
    filer did not present it" must not read the same as "we failed to parse".
    """
    filing = Filing.from_sgml_text(sgml_text)
    xbrl = filing.xbrl()
    if xbrl is None:
        return None

    info = xbrl.entity_info or {}
    # `document_period_end_date`, NOT `reporting_end_date`: the latter is
    # whichever instant the parser saw last and on Apple's FY2025 10-K it is
    # 2025-10-17, the cover-page share-count date, five weeks after the fiscal
    # year actually ended.
    period_end = _date(info.get("document_period_end_date")) or _date(xbrl.period_of_report)
    if period_end is None:
        return None

    fiscal_period = str(info.get("fiscal_period") or "").upper() or "FY"
    try:
        fiscal_year = int(info.get("fiscal_year") or period_end.year)
    except (TypeError, ValueError):
        fiscal_year = period_end.year

    period_start: date | None = None
    for window in xbrl.reporting_periods or []:
        if window.get("type") != "duration":
            continue
        if _date(window.get("end_date")) != period_end:
            continue
        annual = fiscal_period == "FY"
        if (window.get("period_type") == "Annual") is annual:
            period_start = _date(window.get("start_date"))
            break

    statements = xbrl.statements
    income, comparatives = _statement_lines(statements.income_statement(), period_end)
    balance, _ = _statement_lines(statements.balance_sheet(), period_end)
    cashflow, cf_comparatives = _statement_lines(statements.cash_flow_statement(), period_end)
    equity, _ = _statement_lines(statements.statement_of_equity(), period_end)

    return StatementSet(
        income=income,
        balance=balance,
        cashflow=cashflow,
        equity=equity,
        period_start=period_start,
        period_end=period_end,
        fiscal_year=fiscal_year,
        fiscal_period=fiscal_period,
        currency="USD",
        comparative_periods=comparatives or cf_comparatives,
    )


# ── ownership (Forms 3/4/5) ─────────────────────────────────────────────────


def _ownership_row(
    node: Any,
    index: int,
    *,
    is_derivative: bool,
    is_holding: bool,
    footnotes: dict[str, str],
) -> OwnershipRow:
    code = _child_text(_find(node, "transactionCoding"), "transactionCode")
    shares = _float(
        _wrapped(node, "transactionShares")
        or _wrapped(_find(node, "transactionAmounts"), "transactionShares")
    )
    price = _float(_wrapped(_find(node, "transactionAmounts"), "transactionPricePerShare"))
    if shares is None:
        shares = _float(_wrapped(_find(node, "transactionAmounts"), "transactionShares"))

    # value is shares x price ONLY when both exist. A gift (code G) has no
    # price, and a 0.0 there would read as a free transfer of nothing rather
    # than an untold value.
    value = shares * price if (shares is not None and price is not None) else None

    coding = _find(node, "transactionCoding")
    timeliness = _wrapped(node, "transactionTimeliness")

    return OwnershipRow(
        row_index=index,
        security_title=_wrapped(node, "securityTitle") or "",
        is_derivative=is_derivative,
        is_holding=is_holding,
        transaction_code=code,
        code_meaning=TRANSACTION_CODES.get(code) if code else None,
        # Empty element means ON TIME. `None` and "" must not be conflated with
        # E or L: a late filing is a reportable compliance fact.
        timeliness=timeliness if timeliness in {"E", "L"} else None,
        equity_swap=_bool(_child_text(coding, "equitySwapInvolved"))
        if coding is not None
        else False,
        transaction_date=_date(_wrapped(node, "transactionDate")),
        acquired_disposed=_wrapped(
            _find(node, "transactionAmounts"), "transactionAcquiredDisposedCode"
        ),
        shares=shares,
        price=price,
        value=value,
        shares_owned_after=_float(
            _wrapped(_find(node, "postTransactionAmounts"), "sharesOwnedFollowingTransaction")
        ),
        direct_indirect=_wrapped(_find(node, "ownershipNature"), "directOrIndirectOwnership"),
        nature_of_ownership=_wrapped(_find(node, "ownershipNature"), "natureOfOwnership"),
        underlying_security=_wrapped(_find(node, "underlyingSecurity"), "underlyingSecurityTitle"),
        underlying_shares=_float(
            _wrapped(_find(node, "underlyingSecurity"), "underlyingSecurityShares")
        ),
        exercise_price=_float(_wrapped(node, "conversionOrExercisePrice")),
        exercise_date=_date(_wrapped(node, "exerciseDate")),
        expiration_date=_date(_wrapped(node, "expirationDate")),
        footnotes=tuple(footnotes.get(fid, fid) for fid in _footnote_ids(node)),
    )


def ownership_from_bundle(sgml_text: str) -> tuple[OwnershipCover, list[OwnershipRow]]:
    """Forms 3/4/5 → cover plus every table line, transactions AND holdings.

    Holdings are included with ``is_holding=True`` because Form 3 is holdings
    almost entirely and dropping them would make an initial statement of
    ownership look like a filing with nothing in it. They carry no code, no
    price and no acquired/disposed flag, which is exactly why the flag exists:
    counting them as trades overstates insider activity.

    ``row_index`` runs across the combined non-derivative then derivative
    tables and is part of the storage key, because a Form 4 legitimately
    reports the same security, code, date, share count and price twice — two
    lots with two footnotes — and any "natural" key over the economics would
    silently collapse them into one.
    """
    xml = _extract_embedded_xml(sgml_text, "ownershipDocument")
    if xml is None:
        raise ValueError("no <ownershipDocument> in submission")
    root = _parse_xml(xml)

    footnotes = {
        node.get("id"): (_text(node) or "")
        for node in _iter_local(root, "footnote")
        if node.get("id")
    }

    issuer = _find(root, "issuer")
    owner = _find(root, "reportingOwner")
    owner_id = _find(owner, "reportingOwnerId") if owner is not None else None
    rel = _find(owner, "reportingOwnerRelationship") if owner is not None else None
    doc_type = _child_text(root, "documentType") or ""

    cover = OwnershipCover(
        issuer_cik10=cik10(_child_text(issuer, "issuerCik")),
        issuer_name=_child_text(issuer, "issuerName") or "",
        issuer_ticker=_child_text(issuer, "issuerTradingSymbol"),
        owner_cik10=cik10(_child_text(owner_id, "rptOwnerCik")),
        owner_name=_child_text(owner_id, "rptOwnerName") or "",
        is_director=_bool(_child_text(rel, "isDirector")),
        is_officer=_bool(_child_text(rel, "isOfficer")),
        is_ten_pct_owner=_bool(_child_text(rel, "isTenPercentOwner")),
        is_other=_bool(_child_text(rel, "isOther")),
        officer_title=_child_text(rel, "officerTitle"),
        form=doc_type,
        reporting_period=_date(_child_text(root, "periodOfReport")),
        # `<documentType>` reads "4" even on a 4/A — the library has no
        # amendment flag on Ownership at all — so the amendment is detected
        # from the SGML header's submission type, which does carry the "/A".
        is_amendment="/A" in (_sgml_header_value(sgml_text, "CONFORMED SUBMISSION TYPE") or ""),
        remarks=_child_text(root, "remarks"),
    )

    rows: list[OwnershipRow] = []
    for tag, derivative, holding in (
        ("nonDerivativeTransaction", False, False),
        ("nonDerivativeHolding", False, True),
        ("derivativeTransaction", True, False),
        ("derivativeHolding", True, True),
    ):
        for node in _iter_local(root, tag):
            rows.append(
                _ownership_row(
                    node,
                    len(rows),
                    is_derivative=derivative,
                    is_holding=holding,
                    footnotes=footnotes,
                )
            )
    return cover, rows


# ── SGML header ─────────────────────────────────────────────────────────────


# THE LEADING `[ \t]*` IS LOAD-BEARING. The SGML header is two-level:
# submission-level keys (`CONFORMED SUBMISSION TYPE`, `FILED AS OF DATE`) start
# at column 0, but everything inside a FILER / SUBJECT COMPANY block —
# including `CENTRAL INDEX KEY` and `COMPANY CONFORMED NAME` — is TAB-INDENTED.
# Anchoring on `^KEY:` matches the first group and silently returns None for
# the second, which reads as "this filing has no filer CIK" rather than as a
# broken pattern. It cost a 13F manager CIK and every legacy 13D/G identity
# before the fixture assertions caught it.
_HEADER_LINE_PREFIX = r"^[ \t]*"

#: Only the header is scanned. A `CENTRAL INDEX KEY:` string appearing inside a
#: document body must not be able to overwrite the filing's own identity.
_HEADER_SCAN_BYTES = 20000


def _sgml_header_value(sgml_text: str, key: str) -> str | None:
    match = re.search(
        rf"{_HEADER_LINE_PREFIX}{re.escape(key)}:\s*(.+)$",
        sgml_text[:_HEADER_SCAN_BYTES],
        re.MULTILINE,
    )
    return match.group(1).strip() if match else None


def _sgml_header_values(sgml_text: str, key: str) -> list[str]:
    return [
        m.group(1).strip()
        for m in re.finditer(
            rf"{_HEADER_LINE_PREFIX}{re.escape(key)}:\s*(.+)$",
            sgml_text[:_HEADER_SCAN_BYTES],
            re.MULTILINE,
        )
    ]


def _accepted_at(sgml_text: str) -> datetime | None:
    """`<ACCEPTANCE-DATETIME>20260828083048` — the only timestamp that can measure latency.

    `filedAt` is a calendar day at SEC. A filing accepted at 21:53 ET is DATED
    the next business day when it lands after the cutoffs, so a latency
    computed from `filedAt` is negative roughly every evening.

    SEC stamps this in US Eastern time and does not say so. It is normalised to
    UTC here rather than stored naive, because a naive datetime reaching Mongo
    is silently reinterpreted as local time by whatever reads it next.
    """
    match = re.search(r"<ACCEPTANCE-DATETIME>(\d{14})", sgml_text[:4000])
    if not match:
        return None
    stamp = datetime.strptime(match.group(1), "%Y%m%d%H%M%S")
    try:
        from zoneinfo import ZoneInfo

        return stamp.replace(tzinfo=ZoneInfo("America/New_York")).astimezone(UTC)
    except Exception:
        return stamp.replace(tzinfo=UTC)


# ── 13F ─────────────────────────────────────────────────────────────────────


def _library_unit_verdict(
    rows: list[ThirteenFRow], schema_version: str | None, period: date
) -> str | None:
    """What edgartools' heuristic thinks the value column is denominated in.

    RECORDED, NEVER APPLIED. The library infers the unit from implied price per
    share (`thirteenf/models.py:129-151`); we apply Release 34-95148's actual
    rule, which is keyed on the FILING date. Storing both means a disagreement
    is visible in a column instead of resolved silently — and a 1000x error
    here produces a plausible-looking portfolio rather than a crash, so silent
    resolution is the worst available outcome.

    Returns ``None`` if the private helper has moved, which is a library
    upgrade the pin test is there to catch. A missing opinion is honest; a
    fabricated one is not.
    """
    try:
        import pandas as pd
        from edgar.thirteenf.models import _detect_value_in_thousands
    except Exception:
        return None
    if not rows:
        return None
    frame = pd.DataFrame(
        [
            {
                "Type": "Shares" if r.shares_type == "SH" else "Principal",
                "SharesPrnAmount": r.shares,
                "Value": r.value_as_filed,
                "PutCall": r.put_call or "",
            }
            for r in rows
        ]
    )
    try:
        in_thousands = _detect_value_in_thousands(
            frame, schema_version, datetime.combine(period, datetime.min.time())
        )
    except Exception:
        return None
    return "THOUSANDS" if in_thousands else "DOLLARS"


def thirteenf_from_bundle(sgml_text: str) -> tuple[ThirteenFCover, list[ThirteenFRow]]:
    """13F-HR / 13F-HR/A → cover plus the information table, VALUES AS FILED.

    THE UNIT IS NOT APPLIED HERE. Release 34-95148 moved 13F from thousands to
    whole dollars for every report FILED on or after 2023-01-03 — keyed on the
    filing date, not the period — and applying that rule is the writer's job,
    under `UsThirteenFFiling.valueUnitRule`. This function hands back the raw
    filed number and the filing date, plus the library's separate opinion in
    `library_unit_verdict`.

    The MANAGER CIK COMES FROM THE FILING, not the cover page. The 13F cover
    carries only a name and an address (`thirteenf/parsers/primary_xml.py:82`),
    and a name-keyed join would merge every "Capital Management LLC" in the
    country.

    The information table is parsed here rather than by
    ``parse_infotable_xml``: that function calls ``cusip_ticker_mapping()``,
    which is a network fetch, and it emits no ``figi`` column — the one field
    that joins a holding straight to `UsInstrument.openFIGIComposite` with no
    third party involved.
    """
    primary_xml = _extract_embedded_xml(sgml_text, "edgarSubmission")
    if primary_xml is None:
        raise ValueError("no <edgarSubmission> in 13F submission")
    document = parse_primary_document_xml(primary_xml)
    cover_page = document.cover_page
    summary = document.summary_page

    form = _sgml_header_value(sgml_text, "CONFORMED SUBMISSION TYPE") or ""
    filed_at = _date(_sgml_header_value(sgml_text, "FILED AS OF DATE"))
    period = _date(document.report_period)
    if period is None or filed_at is None:
        raise ValueError("13F submission is missing a period or filing date")

    rows: list[ThirteenFRow] = []
    table_xml = _extract_embedded_xml(sgml_text, "informationTable")
    if table_xml is not None:
        root = _parse_xml(table_xml)
        for node in _iter_local(root, "infoTable"):
            shrs = _find(node, "shrsOrPrnAmt")
            voting = _find(node, "votingAuthority")
            put_call = _child_text(node, "putCall")
            rows.append(
                ThirteenFRow(
                    row_index=len(rows),
                    cusip=(_child_text(node, "cusip") or "").strip().upper(),
                    figi=(_child_text(node, "figi") or None),
                    issuer_name=_child_text(node, "nameOfIssuer") or "",
                    title_of_class=_child_text(node, "titleOfClass") or "",
                    value_as_filed=_float(_child_text(node, "value")) or 0.0,
                    shares=_float(_child_text(shrs, "sshPrnamt")) or 0.0,
                    shares_type=(_child_text(shrs, "sshPrnamtType") or "SH").strip().upper(),
                    put_call=put_call.title() if put_call else None,
                    investment_discretion=_child_text(node, "investmentDiscretion") or "",
                    other_managers=tuple(
                        part.strip()
                        for part in (_child_text(node, "otherManager") or "").split(",")
                        if part.strip()
                    ),
                    voting_sole=_float(_child_text(voting, "Sole")) or 0.0,
                    voting_shared=_float(_child_text(voting, "Shared")) or 0.0,
                    voting_none=_float(_child_text(voting, "None")) or 0.0,
                )
            )

    schema_version = _child_text(_parse_xml(primary_xml), "schemaVersion")
    amendment_info = getattr(cover_page, "amendment_info", None)

    cover = ThirteenFCover(
        manager_cik10=cik10(_sgml_header_value(sgml_text, "CENTRAL INDEX KEY")),
        manager_name=getattr(cover_page.filing_manager, "name", "") or "",
        period_of_report=period,
        filed_at=filed_at,
        form=form,
        is_amendment=bool(getattr(cover_page, "is_amendment", False)) or form.endswith("/A"),
        amendment_type=getattr(amendment_info, "amendment_type", None),
        amendment_number=getattr(cover_page, "amendment_number", None),
        report_type=getattr(cover_page, "report_type", None),
        total_value_as_filed=float(summary.total_value or 0),
        total_holdings=int(summary.total_holdings or 0),
        other_managers_count=int(summary.other_included_managers_count or 0),
        library_unit_verdict=_library_unit_verdict(rows, schema_version, period),
    )
    return cover, rows


# ── Schedules 13D / 13G ─────────────────────────────────────────────────────


def schedule13_from_bundle(sgml_text: str) -> tuple[Schedule13Cover, list[Schedule13Row]]:
    """13D / 13G, structured after 2024-12-18 and identities-only before it.

    ``has_structured_data`` is the whole point of the split. Filings before the
    XML mandate are HTML, so no machine-readable percent, share count or
    voting/dispositive breakdown exists — and without the flag, a null
    ``percent_of_class`` on a 2022 filing is indistinguishable from a real
    zero. The legacy branch still returns the subject and the filer, because
    the CUSIP-and-CIK pair on a cover page is the first and only
    primary-source tier of the CUSIP map.
    """
    form = _sgml_header_value(sgml_text, "CONFORMED SUBMISSION TYPE") or ""
    filed_at = _date(_sgml_header_value(sgml_text, "FILED AS OF DATE"))
    schedule = "13D" if "13D" in form.upper() else "13G"
    xml = _extract_embedded_xml(sgml_text, "edgarSubmission")

    if xml is None:
        # Legacy, pre-mandate. Identities come from the SGML header, whose
        # SUBJECT COMPANY block precedes the FILED BY block.
        names = _sgml_header_values(sgml_text, "COMPANY CONFORMED NAME")
        ciks = _sgml_header_values(sgml_text, "CENTRAL INDEX KEY")
        cover = Schedule13Cover(
            schedule=schedule,
            form=form,
            subject_cik10=cik10(ciks[0]) if ciks else "",
            subject_name=names[0] if names else "",
            is_amendment=form.endswith("/A"),
            filed_at=filed_at,
            has_structured_data=False,
        )
        rows = [
            Schedule13Row(
                row_index=0,
                filer_name=names[1] if len(names) > 1 else "",
                filer_cik10=cik10(ciks[1]) if len(ciks) > 1 else None,
            )
        ]
        return cover, rows

    parser = Schedule13D if schedule == "13D" else Schedule13G
    # `parse_xml` returns the CONSTRUCTOR KWARGS, not an instance — the same
    # shape as `Ownership.parse_xml`. `filing` is only read by rendering and
    # comparison helpers we do not call.
    parsed = parser(filing=None, **parser.parse_xml(xml))
    issuer = parsed.issuer_info
    purpose = getattr(parsed.items, "item4_purpose_of_transaction", None)

    cover = Schedule13Cover(
        schedule=schedule,
        form=form,
        subject_cik10=cik10(issuer.cik),
        subject_name=issuer.name or "",
        cusip=(issuer.cusip or None) or (parsed.security_info.cusip or None),
        is_amendment=form.endswith("/A"),
        amendment_number=parsed.amendment_number,
        event_date=_date(parsed.date_of_event),
        filed_at=filed_at,
        purpose_text=purpose,
        has_structured_data=bool(parsed.has_structured_data),
    )
    rows = [
        Schedule13Row(
            row_index=index,
            filer_name=person.name or "",
            # The 13G schema carries no reporting-person CIK at all
            # (`schedule13.py:794`), so an empty string is normalised to None
            # rather than stored as a CIK of "0000000000".
            filer_cik10=cik10(person.cik) if person.cik else None,
            percent_of_class=_float(person.percent_of_class),
            shares_owned=_float(person.aggregate_amount),
            sole_voting=_float(person.sole_voting_power),
            shared_voting=_float(person.shared_voting_power),
            sole_dispositive=_float(person.sole_dispositive_power),
            shared_dispositive=_float(person.shared_dispositive_power),
            type_of_reporting_person=person.type_of_reporting_person,
            citizenship=person.citizenship,
        )
        for index, person in enumerate(parsed.reporting_persons)
    ]
    return cover, rows


# ── 8-K ─────────────────────────────────────────────────────────────────────

#: A PDF's first bytes. Sniffed as well as trusting the filename, because the
#: extension is filer-supplied free text — the same reason the image refusal in
#: ``eightk_logic`` reads EDGAR's TYPE instead.
_PDF_MAGIC = b"%PDF"


def _is_pdf(filename: str, data: bytes | None) -> bool:
    """Whether an attachment is a PDF, by NAME or by BYTES.

    Either signal alone is enough. A ``.pdf`` name with unreadable bytes still
    routes to the PDF path, where it is counted as recovered-nothing rather than
    silently dropped; and a PDF a filer named ``exhibit99`` is still recognised.
    """
    if filename.lower().endswith(".pdf"):
        return True
    return bool(data) and data[:4] == _PDF_MAGIC


def _attachment_bytes(attachment: Any) -> bytes | None:
    """An attachment's raw bytes, or ``None`` when they are not bytes at all.

    ``Attachment.download()`` with no path returns ``self.content``
    (``attachments.py:476``), which for an SGML-backed attachment is the
    uudecoded payload — BYTES for a binary document, ``str`` for a text one.
    A ``str`` is not a candidate for the PDF path, and returning it would make
    the magic-byte sniff a type error rather than a "no".

    NO NETWORK: every attachment here comes from ``Filing.from_sgml_text``, so
    ``sgml_document`` is set and ``content`` never falls through to
    ``download_file(self.url)``. ``test_no_adapter_function_touches_the_network``
    is what keeps that true rather than this comment.
    """
    try:
        data = attachment.download()
    except Exception:
        return None
    return data if isinstance(data, bytes) else None


def pdf_text(data: bytes) -> str | None:
    """A PDF's own text layer, page-marked — or ``None`` when it has none.

    edgartools CANNOT render a PDF: ``Attachment.text()`` answers ``None`` for
    any extension outside its text set (``attachments.py:526``), so before
    MONEY-1350 a PDF exhibit landed as a row with ``textPath: None`` that no
    later run would ever fill. Measured on prod 2026-09-05: 9 of 5,377
    ``us_filing_documents`` rows, 8 of them 6-K exhibits from foreign issuers
    (EQNR, SLF, WPM, Polestar, GORO x2, GDS, LU) and one 8-K (TMQ).

    PAGES ARE MARKED, not concatenated blindly. A table split across a page
    break otherwise reads as one continuous run of numbers, and the marker is
    an HTML comment so a reader that does not care can ignore it. ``N`` is the
    1-based number of the page that FOLLOWS the marker, so the first page needs
    none.

    ``None`` for anything that yields no printable text, which is TWO causes
    with one consequence: a scanned exhibit has no text layer at all, and a
    corrupt or encrypted one cannot be read. Both leave the exhibit a gap, and
    the row records that gap the same way — an honest ``textPath: None`` — so
    they are not separated into two counters nobody could act on differently.
    """
    try:
        pages = [page.extract_text() or "" for page in PdfReader(io.BytesIO(data)).pages]
    except Exception:
        return None
    if not pages:
        return None
    joined = pages[0]
    for number, page in enumerate(pages[1:], start=2):
        joined += f"\n<!-- page {number} -->\n{page}"
    return joined if joined.strip() else None


def eightk_from_bundle(sgml_text: str) -> tuple[EightKMeta, list[EightKDoc]]:
    """8-K → item numbers plus every document and exhibit, with text extracted.

    Items come from the SGML header's ``ITEM INFORMATION`` lines mapped through
    SEC's own Form 8-K table, NOT from ``EightK.items``: that property reaches
    ``filing.html()`` → ``filing.homepage`` and issues a live SEC request even
    for a filing built from local SGML bytes
    (`company_reports/current_report.py:703` → `_filings.py:2288`). Verified by
    a socket-blocking probe, which is the only way this class of defect shows
    up — the fetch succeeds in development and fails only where egress is off.

    A header description with no entry in the table is kept VERBATIM rather
    than dropped, so a new item number added by SEC surfaces as an unmapped
    string instead of vanishing.

    A PDF exhibit falls back to :func:`pdf_text`, because ``attachment.text()``
    answers ``None`` for one and the exhibit would otherwise be a PERMANENT gap
    rather than a refillable one (MONEY-1350). The two outcomes are counted on
    the returned :class:`EightKMeta`.
    """
    filing = Filing.from_sgml_text(sgml_text)

    items: list[str] = []
    for description in _sgml_header_values(sgml_text, "ITEM INFORMATION"):
        number = _EIGHTK_ITEMS.get(_normalise_item_label(description))
        value = number or description
        if value not in items:
            items.append(value)

    documents: list[EightKDoc] = []
    pdf_extracted = 0
    pdf_without_text = 0
    for attachment in filing.attachments:
        document_type = str(attachment.document_type or "")
        # The XBRL linkbases and the SEC viewer's own generated files are
        # neither exhibits nor content. They are excluded by prefix rather than
        # by an allow-list so a new exhibit class (EX-107, say) still lands.
        #
        # ``GRAPHIC`` IS DELIBERATELY NOT IN THIS SET, and adding it would look
        # like tidying. Images are refused one layer up, by
        # ``eightk_logic.triage_documents``, because that is where the refusal
        # can be COUNTED and reported (``binaryMediaSkipped``); dropping them
        # here would leave that counter reading a permanent, confident zero over
        # a filing full of them. `test_an_image_exhibit_is_refused_and_never_enqueued`
        # asserts these attachments arrive, so the move fails a test rather than
        # a dashboard.
        if document_type.startswith("EX-101") or document_type in {"CSS", "JS", "ZIP", "JSON"}:
            continue
        try:
            text = attachment.text()
        except Exception:
            text = None
        if not text:
            # A PDF exhibit — edgartools renders none, so this is the ONLY
            # chance its text has to exist at all (MONEY-1350). Reached only
            # when nothing came out the normal way, so a readable HTML exhibit
            # never pays for the download.
            data = _attachment_bytes(attachment)
            if _is_pdf(str(attachment.document or ""), data):
                text = pdf_text(data) if data else None
                if text:
                    pdf_extracted += 1
                else:
                    # A `.pdf` whose bytes would not read counts here too. Both
                    # causes leave the exhibit a gap; see :func:`pdf_text`.
                    pdf_without_text += 1
        encoded = text.encode("utf-8") if text else None
        documents.append(
            EightKDoc(
                sequence=int(attachment.sequence_number or 0),
                document_type=document_type,
                filename=str(attachment.document or ""),
                description=attachment.description or None,
                text=text,
                text_bytes=len(encoded) if encoded else None,
                # sha256 of the extracted text, so a reparse that changes
                # nothing writes nothing and a reparse that changes something
                # is visible.
                text_hash=hashlib.sha256(encoded).hexdigest() if encoded else None,
            )
        )

    # Built AFTER the walk, because two of its fields are outcomes OF the walk.
    meta = EightKMeta(
        cik10=cik10(filing.cik),
        form=_sgml_header_value(sgml_text, "CONFORMED SUBMISSION TYPE") or filing.form,
        filed_at=_date(_sgml_header_value(sgml_text, "FILED AS OF DATE"))
        or _date(filing.filing_date),
        accepted_at=_accepted_at(sgml_text),
        period_of_report=_date(_sgml_header_value(sgml_text, "CONFORMED PERIOD OF REPORT")),
        items=tuple(items),
        pdf_text_extracted=pdf_extracted,
        pdf_no_text_layer=pdf_without_text,
    )
    return meta, documents


# ── detection sources ───────────────────────────────────────────────────────

_ATOM_ACCESSION = re.compile(r"accession-number=([0-9-]+)")
_ATOM_TITLE = re.compile(r"^(.*?)\s+-\s+(.*)\s+\((\d{4,10})\)\s+\((.*)\)$")
_ATOM_SIZE = re.compile(r"Size:</b>\s*([\d,]+)\s*KB", re.IGNORECASE)
_ATOM_FILED = re.compile(r"Filed:</b>\s*(\d{4}-\d{2}-\d{2})", re.IGNORECASE)


def parse_current_filings_atom(xml: bytes) -> list[CurrentFilingEntry]:
    """The `getcurrent` Atom feed, DEDUPED BY ACCESSION.

    100 entries are about 49 filings. SEC emits ONE ENTRY PER FILER ROLE —
    Reporting, Issuer, Subject, Filed by — so a detector that treats entries as
    filings publishes the same Form 4 twice and the same 13D three times. The
    dedupe is the whole reason this function exists.

    The accession is taken from ``<id>``
    (`urn:tag:sec.gov,2008:accession-number=0001214659-26-011109`), which is
    structured. edgartools instead regex-scrapes it out of the human-readable
    ``<summary>`` and raises ``ValueError`` on any title that does not match its
    pattern (`current_filings.py:58-69`), which fails a whole page for one odd
    company name.

    Roles are kept rather than discarded: the issuer of a Form 4 is a different
    company from the reporting owner, and both are worth knowing. The FIRST
    entry seen for an accession sets the primary cik/company, matching SEC's
    own ordering.
    """
    root = _parse_xml(xml)
    entries: dict[str, dict[str, Any]] = {}

    for entry in _iter_local(root, "entry"):
        raw_id = _child_text(entry, "id") or ""
        match = _ATOM_ACCESSION.search(raw_id)
        if not match:
            continue
        accession = match.group(1)

        category = _find(entry, "category")
        form = (category.get("term") if category is not None else None) or ""
        title = _child_text(entry, "title") or ""
        summary = _child_text(entry, "summary") or ""

        parsed_title = _ATOM_TITLE.match(title.strip())
        if parsed_title:
            _, company, cik, role = parsed_title.groups()
        else:
            company, cik, role = title.strip(), "", ""

        size = _ATOM_SIZE.search(summary)
        filed = _ATOM_FILED.search(summary)
        updated = _child_text(entry, "updated")

        record = entries.setdefault(
            accession,
            {
                "form": form,
                "cik10": cik10(cik),
                "company": company,
                "accepted_at": updated,
                "filed_at": filed.group(1) if filed else None,
                "size_bytes": int(size.group(1).replace(",", "")) * 1024 if size else None,
                "roles": [],
            },
        )
        record["roles"].append((cik10(cik), company, role))

    result: list[CurrentFilingEntry] = []
    for accession, record in entries.items():
        accepted = record["accepted_at"]
        try:
            accepted_at = datetime.fromisoformat(accepted).astimezone(UTC)
        except (TypeError, ValueError):
            continue
        result.append(
            CurrentFilingEntry(
                accession=accession,
                form=record["form"],
                cik10=record["cik10"],
                company=record["company"],
                accepted_at=accepted_at,
                filed_at=_date(record["filed_at"]),
                size_bytes=record["size_bytes"],
                roles=tuple(record["roles"]),
            )
        )
    return result


def parse_efts_response(payload: dict[str, Any]) -> list[EftsHit]:
    """One page of `efts.sec.gov/LATEST/search-index`.

    ``ciks`` IS AN ARRAY and is kept whole. edgartools' own client stores only
    ``ciks[0]`` (`search/efts.py:472`), which silently discards the issuer of
    every two-party filing — on a Form 4 that is the company, which is the only
    party anyone searches by.

    There is no ``form_type`` field anywhere in the response; the field is
    ``form``, with ``root_forms`` alongside it as an array.
    """
    hits: list[EftsHit] = []
    for hit in (payload.get("hits") or {}).get("hits") or []:
        source = hit.get("_source") or {}
        accession = source.get("adsh") or ""
        file_date = _date(source.get("file_date"))
        if not accession or file_date is None:
            continue
        hits.append(
            EftsHit(
                accession=accession,
                form=source.get("form") or "",
                ciks=tuple(cik10(c) for c in (source.get("ciks") or [])),
                display_names=tuple(source.get("display_names") or []),
                file_date=file_date,
                root_forms=tuple(source.get("root_forms") or []),
                file_type=source.get("file_type"),
                items=tuple(source.get("items") or []),
                period_ending=_date(source.get("period_ending")),
            )
        )
    return hits


# MEASURED against form.20220214.idx rather than taken from documentation: the
# date column is `YYYYMMDD` with NO separators, and columns are separated by
# runs of two or more spaces (a form type may itself contain a single space,
# e.g. "SC 13G" or "1-A POS", so splitting on whitespace loses the form).
_IDX_ROW = re.compile(
    r"^(?P<form>\S.*?)\s{2,}(?P<company>.+?)\s{2,}(?P<cik>\d+)\s+(?P<date>\d{8})\s+(?P<path>edgar/\S+?)\s*$"
)


def parse_daily_index(text: str) -> list[DailyIndexRow]:
    """A daily `form.idx`.

    The header is skipped by the `-----` rule line rather than by a fixed line
    count: the preamble is not a stable height (the 2022 file wraps its column
    header across two lines).

    THREE MEASURED PROPERTIES a caller that walks these files per day must
    know, all verified against `form.20220214.idx` (19,412 rows):

    1. ONE ROW PER FILER, not per filing — the same shape as the Atom feed's
       one-entry-per-role. Those 19,412 rows are 11,870 distinct accessions,
       and a single co-registered S-3ASR occupies sixteen of them. A backfill
       that treats rows as filings fans out 1.6x.
    2. THE INDEX DAY IS NOT THE FILING DAY. 198 rows (1.0%) carry an earlier
       ``filed_at``, reaching back nine months to 2021-05-21. So `filedAt` must
       come from THE ROW, never from the date in the filename that was
       fetched. Getting this wrong is silent — the row lands with a plausible
       date, in the wrong period.
    3. Rows are "seen on this day", not "still exists". Daily index files are
       NEVER corrected; post-acceptance deletions appear only in the Saturday
       full-index rebuild, which is why detection keeps a separate weekly
       reconcile rather than trusting these files as a ledger.
    """
    rows: list[DailyIndexRow] = []
    started = False
    for line in text.splitlines():
        if not started:
            if line.startswith("---"):
                started = True
            continue
        match = _IDX_ROW.match(line.rstrip())
        if not match:
            continue
        filed = _date(match.group("date"))
        if filed is None:
            continue
        path = match.group("path")
        rows.append(
            DailyIndexRow(
                form=match.group("form").strip(),
                company=match.group("company").strip(),
                cik10=cik10(match.group("cik")),
                filed_at=filed,
                accession=Path(path).stem,
                path=path,
            )
        )
    return rows


def parse_submissions_json(payload: dict[str, Any]) -> tuple[SubmissionsFiler, list[FilingRef]]:
    """A `submissions.zip` member, or the identical per-company JSON from data.sec.gov.

    ``filings.recent`` is thirteen PARALLEL ARRAYS, which is a shape with a
    specific failure mode: if one array is short, zipping them positionally
    shifts every subsequent field onto the wrong filing without raising. They
    are therefore zipped to the length of the SHORTEST array and the excess is
    dropped rather than mis-attributed.

    ``filings.files[]`` — the references to older shards — is returned but NOT
    followed. This module does not fetch; whether the older pages are worth a
    request is the caller's decision, and in the bulk job they are already
    local members of the same zip.
    """
    filer = SubmissionsFiler(
        cik10=cik10(payload.get("cik")),
        name=payload.get("name") or "",
        sic=payload.get("sic") or None,
        sic_description=payload.get("sicDescription") or None,
        # `MMDD` as SEC publishes it ("0930"), NOT a date: it is a recurring
        # annual boundary and materialising it would invent a year.
        fiscal_year_end=payload.get("fiscalYearEnd") or None,
        entity_type=payload.get("entityType") or None,
        state_of_inc=payload.get("stateOfIncorporation") or None,
        former_names=tuple(payload.get("formerNames") or []),
        # SEC ships NULLS INSIDE these arrays. Measured on prod 2026-08-29: a
        # filer in `submissions.zip` carried `exchanges: [null]`, and because
        # `UsFilerRow.exchangesAsFiled` is `list[str]` pydantic refused the row
        # and took the WHOLE RUN down:
        #
        #   ValidationError: exchangesAsFiled.0 — Input should be a valid string
        #   [input_value=None, input_type=NoneType]
        #
        # The strict model is not the bug; it is what surfaced this instead of
        # writing `None` into a column every reader would then have to guard.
        # The BOUNDARY is where an upstream's nulls get dropped, so the strictness
        # can stay. `tickers` gets the same treatment — same array-of-strings
        # shape from the same payload, and there is no reason to believe SEC
        # treats it more carefully.
        tickers_as_filed=_clean_str_tuple(payload.get("tickers")),
        exchanges_as_filed=_clean_str_tuple(payload.get("exchanges")),
        paging_files=tuple((payload.get("filings") or {}).get("files") or []),
    )

    recent = ((payload.get("filings") or {}).get("recent")) or {}
    columns = (
        "accessionNumber",
        "form",
        "filingDate",
        "reportDate",
        "acceptanceDateTime",
        "items",
        "primaryDocument",
        "isXBRL",
        "isInlineXBRL",
        "size",
    )
    arrays = {name: recent.get(name) or [] for name in columns}

    # The row count is driven by the REQUIRED columns only, and optional ones
    # are read defensively. Both halves matter, and the previous form got each
    # wrong in a different direction.
    #
    # It was `min(len(v) for v in arrays.values() if v)`. The `if v` skips EMPTY
    # arrays when computing the length — and then the loop indexes them anyway,
    # so a payload with one absent column and data in the others raises
    # IndexError and costs the whole filer. Unreachable for a real
    # `filings.recent` (all columns present), reachable for a truncated paging
    # shard, which is exactly where a parser meets a partial write.
    #
    # Dropping the `if v` would trade that crash for something quieter and
    # worse: a legitimately empty optional column — `items` is empty for every
    # filer with no 8-K — would make `count` zero and silently discard every
    # filing the filer has.
    #
    # So: a short REQUIRED column truncates (a missing accession or date shifts
    # every later field onto the wrong filing, which is worse than losing the
    # tail), and an absent OPTIONAL column reads as None per row.
    required = ("accessionNumber", "form", "filingDate")
    count = min((len(arrays[name]) for name in required), default=0)

    def at(name: str, index: int) -> Any:
        """One cell, or None when that column is absent or short."""
        column = arrays[name]
        return column[index] if index < len(column) else None

    filings: list[FilingRef] = []
    annual_years: set[int] = set()
    first: date | None = None
    latest: date | None = None

    for index in range(count):
        filed = _date(arrays["filingDate"][index])
        if filed is None:
            continue
        form = arrays["form"][index] or ""
        accepted_raw = at("acceptanceDateTime", index)
        try:
            accepted = datetime.fromisoformat(str(accepted_raw)) if accepted_raw else None
        except ValueError:
            accepted = None
        if accepted is not None and accepted.tzinfo is None:
            accepted = accepted.replace(tzinfo=UTC)

        raw_items = at("items", index) or ""
        filings.append(
            FilingRef(
                accession=arrays["accessionNumber"][index] or "",
                cik10=filer.cik10,
                form=form,
                filed_at=filed,
                accepted_at=accepted,
                period_of_report=_date(at("reportDate", index)),
                items=tuple(p.strip() for p in raw_items.split(",") if p.strip()),
                primary_document=at("primaryDocument", index) or None,
                is_xbrl=bool(at("isXBRL", index)),
                is_inline_xbrl=bool(at("isInlineXBRL", index)),
                size_bytes=at("size", index) or None,
            )
        )
        if form in {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}:
            period = _date(at("reportDate", index)) or filed
            annual_years.add(period.year)
        first = filed if first is None or filed < first else first
        latest = filed if latest is None or filed > latest else latest

    filer = replace(
        filer,
        first_filing_at=first,
        latest_filed_at=latest,
        # Counted over `recent` ONLY. `filings.files[]` holds older shards this
        # module deliberately does not fetch, so on a prolific filer this is a
        # FLOOR, not a total — which is the safe direction for a coverage gate
        # that must never claim more history than it has seen.
        fiscal_years_on_file=len(annual_years),
    )
    return filer, filings


def json_loads(payload: bytes | str) -> dict[str, Any]:
    """Decode a SEC JSON body. Present so callers need not import json for one line."""
    return json.loads(payload)
