"""THE SEAM. ``parse_and_store(accession, bundle, parse_class=...)`` — MONEY-979.

This function is why the latency roadmap is a change of SOURCE rather than a
rewrite of five parsers. It takes BYTES SOMEBODY ELSE FETCHED and returns an
outcome. Nothing in it fetches from SEC, and nothing in it knows what Pub/Sub
is:

* today       ``app/jobs/parse_*.py`` — Scheduler -> push -> ``fetch_bundle``
              (archive-first) -> this function. p95 ~90 s.
* MONEY-1271  an always-on poller (min=max=1, CPU always allocated) calls THIS
              FUNCTION with THESE ARGUMENTS. Sub-second.
* MONEY-1272  SEC's Public Dissemination Service pushes over SFTP to a
              static-IP receiver, which calls THIS FUNCTION with THESE
              ARGUMENTS. Sub-100 ms.

Anything that fetched inside here would have to be reimplemented three times,
and the third implementation is the one that quietly bypasses the shared
9 req/s budget.

## ``EDGAR_PARSE_APPLY`` — a dry run is a REAL PARSE that writes nothing

Compared to the LITERAL string ``"true"`` (``bool("false")`` is ``True``) and
read PER CALL. Unarmed, every parser still runs end to end: the XBRL is
resolved, the rows are built, the counts are real. It simply does not write —
no Mongo, no GCS object, no status stamp. A "dry run" that SKIPS the work
measures nothing and would report a clean zero for a filing that cannot be
parsed at all.

## Status is stamped from what happened, and UNSUPPORTED is not FAILED

``PARSED``       rows were produced.
``UNSUPPORTED``  the form carries nothing this parser stores — a 13F-NT has no
                 information table by design. Marking it FAILED makes a
                 permanently red parser out of a filing with nothing wrong.
``FAILED``       we could not read a filing we should have been able to read.

## What this module does NOT own

``app/store/writers.py`` is T5's. The contract it must satisfy is
:class:`RowWriter` below; until it exists, ``resolve_writer()`` returns ``None``
and an ARMED run raises :class:`WriterUnavailable` rather than reporting a
successful write of nothing.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Protocol, runtime_checkable

import bson.errors

from app import settings
from app.parsers import (
    eightk_logic,
    financials_logic,
    ownership_logic,
    schedule13_logic,
    thirteenf_logic,
)
from app.sec import edgar_adapter
from app.sec.archive_logic import text_key
from app.store.collections import collection_name

#: Encode-time refusals: "this filing's data cannot be represented", not "the
#: database is unwell". Caught around the WRITE, mirroring the broad catch the
#: PARSE has always had.
#:
#: `OverflowError` is deliberately FIRST and is the one that cost two production
#: runs. Measured against bson 4.17 it is `builtins.OverflowError` — NOT a
#: `bson.errors.BSONError` and NOT `InvalidDocument` — so the handler an author
#: would reach for by reading the bson hierarchy catches none of it:
#:
#:     >>> bson.encode({"val": 2**63})
#:     OverflowError: MongoDB can only handle up to 8-byte ints
#:
#: `bson` is a pure codec with no transport, so importing it here does not cost
#: this module the no-socket property `test_parse_and_store_opens_no_socket`
#: pins. Note what is NOT in this tuple: ConnectionFailure, timeouts and
#: WriterUnavailable stay uncaught, because a database we cannot reach is about
#: US and swallowing it would report a clean run over a walk that stored
#: nothing.
UNENCODABLE_ROW_ERRORS = (
    OverflowError,
    bson.errors.InvalidDocument,
    bson.errors.InvalidStringData,
)

#: The five classes this module dispatches on. Same vocabulary as
#: ``UsFiling.parseClass``, which T6's classifier writes at detection.
PARSE_CLASSES: tuple[str, ...] = (
    "OWNERSHIP",
    "THIRTEENF",
    "SCHEDULE13",
    "EIGHTK",
    "FINANCIALS",
)

STATUS_PARSED = "PARSED"
STATUS_FAILED = "FAILED"
STATUS_UNSUPPORTED = "UNSUPPORTED"

#: Read, never written, and deliberately NOT in ``app/store/collections.py``:
#: that file's contract is "collections THIS SERVICE WRITES", and the TypeScript
#: prod-only-sync guard treats every name in it as prod-writes-QA-receives.
#: ``us_instruments`` is MONEY-980's table and is QA-DIRECT.
US_INSTRUMENTS_COLLECTION = "us_instruments"

#: Truncated before it reaches ``UsFiling.error``. A stack-shaped string in a
#: column nothing renders is how a useful message gets scrolled off.
ERROR_MAX_CHARS = 500


# The SGML header carries the filing date, the submission type and the filer's
# CIK, and the adapter already parses all three — including the tab-indented
# spelling inside a FILER block, which cost this repo a 13F manager CIK and
# every legacy 13D/G identity before its fixtures caught it. These four names
# are private to `edgar_adapter` and are reached into DELIBERATELY: writing a
# second regex over the same bytes here would be one rule stated twice, and the
# two would eventually disagree with nothing to notice.
_header_value = edgar_adapter._sgml_header_value
_header_date = edgar_adapter._date
_accepted_at = edgar_adapter._accepted_at
_cik10 = edgar_adapter.cik10


def _filed_at(text: str) -> date | None:
    """``FILED AS OF DATE`` as a date, or ``None``."""
    return _header_date(_header_value(text, "FILED AS OF DATE"))


def _submission_form(text: str) -> str | None:
    """``CONFORMED SUBMISSION TYPE`` — the form as EDGAR disseminated it."""
    return _header_value(text, "CONFORMED SUBMISSION TYPE")


def _filer_cik10(text: str) -> str | None:
    """The first ``CENTRAL INDEX KEY`` in the header, zero-padded."""
    raw = _header_value(text, "CENTRAL INDEX KEY")
    return _cik10(raw) if raw else None


class WriterUnavailable(RuntimeError):
    """``EDGAR_PARSE_APPLY`` is armed but no writer is wired.

    Raised rather than degraded to a dry run. An armed environment that silently
    stops writing is the exact failure this repo has shipped six times: the job
    runs on schedule, returns 200, and the table stops growing.
    """


@runtime_checkable
class RowWriter(Protocol):
    """What ``app/store/writers.py`` (T5) must provide. Collections are LOGICAL names.

    ``collection`` is a key of ``app.store.collections.COLLECTIONS``
    (``"insider_transactions"``, not ``"us_insider_transactions"``), so the
    physical name is resolved in exactly one place and a typo is a KeyError
    instead of a new collection nothing indexes.
    """

    def upsert_rows(
        self, collection: str, rows: Sequence[Mapping[str, Any]], *, key: Sequence[str]
    ) -> int:
        """Idempotent upsert on ``key``. Returns rows written."""

    def set_filing_status(
        self,
        accession: str,
        *,
        status: str,
        parsed_at: datetime,
        parser_version: str,
        error: str | None = None,
    ) -> None:
        """Stamp ``us_filings.status`` / ``parsedAt`` / ``parserVersion``."""

    def recompute_is_latest(
        self,
        *,
        cik10: str,
        statement_type: str,
        period_type: str,
        period_end: datetime,
    ) -> int:
        """Recompute the single ``isLatest`` pointer for one period group."""


@runtime_checkable
class Lookups(Protocol):
    """Read-only joins a parser needs. Separate from the writer on purpose.

    A dry run uses these (resolution is part of the parse) but must never reach
    the writer, so folding them together would make "writes nothing" untestable.
    """

    def instruments_for_cik(self, cik10: str) -> list[Mapping[str, Any]]:
        """ACTIVE ``us_instruments`` rows for one CIK. May be empty."""

    def cusip_map(self, cusips: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        """Existing ``us_cusip_map`` rows, keyed by CUSIP. Missing == unresolved."""

    def document_hashes(self, accession: str) -> dict[int, str]:
        """``sequence -> textHash`` already stored for this filing."""


class NullLookups:
    """No database configured. Answers "nothing known", and says so.

    Not a fail-open: the parse outcome reports ``lookups: "none"``, so a run
    whose symbols are all null because Mongo was never wired is distinguishable
    from one where the issuers genuinely have no active listing.
    """

    name = "none"

    def instruments_for_cik(self, cik10: str) -> list[Mapping[str, Any]]:
        return []

    def cusip_map(self, cusips: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        return {}

    def document_hashes(self, accession: str) -> dict[int, str]:
        return {}


class MongoLookups:
    """The real joins. Errors PROPAGATE — see :meth:`instruments_for_cik`."""

    name = "mongo"

    def __init__(self, database: Any) -> None:
        self._db = database

    def instruments_for_cik(self, cik10: str) -> list[Mapping[str, Any]]:
        """ACTIVE listings for one CIK.

        A Mongo failure here is NOT swallowed into an empty list. An empty list
        means "this filer has no active listing", which is a real and common
        answer that stores ``symbol: null``; a swallowed outage would store the
        same null for thousands of rows that do have a symbol, and nothing
        downstream could tell the two apart afterwards.
        """
        cursor = self._db[US_INSTRUMENTS_COLLECTION].find(
            {"cik": cik10, "listingStatus": "ACTIVE"},
            {"_id": 0, "symbol": 1, "assetType": 1, "exchange": 1, "openFIGIComposite": 1},
        )
        return list(cursor)

    def cusip_map(self, cusips: Sequence[str]) -> dict[str, Mapping[str, Any]]:
        if not cusips:
            return {}
        cursor = self._db[collection_name("cusip_map")].find(
            {"cusip": {"$in": list(cusips)}},
            {"_id": 0, "cusip": 1, "symbol": 1, "cik10": 1, "source": 1, "attempts": 1},
        )
        return {row["cusip"]: row for row in cursor if row.get("cusip")}

    def document_hashes(self, accession: str) -> dict[int, str]:
        cursor = self._db[collection_name("filing_documents")].find(
            {"accession": accession}, {"_id": 0, "sequence": 1, "textHash": 1}
        )
        return {
            int(row["sequence"]): row["textHash"]
            for row in cursor
            if row.get("sequence") is not None and row.get("textHash")
        }


def resolve_lookups() -> Lookups:
    """Mongo when ``DATABASE_URL`` resolves, otherwise :class:`NullLookups`."""
    if not settings.database_url():
        return NullLookups()
    from app.db import get_database

    database = get_database()
    return NullLookups() if database is None else MongoLookups(database)


def resolve_writer() -> RowWriter | None:
    """T5's writer, or ``None`` while ``app/store/writers.py`` does not exist.

    ``ModuleNotFoundError`` is caught NARROWLY and only for that module: a
    writer that exists but whose own import is broken must surface as the
    ImportError it is, not as "not implemented yet".
    """
    try:
        from app.store import writers  # type: ignore[attr-defined]
    except ModuleNotFoundError as err:
        if err.name in {"app.store.writers", "app.store"}:
            return None
        raise
    factory = getattr(writers, "default_writer", None)
    return factory() if callable(factory) else None


def default_archive_put(key: str, data: bytes) -> None:
    """Write extracted exhibit text to GCS. Imported lazily; used only when armed."""
    from app.sec import archive

    archive.write_bytes(key, data, content_type=archive.BUNDLE_CONTENT_TYPE)


@dataclass(frozen=True)
class _Write:
    """One collection's worth of rows plus the unique key they upsert on."""

    collection: str
    rows: list[dict[str, Any]]
    key: tuple[str, ...]


@dataclass
class _Parsed:
    status: str
    writes: list[_Write] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)
    #: (collection, filter) pairs a RESTATEMENT supersedes. Applied only when
    #: armed AND the writer implements `delete_rows`; reported either way.
    deletes: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    #: Period groups whose `isLatest` pointer must be recomputed after writing.
    latest_groups: list[dict[str, Any]] = field(default_factory=list)
    #: Deferred GCS puts: (key, bytes). Performed BEFORE the rows that point at
    #: them, so a stored `textPath` never precedes the object it names.
    objects: list[tuple[str, bytes]] = field(default_factory=list)


@dataclass(frozen=True)
class _Context:
    accession: str
    cik10: str | None
    form: str | None
    lookups: Lookups
    parser_version: str
    #: From the detector's message. A FALLBACK only: `<ACCEPTANCE-DATETIME>` in
    #: the bundle is the primary source and is present on a backfill, which has
    #: no message at all.
    accepted_at: datetime | None = None


# ── the five parsers ────────────────────────────────────────────────────────


def _resolve_symbol_for_cik(ctx: _Context, cik10: str, ticker: str | None) -> str | None:
    if not cik10:
        return None
    return ownership_logic.resolve_symbol(ticker, ctx.lookups.instruments_for_cik(cik10))


def _parse_ownership(text: str, ctx: _Context) -> _Parsed:
    cover, rows = edgar_adapter.ownership_from_bundle(text)
    # NO FALLBACK. `reportingPeriod` is the TRANSACTION period and is a
    # different fact; storing it as `filedAt` would put an insider trade on the
    # timeline days before the market could have known about it. Every
    # disseminated bundle carries `FILED AS OF DATE`, so its absence is a
    # malformed submission and belongs in FAILED where a reparse can find it.
    filed_at = _filed_at(text)
    if filed_at is None:
        raise ValueError(
            f"{ctx.accession}: Form {cover.form} header has no FILED AS OF DATE; "
            "refusing to substitute the reporting period"
        )
    symbol = _resolve_symbol_for_cik(ctx, cover.issuer_cik10, cover.issuer_ticker)
    documents = ownership_logic.build_rows(
        cover,
        rows,
        accession=ctx.accession,
        filed_at=filed_at,
        accepted_at=_accepted_at(text) or ctx.accepted_at,
        symbol=symbol,
        parser_version=ctx.parser_version,
    )
    transactions, holdings = ownership_logic.count_holdings(rows)
    return _Parsed(
        status=STATUS_PARSED,
        writes=[_Write("insider_transactions", documents, ("accession", "rowIndex"))],
        detail={
            "form": cover.form,
            "issuerCik10": cover.issuer_cik10,
            "symbol": symbol,
            "symbolResolved": symbol is not None,
            "transactions": transactions,
            "holdings": holdings,
            "isAmendment": cover.is_amendment,
        },
    )


def _parse_thirteenf(text: str, ctx: _Context) -> _Parsed:
    # Checked BEFORE parsing: a 13F-NT's form is enough to know there is no
    # information table, and parsing one only to find zero rows would make an
    # empty holdings report and a notice look identical.
    if thirteenf_logic.is_notice(ctx.form):
        return _Parsed(
            status=STATUS_UNSUPPORTED, detail={"reason": "13F-NT carries no information table"}
        )

    cover, rows = edgar_adapter.thirteenf_from_bundle(text)
    if thirteenf_logic.is_notice(ctx.form or cover.form, cover.report_type):
        return _Parsed(
            status=STATUS_UNSUPPORTED,
            detail={
                "reason": "13F-NT carries no information table",
                "reportType": cover.report_type,
            },
        )

    rule = thirteenf_logic.value_unit_rule(cover.filed_at)
    hits = ctx.lookups.cusip_map([row.cusip for row in rows])
    filing_row = thirteenf_logic.build_filing_row(
        cover, accession=ctx.accession, parser_version=ctx.parser_version
    )
    holding_rows = thirteenf_logic.build_holding_rows(
        cover,
        rows,
        accession=ctx.accession,
        parser_version=ctx.parser_version,
        cusip_hits=hits,
    )
    supersede = thirteenf_logic.supersede_filter(cover, ctx.accession)
    resolved = sum(1 for row in holding_rows if row["symbol"])
    disagrees = thirteenf_logic.unit_rule_disagrees(rule, cover.library_unit_verdict)
    unresolved_cusips = sorted({row["cusip"] for row in holding_rows if not row["symbol"]})

    return _Parsed(
        status=STATUS_PARSED,
        writes=[
            _Write("thirteen_f_filings", [filing_row], ("accession",)),
            _Write("thirteen_f_holdings", holding_rows, ("accession", "rowIndex")),
        ],
        deletes=[("thirteen_f_holdings", supersede)] if supersede else [],
        detail={
            "form": cover.form,
            "managerCik10": cover.manager_cik10,
            "periodOfReport": cover.period_of_report.isoformat(),
            "valueUnitRule": rule,
            "libraryUnitVerdict": cover.library_unit_verdict,
            # Surfaced as its own key, not folded into a log line: a 1000x
            # error is a plausible portfolio, so the disagreement has to be
            # countable across a run rather than greppable in one.
            "unitRuleDisagreement": disagrees,
            "amendmentEffect": thirteenf_logic.amendment_effect(cover),
            "cusipsResolved": resolved,
            "cusipsUnresolved": len(holding_rows) - resolved,
            # The DISTINCT unresolved CUSIPs, handed to the map's resolver leg
            # by `app/jobs/parse_13f.py`. That job pops the list before it
            # returns, so a 4,000-row 13F does not answer Pub/Sub with a
            # 4,000-element response body.
            "unresolvedCusips": unresolved_cusips,
        },
    )


def _parse_schedule13(text: str, ctx: _Context) -> _Parsed:
    cover, rows = edgar_adapter.schedule13_from_bundle(text)
    symbol = _resolve_symbol_for_cik(ctx, cover.subject_cik10, None)
    documents = schedule13_logic.build_rows(
        cover,
        rows,
        accession=ctx.accession,
        symbol=symbol,
        parser_version=ctx.parser_version,
    )
    seed = schedule13_logic.cusip_seed(cover)
    return _Parsed(
        status=STATUS_PARSED,
        writes=[_Write("beneficial_ownership", documents, ("accession", "rowIndex"))],
        detail={
            "form": cover.form,
            "schedule": cover.schedule,
            "subjectCik10": cover.subject_cik10,
            "symbol": symbol,
            "hasStructuredData": cover.has_structured_data,
            # "Old filing, HTML by law" vs "recent filing whose XML we failed to
            # read" produce identical rows and need opposite responses.
            "structuredDataExpected": schedule13_logic.expects_structured_data(cover.filed_at),
            "reportingPersons": len(documents),
            "cusipSeed": seed,
        },
    )


def _parse_eightk(text: str, ctx: _Context) -> _Parsed:
    meta, docs = edgar_adapter.eightk_from_bundle(text)
    # A PARTITION, not a filter, because the two refusals are reported as two
    # numbers. `len(docs) - len(storable)` used to be the artefact count, and
    # once images are refused too that subtraction silently attributes them to
    # the XBRL-viewer counter — one number over two causes, which is the
    # MONEY-1255 shape: it stays full while one of the things it counts goes
    # dark. Each count is now taken from the bucket the decision put the
    # document in, so it cannot be incremented ahead of that decision.
    triage = eightk_logic.triage_documents(docs)
    storable = triage.storable
    known = ctx.lookups.document_hashes(ctx.accession)

    changed: list[Any] = []
    unchanged = 0
    for doc in storable:
        if eightk_logic.text_is_unchanged(known.get(doc.sequence), doc):
            unchanged += 1
            continue
        changed.append(doc)

    text_paths: dict[int, str] = {}
    objects: list[tuple[str, bytes]] = []
    for doc in changed:
        if not doc.text:
            continue
        key = text_key(meta.cik10, ctx.accession, doc.sequence)
        text_paths[doc.sequence] = key
        objects.append((key, doc.text.encode("utf-8")))

    symbol = _resolve_symbol_for_cik(ctx, meta.cik10, None)
    documents = eightk_logic.build_rows(
        meta,
        changed,
        accession=ctx.accession,
        text_paths=text_paths,
        symbol=symbol,
        parser_version=ctx.parser_version,
    )
    return _Parsed(
        status=STATUS_PARSED,
        writes=[_Write("filing_documents", documents, ("accession", "sequence"))],
        objects=objects,
        detail={
            "form": meta.form,
            "cik10": meta.cik10,
            "items": list(meta.items),
            "isEarnings": eightk_logic.has_earnings_item(meta),
            "documents": len(storable),
            "generatedArtifactsSkipped": len(triage.generated_artifacts),
            # Images EDGAR types GRAPHIC, refused at the seam that decides what
            # is enqueued. Reported rather than left to be inferred from a
            # smaller `documents`: "we skipped 2 images" and "this filing had 2
            # fewer exhibits than we thought" are the same number otherwise.
            "binaryMediaSkipped": len(triage.binary_media),
            # PDF exhibits the adapter recovered text from, and PDF exhibits it
            # could not (MONEY-1350). NOT folded into `binaryMediaSkipped`:
            # that number is one leg of a three-way PARTITION of the
            # attachments, and a PDF is stored, not refused. Two orthogonal
            # measurements sharing one counter is the MONEY-1255 shape.
            "pdfTextExtracted": meta.pdf_text_extracted,
            "pdfNoTextLayer": meta.pdf_no_text_layer,
            # The idempotence signal. A reparse of an unchanged filing must show
            # `documentsUnchanged == documents` and write nothing.
            "documentsUnchanged": unchanged,
            "textObjects": len(objects),
            "symbol": symbol,
        },
    )


def _parse_financials(text: str, ctx: _Context) -> _Parsed:
    statements = edgar_adapter.statements_from_bundle(text)
    if statements is None:
        return _Parsed(
            status=STATUS_UNSUPPORTED,
            detail={"reason": "filing carries no XBRL instance"},
        )

    cik10 = ctx.cik10 or _filer_cik10(text)
    if not cik10:
        raise ValueError(f"{ctx.accession}: statements have no filer CIK")
    form = ctx.form or _submission_form(text) or ""
    # NO FALLBACK, for the same reason and with a sharper consequence: the
    # period end is by definition EARLIER than the filing, and `filedAt` is what
    # `isLatest` ranks on and what the point-in-time read filters by. A
    # substituted date would quietly make a restatement look like it was known
    # months before it was filed.
    filed_at = _filed_at(text)
    if filed_at is None:
        raise ValueError(
            f"{ctx.accession}: 10-K/10-Q header has no FILED AS OF DATE; "
            "refusing to substitute the period end"
        )
    symbol = _resolve_symbol_for_cik(ctx, cik10, None)

    rows, report = financials_logic.build_rows(
        statements,
        accession=ctx.accession,
        cik10=cik10,
        form=form,
        filed_at=filed_at,
        symbol=symbol,
        parser_version=ctx.parser_version,
    )
    if not rows:
        return _Parsed(
            status=STATUS_UNSUPPORTED,
            detail={"reason": "filing presents none of the three statements", **report},
        )

    return _Parsed(
        status=STATUS_PARSED,
        writes=[
            _Write(
                "fundamentals",
                rows,
                ("cik10", "statementType", "periodType", "periodEnd", "accession"),
            )
        ],
        latest_groups=financials_logic.latest_groups(rows),
        detail={
            "form": form,
            "cik10": cik10,
            "symbol": symbol,
            "fiscalYear": statements.fiscal_year,
            "fiscalPeriod": statements.fiscal_period,
            "periodType": financials_logic.period_type(statements.fiscal_period),
            "periodEnd": statements.period_end.isoformat(),
            "statements": [row["statementType"] for row in rows],
            **report,
        },
    )


_PARSERS: dict[str, Callable[[str, _Context], _Parsed]] = {
    "OWNERSHIP": _parse_ownership,
    "THIRTEENF": _parse_thirteenf,
    "SCHEDULE13": _parse_schedule13,
    "EIGHTK": _parse_eightk,
    "FINANCIALS": _parse_financials,
}


# ── the seam ────────────────────────────────────────────────────────────────


def parse_and_store(
    accession: str,
    bundle: bytes | str,
    *,
    parse_class: str,
    cik10: str | None = None,
    form: str | None = None,
    writer: RowWriter | None = None,
    lookups: Lookups | None = None,
    archive_put: Callable[[str, bytes], None] | None = None,
    accepted_at: datetime | None = None,
    apply: bool | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Parse one filing's bytes and, when armed, store what came out.

    ``bundle`` is the raw full-submission SGML — bytes or text. Where it came
    from is not this function's business, which is the entire design: an archive
    read, a live fetch, a poller's in-memory copy and an SFTP receiver's file all
    look identical from here.

    ``apply`` defaults to ``settings.parse_apply()``, read per call. Passing it
    explicitly is for tests and for a caller that has already resolved it.

    Returns an outcome dict; NEVER raises for a parse failure — a filing this
    build cannot read is data, and the caller needs the counters. Errors that are
    not about the filing (a writer that is missing while armed, a GCS put that
    fails) DO raise, because they are about us.
    """
    if parse_class not in _PARSERS:
        raise ValueError(f"unknown parse class {parse_class!r}; known: {list(PARSE_CLASSES)}")

    applying = settings.parse_apply() if apply is None else bool(apply)
    stamped_at = now or datetime.now(UTC)
    resolved_lookups = lookups if lookups is not None else resolve_lookups()
    text = bundle.decode("utf-8", "replace") if isinstance(bundle, bytes) else bundle

    ctx = _Context(
        accession=accession,
        cik10=cik10,
        form=form,
        lookups=resolved_lookups,
        parser_version=edgar_adapter.PARSER_VERSION,
        accepted_at=accepted_at,
    )

    outcome: dict[str, Any] = {
        "accession": accession,
        "parseClass": parse_class,
        "applied": applying,
        "parserVersion": ctx.parser_version,
        "lookups": getattr(resolved_lookups, "name", "custom"),
        "selected": 1,
        "written": 0,
        "failed": 0,
        "rows": {},
    }

    try:
        parsed = _PARSERS[parse_class](text, ctx)
    # Broad ON PURPOSE: a filing this build cannot read is DATA. Narrowing to
    # the exceptions we have already seen would let the next malformed 8-K
    # take the route to 500 and have Pub/Sub redeliver it five times.
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"[:ERROR_MAX_CHARS]
        outcome.update({"status": STATUS_FAILED, "failed": 1, "error": message})
        if applying:
            _require_writer(writer).set_filing_status(
                accession,
                status=STATUS_FAILED,
                parsed_at=stamped_at,
                parser_version=ctx.parser_version,
                error=message,
            )
        return outcome

    outcome["status"] = parsed.status
    outcome["detail"] = parsed.detail
    outcome["rows"] = {write.collection: len(write.rows) for write in parsed.writes}
    outcome["rowsParsed"] = sum(len(write.rows) for write in parsed.writes)

    if not applying:
        # Parsed fully, counted honestly, wrote nothing. No writer was touched —
        # `tests/test_dispatch.py` asserts that by handing in a writer that
        # raises on every method.
        return outcome

    active = _require_writer(writer)

    # Objects BEFORE rows: a stored `textPath` must never point at an object
    # that does not exist. A failed put raises and the filing stays unparsed.
    put = archive_put or default_archive_put
    for key, data in parsed.objects:
        put(key, data)
    outcome["objectsWritten"] = len(parsed.objects)

    deleted = 0
    delete_rows = getattr(active, "delete_rows", None)
    for collection, where in parsed.deletes:
        if not callable(delete_rows):
            outcome["supersedeApplied"] = False
            outcome["supersedeSkippedReason"] = "writer has no delete_rows"
            break
        deleted += int(delete_rows(collection, where) or 0)
    else:
        if parsed.deletes:
            outcome["supersedeApplied"] = True
    if parsed.deletes:
        outcome["supersededRows"] = deleted

    written = 0
    try:
        for write in parsed.writes:
            if not write.rows:
                continue
            written += int(active.upsert_rows(write.collection, write.rows, key=write.key) or 0)
    except UNENCODABLE_ROW_ERRORS as exc:
        # The write leg owes the same containment the parse leg has had since it
        # shipped. A value SEC filed that Mongo cannot encode is FILING DATA by
        # this function's own contract, and it surfaces here rather than above
        # because encoding happens at write time — so it sailed straight past
        # the parse's `except Exception` and out of the function.
        #
        # Not hypothetical: `edgar-bulk-companyfacts-prod` died on it two nights
        # running (2026-08-30, 2026-08-31) with `us_company_facts` frozen at
        # 134,938 rows, and the same shape was one filing away from ending an
        # `xbrl-backfill` run that costs 23h of a shared per-IP SEC budget.
        #
        # `written` is reported AS IT STANDS, not zeroed: earlier collections in
        # this filing may genuinely have landed, and calling that 0 would make a
        # partial write indistinguishable from a no-op for anything counting
        # rows afterwards.
        message = f"{type(exc).__name__}: {exc}"[:ERROR_MAX_CHARS]
        outcome.update(
            {"status": STATUS_FAILED, "failed": 1, "written": written, "error": message}
        )
        # FAILED, never PARSED. A filing stamped PARSED having stored nothing is
        # skipped by every later run, so a sanitiser shipped tomorrow would
        # never revisit it — the stamped-but-never-created shape of MONEY-1235.
        active.set_filing_status(
            accession,
            status=STATUS_FAILED,
            parsed_at=stamped_at,
            parser_version=ctx.parser_version,
            error=message,
        )
        return outcome
    outcome["written"] = written

    recomputed = 0
    for group in parsed.latest_groups:
        recomputed += int(active.recompute_is_latest(**group) or 0)
    if parsed.latest_groups:
        # Reported so a run that wrote rows and left the pointer stale — because
        # the recompute threw or was never wired — is visible instead of looking
        # like a clean write.
        outcome["isLatestGroups"] = len(parsed.latest_groups)
        outcome["isLatestRecomputed"] = recomputed

    active.set_filing_status(
        accession,
        status=parsed.status,
        parsed_at=stamped_at,
        parser_version=ctx.parser_version,
    )
    return outcome


def _require_writer(writer: RowWriter | None) -> RowWriter:
    resolved = writer if writer is not None else resolve_writer()
    if resolved is None:
        raise WriterUnavailable(
            "EDGAR_PARSE_APPLY is armed but app.store.writers.default_writer() is not available; "
            "refusing to report a successful run that wrote nothing"
        )
    return resolved


# ── the Pub/Sub-shaped wrapper ──────────────────────────────────────────────
#
# `parse_and_store` above is THE SEAM and has no transport in it. What follows
# is the fetch-then-parse COMPOSITION that the five push handlers share; it is
# here rather than duplicated five times, and it imports the client LAZILY so
# that importing `dispatch` still pulls in neither httpx nor the limiter. The
# poller (MONEY-1271) and the PDS receiver (MONEY-1272) will bring their own
# composition and call `parse_and_store` directly.


def _message_accepted_at(raw: Any) -> datetime | None:
    """``2026-08-29T01:53:58.000Z`` -> an aware datetime, or ``None``.

    T6 renders it the way ``JSON.stringify(new Date())`` does, with a literal
    ``Z`` that ``datetime.fromisoformat`` did not accept before 3.11. An
    unparseable value is ``None``, never today: this is a FALLBACK for a
    bundle with no ``<ACCEPTANCE-DATETIME>``, and a fabricated acceptance time
    would silently become a latency measurement.
    """
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _fetch_bundle(cik10: str, accession: str) -> bytes:
    """Archive-first, via T3's client. Lazy import — see the section comment."""
    from app.sec.client import SecClient

    with SecClient.from_settings() as client:
        return client.fetch_bundle(cik10, accession)


def run_parse_job(
    payload: Mapping[str, Any],
    *,
    parse_class: str,
    job: str,
    fetch_bundle: Callable[[str, str], bytes] | None = None,
    writer: RowWriter | None = None,
    lookups: Lookups | None = None,
    archive_put: Callable[[str, bytes], None] | None = None,
    apply: bool | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """One filing, end to end: fetch the bundle, parse it, report the outcome.

    ## What ACKs and what does not

    A message we cannot address — no accession, no CIK — is ACKED with a named
    skip. It will not become addressable on redelivery, and letting Pub/Sub
    retry it five times and dead-letter it turns a producer bug into an alert
    about the consumer.

    A DETERMINISTIC upstream refusal — a rate block, an identity rejection, egress
    switched off in QA, a 404 — is also ACKED, with ``transportFailures`` set. A
    block is measured at SEC's edge across every process we run; retrying
    immediately makes it longer, and five redeliveries of the same message is
    five more requests into a host that has already said no.

    A TRANSPORT error propagates, so the route answers 500 and Pub/Sub
    redelivers. That is the one class where trying again is the right move, and
    the dedupe lease is what makes a redelivery safe.

    ## The outcome is reported from a `finally`

    A job that raises before reporting is invisible in exactly the dimension
    this metric measures — and `selected > 0 and written == 0` is the signal
    that separates a healthy run from the six that ran on schedule, returned
    200 and wrote nothing for a week.
    """
    from app.sec.errors import SecError, SecTransportError
    from app.store.outcome import report_job_outcome

    selected = 0
    written = 0
    failed = 0
    transport_failures = 0
    skipped_reason: str | None = None
    result: dict[str, Any] = {"job": job, "parseClass": parse_class}

    try:
        accession = str(payload.get("accession") or "").strip()
        cik = payload.get("cik10") or payload.get("cik")
        cik = str(cik).strip() if cik is not None else ""
        if not accession or not cik:
            skipped_reason = "message carries no accession/cik10"
            result.update({"success": False, "skippedReason": skipped_reason})
            return result

        selected = 1
        try:
            bundle = (fetch_bundle or _fetch_bundle)(cik, accession)
        except SecTransportError:
            # Counted by nobody here on purpose: this path RAISES, the route
            # answers 500 and Pub/Sub redelivers. Reporting a transport failure
            # AND redelivering would double-count one filing.
            raise
        except SecError as err:
            transport_failures += 1
            skipped_reason = f"{type(err).__name__}"
            result.update(
                {
                    "success": False,
                    "accession": accession,
                    "skippedReason": skipped_reason,
                    "transportFailures": transport_failures,
                }
            )
            return result

        declared = str(payload.get("parseClass") or "").strip()
        if declared and declared != parse_class:
            # The SUBSCRIPTION is the authority — one topic per class — so the
            # route's class is used regardless. Recorded because a mis-routed
            # message means the detector and the topic disagree about a filing,
            # which is otherwise completely silent.
            result["parseClassMismatch"] = declared

        outcome = parse_and_store(
            accession,
            bundle,
            parse_class=parse_class,
            cik10=cik,
            form=(str(payload["form"]).strip() if payload.get("form") else None),
            writer=writer,
            lookups=lookups,
            archive_put=archive_put,
            accepted_at=_message_accepted_at(payload.get("acceptedAt")),
            apply=apply,
            now=now,
        )
        written = int(outcome.get("written") or 0)
        failed = int(outcome.get("failed") or 0)
        if outcome.get("status") == STATUS_UNSUPPORTED:
            skipped_reason = str((outcome.get("detail") or {}).get("reason") or "unsupported form")
        result.update(outcome)
        result["success"] = outcome.get("status") != STATUS_FAILED
        if skipped_reason:
            # Named in the RESPONSE as well as in the metric. The Pub/Sub
            # delivery log is the only place an operator sees why one message
            # produced nothing, and "200, wrote 0" with no reason is the shape
            # a healthy quiet run also has.
            result["skippedReason"] = skipped_reason
        return result
    finally:
        report_job_outcome(
            job,
            selected,
            written,
            failed=failed,
            transport_failures=transport_failures,
            skipped_reason=skipped_reason,
        )
