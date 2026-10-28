"""The statement-history backfill — MONEY-979.

The property this file exists for is the FIRST one below: a DONE checkpoint must
skip **before the fetch**. That is the entire performance argument for a walk of
~8,000 filers x 6 fiscal years, and it is only provable by counting calls on the
fetcher — a run that skipped after fetching would report identical rows,
identical counters and identical checkpoints.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

import pytest

from app.bulk import xbrl_backfill
from app.bulk.backfill_logic import shard_of
from app.bulk.common import (
    CHECKPOINT_COLLECTION,
    CHECKPOINT_DONE,
    CHECKPOINT_EMPTY,
    CHECKPOINT_ERROR,
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_WRITE_DISARMED,
    RunBudget,
)
from app.bulk.xbrl_backfill import CHECKPOINT_JOB_KEY, REASON_UNIVERSE_EMPTY, UnitCheckpoint
from app.sec.errors import SecNotFound, SecRateLimited
from app.store import writers

from .test_store_writers import FakeDatabase

APPLE = "0000320193"
BERKSHIRE = "0001067983"


# ── Doubles ─────────────────────────────────────────────────────────────────


class RecordingFetcher:
    """Counts every bundle request. The whole point of the resume assertion."""

    def __init__(self, *, raises: dict[str, Exception] | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self._raises = raises or {}

    def __call__(self, cik10: str, accession: str) -> bytes:
        self.calls.append((cik10, accession))
        if accession in self._raises:
            raise self._raises[accession]
        return f"<SEC-DOCUMENT>{accession}".encode()

    @property
    def count(self) -> int:
        return len(self.calls)


class RecordingParse:
    """Stands in for ``dispatch.parse_and_store``; returns its real outcome shape."""

    def __init__(self, *, written: int = 3, fail: set[str] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._written = written
        self._fail = fail or set()

    def __call__(self, accession: str, bundle: bytes, **kwargs: Any) -> dict[str, Any]:
        self.calls.append({"accession": accession, "bundle": bundle, **kwargs})
        if accession in self._fail:
            return {"status": "FAILED", "written": 0, "failed": 1, "error": "boom"}
        return {"status": "PARSED", "written": self._written, "failed": 0}


class ExplodingWriter:
    """Every method raises. Handed to a DRY run to prove nothing was written."""

    def upsert_rows(self, *_a: Any, **_k: Any) -> int:
        raise AssertionError("a dry run touched the writer")

    def set_filing_status(self, *_a: Any, **_k: Any) -> None:
        raise AssertionError("a dry run touched the writer")

    def recompute_is_latest(self, *_a: Any, **_k: Any) -> int:
        raise AssertionError("a dry run touched the writer")


# ── World building ──────────────────────────────────────────────────────────


@pytest.fixture
def db() -> FakeDatabase:
    writers.reset_index_cache()
    return FakeDatabase()


def seed_universe(db: FakeDatabase, ciks: list[str], *, in_universe: bool = True) -> None:
    for index, cik in enumerate(ciks):
        db["us_instruments"].documents.append(
            {
                "_id": 1000 + index,
                "cik": cik,
                "symbol": f"SYM{index}",
                "assetType": "Stock",
                "listingStatus": "ACTIVE",
            }
        )
        db["us_filers"].documents.append(
            {"_id": 2000 + index, "cik10": cik, "name": f"Filer {index}", "inUniverse": in_universe}
        )


def seed_filing(
    db: FakeDatabase,
    *,
    accession: str,
    cik10: str = APPLE,
    form: str = "10-K",
    period: date | None = date(2024, 12, 31),
    filed: date = date(2025, 2, 3),
    status: str = "INDEXED",
) -> None:
    doc: dict[str, Any] = {
        "_id": len(db["us_filings"].documents) + 3000,
        "accession": accession,
        "cik10": cik10,
        "form": form,
        "filedAt": filed,
        "status": status,
    }
    if period is not None:
        doc["periodOfReport"] = period
    db["us_filings"].documents.append(doc)


def seed_checkpoint(
    db: FakeDatabase, cik: str, fiscal_year: int, status: str = CHECKPOINT_DONE
) -> None:
    db[CHECKPOINT_COLLECTION].documents.append(
        {
            "_id": len(db[CHECKPOINT_COLLECTION].documents) + 4000,
            "jobKey": CHECKPOINT_JOB_KEY,
            "itemKey": cik,
            "scope": str(fiscal_year),
            "status": status,
            "detail": "seeded",
        }
    )


def checkpoints(db: FakeDatabase) -> list[dict[str, Any]]:
    return db[CHECKPOINT_COLLECTION].documents


def run_job(db: FakeDatabase, fetcher: Any, parse: Any, **kwargs: Any) -> Any:
    return xbrl_backfill.run(
        db=db,
        fetch_bundle=fetcher,
        from_fy=kwargs.pop("from_fy", 2024),
        to_fy=kwargs.pop("to_fy", 2024),
        parse=parse,
        writer=kwargs.pop("writer", object()),
        lookups=kwargs.pop("lookups", object()),
        apply_writes=kwargs.pop("apply_writes", True),
        now=kwargs.pop("now", datetime(2026, 8, 29, tzinfo=UTC)),
        **kwargs,
    )


# ── THE resume property ─────────────────────────────────────────────────────


def test_a_done_checkpoint_skips_before_the_fetch(db: FakeDatabase) -> None:
    """ZERO fetches on a fully checkpointed re-run. Not "fewer" — zero."""
    seed_universe(db, [APPLE])
    seed_filing(db, accession="0000320193-25-000001")
    seed_checkpoint(db, APPLE, 2024)

    fetcher = RecordingFetcher()
    parse = RecordingParse()
    result = run_job(db, fetcher, parse)

    assert fetcher.count == 0, "a DONE unit cost a SEC request; resume is not free"
    assert parse.calls == []
    assert result.status == STATUS_COMPLETED
    assert result.selected == 0
    assert result.counters["filersSkipped"] == 1
    assert result.counters["unitsSkipped"] == 1
    assert result.counters["filersWalked"] == 0


def test_only_the_outstanding_fiscal_years_are_fetched(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2023", period=date(2023, 12, 31), filed=date(2024, 2, 1))
    seed_filing(db, accession="a-2024", period=date(2024, 12, 31), filed=date(2025, 2, 1))
    seed_checkpoint(db, APPLE, 2023)

    fetcher = RecordingFetcher()
    result = run_job(db, fetcher, RecordingParse(), from_fy=2023, to_fy=2024)

    assert [a for _c, a in fetcher.calls] == ["a-2024"]
    assert result.counters["unitsSkipped"] == 1
    assert result.counters["unitsDone"] == 1


def test_an_error_checkpoint_is_retried_and_never_read_as_finished(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2024")
    seed_checkpoint(db, APPLE, 2024, status=CHECKPOINT_ERROR)

    fetcher = RecordingFetcher()
    run_job(db, fetcher, RecordingParse())
    assert fetcher.count == 1, "an ERROR checkpoint made one bad night permanent"


def test_a_filing_already_parsed_is_not_fetched_again(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-parsed", status="PARSED")
    seed_filing(db, accession="a-fresh", status="INDEXED")

    fetcher = RecordingFetcher()
    result = run_job(db, fetcher, RecordingParse())
    assert [a for _c, a in fetcher.calls] == ["a-fresh"]
    assert result.counters["filingsAlreadyParsed"] == 1


# ── The universe ────────────────────────────────────────────────────────────


def test_the_universe_is_the_intersection_and_both_inputs_are_reported(
    db: FakeDatabase,
) -> None:
    seed_universe(db, [APPLE])
    # Listed but not a known filer, and a filer we do not list.
    db["us_instruments"].documents.append(
        {"_id": 9001, "cik": "0000000777", "symbol": "X", "listingStatus": "ACTIVE"}
    )
    db["us_filers"].documents.append({"_id": 9002, "cik10": "0000000888", "inUniverse": True})
    seed_filing(db, accession="a-2024")

    result = run_job(db, RecordingFetcher(), RecordingParse())
    assert result.counters["universeListed"] == 2
    assert result.counters["universeFilers"] == 2
    assert result.counters["universeSelected"] == 1


def test_a_filer_outside_the_universe_flag_is_not_walked(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE], in_universe=False)
    seed_filing(db, accession="a-2024")
    result = run_job(db, RecordingFetcher(), RecordingParse())
    assert result.counters["universeSelected"] == 0
    assert result.skipped_reason == REASON_UNIVERSE_EMPTY


def test_an_empty_universe_is_named_rather_than_left_looking_healthy(db: FakeDatabase) -> None:
    """Zero selected + zero written + no reason is what a CONVERGED run looks like."""
    result = run_job(db, RecordingFetcher(), RecordingParse())
    assert result.status == STATUS_COMPLETED
    assert result.selected == 0
    assert result.skipped_reason == REASON_UNIVERSE_EMPTY
    assert result.counters["universeListed"] == 0
    assert result.counters["universeFilers"] == 0


def test_explicit_ciks_override_the_universe(db: FakeDatabase) -> None:
    # No instruments, no filers — the operator named the filer directly.
    seed_filing(db, accession="a-2024")
    fetcher = RecordingFetcher()
    result = run_job(db, fetcher, RecordingParse(), ciks=["320193"])
    assert fetcher.count == 1
    assert result.counters["universeSelected"] == 1


# ── Fiscal-year windowing ───────────────────────────────────────────────────


def test_the_window_uses_the_period_not_the_filing_date(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    # Reports on FY2024, filed in 2025. A window of [2024, 2024] must include it.
    seed_filing(db, accession="a-2024", period=date(2024, 12, 31), filed=date(2025, 2, 3))
    fetcher = RecordingFetcher()
    result = run_job(db, fetcher, RecordingParse(), from_fy=2024, to_fy=2024)
    assert fetcher.count == 1
    assert result.counters["unitsDone"] == 1


def test_a_filing_outside_the_window_is_never_selected(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2019", period=date(2019, 12, 31), filed=date(2020, 2, 1))
    fetcher = RecordingFetcher()
    result = run_job(db, fetcher, RecordingParse(), from_fy=2024, to_fy=2024)
    assert fetcher.count == 0
    assert result.counters["unitsEmpty"] == 1


def test_a_non_statement_form_is_not_selected(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-8k", form="8-K")
    seed_filing(db, accession="a-nt", form="NT 10-K")
    fetcher = RecordingFetcher()
    run_job(db, fetcher, RecordingParse())
    assert fetcher.count == 0


def test_amendments_are_included_because_they_carry_the_restatement(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-10ka", form="10-K/A")
    fetcher = RecordingFetcher()
    run_job(db, fetcher, RecordingParse())
    assert [a for _c, a in fetcher.calls] == ["a-10ka"]


# ── Checkpoints ─────────────────────────────────────────────────────────────


def test_each_fiscal_year_gets_its_own_checkpoint_row(db: FakeDatabase) -> None:
    """Scope is part of the unique key; without it one row would hide five years."""
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2023", period=date(2023, 12, 31))
    seed_filing(db, accession="a-2024", period=date(2024, 12, 31))

    run_job(db, RecordingFetcher(), RecordingParse(), from_fy=2023, to_fy=2024)
    rows = [r for r in checkpoints(db) if r["status"] == CHECKPOINT_DONE]
    assert {r["scope"] for r in rows} == {"2023", "2024"}
    assert {r["itemKey"] for r in rows} == {APPLE}
    assert xbrl_backfill.load_done_units(db) == {(APPLE, "2023"), (APPLE, "2024")}


def test_a_fiscal_year_with_no_filings_is_empty_and_therefore_re_examined(
    db: FakeDatabase,
) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2024", period=date(2024, 12, 31))

    run_job(db, RecordingFetcher(), RecordingParse(), from_fy=2023, to_fy=2024)
    by_scope = {r["scope"]: r for r in checkpoints(db)}
    assert by_scope["2023"]["status"] == CHECKPOINT_EMPTY
    assert by_scope["2024"]["status"] == CHECKPOINT_DONE
    # EMPTY is not DONE, so the year is looked at again once submissions lands.
    assert (APPLE, "2023") not in xbrl_backfill.load_done_units(db)


def test_a_failed_parse_leaves_an_error_checkpoint_not_a_done_one(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2024")

    result = run_job(db, RecordingFetcher(), RecordingParse(fail={"a-2024"}))
    assert result.failed == 1
    assert [r["status"] for r in checkpoints(db)] == [CHECKPOINT_ERROR]
    assert xbrl_backfill.load_done_units(db) == set()


def test_a_dry_run_parses_counts_and_checkpoints_nothing(db: FakeDatabase) -> None:
    """MONEY-1235: a checkpoint beside zero rows marks the unit converged forever."""
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2024")

    fetcher = RecordingFetcher()
    parse = RecordingParse()
    result = run_job(
        db, fetcher, parse, apply_writes=False, writer=ExplodingWriter(), lookups=object()
    )

    assert fetcher.count == 1, "a dry run must still prove the parse"
    assert len(parse.calls) == 1
    assert parse.calls[0]["apply"] is False
    assert result.status == STATUS_WRITE_DISARMED
    assert result.skipped_reason == STATUS_WRITE_DISARMED
    assert checkpoints(db) == [], "a dry run checkpointed a unit it did not write"


def test_write_units_is_idempotent_on_the_compound_key(db: FakeDatabase) -> None:
    entry = UnitCheckpoint(item_key=APPLE, scope="2024", detail="1/1 parsed", rows=3)
    xbrl_backfill.write_units(db, [entry])
    xbrl_backfill.write_units(db, [entry])
    assert len(checkpoints(db)) == 1


# ── The wall clock ──────────────────────────────────────────────────────────


class StepClock:
    """A monotonic clock the test advances by whole seconds per read."""

    def __init__(self, step: float = 10.0) -> None:
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        value = self.now
        self.now += self.step
        return value


def test_the_budget_stops_cleanly_and_reports_resumable(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE, BERKSHIRE])
    seed_filing(db, accession="a-2024", cik10=APPLE)
    seed_filing(db, accession="b-2024", cik10=BERKSHIRE)

    fetcher = RecordingFetcher()
    # The clock advances 10s per read. The first filer costs two reads (10s, 20s)
    # and both pass against a 25s budget; the second filer's first read is 30s
    # and stops the walk. So exactly ONE filer is walked.
    budget = RunBudget(25.0, clock=StepClock(10.0))
    result = run_job(db, fetcher, RecordingParse(), budget=budget)

    assert result.status == STATUS_BUDGET_EXHAUSTED
    assert result.resumable is True
    assert result.exit_code == 0, "a budget stop must not be reported as a failure"
    assert [a for _c, a in fetcher.calls] == ["a-2024"], "the walk continued past its budget"
    # Whatever it finished IS checkpointed, so the re-run resumes rather than restarts.
    done = xbrl_backfill.load_done_units(db)
    assert done == {(APPLE, "2024")}
    assert (BERKSHIRE, "2024") not in done

    # And the re-run picks up exactly where it stopped, fetching only the rest.
    resumed = RecordingFetcher()
    again = run_job(db, resumed, RecordingParse())
    assert [a for _c, a in resumed.calls] == ["b-2024"]
    assert again.status == STATUS_COMPLETED


def test_a_run_with_no_budget_left_writes_nothing_and_still_exits_zero(
    db: FakeDatabase,
) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2024")

    fetcher = RecordingFetcher()
    result = run_job(db, fetcher, RecordingParse(), budget=RunBudget(0.0))
    assert result.status == STATUS_BUDGET_EXHAUSTED
    assert fetcher.count == 0
    assert result.exit_code == 0


# ── Sharding ────────────────────────────────────────────────────────────────


def test_two_tasks_split_the_universe_with_no_overlap_and_no_gap(db: FakeDatabase) -> None:
    ciks = [f"{i:010d}" for i in range(1, 41)]
    seed_universe(db, ciks)
    for cik in ciks:
        seed_filing(db, accession=f"acc-{cik}", cik10=cik)

    walked: list[list[str]] = []
    for index in range(2):
        fetcher = RecordingFetcher()
        fresh = FakeDatabase()
        fresh.collections = db.collections  # same world, separate fetch tally
        xbrl_backfill.run(
            db=fresh,
            fetch_bundle=fetcher,
            from_fy=2024,
            to_fy=2024,
            tasks=2,
            task_index=index,
            parse=RecordingParse(),
            writer=object(),
            lookups=object(),
            apply_writes=False,
        )
        walked.append([cik for cik, _acc in fetcher.calls])

    assert not set(walked[0]) & set(walked[1]), "a filer was walked by both tasks"
    assert sorted(walked[0] + walked[1]) == sorted(ciks), "a filer was never walked"
    assert all(shard_of(cik, 2) == 0 for cik in walked[0])
    assert all(shard_of(cik, 2) == 1 for cik in walked[1])


def test_an_out_of_range_task_index_raises_instead_of_walking_nothing(
    db: FakeDatabase,
) -> None:
    seed_universe(db, [APPLE])
    with pytest.raises(ValueError, match="--task-index"):
        run_job(db, RecordingFetcher(), RecordingParse(), tasks=2, task_index=2)


# ── Upstream refusals ───────────────────────────────────────────────────────


def test_a_missing_bundle_is_counted_and_the_walk_continues(db: FakeDatabase) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-gone", period=date(2024, 12, 31))
    seed_filing(db, accession="a-here", period=date(2024, 12, 31))

    fetcher = RecordingFetcher(raises={"a-gone": SecNotFound("404")})
    result = run_job(db, fetcher, RecordingParse())

    assert fetcher.count == 2, "one 404 stopped the other filing"
    assert result.transport_failures == 1
    assert [r["status"] for r in checkpoints(db)] == [CHECKPOINT_ERROR]


def test_a_rate_block_propagates_rather_than_being_retried(db: FakeDatabase) -> None:
    """A block is measured at SEC's edge; the only useful contribution is silence."""
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2024")

    fetcher = RecordingFetcher(raises={"a-2024": SecRateLimited()})
    with pytest.raises(SecRateLimited):
        run_job(db, fetcher, RecordingParse())
    assert fetcher.count == 1


# ── What reaches the parse seam ─────────────────────────────────────────────


def test_the_parse_seam_is_called_with_the_financials_class_and_the_filings_form(
    db: FakeDatabase,
) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-2024", form="20-F")

    parse = RecordingParse()
    run_job(db, RecordingFetcher(), parse)

    assert len(parse.calls) == 1
    call = parse.calls[0]
    assert call["parse_class"] == "FINANCIALS"
    assert call["form"] == "20-F"
    assert call["cik10"] == APPLE
    assert call["apply"] is True
    assert call["bundle"] == b"<SEC-DOCUMENT>a-2024"


def test_written_and_failed_come_from_the_parse_outcome_not_from_the_row_count(
    db: FakeDatabase,
) -> None:
    seed_universe(db, [APPLE])
    seed_filing(db, accession="a-1", period=date(2024, 12, 31))
    seed_filing(db, accession="a-2", period=date(2024, 12, 31))

    result = run_job(db, RecordingFetcher(), RecordingParse(written=7))
    assert result.written == 14
    assert result.failed == 0
    assert result.counters["filingsParsed"] == 2


def test_a_run_that_ABORTS_still_records_the_units_it_FINISHED(db: FakeDatabase) -> None:
    # MONEY-1280, the sibling of the ownership case. The trailing checkpoint
    # flush sat after the loop with nothing protecting it, so an exception
    # escaping the walk discarded every unit finished since the last in-loop
    # write. Bounded here — the in-loop flush is over FILINGS and 500 is
    # reachable — but those units were bought with requests against SEC's
    # shared per-IP budget, and a resume must never re-buy them.
    other = "0000789019"
    seed_universe(db, [APPLE, other])
    seed_filing(db, accession="acc-apple", cik10=APPLE)
    seed_filing(db, accession="acc-other", cik10=other)
    fetcher = RecordingFetcher(raises={"acc-other": SecRateLimited("blocked mid-walk")})

    with pytest.raises(SecRateLimited):
        run_job(db, fetcher, RecordingParse())

    assert {r["itemKey"] for r in checkpoints(db)} == {APPLE}, (
        "the unit that completed before the abort must survive it"
    )
