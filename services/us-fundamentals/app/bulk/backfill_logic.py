"""The three history backfills' DECISIONS — MONEY-979.

Windows, sharding, resume, day-walk planning, and the two file formats the
backfills read (SEC's daily ``form.idx`` and its Fails-to-Deliver files). No
network, no Mongo, no GCS, no clock — so every rule below is driven by a test
against the REAL implementation rather than a re-declaration of it.

One documented exception: :func:`budget_seconds` reads ``os.environ`` (PER CALL,
never captured at import). It lives here because all three jobs share the
override and a second copy of the parsing rule is exactly the kind of drift this
service keeps paying for.

## Four measured facts the callers depend on

1. **``hash()`` IS NOT STABLE ACROSS PROCESSES.** CPython salts ``str`` hashing
   with ``PYTHONHASHSEED``, which is random per interpreter. ``hash(cik) % tasks``
   therefore gives Cloud Run task 0 and task 1 two DIFFERENT partitions of the
   same universe — some filers walked twice, some never — and it reports a clean
   run either way, because each task's own arithmetic is self-consistent.
   :func:`shard_of` uses SHA-256 for that reason.
2. **A daily ``form.idx`` is a DISSEMINATION-day index, not a filing-day one.**
   Measured on ``form.20220214.idx``: 19,412 rows collapse to 11,870 distinct
   accessions (ONE ROW PER FILER — a co-registered S-3ASR occupies sixteen, each
   with its own CIK and its own path), and 198 rows carry a ``filed_at`` earlier
   than the file's own date, reaching back to 2021-05-21. So the walk DEDUPES ON
   ACCESSION and takes ``filedAt`` FROM THE ROW. Both are enforced in
   :func:`select_index_filings`; taking the date from the filename would land
   every one of those 198 filings in the wrong period, silently.
3. **SEC's FTD index page cannot be templated.** Measured 2026-08-29: 410
   ``cnsfails*.zip`` links spread over FOUR directories —
   ``/files/data/fails-deliver-data`` (210), ``/files/data/other/fails-deliver-data``
   (3), ``/files/node/add/data_distribution`` (6) and
   ``/files/data/frequently-requested-foia-document-fails-deliver-data`` (191) —
   and two of them carry a ``_0`` suffix (``cnsfails202308b_0.zip``,
   ``cnsfails201910a_0.zip``). A URL built from the date is wrong for 201 of 410
   files. The index is READ, never guessed.
4. **An FTD file has TWO TRAILER RECORDS, not just a trailing blank line.**
   Measured on ``cnsfails202607b.txt``: 73,338 pipe-delimited lines (1 header +
   73,337 data) followed by ``Trailer record count 73337``, ``Trailer total
   quantity of shares 2739615364`` and an empty line. A parser that split every
   line on ``|`` would emit three garbage rows. The trailer count is also a free
   integrity check and is returned rather than discarded.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from app.bulk.common import (
    CLEAN_STATUSES,
    STATUS_BUDGET_EXHAUSTED,
)
from app.sec.adapter_types import DailyIndexRow
from app.sec.archive_logic import bulk_key
from app.store.models import (
    PARSE_CLASS_BY_FORM,
    PARSE_CLASS_FINANCIALS,
    PARSE_CLASS_OWNERSHIP,
    PARSE_CLASS_SCHEDULE13,
    PARSE_CLASS_THIRTEENF,
    parse_class,
)

# ── Wall-clock budgets ──────────────────────────────────────────────────────

#: Shared with the two nightly bulk jobs. Same name, same parsing rule, a
#: different DEFAULT — see :func:`budget_seconds`.
BUDGET_ENV = "EDGAR_BULK_BUDGET_SECONDS"

#: 23 h against Cloud Run's 24 h task-timeout ceiling. The budget is checked
#: BETWEEN units of work, so the true wall is ``budget + one worst unit``; an
#: hour of headroom covers the largest (one filer's whole fiscal year of 10-Qs,
#: or the tail of one dissemination day) and still lets the run report an
#: outcome instead of being killed mid-write.
XBRL_BUDGET_SECONDS = 82_800.0
OWNERSHIP_BUDGET_SECONDS = 82_800.0

#: The FTD walk is 2 files a month against a page that lists 410 of them; even
#: ``--months 24`` is 48 small downloads. An hour is generous.
FTD_BUDGET_SECONDS = 3_600.0


def budget_seconds(default: float) -> float:
    """``EDGAR_BULK_BUDGET_SECONDS`` if it parses to a positive float, else ``default``.

    Read PER CALL. A module-level ``os.getenv`` freezes at import — which happens
    before any test or any operator override — and the value silently used would
    be the default.

    The parsing rule is deliberately IDENTICAL to
    :func:`app.bulk.common.budget_seconds`; only the fallback differs, because
    that function's per-feed table has no entry for a backfill and would hand
    these 24-hour jobs a 2.5-hour ceiling. ``test_backfill_logic`` asserts the
    two agree whenever the variable is actually set, which is the half that can
    drift.
    """
    raw = (os.environ.get(BUDGET_ENV) or "").strip()
    if raw:
        try:
            value = float(raw)
        except ValueError:
            value = 0.0
        if value > 0:
            return value
    return default


# ── The outcome of one backfill run ─────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class BackfillRunResult:
    """One run, reported honestly.

    ``resumable`` is derived rather than stored: a run is resumable exactly when
    the WALL CLOCK stopped it, and a flag that could be set independently of the
    status is a flag that will eventually disagree with it.
    """

    status: str
    selected: int = 0
    written: int = 0
    failed: int = 0
    transport_failures: int = 0
    skipped_reason: str | None = None
    counters: dict[str, int] = field(default_factory=dict)

    @property
    def resumable(self) -> bool:
        return self.status == STATUS_BUDGET_EXHAUSTED

    @property
    def exit_code(self) -> int:
        """0 for every clean end, including a budget stop.

        A backfill that ran out of wall clock did exactly what it was told to do
        and checkpointed everything it finished. Exiting non-zero would make
        Cloud Run mark the execution failed and would train an operator to
        ignore the one status that means "run me again".
        """
        return 0 if self.status in CLEAN_STATUSES else 1

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "selected": self.selected,
            "written": self.written,
            "failed": self.failed,
            "transportFailures": self.transport_failures,
            "skippedReason": self.skipped_reason,
            "resumable": self.resumable,
            "counters": dict(self.counters),
        }


# ── Which forms a backfill selects ──────────────────────────────────────────


def forms_for_parse_class(wanted: str) -> frozenset[str]:
    """Every form string that classifies as ``wanted``. DERIVED, never restated.

    ``app.store.models.PARSE_CLASS_BY_FORM`` is the one form table in this tree.
    A second list here would drift the day SEC adds a spelling — and the copy
    that is wrong is the one nobody notices, because it keeps returning a
    plausible answer instead of raising (both 13D/G spellings are the standing
    example: a list that knew only ``SCHEDULE 13D`` would drop the whole
    pre-2025 backfill and report the rest as a complete run).
    """
    return frozenset(form for form, cls in PARSE_CLASS_BY_FORM.items() if cls == wanted)


#: 10-K / 10-Q / 20-F / 40-F **and their amendments**. An amendment carries the
#: restated statements, which is precisely what a history backfill wants; the
#: writer's ``recompute_is_latest`` already ranks a non-amendment below the
#: amendment that supersedes it, so including them cannot mis-order a period.
FINANCIALS_FORMS: frozenset[str] = forms_for_parse_class(PARSE_CLASS_FINANCIALS)

#: ``--class`` value -> ``us_filings.parseClass``. The CLI spells the walks the
#: way an operator thinks about them; the stored column is the vocabulary
#: everything else uses.
CLASS_ALIASES: dict[str, str] = {
    "ownership": PARSE_CLASS_OWNERSHIP,
    "13f": PARSE_CLASS_THIRTEENF,
    "13dg": PARSE_CLASS_SCHEDULE13,
}


def parse_class_for_alias(alias: str) -> str:
    """``"13dg"`` -> ``"SCHEDULE13"``. Raises on anything else.

    Raising rather than defaulting: an unrecognised ``--class`` can only come
    from a typo in an operator's argv, and answering with a default would walk
    several hundred thousand filings of the WRONG class under the right job name.
    """
    key = (alias or "").strip().lower()
    try:
        return CLASS_ALIASES[key]
    except KeyError as err:
        raise ValueError(f"unknown --class {alias!r}; known: {sorted(CLASS_ALIASES)}") from err


# ── Fiscal-year windows ─────────────────────────────────────────────────────


def fiscal_year_of(period_of_report: date | None, filed_at: date | None) -> int | None:
    """The fiscal year a filing belongs to. ``periodOfReport`` first.

    A 10-K is filed two to three months AFTER the year it reports on, so the
    filing date alone shifts most annual reports into the following year — it can
    both invent a year and lose one. Same rule as
    ``app.bulk.submissions.annual_fiscal_years``, for the same reason.
    """
    if period_of_report is not None:
        return period_of_report.year
    if filed_at is not None:
        return filed_at.year
    return None


def fiscal_years(from_fy: int, to_fy: int) -> list[int]:
    """``[from_fy .. to_fy]`` inclusive, ascending. Raises on an inverted window.

    Inverted is not "no work": it is an argv mistake, and an empty walk that
    exits 0 having selected nothing is indistinguishable from a converged one.
    """
    if from_fy > to_fy:
        raise ValueError(f"--from-fy {from_fy} is after --to-fy {to_fy}")
    return list(range(from_fy, to_fy + 1))


def in_fy_window(fiscal_year: int | None, from_fy: int, to_fy: int) -> bool:
    """Whether a fiscal year falls inside the window. ``None`` never does."""
    return fiscal_year is not None and from_fy <= fiscal_year <= to_fy


# ── Task sharding ───────────────────────────────────────────────────────────


def validate_shard(tasks: int, task_index: int) -> None:
    """``0 <= task_index < tasks`` and ``tasks >= 1``. Raises otherwise.

    An out-of-range index selects NOTHING and exits 0. That is the worst possible
    failure for a sharded backfill: N-1 tasks do their share, the misconfigured
    one reports a clean empty run, and the gap is invisible until someone counts
    rows months later.
    """
    if tasks < 1:
        raise ValueError(f"--tasks must be >= 1, got {tasks}")
    if not 0 <= task_index < tasks:
        raise ValueError(f"--task-index must be in [0, {tasks}), got {task_index}")


def shard_of(cik10: str, tasks: int) -> int:
    """Which task owns this CIK. STABLE ACROSS PROCESSES — see the module docstring.

    NOT ``hash(cik10) % tasks``. CPython salts string hashing per interpreter, so
    two Cloud Run tasks of the same execution would partition the universe
    differently: some filers walked twice, some never walked at all, and every
    task reporting a clean run because its own arithmetic is self-consistent.
    """
    if tasks < 1:
        raise ValueError(f"tasks must be >= 1, got {tasks}")
    digest = hashlib.sha256(cik10.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % tasks


def owns_shard(cik10: str, *, tasks: int, task_index: int) -> bool:
    return shard_of(cik10, tasks) == task_index


def select_shard(ciks: Iterable[str], *, tasks: int, task_index: int) -> list[str]:
    """This task's slice of the universe, DEDUPED and sorted ASCENDING.

    Ascending, always. A backfill that walks its population in an order the
    population's own growth can change hands later runs a different prefix, and
    a batch ordered by a column that is constant — or descending over a growing
    queue — never reaches its tail at all (MONEY-1211, MONEY-1255).
    """
    validate_shard(tasks, task_index)
    return sorted({c for c in ciks if c and owns_shard(c, tasks=tasks, task_index=task_index)})


# ── The daily-index day walk ────────────────────────────────────────────────

#: SEC's daily form index. Quarter-partitioned, one file per DISSEMINATION day.
DAILY_INDEX_URL = (
    "https://www.sec.gov/Archives/edgar/daily-index/{year}/QTR{quarter}/form.{stamp}.idx"
)

#: Feed name under ``edgar/bulk/`` for the archived index files.
DAILY_INDEX_FEED = "daily-index"


def quarter_of(day: date) -> int:
    """1-4. The URL is quarter-partitioned and a wrong quarter is a plain 404."""
    return (day.month - 1) // 3 + 1


def daily_index_url(day: date) -> str:
    return DAILY_INDEX_URL.format(
        year=day.year, quarter=quarter_of(day), stamp=day.strftime("%Y%m%d")
    )


def daily_index_basename(day: date) -> str:
    return f"form.{day.strftime('%Y%m%d')}.idx"


def daily_index_key(day: date) -> str:
    """``edgar/bulk/daily-index/{YYYY-MM-DD}/form.{YYYYMMDD}.idx``.

    RAW-FIRST, exactly like the filing bundles: the index is archived before it
    is parsed, so a re-walk (a mapping change, a new class) re-reads our own
    object, and QA — which may not reach sec.gov at all — can replay prod's
    bytes instead of being unable to run the walk.
    """
    return bulk_key(DAILY_INDEX_FEED, day.isoformat(), daily_index_basename(day))


def day_key(day: date) -> str:
    """``backfill_checkpoints.itemKey`` for one dissemination day."""
    return day.strftime("%Y%m%d")


def publishes_index(day: date) -> bool:
    """False for Saturday and Sunday. SEC disseminates nothing on a weekend.

    A deterministic, permanent rule, so a weekend is skipped WITHOUT a request.
    A holiday is not predictable and is NOT guessed at: it 404s, which the
    caller records as ``NO_INDEX`` — a named outcome that is neither a failure
    nor a success, and specifically NOT checkpointed DONE, because "SEC has not
    published this day yet" and "SEC will never publish this day" are the same
    404 and only one of them is permanent.
    """
    return day.weekday() < 5


def walk_days(from_date: date, to_date: date, *, newest_first: bool = True) -> Iterator[date]:
    """Every calendar day in ``[from_date, to_date]``. Raises on inversion.

    NEWEST FIRST by default, and that default is the point.

    A long backfill is not one atomic act — it is N budget-limited runs, and it
    is QUERIED between them. Walking ascending means the table fills from the
    least useful end: measured on prod 2026-08-30, a 5-year ownership walk
    started at 2021-08-30 held **12,897 rows for 2021 and 47 for 2025** while
    still days away from reaching the recent years anyone actually asks about.
    Every intermediate state was maximally unhelpful.

    Descending inverts that: run one leaves the most-queried year complete, and
    each subsequent run extends the history backwards. If the walk is abandoned
    half-way — budget, quota, a change of priorities — what got done is the half
    worth having.

    Ordering is free to choose because it carries no correctness weight:
    checkpoints are keyed per DAY and `load_checkpoints` returns finished days
    as a set, so resume is order-independent. Pass ``newest_first=False`` when a
    caller genuinely needs chronological order (a cumulative computation that
    reads its own previous output, say) — nothing in this repo does today.
    """
    if from_date > to_date:
        raise ValueError(f"--from-date {from_date} is after --to-date {to_date}")
    if newest_first:
        day = to_date
        while day >= from_date:
            yield day
            day = day - timedelta(days=1)
        return
    day = from_date
    while day <= to_date:
        yield day
        day = day + timedelta(days=1)


# ── One dissemination day's filings ─────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class IndexFiling:
    """One FILING (not one row) selected out of a daily index."""

    accession: str
    cik10: str
    form: str
    filed_at: date
    #: How many index ROWS this one filing occupied. 16 for the measured
    #: co-registered S-3ASR. Reported so the 1.6x row-to-filing ratio is a
    #: number in the log rather than a surprise in the row counts.
    rows: int = 1


def select_index_filings(rows: Sequence[DailyIndexRow], wanted_class: str) -> list[IndexFiling]:
    """Rows of one ``form.idx`` -> the distinct filings of one parse class.

    THREE properties, each of which has its own test and its own mutation:

    * **Filtered by PARSE CLASS, never by a form list of our own.** The form
      string is routed through ``app.store.models.parse_class``, which also
      normalises internal whitespace — the fixed-width index really does emit
      ``SC  13G`` with two spaces, and an exact-match form set would drop every
      one of them.
    * **Deduped on ACCESSION.** The index carries one row per FILER; 19,412 rows
      are 11,870 filings. Treating rows as filings fans the walk out 1.6x and
      fetches the same bundle sixteen times.
    * **``filed_at`` comes from THE ROW.** Never from the file's own date. 198
      of those 19,412 rows were filed as much as nine months earlier, and a
      backfill that stamped the filename's date would put each of them in a
      period the market could not have known about.

    The surviving row's CIK is ``min(cik10)`` across the group. Any choice is
    arbitrary — the index does not say which co-registrant is the issuer — so
    the requirement is that it be ORDER-INDEPENDENT: the CIK becomes the archive
    key for the bundle, and picking a different one on a re-walk would archive
    the same submission a second time under a second key.
    """
    grouped: dict[str, IndexFiling] = {}
    for row in rows:
        if parse_class(row.form) != wanted_class:
            continue
        accession = (row.accession or "").strip()
        if not accession:
            continue
        seen = grouped.get(accession)
        if seen is None:
            grouped[accession] = IndexFiling(
                accession=accession,
                cik10=row.cik10,
                form=row.form,
                filed_at=row.filed_at,
                rows=1,
            )
            continue
        grouped[accession] = IndexFiling(
            accession=accession,
            cik10=min(seen.cik10, row.cik10),
            form=seen.form,
            # THE ROW, and the EARLIEST row when the group disagrees. All rows of
            # one accession carry the same date in every file measured; taking
            # the minimum makes the tie-break explicit instead of "whichever row
            # the iteration reached last".
            filed_at=min(seen.filed_at, row.filed_at),
            rows=seen.rows + 1,
        )
    return [grouped[accession] for accession in sorted(grouped)]


# ── SEC's Fails-to-Deliver files ────────────────────────────────────────────

#: The ONE page this feed's URLs come from.
FTD_INDEX_URL = "https://www.sec.gov/data/foiadocsfailsdatahtm"

#: Links on that page are site-relative.
SEC_ORIGIN = "https://www.sec.gov"

#: Feed name under ``edgar/bulk/``.
FTD_FEED = "ftd"

#: ``cnsfails202607b.zip``, and the two ``cnsfails202308b_0.zip`` shapes. The
#: DIRECTORY is captured, never assumed: four of them are in use.
_FTD_HREF = re.compile(
    r"""href=["'](?P<path>[^"']*?/cnsfails(?P<period>\d{6})(?P<half>[ab])(?:_\d+)?\.zip)["']""",
    re.IGNORECASE,
)

#: The FTD text file's own header line.
FTD_HEADER_PREFIX = "SETTLEMENT DATE"

#: Both trailer records begin with this word. Measured:
#: ``Trailer record count 73337`` / ``Trailer total quantity of shares 2739615364``.
FTD_TRAILER_PREFIX = "TRAILER"

#: ``SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE``.
FTD_COLUMNS = 6

_FTD_TRAILER_COUNT = re.compile(r"^Trailer record count\s+(\d+)", re.IGNORECASE)
_FTD_TRAILER_SHARES = re.compile(r"^Trailer total quantity of shares\s+(\d+)", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class FtdFile:
    """One twice-monthly Fails-to-Deliver file, as the index page names it."""

    #: ``"202607b"`` — the sort key, and the checkpoint ``itemKey``.
    period: str
    url: str
    basename: str

    @property
    def year(self) -> int:
        return int(self.period[:4])

    @property
    def month(self) -> int:
        return int(self.period[4:6])

    @property
    def half(self) -> str:
        return self.period[6]

    @property
    def day(self) -> str:
        """The archive-key day: the 1st for the ``a`` half, the 16th for ``b``.

        Derived from the FILENAME, not from the file's contents, on purpose. A
        key has to be computable before the object is read — otherwise the
        archive cannot be checked for a hit — and the settlement dates inside
        ``202607b`` really do run 2026-07-15 to 2026-07-31, which is neither
        half's nominal boundary.
        """
        return f"{self.year:04d}-{self.month:02d}-{16 if self.half == 'b' else 1:02d}"

    @property
    def archive_key(self) -> str:
        """``edgar/bulk/ftd/{YYYY-MM-DD}/cnsfails{YYYYMM}{a|b}.zip``."""
        return bulk_key(FTD_FEED, self.day, self.basename)


def parse_ftd_index(html: str) -> list[FtdFile]:
    """Every Fails-to-Deliver file the index page links to, NEWEST FIRST.

    Measured 2026-08-29: 410 links, back to ``200907a``, across FOUR different
    directories, two of them carrying a ``_0`` filename suffix. Deriving a URL
    from the date is wrong for 201 of the 410 — so the path is taken from the
    page verbatim and only the PERIOD is parsed out of it, for ordering and for
    the checkpoint key.

    Deduped on period: if the page ever lists a period twice, the FIRST link
    wins, because the page is ordered newest-first and a re-post
    (``..._0.zip``) appears in place of the original rather than beside it.
    """
    seen: dict[str, FtdFile] = {}
    for match in _FTD_HREF.finditer(html):
        path = match.group("path")
        period = f"{match.group('period')}{match.group('half').lower()}"
        if period in seen:
            continue
        seen[period] = FtdFile(
            period=period,
            url=path if path.startswith("http") else f"{SEC_ORIGIN}{path}",
            basename=path.rsplit("/", 1)[-1],
        )
    return sorted(seen.values(), key=lambda f: f.period, reverse=True)


def recent_ftd_files(files: Sequence[FtdFile], months: int) -> list[FtdFile]:
    """The newest ``months`` months' worth — two files per month — newest first.

    Bounded by COUNT rather than by a date subtraction against today's clock:
    SEC publishes with a lag (the newest file on 2026-08-29 covered the second
    half of JULY), so "the last 24 months by calendar" and "the last 48 files"
    are different sets and only the second one is what an operator means.
    """
    if months < 1:
        raise ValueError(f"--months must be >= 1, got {months}")
    return list(files[: months * 2])


@dataclass(frozen=True, slots=True)
class FtdRow:
    """One data line. ``symbol`` and ``price`` may legitimately be absent."""

    settlement_date: str
    cusip: str
    symbol: str | None
    quantity: int
    description: str
    price: float | None


@dataclass(frozen=True, slots=True)
class FtdParse:
    """What one file yielded, and what it could not.

    ``dropped`` counts lines that were neither header, trailer, blank nor a
    well-formed row. It is RETURNED rather than logged and forgotten: a file
    that silently loses 40% of its lines reads exactly like a file that was
    published with 60% of the rows.
    """

    rows: list[FtdRow]
    dropped: int = 0
    trailer_count: int | None = None
    trailer_shares: int | None = None

    @property
    def trailer_matches(self) -> bool | None:
        """``True``/``False``, or ``None`` when the file carried no trailer.

        Three values, not two. "The file did not tell us how many rows it had"
        is not "the count disagreed", and collapsing them would turn a missing
        trailer into a permanent integrity alarm — or, far worse the other way,
        into a silent pass.
        """
        if self.trailer_count is None:
            return None
        return self.trailer_count == len(self.rows)


def parse_ftd_file(text: str) -> FtdParse:
    """SEC's pipe-delimited Fails-to-Deliver text -> rows. PURE.

    Measured shape (``cnsfails202607b.txt``, 4,613,759 B):

    * header ``SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE``
      — note the fourth column is ``QUANTITY (FAILS)``, not ``QUANTITY``;
    * 73,337 data rows, ``20260715|B5950S113|MDXH|1|MDXHEALTH SA SHS NEW(BELGIUM) |0.42``;
    * ``Trailer record count 73337``;
    * ``Trailer total quantity of shares 2739615364``;
    * one empty line.

    ``PRICE`` is the literal string ``"."`` on 345 of those rows, so a
    positional ``float()`` raises on real data. ``SYMBOL`` is empty on at least
    one CUSIP per file. Neither is an error and neither drops the row — the
    column this feed exists for is CUSIP, and a row with a price we cannot read
    still carries a mapping.
    """
    rows: list[FtdRow] = []
    dropped = 0
    trailer_count: int | None = None
    trailer_shares: int | None = None

    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line.strip():
            continue
        upper = line.lstrip().upper()
        if upper.startswith(FTD_HEADER_PREFIX):
            continue
        if upper.startswith(FTD_TRAILER_PREFIX):
            count = _FTD_TRAILER_COUNT.match(line.lstrip())
            if count:
                trailer_count = int(count.group(1))
                continue
            shares = _FTD_TRAILER_SHARES.match(line.lstrip())
            if shares:
                trailer_shares = int(shares.group(1))
            continue
        fields = line.split("|")
        if len(fields) != FTD_COLUMNS:
            dropped += 1
            continue
        row = _ftd_row(fields)
        if row is None:
            dropped += 1
            continue
        rows.append(row)

    return FtdParse(
        rows=rows,
        dropped=dropped,
        trailer_count=trailer_count,
        trailer_shares=trailer_shares,
    )


def _ftd_row(fields: Sequence[str]) -> FtdRow | None:
    settlement = fields[0].strip()
    cusip = fields[1].strip().upper()
    if len(settlement) != 8 or not settlement.isdigit() or not cusip:
        return None
    quantity_raw = fields[3].strip()
    return FtdRow(
        settlement_date=settlement,
        cusip=cusip,
        symbol=fields[2].strip() or None,
        quantity=int(quantity_raw) if quantity_raw.isdigit() else 0,
        description=fields[4].strip(),
        price=_maybe_float(fields[5]),
    )


def _maybe_float(raw: str) -> float | None:
    text = raw.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        # The literal "." — 345 rows of the measured file. A fact about the
        # feed, not a malformed line, and never a reason to drop the mapping.
        return None


def ftd_symbol_by_cusip(rows: Iterable[FtdRow]) -> tuple[dict[str, str], int]:
    """``({cusip: symbol}, ambiguous)`` — LATEST SETTLEMENT DATE WINS.

    Measured on ``cnsfails202607b.txt``: 13,496 distinct CUSIPs, of which **39
    carry more than one symbol inside the one file** — a ticker that changed
    mid-month (``G8923U129`` is both ``DPU`` and ``WAI``) or a pending-symbol
    placeholder (``AMDD`` / ``AMDDZZZZ``). Building the map with a plain
    ``{cusip: symbol}`` assignment would silently keep whichever row came last
    in file order.

    Taking the latest settlement date resolves ALL 39, leaving zero ambiguous
    and 13,495 of 13,496 CUSIPs with a unique non-blank symbol. The remaining
    branch — two different symbols on the SAME latest date — is a genuine
    "we do not know", and it REFUSES rather than picking: the same refusal
    ``app.parsers.cusip_map._one_symbol`` makes when a CIK carries several
    tickers, and for the same reason. A refusal is counted and returned.
    """
    best: dict[str, tuple[str, set[str]]] = {}
    for row in rows:
        symbol = (row.symbol or "").strip().upper()
        if not symbol:
            continue
        current = best.get(row.cusip)
        if current is None or row.settlement_date > current[0]:
            best[row.cusip] = (row.settlement_date, {symbol})
        elif row.settlement_date == current[0]:
            current[1].add(symbol)

    resolved: dict[str, str] = {}
    ambiguous = 0
    for cusip, (_stamp, symbols) in best.items():
        if len(symbols) != 1:
            ambiguous += 1
            continue
        resolved[cusip] = next(iter(symbols))
    return resolved, ambiguous
