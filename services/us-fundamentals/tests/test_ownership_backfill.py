"""The daily-index day walk — MONEY-979.

Two properties are the reason this file exists, and both were MEASURED by T4 on
the committed ``form_20220214.idx.gz`` fixture rather than assumed:

* a daily ``form.idx`` carries **one row per FILER**, so 19,412 rows are 11,870
  filings and a walk that treats rows as filings fetches one bundle sixteen
  times;
* **198 of those rows were filed earlier than the file that disseminated them**,
  by as much as nine months, so ``filedAt`` must come from the ROW.

Both are asserted here at the JOB level — one fetch per accession, and the
stored ``us_filings.filedAt`` equal to the row's date and not the day walked —
because the pure-logic assertions in ``test_backfill_logic.py`` cannot show that
the job actually calls that logic.
"""

from __future__ import annotations

import gzip
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from app.bulk import ownership_backfill
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
from app.bulk.ownership_backfill import REASON_NO_INDEX, checkpoint_job_key, job_name
from app.sec import archive
from app.sec.errors import (
    SecNotFound,
    SecRateLimited,
    body_excerpt,
    classify_sec_response,
)
from app.store import writers

from .test_store_writers import FakeDatabase
from .test_xbrl_backfill import ExplodingWriter, RecordingParse, StepClock

FIXTURES = Path(__file__).resolve().parent / "fixtures"

#: The fixture's dissemination day.
INDEX_DAY = date(2022, 2, 14)

IDX_HEADER = (
    "Description:           Daily Index of EDGAR Dissemination Feed by Form Type\n"
    "Form Type   Company Name                                        CIK"
    "         Date Filed  File Name\n"
    "-------------------------------------------------------------------"
    "----------------------------\n"
)


def idx(rows: list[tuple[str, str, str, str, str]]) -> str:
    """Build a ``form.idx`` from ``(form, company, cik, YYYYMMDD, accession)``.

    Columns are separated by runs of two or more spaces, which is what the real
    fixed-width file uses and what ``parse_daily_index`` splits on — a form type
    may itself contain one space (``SC 13G``).
    """
    lines = [IDX_HEADER.rstrip("\n")]
    for form, company, cik, filed, accession in rows:
        path = f"edgar/data/{int(cik)}/{accession}.txt"
        lines.append(f"{form:<12}{company:<54}{cik}     {filed}    {path}")
    return "\n".join(lines) + "\n"


def real_index_text() -> str:
    with gzip.open(
        FIXTURES / "form_20220214.idx.gz", "rt", encoding="utf-8", errors="replace"
    ) as f:
        return f.read()


# ── Doubles ─────────────────────────────────────────────────────────────────


class RecordingIndexFetcher:
    """``day -> idx text | None``. Counts every call, including the misses."""

    def __init__(self, by_day: dict[date, str | None]) -> None:
        self.by_day = by_day
        self.days: list[date] = []

    def __call__(self, day: date) -> str | None:
        self.days.append(day)
        return self.by_day.get(day)

    @property
    def count(self) -> int:
        return len(self.days)


class RecordingBundleFetcher:
    def __init__(self, *, raises: dict[str, Exception] | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self._raises = raises or {}

    def __call__(self, cik10: str, accession: str) -> bytes:
        self.calls.append((cik10, accession))
        if accession in self._raises:
            raise self._raises[accession]
        return b"<SEC-DOCUMENT>"

    @property
    def count(self) -> int:
        return len(self.calls)


@pytest.fixture
def db() -> FakeDatabase:
    writers.reset_index_cache()
    return FakeDatabase()


def seed_day_checkpoint(
    db: FakeDatabase, alias: str, day: date, status: str = CHECKPOINT_DONE
) -> None:
    db[CHECKPOINT_COLLECTION].documents.append(
        {
            "_id": len(db[CHECKPOINT_COLLECTION].documents) + 5000,
            "jobKey": checkpoint_job_key(alias),
            "itemKey": day.strftime("%Y%m%d"),
            "scope": "",
            "status": status,
            "detail": "seeded",
        }
    )


def run_job(
    db: FakeDatabase,
    index: Any,
    bundles: Any,
    parse: Any,
    *,
    cls: str = "ownership",
    from_date: date = INDEX_DAY,
    to_date: date = INDEX_DAY,
    **kwargs: Any,
) -> Any:
    return ownership_backfill.run(
        db=db,
        cls=cls,
        from_date=from_date,
        to_date=to_date,
        fetch_index=index,
        fetch_bundle=bundles,
        parse=parse,
        writer=kwargs.pop("writer", object()),
        lookups=kwargs.pop("lookups", object()),
        apply_writes=kwargs.pop("apply_writes", True),
        now=kwargs.pop("now", datetime(2026, 8, 29, tzinfo=UTC)),
        **kwargs,
    )


ONE_FORM_4 = idx([("4", "ACME CORP", "0000000001", "20220214", "0000000001-22-000001")])


# ── The two measured index properties ───────────────────────────────────────


def test_one_filing_occupying_many_rows_is_fetched_once(db: FakeDatabase) -> None:
    """A co-registered filing occupies 16 rows in the real fixture."""
    rows = [
        ("4", f"CO-REGISTRANT {i}", f"{i:010d}", "20220214", "0000000001-22-000001")
        for i in range(1, 17)
    ]
    index = RecordingIndexFetcher({INDEX_DAY: idx(rows)})
    bundles = RecordingBundleFetcher()

    result = run_job(db, index, bundles, RecordingParse())

    assert bundles.count == 1, "rows were treated as filings; the walk fanned out 16x"
    assert result.counters["indexRows"] == 16
    assert result.counters["indexFilings"] == 1
    assert db["us_filings"].count_documents({}) == 1


def test_filed_at_is_the_rows_date_not_the_day_that_was_walked(db: FakeDatabase) -> None:
    """198 real rows carry a date up to nine months before their index file."""
    stale = idx([("4", "LATE FILER", "0000000001", "20210521", "0000000001-22-000009")])
    index = RecordingIndexFetcher({INDEX_DAY: stale})

    run_job(db, index, RecordingBundleFetcher(), RecordingParse())

    stored = db["us_filings"].find_one({"accession": "0000000001-22-000009"})
    assert stored is not None
    # `models._coerce` widens a date to a UTC datetime on the way into Mongo.
    assert stored["filedAt"] == datetime(2021, 5, 21, tzinfo=UTC), (
        "filedAt came from the file we fetched, not from the row; the filing "
        "lands in the wrong period with a plausible-looking date"
    )
    assert stored["filedAt"] != datetime(2022, 2, 14, tzinfo=UTC)


def test_the_real_fixture_collapses_to_one_fetch_per_distinct_accession(
    db: FakeDatabase,
) -> None:
    index = RecordingIndexFetcher({INDEX_DAY: real_index_text()})
    bundles = RecordingBundleFetcher()

    result = run_job(db, index, bundles, RecordingParse(), cls="13f")

    accessions = [a for _c, a in bundles.calls]
    assert accessions, "the fixture carries 13F filings"
    assert len(accessions) == len(set(accessions))
    assert result.counters["indexRows"] == 19_412
    assert result.counters["indexFilings"] == len(accessions)
    assert result.counters["indexFilings"] < result.counters["indexRows"]


def test_the_class_decides_which_forms_are_walked(db: FakeDatabase) -> None:
    mixed = idx(
        [
            ("4", "INSIDER", "0000000001", "20220214", "0000000001-22-000001"),
            ("13F-HR", "MANAGER", "0000000002", "20220214", "0000000002-22-000002"),
            ("SC 13G/A", "HOLDER", "0000000003", "20220214", "0000000003-22-000003"),
            ("8-K", "ISSUER", "0000000004", "20220214", "0000000004-22-000004"),
        ]
    )
    for alias, expected in (
        ("ownership", "0000000001-22-000001"),
        ("13f", "0000000002-22-000002"),
        ("13dg", "0000000003-22-000003"),
    ):
        fresh = FakeDatabase()
        bundles = RecordingBundleFetcher()
        run_job(
            fresh,
            RecordingIndexFetcher({INDEX_DAY: mixed}),
            bundles,
            RecordingParse(),
            cls=alias,
        )
        assert [a for _c, a in bundles.calls] == [expected]


def test_an_unknown_class_raises_before_anything_is_walked(db: FakeDatabase) -> None:
    with pytest.raises(ValueError, match="unknown --class"):
        run_job(
            db, RecordingIndexFetcher({}), RecordingBundleFetcher(), RecordingParse(), cls="13-f"
        )


# ── NO_INDEX ────────────────────────────────────────────────────────────────


def test_a_day_with_no_index_file_is_named_and_is_not_a_failure(db: FakeDatabase) -> None:
    tuesday = date(2022, 2, 15)
    index = RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4, tuesday: None})

    result = run_job(
        db, index, RecordingBundleFetcher(), RecordingParse(), from_date=INDEX_DAY, to_date=tuesday
    )

    assert result.status == STATUS_COMPLETED, "a holiday is not a failed run"
    assert result.failed == 0
    assert result.counters["daysNoIndex"] == 1
    assert result.counters["daysWalked"] == 1
    assert index.days == [tuesday, INDEX_DAY], (
        "newest-first: the day was asked for exactly once, latest first"
    )

    stamped = {r["itemKey"]: r for r in db[CHECKPOINT_COLLECTION].documents}
    assert stamped["20220215"]["status"] == CHECKPOINT_EMPTY
    assert stamped["20220215"]["detail"] == REASON_NO_INDEX
    # EMPTY is not DONE, so tomorrow's run asks again: a day SEC had simply not
    # published yet must not become a hole nobody comes back for.
    assert "20220215" not in ownership_backfill.load_checkpoints(
        db, checkpoint_job_key("ownership")
    )


def test_a_weekend_is_skipped_without_spending_a_request(db: FakeDatabase) -> None:
    saturday = date(2022, 2, 19)
    sunday = date(2022, 2, 20)
    index = RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4})

    result = run_job(
        db, index, RecordingBundleFetcher(), RecordingParse(), from_date=INDEX_DAY, to_date=sunday
    )

    assert saturday not in index.days and sunday not in index.days
    assert result.counters["weekendsSkipped"] == 2
    assert result.counters["daysInWindow"] == 7
    # And no checkpoint row was spent on them either — 260 Saturdays a walk does
    # not need 260 writes to know about.
    stamped = {r["itemKey"] for r in db[CHECKPOINT_COLLECTION].documents}
    assert "20220219" not in stamped and "20220220" not in stamped
    assert "20220214" in stamped


# ── Resume ──────────────────────────────────────────────────────────────────


def test_a_done_day_skips_before_the_index_is_fetched(db: FakeDatabase) -> None:
    seed_day_checkpoint(db, "ownership", INDEX_DAY)
    index = RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4})
    bundles = RecordingBundleFetcher()

    result = run_job(db, index, bundles, RecordingParse())

    assert index.count == 0, "a DONE day cost an index request; resume is not free"
    assert bundles.count == 0
    assert result.counters["daysSkipped"] == 1


def test_an_error_day_is_walked_again(db: FakeDatabase) -> None:
    seed_day_checkpoint(db, "ownership", INDEX_DAY, status=CHECKPOINT_ERROR)
    index = RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4})
    run_job(db, index, RecordingBundleFetcher(), RecordingParse())
    assert index.count == 1


def test_each_class_keeps_its_own_day_namespace(db: FakeDatabase) -> None:
    seed_day_checkpoint(db, "13f", INDEX_DAY)
    index = RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4})
    run_job(db, index, RecordingBundleFetcher(), RecordingParse(), cls="ownership")
    assert index.count == 1, "the 13F walk's checkpoint skipped the ownership walk"
    assert checkpoint_job_key("ownership") != checkpoint_job_key("13f")
    assert job_name("13dg") == "edgar-13dg-backfill"


# ── Writes ──────────────────────────────────────────────────────────────────


def test_filings_are_indexed_before_they_are_parsed(db: FakeDatabase) -> None:
    """`mark_filing_status` is UPDATE-ONLY; a parse that ran first stamps nothing."""
    order: list[str] = []

    class OrderedParse(RecordingParse):
        def __call__(self, accession: str, bundle: bytes, **kwargs: Any) -> dict[str, Any]:
            order.append(f"parse:{db['us_filings'].count_documents({})}")
            return super().__call__(accession, bundle, **kwargs)

    run_job(
        db, RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4}), RecordingBundleFetcher(), OrderedParse()
    )
    assert order == ["parse:1"], "the row did not exist when the parse tried to stamp it"


def test_a_filings_status_is_insert_only_so_a_backfill_never_downgrades_it(
    db: FakeDatabase,
) -> None:
    db["us_filings"].documents.append(
        {
            "_id": 1,
            "accession": "0000000001-22-000001",
            "cik10": "0000000001",
            "form": "4",
            "filedAt": date(2022, 2, 14),
            "status": "PARSED",
        }
    )
    run_job(
        db,
        RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4}),
        RecordingBundleFetcher(),
        RecordingParse(),
    )
    stored = db["us_filings"].find_one({"accession": "0000000001-22-000001"})
    assert stored is not None
    assert stored["status"] == "PARSED"


def test_the_parse_class_reaches_the_seam(db: FakeDatabase) -> None:
    parse = RecordingParse()
    run_job(db, RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4}), RecordingBundleFetcher(), parse)
    assert len(parse.calls) == 1
    assert parse.calls[0]["parse_class"] == "OWNERSHIP"
    assert parse.calls[0]["form"] == "4"
    assert parse.calls[0]["apply"] is True


def test_a_dry_run_parses_counts_and_checkpoints_nothing(db: FakeDatabase) -> None:
    index = RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4})
    bundles = RecordingBundleFetcher()
    parse = RecordingParse()

    result = run_job(db, index, bundles, parse, apply_writes=False, writer=ExplodingWriter())

    assert bundles.count == 1, "a dry run must still prove the parse"
    assert parse.calls[0]["apply"] is False
    assert result.status == STATUS_WRITE_DISARMED
    assert db[CHECKPOINT_COLLECTION].documents == []
    assert db["us_filings"].documents == []


def test_a_completed_day_is_checkpointed_done(db: FakeDatabase) -> None:
    run_job(
        db,
        RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4}),
        RecordingBundleFetcher(),
        RecordingParse(),
    )
    rows = db[CHECKPOINT_COLLECTION].documents
    assert [r["status"] for r in rows] == [CHECKPOINT_DONE]
    assert rows[0]["itemKey"] == "20220214"
    assert rows[0]["scope"] == "", "an absent scope collides with every other absent one"


# ── Upstream refusals ───────────────────────────────────────────────────────


def test_a_missing_bundle_leaves_the_day_error_so_it_is_retried(db: FakeDatabase) -> None:
    two = idx(
        [
            ("4", "GONE", "0000000001", "20220214", "0000000001-22-000001"),
            ("4", "HERE", "0000000002", "20220214", "0000000002-22-000002"),
        ]
    )
    bundles = RecordingBundleFetcher(raises={"0000000001-22-000001": SecNotFound("404")})
    result = run_job(db, RecordingIndexFetcher({INDEX_DAY: two}), bundles, RecordingParse())

    assert bundles.count == 2, "one 404 stopped the rest of the day"
    assert result.transport_failures == 1
    assert [r["status"] for r in db[CHECKPOINT_COLLECTION].documents] == [CHECKPOINT_ERROR]


def test_a_rate_block_propagates_rather_than_walking_on(db: FakeDatabase) -> None:
    bundles = RecordingBundleFetcher(raises={"0000000001-22-000001": SecRateLimited()})
    with pytest.raises(SecRateLimited):
        run_job(db, RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4}), bundles, RecordingParse())


def test_a_failed_parse_leaves_the_day_error(db: FakeDatabase) -> None:
    result = run_job(
        db,
        RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4}),
        RecordingBundleFetcher(),
        RecordingParse(fail={"0000000001-22-000001"}),
    )
    assert result.failed == 1
    assert [r["status"] for r in db[CHECKPOINT_COLLECTION].documents] == [CHECKPOINT_ERROR]


# ── The wall clock ──────────────────────────────────────────────────────────


def test_the_budget_stops_between_days_and_reports_resumable(db: FakeDatabase) -> None:
    tuesday = date(2022, 2, 15)
    index = RecordingIndexFetcher({INDEX_DAY: ONE_FORM_4, tuesday: ONE_FORM_4})
    bundles = RecordingBundleFetcher()

    # One read per day plus one per filing: day1 reads at 10s and 20s (both
    # inside a 25s budget), day2's first read is 30s and stops the walk.
    result = run_job(
        db,
        index,
        bundles,
        RecordingParse(),
        from_date=INDEX_DAY,
        to_date=tuesday,
        budget=RunBudget(25.0, clock=StepClock(10.0)),
    )

    assert result.status == STATUS_BUDGET_EXHAUSTED
    assert result.resumable is True
    assert result.exit_code == 0
    assert index.days == [tuesday], (
        "newest-first, so the LATER day is walked first; the walk continued past its budget"
    )
    assert [r["itemKey"] for r in db[CHECKPOINT_COLLECTION].documents] == ["20220215"], (
        "newest-first: the day that completed inside the budget is the LATER "
        "one, and it is the one checkpointed"
    )


def test_a_budget_that_expires_mid_day_does_not_checkpoint_that_day(
    db: FakeDatabase,
) -> None:
    two = idx(
        [
            ("4", "FIRST", "0000000001", "20220214", "0000000001-22-000001"),
            ("4", "SECOND", "0000000002", "20220214", "0000000002-22-000002"),
        ]
    )
    bundles = RecordingBundleFetcher()
    # Day check at 10s passes; the first filing's check at 20s passes; the
    # second filing's at 30s does not.
    result = run_job(
        db,
        RecordingIndexFetcher({INDEX_DAY: two}),
        bundles,
        RecordingParse(),
        budget=RunBudget(25.0, clock=StepClock(10.0)),
    )

    assert result.status == STATUS_BUDGET_EXHAUSTED
    assert bundles.count == 1
    assert db[CHECKPOINT_COLLECTION].documents == [], (
        "a partly-walked day was checkpointed; its remaining filings would never be reached"
    )


# ── MONEY-1279 / MONEY-1280 ─────────────────────────────────────────────────
#
# `test_a_day_with_no_index_file_is_named_and_is_not_a_failure` above drives a
# RecordingIndexFetcher that returns None from a dict. It pins the NO_INDEX
# BRANCH and is correct — but it injects the very absence it is testing for, so
# it can say nothing about whether anything ever REACHES that branch. It could
# not: `default_fetch_index` mapped only 404 to None, and a holiday 403s.
#
# These drive the real `default_fetch_index`.

HOLIDAY = date(2021, 9, 6)  # Labor Day 2021 — the day the first 5-year run died

# Captured from the live response; see test_client.HOLIDAY_403_BODY.
S3_ABSENT_BODY = (
    b'<?xml version="1.0" encoding="UTF-8"?>\n'
    b"<Error><Code>AccessDenied</Code><Message>Access Denied</Message>"
    b"<RequestId>94S9KK0YK39QKB2W</RequestId><HostId>Ukg+GYlxAFpk</HostId></Error>"
)


class ArchiveClient:
    """A client answering one status+body the way `SecClient.get` would.

    It raises whatever `classify_sec_response` says, so this test is bound to
    the real table rather than to a hand-picked exception: change the
    classification and this moves with it.
    """

    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self.body = body
        self.urls: list[str] = []

    def get(self, url: str) -> bytes:
        self.urls.append(url)
        kind = classify_sec_response(self.status, self.body)
        if kind is None:
            return self.body
        raise kind(f"{self.status} from {url}: {body_excerpt(self.body)}")


@pytest.fixture
def no_archive(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force a cache miss so the fetch actually reaches the client."""
    monkeypatch.setattr(archive, "read_bytes", lambda key: None)
    monkeypatch.setattr(archive, "write_bytes", lambda *a, **k: None)


def test_THE_JOIN_a_holiday_403_becomes_None_so_NO_INDEX_is_reachable(
    no_archive: None,
) -> None:
    # The whole defect in one assertion. Before the fix this raised
    # SecForbidden, the exception escaped the day loop, and the run stopped.
    client = ArchiveClient(403, S3_ABSENT_BODY)

    assert ownership_backfill.default_fetch_index(client, HOLIDAY) is None
    assert len(client.urls) == 1, "asked for exactly once"


def test_a_404_still_becomes_None(no_archive: None) -> None:
    assert ownership_backfill.default_fetch_index(ArchiveClient(404, b""), HOLIDAY) is None


def test_a_RATE_BLOCK_still_propagates_and_is_never_read_as_absence(
    no_archive: None,
) -> None:
    # The property `default_fetch_index`'s docstring promises. If a block became
    # None, the walk would record "SEC published nothing that day" for every day
    # of the block and move on — writing zeros and checkpointing holes.
    client = ArchiveClient(403, b"Your request rate has exceeded the SEC's traffic limit")
    with pytest.raises(SecRateLimited):
        ownership_backfill.default_fetch_index(client, HOLIDAY)


def test_an_unclassifiable_403_still_propagates(no_archive: None) -> None:
    from app.sec.errors import SecForbidden

    client = ArchiveClient(403, b"<html>something new from a CDN</html>")
    with pytest.raises(SecForbidden):
        ownership_backfill.default_fetch_index(client, HOLIDAY)


class ExplodingIndexFetcher:
    """Serves real index text until `explode_on`, then raises."""

    def __init__(self, by_day: dict[date, str], explode_on: date) -> None:
        self.by_day = by_day
        self.explode_on = explode_on
        self.days: list[date] = []

    def __call__(self, day: date) -> str | None:
        self.days.append(day)
        if day == self.explode_on:
            raise SecRateLimited("blocked mid-walk")
        return self.by_day.get(day)


def test_a_run_that_ABORTS_still_records_the_days_it_FINISHED(db: FakeDatabase) -> None:
    # MONEY-1280. The first 5-year run walked five days, threw, and left ZERO
    # checkpoints — so the retry re-spent every one of those requests against
    # SEC's shared per-IP budget. Checkpoints flushed only at DEFAULT_CHUNK
    # (500) or after a clean exit, and a 23h budget covers ~300 days, so the
    # in-loop flush was unreachable and an exception skipped the trailing one.
    # Newest-first, so days[2] is walked FIRST and days[0] LAST. Explode on the
    # OLDEST so two days genuinely complete before the abort.
    days = [date(2022, 2, 14), date(2022, 2, 15), date(2022, 2, 16)]
    index = ExplodingIndexFetcher({d: ONE_FORM_4 for d in days[1:]}, explode_on=days[0])

    with pytest.raises(SecRateLimited):
        run_job(
            db,
            index,
            RecordingBundleFetcher(),
            RecordingParse(),
            from_date=days[0],
            to_date=days[2],
        )

    stamped = {r["itemKey"]: r for r in db[CHECKPOINT_COLLECTION].documents}
    assert set(stamped) == {"20220216", "20220215"}, (
        "the two days that completed before the abort must survive it; the day "
        "that raised must NOT be checkpointed"
    )
    assert all(r["status"] == CHECKPOINT_DONE for r in stamped.values())


def test_the_flush_cadence_is_sized_in_DAYS_not_ROWS() -> None:
    # A guard on the constant itself, because the defect was not the flush being
    # absent — it was the threshold being borrowed from a ROW writer. Any value
    # at or above a run's reachable day count makes the in-loop flush dead code
    # again, and nothing else in the suite would notice.
    assert ownership_backfill.CHECKPOINT_FLUSH_DAYS < writers.DEFAULT_CHUNK
    assert ownership_backfill.CHECKPOINT_FLUSH_DAYS <= 25


def test_finished_days_are_flushed_DURING_a_long_walk_not_only_at_the_end(
    db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The companion to `test_the_flush_cadence_is_sized_in_DAYS_not_ROWS`, which
    # only pins the CONSTANT. Restoring `writers.DEFAULT_CHUNK` at the call site
    # leaves that assertion perfectly green while making the in-loop flush dead
    # code again — the exact "pins construction, not use" shape that let the
    # original defect through. This one drives the call site.
    calls: list[int] = []
    real = ownership_backfill.write_checkpoints

    def counting(database: Any, job_key: str, entries: Any) -> Any:
        calls.append(len(entries))
        return real(database, job_key, entries)

    monkeypatch.setattr(ownership_backfill, "write_checkpoints", counting)

    start = date(2022, 2, 14)
    days = [d for d in (start + timedelta(n) for n in range(20)) if d.weekday() < 5][:12]
    index = RecordingIndexFetcher({d: ONE_FORM_4 for d in days})

    run_job(
        db,
        index,
        RecordingBundleFetcher(),
        RecordingParse(),
        from_date=days[0],
        to_date=days[-1],
    )

    assert len(calls) >= 2, (
        f"12 finished days produced {len(calls)} flush(es); the in-loop flush "
        "never fired, so an abort would discard everything"
    )
    assert calls[0] == ownership_backfill.CHECKPOINT_FLUSH_DAYS
