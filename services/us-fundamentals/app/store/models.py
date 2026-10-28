"""Row models for the eleven ``us_*`` collections — MONEY-979.

## These field names are the CONTRACT, not a convenience

pymongo writes the PHYSICAL document and Prisma reads it, so the document keys
have to be the ones ``schema.prisma`` declares — camelCase, exactly as written in
the ``US FUNDAMENTALS — SEC EDGAR (MONEY-979)`` block. There is no ORM in between
to translate, which means a field spelled ``fiscal_year_end`` here is a field
Prisma reads as ``null`` forever, with nothing failing anywhere.

``tests/test_store_models.py`` emits :data:`SCHEMA_SNAPSHOT` to
``tests/_schema_snapshot.json`` and T11's
``packages/core/__tests__/us-fundamentals/schema-parity.test.ts`` compares that
file against the parsed schema. The snapshot deliberately OMITS Prisma's ``id``:
it is declared ``@map("_id")``, so the physical key is ``_id`` and MongoDB owns
it. Nothing here may write it.

## Why ``to_doc()`` drops ``None`` instead of writing it

A document that stores an explicit ``null`` makes "absent" and "null"
indistinguishable, and this repo has four tickets from that one confusion
(MONEY-1050, MONEY-1234, MONEY-1235, MONEY-1236). On Mongo a field added by a
later ``db push`` is ABSENT on every pre-existing row, so ``{f: null}`` and
``{f: {$ne: null}}`` both return ZERO — a filter that looks exhaustive and
selects nothing. Writing ``null`` for "we did not determine this" adds a third
population to that mess: rows where the value was actively decided to be
unknown, spelled the same way as rows nobody ever looked at.

So an unknown field is simply not in the document. A value that IS known to be
empty — ``formerNames: []`` on a company that never renamed — is written, because
an empty list is an answer.

## Dates

Prisma ``DateTime`` is BSON Date, and pymongo cannot encode ``datetime.date`` at
all (it raises ``InvalidDocument``). :func:`to_doc` widens every ``date`` to
midnight UTC and stamps UTC on any naive ``datetime``, because a naive datetime
crossing into Mongo is a silent local-time reinterpretation — one that shifts a
filing date across a day boundary for every filer in Asia/Kolkata.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

# ── Enumerated column values ────────────────────────────────────────────────
#
# Spelled as constants rather than as `Literal[...]` annotations on purpose: a
# value SEC starts publishing tomorrow must be storable, and a pydantic model
# that refuses it would turn one new form type into a whole failed nightly run.
# The constants exist so the writers and the tests agree on the spelling.

SOURCE_SEC_EDGAR = "SEC_EDGAR"
CURRENCY_USD = "USD"

#: ``UsFiling.status``.
#:
#: DETECTED is an IN-FLIGHT status and nothing else may borrow it. It means
#: "claimed and published to a parse topic, awaiting a parser", so a growing
#: DETECTED population is the signal that a parse queue has backed up. That
#: reading only works while every DETECTED row is genuinely waiting for
#: something.
#:
#: NO_PARSER is the TERMINAL answer for a filing whose ``parseClass`` is routed
#: nowhere — today that is exactly ``OTHER``, and ``classify.topic_for`` answers
#: ``None`` for it BY DESIGN. Those rows used to be stored DETECTED, which made
#: one status mean two opposite things: 933 permanent rows on prod
#: (MONEY-1303), indistinguishable from a genuinely stalled queue, and the
#: ambiguity hid the stall rather than the ledger row.
#:
#: It is NOT ``UNSUPPORTED``, and the difference is the evidence behind it.
#: UNSUPPORTED is stamped by a parser that RAN and found nothing to extract (a
#: ``13F-NT`` notice filing carries no information table). NO_PARSER means no
#: parser was ever asked. Collapsing the two would make "we looked" and "we
#: never looked" the same query.
STATUS_DETECTED = "DETECTED"
STATUS_INDEXED = "INDEXED"
STATUS_ARCHIVED = "ARCHIVED"
STATUS_PARSED = "PARSED"
STATUS_FAILED = "FAILED"
STATUS_UNSUPPORTED = "UNSUPPORTED"
STATUS_NO_PARSER = "NO_PARSER"
STATUS_WITHDRAWN = "WITHDRAWN"

#: ``UsFundamentals.statementType``.
STATEMENT_INCOME = "INCOME"
STATEMENT_BALANCE_SHEET = "BALANCE_SHEET"
STATEMENT_CASH_FLOW = "CASH_FLOW"

#: ``UsFundamentals.periodType``.
PERIOD_ANNUAL = "ANNUAL"
PERIOD_QUARTERLY = "QUARTERLY"

#: ``UsFundamentals.mappingSource``. FILING_XBRL outranks COMPANYFACTS — see
#: ``app.store.writers.recompute_is_latest``.
MAPPING_COMPANYFACTS = "COMPANYFACTS"
MAPPING_FILING_XBRL = "FILING_XBRL"

#: ``UsFiling.parseClass`` — which parser owns a filing.
PARSE_CLASS_OWNERSHIP = "OWNERSHIP"
PARSE_CLASS_THIRTEENF = "THIRTEENF"
PARSE_CLASS_SCHEDULE13 = "SCHEDULE13"
PARSE_CLASS_EIGHTK = "EIGHTK"
PARSE_CLASS_FINANCIALS = "FINANCIALS"
PARSE_CLASS_OTHER = "OTHER"

#: Form string -> ``parseClass``.
#:
#: EXACT MATCH, never a substring test. ``NT 10-K`` is a notice that a 10-K will
#: be LATE — it contains no financial statements at all — and a ``"10-K" in
#: form`` test would hand it to the financials parser, which would fetch it,
#: find no XBRL and record a FAILED parse for a filing that was never going to
#: have any. Same for ``NT 10-Q``, ``10-K405`` and ``25-NSE``.
#:
#: BOTH 13D/G spellings are present. SEC's XML mandate of 2024-12-18 changed the
#: form string from ``SC 13D`` to ``SCHEDULE 13D``; a classifier that knows only
#: one of them silently drops half the history and reports the other half as a
#: complete run.
PARSE_CLASS_BY_FORM: dict[str, str] = {
    "3": PARSE_CLASS_OWNERSHIP,
    "3/A": PARSE_CLASS_OWNERSHIP,
    "4": PARSE_CLASS_OWNERSHIP,
    "4/A": PARSE_CLASS_OWNERSHIP,
    "5": PARSE_CLASS_OWNERSHIP,
    "5/A": PARSE_CLASS_OWNERSHIP,
    "13F-HR": PARSE_CLASS_THIRTEENF,
    "13F-HR/A": PARSE_CLASS_THIRTEENF,
    "13F-NT": PARSE_CLASS_THIRTEENF,
    "13F-NT/A": PARSE_CLASS_THIRTEENF,
    "SC 13D": PARSE_CLASS_SCHEDULE13,
    "SC 13D/A": PARSE_CLASS_SCHEDULE13,
    "SC 13G": PARSE_CLASS_SCHEDULE13,
    "SC 13G/A": PARSE_CLASS_SCHEDULE13,
    "SCHEDULE 13D": PARSE_CLASS_SCHEDULE13,
    "SCHEDULE 13D/A": PARSE_CLASS_SCHEDULE13,
    "SCHEDULE 13G": PARSE_CLASS_SCHEDULE13,
    "SCHEDULE 13G/A": PARSE_CLASS_SCHEDULE13,
    "8-K": PARSE_CLASS_EIGHTK,
    "8-K/A": PARSE_CLASS_EIGHTK,
    # The foreign private issuer's current report — material events and
    # earnings releases filed as exhibits, which is exactly what `parse_8k`
    # extracts. FINANCIALS would be wrong (a 6-K carries no audited statement
    # set and no XBRL statements, so `parse_financials` fails on every one) and
    # OTHER drops every foreign issuer's earnings release out of the document
    # queue entirely.
    #
    # Note it carries no NUMBERED items the way an 8-K does, so `items` comes
    # back empty. That is the honest result — an empty list, not a missing
    # filing — and the exhibits, which are the point, are stored either way.
    "6-K": PARSE_CLASS_EIGHTK,
    "6-K/A": PARSE_CLASS_EIGHTK,
    "10-K": PARSE_CLASS_FINANCIALS,
    "10-K/A": PARSE_CLASS_FINANCIALS,
    "10-Q": PARSE_CLASS_FINANCIALS,
    "10-Q/A": PARSE_CLASS_FINANCIALS,
    "20-F": PARSE_CLASS_FINANCIALS,
    "20-F/A": PARSE_CLASS_FINANCIALS,
    "40-F": PARSE_CLASS_FINANCIALS,
    "40-F/A": PARSE_CLASS_FINANCIALS,
}

#: Forms whose presence proves a fiscal year of ANNUAL history.
#:
#: The coverage denominator (``UsFiler.fiscalYearsOnFile``) counts distinct
#: fiscal years carrying one of these. 20-F and 40-F are here because a foreign
#: private issuer and a Canadian MJDS filer never file a 10-K, and a gate that
#: counted only 10-Ks would report every one of them as having zero years of
#: history while their statements sat in the table.
ANNUAL_REPORT_FORMS: frozenset[str] = frozenset(
    {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}
)


def parse_class(form: str | None) -> str:
    """``UsFiling.parseClass`` for a form string. Unknown forms are ``OTHER``.

    SINGLE DEFINITION IN THE TREE. T6's ``app/sec/classify.py`` must import this
    rather than restate it: two copies of a form table drift the moment SEC adds
    a spelling, and the copy that is wrong is the one nobody notices because it
    keeps returning a plausible value (``OTHER``) instead of raising.
    """
    if not form:
        return PARSE_CLASS_OTHER
    normalised = " ".join(str(form).strip().upper().split())
    return PARSE_CLASS_BY_FORM.get(normalised, PARSE_CLASS_OTHER)


def utc_now() -> datetime:
    """Timezone-aware now. Every timestamp this service stores goes through it."""
    return datetime.now(UTC)


# ── Coercion ────────────────────────────────────────────────────────────────


def _coerce(value: Any) -> Any:
    """One document value, in a shape pymongo can encode and Prisma can read."""
    # datetime BEFORE date: `datetime` subclasses `date`, so the obvious order
    # truncates every timestamp in the service to midnight.
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    if isinstance(value, (list, tuple)):
        return [_coerce(item) for item in value]
    if isinstance(value, dict):
        return {key: _coerce(item) for key, item in value.items()}
    return value


class Row(BaseModel):
    """Base for every stored row: frozen, closed, and null-free on the way out."""

    # frozen: a row is a value. A writer that mutated one after building it would
    # make the checkpoint written beside it describe something else.
    # extra="forbid": a typo'd keyword is a field silently dropped from every
    # document otherwise, and the read side would report it as missing data.
    model_config = ConfigDict(frozen=True, extra="forbid")

    def to_doc(self) -> dict[str, Any]:
        """The MongoDB document. ``None`` fields are OMITTED, never written."""
        doc: dict[str, Any] = {}
        for name in type(self).model_fields:
            value = getattr(self, name)
            if value is None:
                continue
            doc[name] = _coerce(value)
        return doc


# ── The eleven ──────────────────────────────────────────────────────────────


class UsFilerRow(Row):
    """``us_filers`` — one SEC filer. Key: ``cik10``."""

    cik10: str
    name: str
    sic: str | None = None
    sicDescription: str | None = None
    #: ``MMDD`` as SEC publishes it ("0930"). NOT a date: it is a recurring
    #: annual boundary and materialising it would invent a year.
    fiscalYearEnd: str | None = None
    entityType: str | None = None
    stateOfInc: str | None = None
    formerNames: list[dict[str, Any]] = Field(default_factory=list)
    tickersAsFiled: list[str] = Field(default_factory=list)
    exchangesAsFiled: list[str] = Field(default_factory=list)
    firstFilingAt: date | None = None
    latestFiledAt: date | None = None
    inUniverse: bool = False
    fiscalYearsOnFile: int = 0
    eligibleForCoverage: bool = False
    source: str = SOURCE_SEC_EDGAR
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsFilingRow(Row):
    """``us_filings`` — every filing we have seen. Key: ``accession``."""

    accession: str
    cik10: str
    form: str
    filedAt: date
    acceptedAt: datetime | None = None
    periodOfReport: date | None = None
    items: list[str] = Field(default_factory=list)
    primaryDocument: str | None = None
    isXbrl: bool = False
    isInlineXbrl: bool = False
    sizeBytes: int | None = None
    parseClass: str = PARSE_CLASS_OTHER
    status: str = STATUS_INDEXED
    rawPath: str | None = None
    detectedAt: datetime | None = None
    parsedAt: datetime | None = None
    error: str | None = None
    parserVersion: str | None = None
    source: str = SOURCE_SEC_EDGAR
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsFundamentalsRow(Row):
    """``us_fundamentals`` — POINT-IN-TIME statements.

    Key: ``(cik10, statementType, periodType, periodEnd, accession)``. The
    accession is in the key because a restatement is a second true statement
    about one period, not a correction to be applied over the first.
    """

    cik10: str
    symbol: str | None = None
    statementType: str
    periodType: str
    periodStart: date | None = None
    periodEnd: date
    fiscalYear: int
    fiscalPeriod: str
    accession: str
    form: str
    filedAt: date
    isAmendment: bool = False
    isLatest: bool = False
    currency: str = CURRENCY_USD
    standardized: dict[str, Any] = Field(default_factory=dict)
    asReported: list[dict[str, Any]] = Field(default_factory=list)
    mappingSource: str = MAPPING_FILING_XBRL
    mappingVersion: str
    parserVersion: str
    source: str = SOURCE_SEC_EDGAR
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsCompanyFactRow(Row):
    """``us_company_facts`` — one concept's whole history.

    Key: ``(cik10, taxonomy, concept, unit)``. ``unit`` is in the key because the
    same concept is legitimately reported in more than one unit.
    """

    cik10: str
    taxonomy: str
    concept: str
    unit: str
    label: str | None = None
    #: ``[{start?, end, val, accn, fy, fp, form, filed, frame?}]``, ascending by
    #: ``end`` then ``filed``. ``frame`` is preserved here and in the cold shard;
    #: edgartools drops it, and it is the only de-duplication signal SEC itself
    #: publishes.
    values: list[dict[str, Any]] = Field(default_factory=list)
    lastFiledAt: date | None = None
    source: str = SOURCE_SEC_EDGAR
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsInsiderTransactionRow(Row):
    """``us_insider_transactions`` — Forms 3/4/5. Key: ``(accession, rowIndex)``."""

    accession: str
    rowIndex: int
    issuerCik10: str
    issuerName: str
    issuerTicker: str | None = None
    symbol: str | None = None
    ownerCik10: str
    ownerName: str
    isDirector: bool = False
    isOfficer: bool = False
    isTenPctOwner: bool = False
    isOther: bool = False
    officerTitle: str | None = None
    form: str
    transactionDate: date | None = None
    reportingPeriod: date | None = None
    filedAt: date
    acceptedAt: datetime | None = None
    securityTitle: str
    isDerivative: bool = False
    isHolding: bool = False
    transactionCode: str | None = None
    codeMeaning: str | None = None
    timeliness: str | None = None
    equitySwap: bool = False
    acquiredDisposed: str | None = None
    shares: float | None = None
    price: float | None = None
    value: float | None = None
    sharesOwnedAfter: float | None = None
    directIndirect: str | None = None
    natureOfOwnership: str | None = None
    underlyingSecurity: str | None = None
    underlyingShares: float | None = None
    exercisePrice: float | None = None
    exerciseDate: date | None = None
    expirationDate: date | None = None
    footnotes: list[str] = Field(default_factory=list)
    isAmendment: bool = False
    source: str = SOURCE_SEC_EDGAR
    parserVersion: str
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsThirteenFFilingRow(Row):
    """``us_13f_filings`` — one 13F cover page. Key: ``accession``."""

    accession: str
    managerCik10: str
    managerName: str
    periodOfReport: date
    filedAt: date
    form: str
    isAmendment: bool = False
    amendmentType: str | None = None
    amendmentNumber: int | None = None
    totalValueUsd: float = 0.0
    totalHoldings: int = 0
    otherManagersCount: int = 0
    tier: str = "HOT"
    coldPath: str | None = None
    valueUnitRule: str
    libraryUnitVerdict: str | None = None
    source: str = SOURCE_SEC_EDGAR
    parserVersion: str
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsThirteenFHoldingRow(Row):
    """``us_13f_holdings`` — one information-table row. Key: ``(accession, rowIndex)``."""

    accession: str
    rowIndex: int
    managerCik10: str
    periodOfReport: date
    filedAt: date
    cusip: str
    figi: str | None = None
    issuerName: str
    titleOfClass: str
    valueUsd: float
    shares: float
    sharesType: str
    putCall: str | None = None
    investmentDiscretion: str
    otherManagers: list[str] = Field(default_factory=list)
    votingSole: float = 0.0
    votingShared: float = 0.0
    votingNone: float = 0.0
    symbol: str | None = None
    issuerCik10: str | None = None
    resolvedBy: str | None = None
    source: str = SOURCE_SEC_EDGAR
    parserVersion: str
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsBeneficialOwnershipRow(Row):
    """``us_beneficial_ownership`` — 13D/G. Key: ``(accession, rowIndex)``."""

    accession: str
    rowIndex: int
    schedule: str
    form: str
    isAmendment: bool = False
    amendmentNumber: int | None = None
    subjectCik10: str
    subjectName: str
    cusip: str | None = None
    symbol: str | None = None
    filerCik10: str | None = None
    filerName: str
    percentOfClass: float | None = None
    sharesOwned: float | None = None
    soleVoting: float | None = None
    sharedVoting: float | None = None
    soleDispositive: float | None = None
    sharedDispositive: float | None = None
    typeOfReportingPerson: str | None = None
    eventDate: date | None = None
    filedAt: date
    purposeText: str | None = None
    hasStructuredData: bool = False
    source: str = SOURCE_SEC_EDGAR
    parserVersion: str
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsFilingDocumentRow(Row):
    """``us_filing_documents`` — one document/exhibit. Key: ``(accession, sequence)``."""

    accession: str
    sequence: int
    cik10: str
    symbol: str | None = None
    form: str
    filedAt: date
    items: list[str] = Field(default_factory=list)
    documentType: str
    description: str | None = None
    filename: str
    textPath: str | None = None
    textBytes: int | None = None
    textHash: str | None = None
    extractionStatus: str = "PENDING"
    source: str = SOURCE_SEC_EDGAR
    parserVersion: str
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsCusipMapRow(Row):
    """``us_cusip_map`` — CUSIP -> ticker. Key: ``cusip``.

    ``source`` here is the RESOLUTION TIER (``SEC_13DG`` / ``TIINGO_FIGI`` /
    ``SEC_FTD`` / ``OPENFIGI`` / ``UNRESOLVED``), not ``SEC_EDGAR`` — this is the
    one model whose ``source`` column answers a different question, which is why
    it has no default.
    """

    cusip: str
    symbol: str | None = None
    cik10: str | None = None
    compositeFigi: str | None = None
    issuerName: str | None = None
    source: str
    confidence: float = 1.0
    attempts: int = 0
    resolvedAt: datetime | None = None
    lastTriedAt: datetime | None = None
    ingestedAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


class UsEdgarCursorRow(Row):
    """``us_edgar_cursor`` — one detection cursor or bulk watermark. Key: ``key``."""

    key: str
    lastAccession: str | None = None
    lastAcceptedAt: datetime | None = None
    lastRunAt: datetime | None = None
    #: ``{lastModified, etag, sha256, members, changedMembers}`` — free-form,
    #: because each stream watermarks differently.
    meta: dict[str, Any] | None = None
    createdAt: datetime = Field(default_factory=utc_now)
    updatedAt: datetime = Field(default_factory=utc_now)


#: Prisma model name -> the row model that writes its collection.
#:
#: Keyed by the PRISMA name (not the ``@@map``) because the parity test parses
#: ``schema.prisma``, where the model name is what a ``model (\\w+) {`` regex
#: yields.
MODELS: dict[str, type[Row]] = {
    "UsFiler": UsFilerRow,
    "UsFiling": UsFilingRow,
    "UsFundamentals": UsFundamentalsRow,
    "UsCompanyFact": UsCompanyFactRow,
    "UsInsiderTransaction": UsInsiderTransactionRow,
    "UsThirteenFFiling": UsThirteenFFilingRow,
    "UsThirteenFHolding": UsThirteenFHoldingRow,
    "UsBeneficialOwnership": UsBeneficialOwnershipRow,
    "UsFilingDocument": UsFilingDocumentRow,
    "UsCusipMap": UsCusipMapRow,
    "UsEdgarCursor": UsEdgarCursorRow,
}


def schema_snapshot() -> dict[str, list[str]]:
    """``{PrismaModel: [field, ...]}`` — the file T11's TypeScript test reads.

    Sorted, so a re-ordering of the declarations above cannot show up as a diff
    and train the next person to ignore one.
    """
    return {name: sorted(model.model_fields) for name, model in sorted(MODELS.items())}
