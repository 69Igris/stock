"""Backfill decisions — MONEY-979.

Every assertion here drives the REAL function in ``app/bulk/backfill_logic.py``.
The daily-index cases run against the committed ``form_20220214.idx.gz``
fixture — 19,412 real rows — because the three properties that matter (one row
per FILER, an index day that is not the filing day, and a co-registered filing
occupying sixteen rows) are facts about SEC's file and cannot be demonstrated by
a hand-written one.
"""

from __future__ import annotations

import gzip
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from app.bulk import common
from app.bulk.backfill_logic import (
    BUDGET_ENV,
    CLASS_ALIASES,
    FINANCIALS_FORMS,
    FTD_BUDGET_SECONDS,
    OWNERSHIP_BUDGET_SECONDS,
    XBRL_BUDGET_SECONDS,
    BackfillRunResult,
    FtdFile,
    FtdRow,
    budget_seconds,
    daily_index_key,
    daily_index_url,
    day_key,
    fiscal_year_of,
    fiscal_years,
    forms_for_parse_class,
    ftd_symbol_by_cusip,
    in_fy_window,
    owns_shard,
    parse_class_for_alias,
    parse_ftd_file,
    parse_ftd_index,
    publishes_index,
    quarter_of,
    recent_ftd_files,
    select_index_filings,
    select_shard,
    shard_of,
    validate_shard,
    walk_days,
)
from app.bulk.common import (
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_WRITE_DISARMED,
)
from app.sec.edgar_adapter import parse_daily_index
from app.store.models import (
    PARSE_CLASS_OWNERSHIP,
    PARSE_CLASS_SCHEDULE13,
    PARSE_CLASS_THIRTEENF,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"

#: The day the committed fixture was disseminated. Nothing derives ``filedAt``
#: from it — that is the whole point of the assertions below.
INDEX_DAY = date(2022, 2, 14)


def index_rows() -> list:
    with gzip.open(
        FIXTURES / "form_20220214.idx.gz", "rt", encoding="utf-8", errors="replace"
    ) as handle:
        return parse_daily_index(handle.read())


# ── Budgets ─────────────────────────────────────────────────────────────────


def test_budget_falls_back_to_the_per_job_default_when_unset() -> None:
    assert budget_seconds(XBRL_BUDGET_SECONDS) == XBRL_BUDGET_SECONDS
    assert budget_seconds(FTD_BUDGET_SECONDS) == FTD_BUDGET_SECONDS
    # 23h against Cloud Run's 24h ceiling — headroom for one worst unit.
    assert XBRL_BUDGET_SECONDS == OWNERSHIP_BUDGET_SECONDS == 82_800.0


@pytest.mark.parametrize("raw", ["", "   ", "abc", "0", "-5"])
def test_an_unusable_override_resolves_to_the_default_rather_than_raising(raw: str) -> None:
    os.environ[BUDGET_ENV] = raw
    try:
        assert budget_seconds(XBRL_BUDGET_SECONDS) == XBRL_BUDGET_SECONDS
    finally:
        os.environ.pop(BUDGET_ENV, None)


def test_the_override_is_read_per_call_and_agrees_with_the_bulk_jobs_reader() -> None:
    """The half of the shared rule that can drift is the PARSING, not the default."""
    os.environ[BUDGET_ENV] = "1234.5"
    try:
        assert budget_seconds(XBRL_BUDGET_SECONDS) == 1234.5
        # Same variable, same parse, in the module the nightly bulk jobs use.
        assert common.budget_seconds(common.FEED_SUBMISSIONS) == 1234.5
    finally:
        os.environ.pop(BUDGET_ENV, None)
    # Read PER CALL: removing the variable changes the answer without a reimport.
    assert budget_seconds(XBRL_BUDGET_SECONDS) == XBRL_BUDGET_SECONDS


# ── The run result ──────────────────────────────────────────────────────────


def test_only_a_budget_stop_is_resumable_and_it_still_exits_zero() -> None:
    stopped = BackfillRunResult(status=STATUS_BUDGET_EXHAUSTED, selected=7)
    assert stopped.resumable is True
    assert stopped.exit_code == 0, "a budget stop did what it was told; it is not a failure"
    assert stopped.as_dict()["resumable"] is True

    for status in (STATUS_COMPLETED, STATUS_WRITE_DISARMED):
        assert BackfillRunResult(status=status).resumable is False
        assert BackfillRunResult(status=status).exit_code == 0

    failure = BackfillRunResult(status=STATUS_FAILED)
    assert failure.resumable is False
    assert failure.exit_code == 1


# ── Form selection ──────────────────────────────────────────────────────────


def test_financials_forms_are_derived_from_the_one_form_table() -> None:
    assert set(FINANCIALS_FORMS) == {
        "10-K",
        "10-K/A",
        "10-Q",
        "10-Q/A",
        "20-F",
        "20-F/A",
        "40-F",
        "40-F/A",
    }
    # `NT 10-K` is a notice that a 10-K will be LATE. A substring test would
    # hand it to the statement parser and record a FAILED parse forever.
    assert "NT 10-K" not in FINANCIALS_FORMS


def test_the_13dg_walk_covers_both_spellings_of_the_form() -> None:
    forms = forms_for_parse_class(PARSE_CLASS_SCHEDULE13)
    assert {"SC 13D", "SC 13G", "SCHEDULE 13D", "SCHEDULE 13G"} <= forms
    assert forms_for_parse_class(PARSE_CLASS_THIRTEENF) >= {"13F-HR", "13F-NT"}


def test_class_aliases_map_onto_stored_parse_classes_and_a_typo_raises() -> None:
    assert parse_class_for_alias("ownership") == PARSE_CLASS_OWNERSHIP
    assert parse_class_for_alias(" 13F ") == PARSE_CLASS_THIRTEENF
    assert parse_class_for_alias("13dg") == PARSE_CLASS_SCHEDULE13
    assert set(CLASS_ALIASES) == {"ownership", "13f", "13dg"}
    with pytest.raises(ValueError, match="unknown --class"):
        parse_class_for_alias("13-f")


# ── Fiscal-year windows ─────────────────────────────────────────────────────


def test_the_fiscal_year_comes_from_the_period_not_the_filing_date() -> None:
    # A 10-K for FY2024 filed in Feb 2025. `filedAt` alone would both invent
    # 2025 and lose 2024.
    assert fiscal_year_of(date(2024, 12, 31), date(2025, 2, 3)) == 2024
    assert fiscal_year_of(None, date(2025, 2, 3)) == 2025
    assert fiscal_year_of(None, None) is None


def test_an_inverted_window_raises_rather_than_selecting_nothing() -> None:
    assert fiscal_years(2020, 2022) == [2020, 2021, 2022]
    assert fiscal_years(2024, 2024) == [2024]
    with pytest.raises(ValueError, match="after"):
        fiscal_years(2026, 2020)


def test_a_missing_fiscal_year_is_never_inside_the_window() -> None:
    assert in_fy_window(2021, 2020, 2026) is True
    assert in_fy_window(2019, 2020, 2026) is False
    assert in_fy_window(None, 2020, 2026) is False


# ── Sharding ────────────────────────────────────────────────────────────────

_HASH_PROBE = (
    "from app.bulk.backfill_logic import shard_of;"
    "ciks=['0000320193','0001067983','0000789019','0001318605'];"
    "print([shard_of(c, 4) for c in ciks]);"
    "print([hash(c) % 4 for c in ciks])"
)


def _probe_with_seed(seed: str) -> tuple[str, str]:
    env = {**os.environ, "PYTHONHASHSEED": seed}
    root = Path(__file__).resolve().parents[1]
    out = subprocess.run(
        [sys.executable, "-c", _HASH_PROBE],
        capture_output=True,
        text=True,
        cwd=root,
        env=env,
        check=True,
    ).stdout.splitlines()
    return out[0], out[1]


def test_sharding_is_stable_across_processes_and_builtin_hash_is_not() -> None:
    """The hazard and the fix, measured in two real interpreters.

    ``hash()`` on ``str`` is salted per process. With ``hash(cik) % tasks``, two
    Cloud Run tasks of ONE execution partition the same universe differently:
    filers walked twice, filers never walked, and both tasks reporting a clean
    run because each is internally consistent.
    """
    shard_a, builtin_a = _probe_with_seed("0")
    shard_b, builtin_b = _probe_with_seed("1")
    assert shard_a == shard_b, "shard_of must not depend on PYTHONHASHSEED"
    assert builtin_a != builtin_b, (
        "builtin hash() agreed across seeds — the hazard this test documents "
        "would no longer be demonstrated, so the assertion above proves nothing"
    )


def test_shards_partition_the_universe_with_no_overlap_and_no_gap() -> None:
    universe = [f"{i:010d}" for i in range(1, 1201)]
    tasks = 7
    slices = [select_shard(universe, tasks=tasks, task_index=i) for i in range(tasks)]

    union: list[str] = []
    for part in slices:
        union.extend(part)
    assert sorted(union) == sorted(universe), "a filer was walked twice or never"
    assert len(set(union)) == len(union), "shards overlap"
    for i in range(tasks):
        for j in range(i + 1, tasks):
            assert not set(slices[i]) & set(slices[j])
    # Every shard actually got work — a partition that put everything in one
    # bucket would satisfy the union check above and be useless.
    assert all(part for part in slices)


def test_a_single_task_takes_everything_and_the_slice_is_sorted_ascending() -> None:
    universe = ["0000789019", "0000320193", "0001067983", "0000320193"]
    assert select_shard(universe, tasks=1, task_index=0) == [
        "0000320193",
        "0000789019",
        "0001067983",
    ]


def test_an_out_of_range_shard_raises_instead_of_selecting_nothing() -> None:
    with pytest.raises(ValueError, match="--task-index"):
        validate_shard(4, 4)
    with pytest.raises(ValueError, match="--task-index"):
        validate_shard(4, -1)
    with pytest.raises(ValueError, match="--tasks"):
        validate_shard(0, 0)
    with pytest.raises(ValueError, match="tasks must be"):
        shard_of("0000320193", 0)


def test_owns_shard_agrees_with_shard_of() -> None:
    cik = "0000320193"
    index = shard_of(cik, 5)
    assert owns_shard(cik, tasks=5, task_index=index) is True
    assert owns_shard(cik, tasks=5, task_index=(index + 1) % 5) is False


# ── The day walk ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("day", "quarter"),
    [
        (date(2022, 1, 1), 1),
        (date(2022, 3, 31), 1),
        (date(2022, 4, 1), 2),
        (date(2022, 6, 30), 2),
        (date(2022, 7, 1), 3),
        (date(2022, 9, 30), 3),
        (date(2022, 10, 1), 4),
        (date(2022, 12, 31), 4),
    ],
)
def test_the_index_url_is_quarter_partitioned(day: date, quarter: int) -> None:
    assert quarter_of(day) == quarter
    assert f"/QTR{quarter}/" in daily_index_url(day)


def test_the_index_url_and_archive_key_are_the_measured_shapes() -> None:
    assert daily_index_url(INDEX_DAY) == (
        "https://www.sec.gov/Archives/edgar/daily-index/2022/QTR1/form.20220214.idx"
    )
    assert daily_index_key(INDEX_DAY) == "edgar/bulk/daily-index/2022-02-14/form.20220214.idx"
    assert day_key(INDEX_DAY) == "20220214"


def test_sec_publishes_no_index_on_a_weekend() -> None:
    assert publishes_index(date(2022, 2, 14)) is True  # Monday
    assert publishes_index(date(2022, 2, 18)) is True  # Friday
    assert publishes_index(date(2022, 2, 19)) is False  # Saturday
    assert publishes_index(date(2022, 2, 20)) is False  # Sunday


def test_the_walk_is_inclusive_NEWEST_FIRST_and_refuses_an_inverted_window() -> None:
    # Newest-first is the DEFAULT, and it is a product decision, not a detail:
    # a long backfill is queried between its runs, so run one must leave the
    # most-asked-about year complete. Measured on prod before this changed, an
    # ascending 5-year walk held 12,897 rows for 2021 and 47 for 2025.
    days = list(walk_days(date(2022, 2, 12), date(2022, 2, 15)))
    assert days == [
        date(2022, 2, 15),
        date(2022, 2, 14),
        date(2022, 2, 13),
        date(2022, 2, 12),
    ]
    assert days == sorted(days, reverse=True)
    assert days[0] == date(2022, 2, 15), "the NEWEST day is walked first"

    # Both ends are still inclusive, in both directions.
    assert list(walk_days(INDEX_DAY, INDEX_DAY)) == [INDEX_DAY]
    assert list(walk_days(date(2022, 2, 12), date(2022, 2, 15), newest_first=False)) == [
        date(2022, 2, 12),
        date(2022, 2, 13),
        date(2022, 2, 14),
        date(2022, 2, 15),
    ]

    # An inverted window is still a caller error in either direction — it must
    # never be silently reinterpreted as the reversed walk it now resembles.
    with pytest.raises(ValueError, match="after"):
        list(walk_days(date(2022, 2, 15), date(2022, 2, 12)))
    with pytest.raises(ValueError, match="after"):
        list(walk_days(date(2022, 2, 15), date(2022, 2, 12), newest_first=False))


# ── One dissemination day's filings ─────────────────────────────────────────


def test_the_real_index_collapses_19412_rows_to_11870_accessions() -> None:
    rows = index_rows()
    assert len(rows) == 19_412
    assert len({r.accession for r in rows}) == 11_870


def test_selection_dedupes_on_accession_so_one_filing_is_fetched_once() -> None:
    rows = index_rows()
    for parse_class_name in (
        PARSE_CLASS_OWNERSHIP,
        PARSE_CLASS_THIRTEENF,
        PARSE_CLASS_SCHEDULE13,
    ):
        selected = select_index_filings(rows, parse_class_name)
        accessions = [f.accession for f in selected]
        assert len(accessions) == len(set(accessions)), f"{parse_class_name} fanned out"
        assert accessions == sorted(accessions)
    # Non-trivial: the fixture really does carry all three classes.
    assert len(select_index_filings(rows, PARSE_CLASS_OWNERSHIP)) > 1_000
    assert len(select_index_filings(rows, PARSE_CLASS_THIRTEENF)) > 100
    assert len(select_index_filings(rows, PARSE_CLASS_SCHEDULE13)) > 1_000


def test_a_co_registered_filing_becomes_one_row_and_reports_how_many_it_occupied() -> None:
    """The measured 16-row S-3ASR, re-labelled onto a class we actually walk.

    S-3ASR itself is OTHER, so the shape is reproduced with the fixture's own
    co-registration pattern under a form the ownership walk selects.
    """
    from dataclasses import replace

    rows = [r for r in index_rows() if r.accession == "0001193125-22-037792"]
    assert len(rows) == 16, "the fixture's 16-way co-registration moved"
    relabelled = [replace(r, form="4") for r in rows]

    selected = select_index_filings(relabelled, PARSE_CLASS_OWNERSHIP)
    assert len(selected) == 1
    assert selected[0].rows == 16
    # Order-independent: the CIK is the minimum, never "whichever row was last".
    assert selected[0].cik10 == min(r.cik10 for r in rows)
    assert select_index_filings(list(reversed(relabelled)), PARSE_CLASS_OWNERSHIP) == selected


def test_filed_at_comes_from_the_row_and_never_from_the_file_it_was_found_in() -> None:
    """198 of the fixture's rows were filed as much as nine months earlier."""
    rows = index_rows()
    stale = [r for r in rows if r.filed_at != INDEX_DAY]
    assert len(stale) == 198
    assert min(r.filed_at for r in stale) == date(2021, 5, 21)

    from dataclasses import replace

    # One row, filed nine months before the file that disseminated it.
    old = replace(stale[0], form="4")
    selected = select_index_filings([old], PARSE_CLASS_OWNERSHIP)
    assert len(selected) == 1
    assert selected[0].filed_at == old.filed_at
    assert selected[0].filed_at != INDEX_DAY, (
        "filedAt was taken from the index day; the filing would land in the "
        "wrong period with a plausible-looking date"
    )


def test_selection_normalises_the_double_spaced_form_the_fixed_width_index_emits() -> None:
    from app.sec.adapter_types import DailyIndexRow

    row = DailyIndexRow(
        form="SC  13G",
        company="ACME",
        cik10="0000000001",
        filed_at=INDEX_DAY,
        accession="0000000000-22-000001",
        path="edgar/data/1/0000000000-22-000001.txt",
    )
    assert len(select_index_filings([row], PARSE_CLASS_SCHEDULE13)) == 1


def test_a_row_of_another_class_is_not_selected() -> None:
    rows = index_rows()
    forms = {f.form for f in select_index_filings(rows, PARSE_CLASS_THIRTEENF)}
    assert forms and forms <= {"13F-HR", "13F-HR/A", "13F-NT", "13F-NT/A"}


# ── SEC's FTD index page ────────────────────────────────────────────────────

#: The four directory shapes and the ``_0`` suffix, as MEASURED on the live page
#: 2026-08-29. A templated URL is wrong for 201 of the 410 real links.
FTD_INDEX_HTML = """
<ul>
  <li><a href="/files/data/fails-deliver-data/cnsfails202607b.zip">Jul 2026 b</a></li>
  <li><a href="/files/data/fails-deliver-data/cnsfails202607a.zip">Jul 2026 a</a></li>
  <li><a href="/files/data/other/fails-deliver-data/cnsfails202605b.zip">May 2026 b</a></li>
  <li><a href="/files/data/other/fails-deliver-data/cnsfails202308b_0.zip">Aug 2023 b</a></li>
  <li><a href="/files/node/add/data_distribution/cnsfails202004a.zip">Apr 2020 a</a></li>
  <li><a href="/files/data/frequently-requested-foia-document-fails-deliver-data/cnsfails200907a.zip">Jul 2009 a</a></li>
  <li><a href="/some/other/file.zip">not a fails file</a></li>
</ul>
"""


def test_the_index_page_is_read_and_the_directory_is_never_assumed() -> None:
    files = parse_ftd_index(FTD_INDEX_HTML)
    assert [f.period for f in files] == [
        "202607b",
        "202607a",
        "202605b",
        "202308b",
        "202004a",
        "200907a",
    ], "newest first"
    by_period = {f.period: f for f in files}
    assert by_period["202605b"].url == (
        "https://www.sec.gov/files/data/other/fails-deliver-data/cnsfails202605b.zip"
    )
    assert by_period["202004a"].url == (
        "https://www.sec.gov/files/node/add/data_distribution/cnsfails202004a.zip"
    )
    # The `_0` re-post keeps its own basename — the archive key and the
    # checkpoint detail both follow the FILE, not a template.
    assert by_period["202308b"].basename == "cnsfails202308b_0.zip"
    assert "file.zip" not in {f.basename for f in files}


def test_the_archive_key_is_derived_from_the_filename_alone() -> None:
    files = {f.period: f for f in parse_ftd_index(FTD_INDEX_HTML)}
    assert files["202607b"].archive_key == "edgar/bulk/ftd/2026-07-16/cnsfails202607b.zip"
    assert files["202607a"].archive_key == "edgar/bulk/ftd/2026-07-01/cnsfails202607a.zip"
    assert files["202308b"].archive_key == "edgar/bulk/ftd/2023-08-16/cnsfails202308b_0.zip"


def test_recent_files_are_bounded_by_a_file_count_not_a_calendar_subtraction() -> None:
    files = parse_ftd_index(FTD_INDEX_HTML)
    assert [f.period for f in recent_ftd_files(files, 1)] == ["202607b", "202607a"]
    assert len(recent_ftd_files(files, 24)) == len(files)
    with pytest.raises(ValueError, match="--months"):
        recent_ftd_files(files, 0)


def test_a_period_listed_twice_keeps_the_first_link() -> None:
    html = (
        '<a href="/files/data/other/fails-deliver-data/cnsfails202308b_0.zip">re-post</a>'
        '<a href="/files/data/fails-deliver-data/cnsfails202308b.zip">original</a>'
    )
    files = parse_ftd_index(html)
    assert len(files) == 1
    assert files[0].basename == "cnsfails202308b_0.zip"


# ── The FTD text format ─────────────────────────────────────────────────────

#: The MEASURED shape of ``cnsfails202607b.txt``, in miniature: the real header
#: (with its ``QUANTITY (FAILS)`` column name), a ``.`` price, a blank symbol,
#: BOTH trailer records, and the trailing blank line.
FTD_TEXT = (
    "SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE\n"
    "20260715|B5950S113|MDXH|1|MDXHEALTH SA SHS NEW(BELGIUM) |0.42\n"
    "20260715|037833100|AAPL|500|APPLE INC                     |210.15\n"
    "20260731|037833100|AAPL|250|APPLE INC                     |211.00\n"
    "20260715|25461H259|AMDDZZZZ|3|AMD PENDING                   |.\n"
    "20260731|25461H259|AMDD|4|AMD                           |1.10\n"
    "20260715|11111X111||7|NO SYMBOL AT ALL              |9.99\n"
    "Trailer record count 6\n"
    "Trailer total quantity of shares 765\n"
    "\n"
)


def test_the_parser_skips_the_header_both_trailers_and_the_blank_line() -> None:
    parsed = parse_ftd_file(FTD_TEXT)
    assert len(parsed.rows) == 6, "a trailer or the blank line was read as a data row"
    assert parsed.dropped == 0
    assert parsed.trailer_count == 6
    assert parsed.trailer_shares == 765
    assert parsed.trailer_matches is True
    assert all(row.cusip.isalnum() for row in parsed.rows)


def test_a_dot_price_and_a_blank_symbol_are_facts_not_failures() -> None:
    rows = {(r.cusip, r.settlement_date): r for r in parse_ftd_file(FTD_TEXT).rows}
    pending = rows[("25461H259", "20260715")]
    assert pending.price is None, "the literal '.' must not raise and must not become 0.0"
    assert pending.quantity == 3
    blank = rows[("11111X111", "20260715")]
    assert blank.symbol is None
    assert blank.price == 9.99
    # The description keeps its content and loses only the padding.
    assert rows[("037833100", "20260715")].description == "APPLE INC"


def test_a_malformed_line_is_dropped_and_counted_rather_than_silently_lost() -> None:
    text = FTD_TEXT.replace(
        "20260715|11111X111||7|NO SYMBOL AT ALL              |9.99\n",
        "20260715|11111X111|BAD|7\n",
    )
    parsed = parse_ftd_file(text)
    assert len(parsed.rows) == 5
    assert parsed.dropped == 1
    assert parsed.trailer_matches is False, "the trailer count disagrees and says so"


def test_a_file_with_no_trailer_reports_could_not_determine_not_a_mismatch() -> None:
    text = "\n".join(line for line in FTD_TEXT.splitlines() if not line.startswith("Trailer"))
    parsed = parse_ftd_file(text)
    assert parsed.trailer_count is None
    assert parsed.trailer_matches is None, (
        '"the file did not say" and "the count disagreed" are different facts'
    )


def test_an_empty_file_parses_to_nothing_rather_than_raising() -> None:
    assert parse_ftd_file("").rows == []
    assert (
        parse_ftd_file("SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE\n").rows
        == []
    )


# ── CUSIP -> symbol ─────────────────────────────────────────────────────────


def test_the_latest_settlement_date_decides_a_mid_month_ticker_change() -> None:
    """39 of the real file's 13,496 CUSIPs carry more than one symbol."""
    mapping, ambiguous = ftd_symbol_by_cusip(parse_ftd_file(FTD_TEXT).rows)
    assert ambiguous == 0
    assert mapping["25461H259"] == "AMDD", (
        "the 07-31 row must win over the 07-15 placeholder; a plain "
        "{cusip: symbol} assignment would keep whichever row came last"
    )
    assert mapping["037833100"] == "AAPL"
    assert "11111X111" not in mapping, "a blank symbol is not a mapping"


def test_two_symbols_on_the_same_latest_date_refuse_rather_than_pick() -> None:
    rows = [
        FtdRow("20260731", "G8923U129", "DPU", 1, "", None),
        FtdRow("20260731", "G8923U129", "WAI", 1, "", None),
        FtdRow("20260715", "G8923U129", "OLD", 1, "", None),
    ]
    mapping, ambiguous = ftd_symbol_by_cusip(rows)
    assert mapping == {}
    assert ambiguous == 1


def test_symbols_are_upper_cased_and_trimmed() -> None:
    mapping, _ = ftd_symbol_by_cusip([FtdRow("20260731", "037833100", " aapl ", 1, "", None)])
    assert mapping == {"037833100": "AAPL"}


def test_ftd_file_period_parts_are_derived_from_the_period_string() -> None:
    file = FtdFile(period="202607b", url="", basename="cnsfails202607b.zip")
    assert (file.year, file.month, file.half) == (2026, 7, "b")
    assert file.day == "2026-07-16"
    assert FtdFile(period="200907a", url="", basename="x.zip").day == "2009-07-01"
