"""OUR types for parsed SEC filings — deliberately not edgartools' types.

Every dataclass here is frozen and carries the FIELD NAMES FROM
`packages/database/prisma/schema.prisma`, so a writer is a straight copy rather
than a translation layer. That is the whole point: the schema is the contract,
`packages/core/__tests__/us-fundamentals/schema-parity.test.ts` fails the build
when the two drift, and a translation layer is where a field silently stops
being written.

The second reason these exist is INSULATION. `edgar_adapter` is the only module
in the tree allowed to `import edgar`; if its return types were the library's
types, every consumer would import them transitively and the pin would be
meaningless. A library upgrade must be able to change `ThirteenF.infotable`'s
columns without changing a single writer.

CONVENTIONS, all of which have a reason:

* Dates are `datetime.date` and timestamps are timezone-aware `datetime`. A
  naive datetime crossing into Mongo is a silent local-time reinterpretation.
* A value that could not be determined is `None`, NEVER a zero or an empty
  string. A gift (transaction code G) has no price, and a `0.0` there reads as
  a free transfer of nothing rather than an untold value.
* Numbers arrive EXACTLY AS FILED. No unit conversion happens in this module —
  see `ThirteenFCover.library_unit_verdict` for the one place that rule is
  load-bearing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime

# ── Filings and filers ──────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class FilingRef:
    """One filing as an index entry — what a detector or a ledger knows before parsing."""

    accession: str
    cik10: str
    form: str
    filed_at: date
    accepted_at: datetime | None = None
    period_of_report: date | None = None
    items: tuple[str, ...] = ()
    primary_document: str | None = None
    is_xbrl: bool = False
    is_inline_xbrl: bool = False
    size_bytes: int | None = None


@dataclass(frozen=True, slots=True)
class SubmissionsFiler:
    """The filer-level half of a `submissions.zip` member → `UsFiler`."""

    cik10: str
    name: str
    sic: str | None = None
    sic_description: str | None = None
    fiscal_year_end: str | None = None
    entity_type: str | None = None
    state_of_inc: str | None = None
    former_names: tuple[dict[str, str | None], ...] = ()
    tickers_as_filed: tuple[str, ...] = ()
    exchanges_as_filed: tuple[str, ...] = ()
    first_filing_at: date | None = None
    latest_filed_at: date | None = None
    # Distinct fiscal years with a 10-K / 20-F / 40-F on file. The COVERAGE
    # DENOMINATOR: decision 5 says a filer with less than five years must yield
    # everything it has and never fail, which is only expressible as a
    # measurement if the count is stored rather than inferred.
    fiscal_years_on_file: int = 0
    # `filings.files[]` — the paging references to the older shards. Carried so
    # a caller can decide to walk them; this module never fetches.
    paging_files: tuple[dict[str, str | int | None], ...] = ()


# ── Financial statements ────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class StatementLine:
    """One line of one statement, carrying BOTH namings of the same fact.

    `concept` is what the filer actually tagged (`us-gaap_GrossProfit`) and
    `standard_concept` is edgartools' normalisation of it (`GrossProfit`).
    Both are kept because roughly 5% of tags fall outside the standard map and
    company extension concepts fall outside it BY DEFINITION — a standardized
    number nobody can trace back to a filed label is a number nobody can
    defend.

    `standard_concept` is `None` on a dimensional row (a segment breakdown),
    which is how a reader tells "iPhone revenue" from "Net sales".
    """

    concept: str
    label: str
    standard_concept: str | None
    value: float | None
    unit: str | None = None
    # `{"us-gaap:StatementBusinessSegmentsAxis": "aapl:AmericasSegmentMember"}`.
    # Empty for an entity-wide line. `companyfacts.zip` has no dimensional facts
    # at all, so this is the only place segments can come from.
    dimensions: dict[str, str] = field(default_factory=dict)
    is_abstract: bool = False


@dataclass(frozen=True, slots=True)
class StatementSet:
    """The three primary statements (plus equity) for ONE period of one filing.

    `income`/`balance`/`cashflow`/`equity` are empty tuples — never `None` —
    when a filing does not present that statement, because a bank's 10-Q and a
    shell company's 10-K legitimately omit some of them and an empty statement
    must be distinguishable from a parse failure. A parse failure is
    `statements_from_bundle` returning `None` for the whole set.
    """

    income: tuple[StatementLine, ...]
    balance: tuple[StatementLine, ...]
    cashflow: tuple[StatementLine, ...]
    equity: tuple[StatementLine, ...]
    period_start: date | None
    period_end: date
    fiscal_year: int
    fiscal_period: str
    currency: str = "USD"
    # Column labels of the OTHER periods the filing presents (a 10-K carries two
    # prior years as comparatives). Listed rather than parsed so that a
    # comparative is a deliberate second write under the same accession, never
    # something that arrives unnoticed and doubles a period.
    comparative_periods: tuple[str, ...] = ()


# ── Ownership (Forms 3/4/5) ─────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class OwnershipCover:
    """Issuer + reporting owner, shared by every row of one Form 3/4/5."""

    issuer_cik10: str
    issuer_name: str
    issuer_ticker: str | None
    owner_cik10: str
    owner_name: str
    is_director: bool = False
    is_officer: bool = False
    is_ten_pct_owner: bool = False
    is_other: bool = False
    officer_title: str | None = None
    form: str = ""
    reporting_period: date | None = None
    is_amendment: bool = False
    remarks: str | None = None


@dataclass(frozen=True, slots=True)
class OwnershipRow:
    """One table line of a Form 3/4/5 → `UsInsiderTransaction`.

    Field names track the Prisma model exactly, including the ones that only
    ever apply to half the rows: a HOLDING has no code, no price and no
    acquired/disposed flag, and counting holdings as trades overstates insider
    activity — Form 3 is holdings almost entirely.
    """

    row_index: int
    security_title: str
    is_derivative: bool
    is_holding: bool
    transaction_code: str | None = None
    # From SEC's own 20-entry `TransCodeList`, not the library's 15-entry table.
    code_meaning: str | None = None
    # E (early) | L (late) | None (on time). This is where the printed form's
    # "V" went; there is no V code in the XML at all.
    timeliness: str | None = None
    # EDGAR appends "K" to a DISPLAYED code when `<equitySwapInvolved>` is set.
    # Stored as the flag it actually is, so `transaction_code` stays the code
    # SEC published and a "K" never has to be stripped back off.
    equity_swap: bool = False
    transaction_date: date | None = None
    acquired_disposed: str | None = None
    shares: float | None = None
    price: float | None = None
    # shares x price when BOTH exist; None otherwise. Never 0.0 — see module
    # docstring.
    value: float | None = None
    shares_owned_after: float | None = None
    direct_indirect: str | None = None
    # MANDATORY when `direct_indirect` is "I", forbidden when "D", per the spec.
    nature_of_ownership: str | None = None
    underlying_security: str | None = None
    underlying_shares: float | None = None
    exercise_price: float | None = None
    exercise_date: date | None = None
    expiration_date: date | None = None
    footnotes: tuple[str, ...] = ()


# ── 13F ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ThirteenFCover:
    """13F cover + summary page → `UsThirteenFFiling`.

    THE UNIT IS NOT APPLIED HERE, and that is deliberate. Release 34-95148
    moved 13F from thousands to whole dollars for every report FILED on or
    after 2023-01-03 — keyed on the FILING date, not the period, so a 2023-filed
    amendment of a 2022 quarter is in dollars while the original was in
    thousands. That rule is the caller's to apply, and this type gives it the
    two things it needs: the raw filed number and the filing date.

    `library_unit_verdict` records what edgartools' heuristic concluded, which
    is a different mechanism entirely — it infers the unit from implied price
    per share. It is stored so a disagreement is VISIBLE. A 1000x error here is
    a plausible-looking portfolio, not a crash, so a silent resolution of the
    two is the worst available outcome.
    """

    manager_cik10: str
    manager_name: str
    period_of_report: date
    filed_at: date
    form: str
    is_amendment: bool = False
    # RESTATEMENT replaces the original's holdings; NEW HOLDINGS adds to them.
    # Applying the wrong one either doubles a portfolio or erases most of it.
    amendment_type: str | None = None
    amendment_number: int | None = None
    report_type: str | None = None
    # EXACTLY as filed — thousands or dollars depending on the filing date.
    total_value_as_filed: float = 0.0
    total_holdings: int = 0
    other_managers_count: int = 0
    # "THOUSANDS" | "DOLLARS" | None. edgartools' opinion, never ours.
    library_unit_verdict: str | None = None


@dataclass(frozen=True, slots=True)
class ThirteenFRow:
    """One information-table row → `UsThirteenFHolding`.

    `value_as_filed` is the raw number. The writer converts it once, under
    `valueUnitRule`, into the schema's `valueUsd`.
    """

    row_index: int
    cusip: str
    issuer_name: str
    title_of_class: str
    value_as_filed: float
    shares: float
    # SH (shares) | PRN (principal amount). A PRN row is a bond position whose
    # "shares" are dollars of face value; summing the two as one quantity is
    # meaningless.
    shares_type: str
    # Optional since EDGAR Release 22.4.1 (Jan 2023) and genuinely optional in
    # practice — Berkshire omits it on every row of its 2026 filing. Where it
    # exists it joins straight to `UsInstrument.openFIGIComposite`.
    figi: str | None = None
    # Put | Call | None. An options position is not a share position.
    put_call: str | None = None
    investment_discretion: str = ""
    other_managers: tuple[str, ...] = ()
    voting_sole: float = 0.0
    voting_shared: float = 0.0
    voting_none: float = 0.0


# ── Schedules 13D / 13G ─────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Schedule13Cover:
    """Subject company and filing-level facts of a 13D/13G."""

    schedule: str  # "13D" | "13G"
    form: str  # as filed: "SCHEDULE 13D" | "SC 13G" | ".../A"
    subject_cik10: str
    subject_name: str
    cusip: str | None = None
    is_amendment: bool = False
    amendment_number: int | None = None
    event_date: date | None = None
    filed_at: date | None = None
    # 13D Item 4 — activist intent versus passive investment, and the only
    # field here a 13G structurally cannot have.
    purpose_text: str | None = None
    # FALSE for every filing before 2024-12-18, when structured XML became
    # mandatory. Without this flag, a null `percent_of_class` on a 2019 filing
    # is indistinguishable from a real zero.
    has_structured_data: bool = False


@dataclass(frozen=True, slots=True)
class Schedule13Row:
    """One reporting person → `UsBeneficialOwnership`."""

    row_index: int
    filer_name: str
    filer_cik10: str | None = None
    percent_of_class: float | None = None
    shares_owned: float | None = None
    sole_voting: float | None = None
    shared_voting: float | None = None
    sole_dispositive: float | None = None
    shared_dispositive: float | None = None
    # IN | CO | PN | IA | BD ... — SEC's reporting-person taxonomy.
    type_of_reporting_person: str | None = None
    citizenship: str | None = None


# ── 8-K ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class EightKMeta:
    """Filing-level facts of an 8-K."""

    cik10: str
    form: str
    filed_at: date
    accepted_at: datetime | None = None
    period_of_report: date | None = None
    # Item NUMBERS ("2.02"), not the descriptions SEC writes in the SGML
    # header. Item 2.02 is the earnings release.
    items: tuple[str, ...] = ()
    # PDF exhibits this walk RECOVERED text from, and PDF exhibits it could
    # not (MONEY-1350). Counted here rather than derived downstream because
    # the attempt happens in the adapter and nothing after it can tell a PDF
    # that had no text layer from one nobody tried.
    #
    # They are NOT part of the storable / artefact / binary-media partition —
    # they measure an EXTRACTION ATTEMPT over attachments, so a document counted
    # here is also counted in exactly one triage bucket. Folding them into
    # ``binaryMediaSkipped`` would break that partition in both directions.
    pdf_text_extracted: int = 0
    pdf_no_text_layer: int = 0


@dataclass(frozen=True, slots=True)
class EightKDoc:
    """One document or exhibit of a filing → `UsFilingDocument`."""

    sequence: int
    document_type: str  # EX-99.1 | EX-10.1 | 8-K (the primary document) ...
    filename: str
    description: str | None = None
    text: str | None = None
    text_bytes: int | None = None
    text_hash: str | None = None


# ── companyfacts ────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class CompanyFactValue:
    """One reported value of one concept.

    SEVERAL VALUES SHARE ONE PERIOD and that is not corruption: a later filing
    restates, and every 10-K carries comparative columns for prior years.

    `frame` (`CY2024Q1I`) is SEC's own answer to which fact best fits a
    calendar period, present only when the reporting window aligns. It is the
    one de-duplication signal SEC itself publishes, and edgartools' parser
    DROPS it — which is the entire reason `facts_from_companyfacts_json` reads
    the raw JSON instead of calling `EntityFactsParser.parse_company_facts`.
    """

    end: date
    val: float | int | str
    accn: str
    fy: int | None
    fp: str | None
    form: str
    filed: date
    start: date | None = None
    frame: str | None = None


@dataclass(frozen=True, slots=True)
class CompanyFactSeries:
    """Every value of one (taxonomy, concept, unit) → one `UsCompanyFact` doc."""

    cik10: str
    taxonomy: str
    concept: str
    unit: str
    label: str | None
    description: str | None
    values: tuple[CompanyFactValue, ...]


# ── Detection sources ───────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class CurrentFilingEntry:
    """One DEDUPED filing from the `getcurrent` Atom feed.

    100 Atom entries are ~49 filings: SEC emits one entry per filer ROLE
    (Reporting / Issuer / Subject / Filed by). `roles` keeps every (cik, role)
    pair seen for the accession so nothing is lost by the dedupe — the issuer
    of a Form 4 is a different company from the reporting owner, and both are
    worth knowing.
    """

    accession: str
    form: str
    cik10: str
    company: str
    accepted_at: datetime
    filed_at: date | None = None
    size_bytes: int | None = None
    roles: tuple[tuple[str, str, str], ...] = ()  # (cik10, company, role)


@dataclass(frozen=True, slots=True)
class EftsHit:
    """One hit from `efts.sec.gov/LATEST/search-index`.

    `ciks` is an ARRAY — a filing has one to several filers, and edgartools'
    own client keeps only `[0]`, which silently discards the issuer of every
    two-party filing. There is NO `form_type` field; it is `form`.
    """

    accession: str
    form: str
    ciks: tuple[str, ...]
    display_names: tuple[str, ...]
    file_date: date
    root_forms: tuple[str, ...] = ()
    file_type: str | None = None
    items: tuple[str, ...] = ()
    period_ending: date | None = None


@dataclass(frozen=True, slots=True)
class DailyIndexRow:
    """One row of a daily `form.idx`.

    Daily index files are NEVER corrected — post-acceptance deletions reach
    only the Saturday full-index rebuild — so a row here is "seen on this day",
    not "still exists".
    """

    form: str
    company: str
    cik10: str
    filed_at: date
    accession: str
    path: str
