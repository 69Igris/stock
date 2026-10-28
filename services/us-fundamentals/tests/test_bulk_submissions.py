"""``submissions.zip`` -> ``us_filers`` + ``us_filings`` — MONEY-979.

The fixture archive has THREE members, deliberately:

* ``CIK0001067983.json`` + its paging shard — the real Berkshire fixture, a filer
  whose annual history lives in the SECOND member and would be invisible to a
  job that read only the index;
* ``CIK0000320193.json`` — already checkpointed at its own sha256, so the
  hash-skip has something to skip;
* ``CIK0000000009.json`` — malformed, so "counted and the batch continues" is
  asserted rather than asserted-about.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from typing import Any

import pytest

from app.bulk import submissions
from app.bulk.common import (
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_NOT_YET_PUBLISHED,
    STATUS_WRITE_DISARMED,
    CheckpointEntry,
    RunBudget,
    load_checkpoints,
    open_zip_archive,
    sha256_hex,
    write_checkpoints,
    zip_from_bytes,
)
from app.sec.edgar_adapter import parse_submissions_json
from app.store import writers

from .test_bulk_common import (
    FakeSecClient,
    counting_opener,
    fixture_bytes,
    make_zip,
    open_and_list_reads,
    record_member_reads,
)
from .test_store_writers import FakeDatabase

BRK_CIK = "0001067983"
MALFORMED = b'{"cik": "0000000009", "filings": {"recent": '


@pytest.fixture
def db() -> FakeDatabase:
    writers.reset_index_cache()
    return FakeDatabase()


def brk_members() -> dict[str, bytes]:
    """Berkshire's index plus a REAL paging shard synthesised from its own rows.

    SEC's paging members are the bare parallel arrays at the TOP level, with no
    ``filings.recent`` wrapper — the shape ``page_payload`` exists to re-wrap.
    Built from the fixture's own tail so the arrays are genuine SEC data.
    """
    payload = json.loads(fixture_bytes("submissions_brk.json.gz"))
    recent = payload["filings"]["recent"]
    page = {column: values[-40:] for column, values in recent.items()}
    payload["filings"]["recent"] = {column: values[:-40] for column, values in recent.items()}
    # Force an annual report into the PAGING shard only, so a job that ignored
    # pages would under-count this filer's fiscal years.
    page["form"][0] = "10-K"
    page["reportDate"][0] = "2001-12-31"
    return {
        f"CIK{BRK_CIK}.json": json.dumps(payload).encode(),
        f"CIK{BRK_CIK}-submissions-001.json": json.dumps(page).encode(),
    }


def build_archive(*, extra: dict[str, bytes] | None = None) -> dict[str, bytes]:
    members = brk_members()
    members["CIK0000320193.json"] = json.dumps(
        {"cik": "0000320193", "name": "Apple Inc.", "filings": {"recent": {}}}
    ).encode()
    members["CIK0000000009.json"] = MALFORMED
    members.update(extra or {})
    return members


#: `build_archive` always plants one MALFORMED member, so every count below is
#: relative to it. Named rather than folded into a literal: a bare `== 2` reads
#: as "two things went wrong here" when one of them is the fixture itself.
BASELINE_SKIPS = 1


def run_job(db: FakeDatabase, members: dict[str, bytes], **kwargs: Any) -> Any:
    body = make_zip(members)
    return submissions.run(
        db=db,
        client=FakeSecClient(),
        opener=zip_from_bytes(body),
        archive_key="edgar/bulk/submissions/2026-08-29/submissions.zip",
        apply_writes=kwargs.pop("apply_writes", True),
        **kwargs,
    )


# ── Pure helpers ────────────────────────────────────────────────────────────


def test_group_members_pairs_an_index_with_its_paging_shards() -> None:
    groups, ignored = submissions.group_members(
        [
            "CIK0001067983-submissions-001.json",
            "CIK0001067983.json",
            "CIK0000320193.json",
            "placeholder.txt",
        ]
    )
    assert ignored == ["placeholder.txt"]
    assert groups[BRK_CIK].primary == "CIK0001067983.json"
    assert groups[BRK_CIK].pages == ("CIK0001067983-submissions-001.json",)
    assert groups["0000320193"].pages == ()


def test_grouping_survives_the_sort_order_that_puts_a_page_before_its_index() -> None:
    # "-" is 0x2D and "." is 0x2E, so the paging member sorts FIRST. A job that
    # walked members in name order would meet the pages with nowhere to put them.
    assert "CIK0001067983-submissions-001.json" < "CIK0001067983.json"
    groups, _ = submissions.group_members(sorted(brk_members()))
    assert groups[BRK_CIK].names[0] == "CIK0001067983.json"


def test_a_member_name_that_is_not_a_filer_index_is_ignored_not_parsed() -> None:
    _, ignored = submissions.group_members(["CIK123.json", "readme.md", "CIK0000320193.txt"])
    assert sorted(ignored) == ["CIK0000320193.txt", "CIK123.json", "readme.md"]


def test_page_payload_reuses_the_real_parser_and_its_shortest_array_guard() -> None:
    page = {
        "accessionNumber": ["0001067983-20-000001", "0001067983-20-000002"],
        "form": ["10-K"],  # SHORT: one fewer than every sibling column.
        "filingDate": ["2020-02-22", "2020-03-01"],
        "reportDate": ["2019-12-31", "2020-02-28"],
        "acceptanceDateTime": ["2020-02-22T08:02:00.000Z", "2020-03-01T08:02:00.000Z"],
        "items": ["", ""],
        "primaryDocument": ["a.htm", "b.htm"],
        "isXBRL": [1, 1],
        "isInlineXBRL": [1, 0],
        "size": [10, 20],
    }
    _, filings = parse_submissions_json(submissions.page_payload(BRK_CIK, page))
    assert len(filings) == 1, "arrays must zip to the SHORTEST, never shift fields"
    assert filings[0].form == "10-K"
    assert filings[0].accession == "0001067983-20-000001"


def test_a_partial_paging_shard_is_PARSED_now_that_the_adapter_indexes_defensively(
    db: FakeDatabase,
) -> None:
    """This test used to pin the CONTAINMENT of an adapter crash. The crash is gone.

    `parse_submissions_json` computed its row count as
    `min(len(v) for v in arrays.values() if v)` — the `if v` skipping EMPTY
    columns — and then indexed those same columns, so a page carrying data in
    some columns and none in another raised IndexError. This job caught it and
    counted the filer as skipped, which is what the old assertion checked.

    The adapter now distinguishes REQUIRED columns (accession, form, filingDate
    — a short one truncates, because a missing value shifts every later field
    onto the wrong filing) from OPTIONAL ones (read as None per row). So the
    shape below is no longer an error at all: it parses, and the absent columns
    are absent rather than fatal.

    Asserting the new behaviour rather than deleting the test, because the
    payload is the interesting one — a truncated paging shard is exactly what a
    partial write looks like, and "it parses" is the property worth holding.
    """
    members = build_archive(
        extra={
            "CIK0000000077.json": json.dumps(
                {"cik": "0000000077", "name": "Odd Co", "filings": {"recent": {}}}
            ).encode(),
            "CIK0000000077-submissions-001.json": json.dumps(
                {
                    "accessionNumber": ["0000000077-20-000001"],
                    "form": ["8-K"],
                    "filingDate": ["2020-01-01"],
                    # every other column absent — the truncated-shard shape
                }
            ).encode(),
        }
    )
    result = run_job(db, members)

    assert result.counters["filersSkipped"] == BASELINE_SKIPS, (
        "a readable partial page must not add a skip — only the fixture's own "
        "MALFORMED member should be counted"
    )
    assert db["us_filers"].find_one({"cik10": BRK_CIK}) is not None

    stored = db["us_filings"].find_one({"accession": "0000000077-20-000001"})
    assert stored is not None, "the filing from the partial shard was stored"
    assert stored["form"] == "8-K"
    # `to_doc()` omits None, so an absent optional column is an ABSENT KEY —
    # not a null. A reader must filter positively; `{periodOfReport: null}`
    # matches nothing in Mongo.
    assert "periodOfReport" not in stored


def test_a_genuinely_unreadable_page_still_costs_one_filer_and_not_the_run(
    db: FakeDatabase,
) -> None:
    """The containment property itself, kept — on a payload that really is unreadable.

    The test above no longer exercises it, and losing it would mean nothing
    checks that one bad member cannot take down a 15,000-member run. A page
    whose `recent` is a LIST where the parser expects a mapping is unreadable in
    a way no defensive indexing can fix.
    """
    members = build_archive(
        extra={
            "CIK0000000078.json": json.dumps(
                {"cik": "0000000078", "name": "Bad Co", "filings": {"recent": ["not", "a", "map"]}}
            ).encode(),
        }
    )
    result = run_job(db, members)

    assert result.counters["filersSkipped"] == BASELINE_SKIPS + 1
    assert db["us_filers"].find_one({"cik10": BRK_CIK}) is not None, (
        "the healthy filer in the same archive still landed"
    )


def test_annual_fiscal_years_uses_the_period_not_the_filing_date() -> None:
    from app.sec.adapter_types import FilingRef

    filings = [
        # Filed in Feb 2025 FOR fiscal 2024. Counting the filing date would both
        # invent 2025 and lose 2024.
        FilingRef(
            accession="a",
            cik10=BRK_CIK,
            form="10-K",
            filed_at=date(2025, 2, 22),
            period_of_report=date(2024, 12, 31),
        ),
        FilingRef(
            accession="b",
            cik10=BRK_CIK,
            form="10-Q",
            filed_at=date(2024, 5, 4),
            period_of_report=date(2024, 3, 31),
        ),
        FilingRef(
            accession="c",
            cik10=BRK_CIK,
            form="20-F",
            filed_at=date(2023, 4, 1),
            period_of_report=date(2022, 12, 31),
        ),
        # No period published: the filing date is the only evidence there is.
        FilingRef(accession="d", cik10=BRK_CIK, form="40-F", filed_at=date(2019, 3, 1)),
    ]
    assert submissions.annual_fiscal_years(filings) == {2024, 2022, 2019}


def test_filing_rows_are_deduplicated_and_classified() -> None:
    from app.sec.adapter_types import FilingRef

    rows = submissions.build_filing_rows(
        [
            FilingRef(
                accession="0001067983-26-000001",
                cik10=BRK_CIK,
                form="13F-HR",
                filed_at=date(2026, 2, 1),
            ),
            FilingRef(
                accession="0001067983-26-000001",
                cik10=BRK_CIK,
                form="13F-HR",
                filed_at=date(2026, 2, 1),
            ),
            FilingRef(accession="", cik10=BRK_CIK, form="4", filed_at=date(2026, 2, 1)),
            FilingRef(
                accession="0001067983-26-000002",
                cik10=BRK_CIK,
                form="SC 13G",
                filed_at=date(2026, 2, 2),
            ),
        ]
    )
    assert [row.accession for row in rows] == ["0001067983-26-000001", "0001067983-26-000002"]
    assert [row.parseClass for row in rows] == ["THIRTEENF", "SCHEDULE13"]
    assert {row.status for row in rows} == {"INDEXED"}


# ── The run ─────────────────────────────────────────────────────────────────


def test_a_full_pass_writes_the_filer_and_its_filings(db: FakeDatabase) -> None:
    result = run_job(db, build_archive())
    assert result.status == STATUS_COMPLETED
    assert result.exit_code == 0
    filer = db["us_filers"].find_one({"cik10": BRK_CIK})
    assert filer is not None
    assert filer["name"] == "BERKSHIRE HATHAWAY INC"
    assert filer["tickersAsFiled"] == ["BRK-B", "BRK-A"]
    assert filer["formerNames"][0]["name"] == "NBH INC"
    assert db["us_filings"].count_documents({"cik10": BRK_CIK}) > 900


def test_the_paging_shard_is_read_and_counts_toward_the_coverage_denominator(
    db: FakeDatabase,
) -> None:
    with_pages = build_archive()
    without_pages = {k: v for k, v in with_pages.items() if "submissions-001" not in k}

    run_job(db, with_pages)
    full = db["us_filers"].find_one({"cik10": BRK_CIK})

    writers.reset_index_cache()
    other = FakeDatabase()
    run_job(other, without_pages)
    partial = other["us_filers"].find_one({"cik10": BRK_CIK})

    assert full is not None and partial is not None
    assert full["fiscalYearsOnFile"] > partial["fiscalYearsOnFile"]
    assert full["firstFilingAt"] <= partial["firstFilingAt"]


def test_a_malformed_member_is_counted_and_the_batch_continues(db: FakeDatabase) -> None:
    result = run_job(db, build_archive())
    assert result.counters["filersSkipped"] == 1
    assert result.failed >= 1
    # The healthy filer in the SAME archive still landed.
    assert db["us_filers"].find_one({"cik10": BRK_CIK}) is not None
    # And the failure left a triage row that the skip logic will never read.
    errors = db["backfill_checkpoints"].find({"status": "ERROR"})
    assert [row["itemKey"] for row in errors] == ["0000000009"]
    assert "0000000009" not in load_checkpoints(db, "edgar-submissions")


def test_an_unchanged_member_is_skipped_and_the_skip_is_counted(db: FakeDatabase) -> None:
    members = build_archive()
    apple = members["CIK0000320193.json"]
    write_checkpoints(
        db,
        "edgar-submissions",
        [CheckpointEntry(item_key="0000320193", detail=sha256_hex(apple))],
    )
    result = run_job(db, members)
    assert result.counters["membersSkipped"] == 1
    assert db["us_filers"].find_one({"cik10": "0000320193"}) is None
    # ... and the OTHER filers were not skipped.
    assert result.selected == 2


def test_a_changed_member_is_reprocessed_even_though_a_checkpoint_exists(db: FakeDatabase) -> None:
    members = build_archive()
    write_checkpoints(
        db, "edgar-submissions", [CheckpointEntry(item_key="0000320193", detail="a-stale-hash")]
    )
    result = run_job(db, members)
    assert result.counters["membersSkipped"] == 0
    assert db["us_filers"].find_one({"cik10": "0000320193"}) is not None


def test_a_second_run_over_an_unchanged_file_does_not_read_it_at_all(db: FakeDatabase) -> None:
    members = build_archive()
    run_job(db, members)
    # The first run stamped the watermark, so the HEAD now says UNCHANGED and
    # the 1.45 GiB is never streamed a second time.
    second = run_job(db, members)
    assert second.status == STATUS_NOT_YET_PUBLISHED


def test_the_run_is_idempotent(db: FakeDatabase) -> None:
    members = build_archive()
    run_job(db, members)
    before = db["us_filings"].count_documents({})
    filers_before = db["us_filers"].count_documents({})
    second = run_job(db, members, force=True)
    assert db["us_filings"].count_documents({}) == before
    assert db["us_filers"].count_documents({}) == filers_before
    # Everything the first run finished is now checkpointed, so a FORCED second
    # pass selects nothing rather than re-writing rows it agrees with.
    assert second.status == STATUS_COMPLETED
    assert second.counters["membersSkipped"] == 2, "both healthy members skipped on their hash"
    # The malformed member is SELECTED again: it was never checkpointed DONE, so
    # one bad night is not permanent.
    assert second.selected == 1
    assert second.failed == 1


def test_not_yet_published_is_distinguishable_from_both_success_and_failure(
    db: FakeDatabase,
) -> None:
    from app.store.models import UsEdgarCursorRow

    writers.upsert_cursor(db, UsEdgarCursorRow(key="bulk:submissions", meta={"etag": '"abc"'}))
    result = submissions.run(
        db=db,
        client=FakeSecClient(),
        opener=zip_from_bytes(make_zip(build_archive())),
        archive_key="unused",
        apply_writes=True,
    )
    assert result.status == STATUS_NOT_YET_PUBLISHED
    assert result.skipped_reason == STATUS_NOT_YET_PUBLISHED
    assert result.exit_code == 0, "not a failure"
    assert result.status != STATUS_COMPLETED, "not a success that claims work"
    assert (result.selected, result.written) == (0, 0)
    assert db["us_filers"].count_documents({}) == 0


def test_force_processes_a_file_whose_validators_have_not_moved(db: FakeDatabase) -> None:
    from app.store.models import UsEdgarCursorRow

    writers.upsert_cursor(db, UsEdgarCursorRow(key="bulk:submissions", meta={"etag": '"abc"'}))
    result = run_job(db, build_archive(), force=True)
    assert result.status == STATUS_COMPLETED
    assert db["us_filers"].find_one({"cik10": BRK_CIK}) is not None


def test_a_completed_run_stamps_the_watermark(db: FakeDatabase) -> None:
    run_job(db, build_archive())
    cursor = writers.read_cursor(db, "bulk:submissions")
    assert cursor is not None
    assert cursor["meta"]["etag"] == '"abc"'


def test_a_budget_exhausted_run_resumes_and_never_stamps_the_watermark(db: FakeDatabase) -> None:
    members = build_archive()
    # A budget that is spent the moment the first member is considered.
    spent = RunBudget(0.0, clock=lambda: 0.0)
    result = run_job(db, members, budget=spent)
    assert result.status == STATUS_BUDGET_EXHAUSTED
    assert result.exit_code == 0, "resumable, not failed"
    assert result.selected == 0
    # Stamping the watermark here would make tomorrow's HEAD answer
    # NOT_YET_PUBLISHED and the unread remainder would never be processed.
    assert writers.read_cursor(db, "bulk:submissions") is None

    resumed = run_job(db, members)
    assert resumed.status == STATUS_COMPLETED
    assert db["us_filers"].find_one({"cik10": BRK_CIK}) is not None


def test_a_disarmed_run_parses_and_counts_but_writes_and_checkpoints_nothing(
    db: FakeDatabase,
) -> None:
    result = run_job(db, build_archive(), apply_writes=False)
    assert result.status == STATUS_WRITE_DISARMED
    assert result.exit_code == 0
    assert result.selected == 3
    assert result.written == 0
    assert db["us_filers"].count_documents({}) == 0
    # A checkpoint beside zero rows would mark the member converged FOREVER and
    # the first armed run would skip it (the MONEY-1235 shape).
    assert load_checkpoints(db, "edgar-submissions") == {}
    assert writers.read_cursor(db, "bulk:submissions") is None


def test_the_write_arm_is_read_from_the_environment_when_not_injected(
    db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("EDGAR_PARSE_APPLY", "false")
    disarmed = submissions.run(
        db=db,
        client=FakeSecClient(),
        opener=zip_from_bytes(make_zip(build_archive())),
        archive_key="k",
    )
    assert disarmed.status == STATUS_WRITE_DISARMED
    # `bool("false")` is True. A flag coerced instead of compared would have
    # armed the writer in the one configuration meant to keep it off.
    monkeypatch.setenv("EDGAR_PARSE_APPLY", "true")
    writers.reset_index_cache()
    armed = submissions.run(
        db=FakeDatabase(),
        client=FakeSecClient(),
        opener=zip_from_bytes(make_zip(build_archive())),
        archive_key="k",
    )
    assert armed.status == STATUS_COMPLETED


def test_the_detect_cursor_is_seeded_once_and_never_overwritten(db: FakeDatabase) -> None:
    run_job(db, build_archive())
    seeded = writers.read_cursor(db, "getcurrent")
    assert seeded is not None
    assert isinstance(seeded["lastAcceptedAt"], datetime)
    assert seeded["meta"]["seededBy"] == "edgar-bulk-submissions"

    # A later run must NOT move a live detection watermark forward — that would
    # skip everything accepted since the last poll, silently.
    from app.store.models import UsEdgarCursorRow

    writers.upsert_cursor(
        db, UsEdgarCursorRow(key="getcurrent", lastAccession="held", meta={"seededBy": "detect"})
    )
    run_job(
        db,
        build_archive(
            extra={
                "CIK0000000042.json": json.dumps(
                    {
                        "cik": "0000000042",
                        "name": "New Co",
                        "filings": {
                            "recent": {
                                "accessionNumber": ["0000000042-26-000001"],
                                "form": ["8-K"],
                                "filingDate": ["2026-08-29"],
                                "reportDate": [""],
                                "acceptanceDateTime": ["2026-08-29T21:53:00.000Z"],
                                "items": [""],
                                "primaryDocument": ["x.htm"],
                                "isXBRL": [0],
                                "isInlineXBRL": [0],
                                "size": [1],
                            }
                        },
                    }
                ).encode()
            }
        ),
    )
    held = writers.read_cursor(db, "getcurrent")
    assert held is not None
    assert held["lastAccession"] == "held"


def test_the_ledger_does_not_downgrade_a_filing_a_parser_already_finished(db: FakeDatabase) -> None:
    members = build_archive()
    run_job(db, members)
    accession = db["us_filings"].find({"cik10": BRK_CIK})[0]["accession"]
    writers.mark_filing_status(db, accession, "PARSED", parser_version="v1")
    # Re-run with the checkpoints cleared, so the member is genuinely reprocessed.
    db["backfill_checkpoints"].documents.clear()
    run_job(db, members)
    stored = db["us_filings"].find_one({"accession": accession})
    assert stored is not None
    assert stored["status"] == "PARSED"


# ── Resume cost — MONEY-1283 ────────────────────────────────────────────────
#
# The defect these five tests exist for was not a slow function. The member loop
# READ every member out of the archive and hashed it BEFORE it could decide the
# member was already finished — and a member is decompressed straight out of a
# live GCS object, so on prod each of those reads is a network round trip
# charged to the same RunBudget as real work. Measured 2026-08-30: 87,052
# finished members took 51.5 minutes to skip, 1,691/min, against a 988,373-member
# universe. A 150-minute budget could skip at most 253,650; the walk stalled at
# ~25.7% and every later run reported BUDGET_EXHAUSTED with selected=0,
# written=0. Raising the budget only buys time to repeat the same reads.
#
# So these assertions COUNT READS, never elapsed time. A timing assertion passes
# trivially here — the fixture archive is a few KB in RAM, where the production
# one is 1.56 GB over the wire — and that gap is exactly what hid the defect
# through every green run of this file. The count is identical in both places.


def tiny_filer(cik: str, revision: str) -> bytes:
    """The smallest member `parse_submissions_json` accepts, plus a mutable field."""
    return json.dumps({"cik": cik, "name": f"Co {revision}", "filings": {"recent": {}}}).encode()


def tiny_archive(count: int, *, changed: frozenset[int] = frozenset()) -> dict[str, bytes]:
    """`count` one-member filers; the CIKs in `changed` carry different bytes."""
    return {
        f"CIK{index:010d}.json": tiny_filer(f"{index:010d}", "v2" if index in changed else "v1")
        for index in range(1, count + 1)
    }


def run_counting(db: FakeDatabase, members: dict[str, bytes], **kwargs: Any) -> tuple[Any, Any]:
    """`(result, stream)` — the run, and the tape of every read it made."""
    opener, stream = counting_opener(make_zip(members))
    result = submissions.run(
        db=db,
        client=FakeSecClient(),
        opener=opener,
        archive_key="edgar/bulk/submissions/2026-08-29/submissions.zip",
        apply_writes=kwargs.pop("apply_writes", True),
        **kwargs,
    )
    return result, stream


def test_a_resume_reads_only_the_members_that_are_not_already_checkpointed(
    db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE load-bearing one. 90% already done must cost 10% of the reads.

    Two of twenty members changed between the runs, so exactly two may be
    decompressed. Before the fix the count was TWENTY: the loop hashed every
    member to discover eighteen of them were finished, which is the O(members
    already done) resume that stalled the production walk at 25.7%.

    Falsifiable in both directions — the read list is asserted by NAME, so a skip
    that read the wrong members fails just as loudly as one that read too many.
    """
    members = tiny_archive(20)
    first = run_counting(db, members)[0]
    assert first.selected == 20, "the first run has nothing to skip"

    reads = record_member_reads(monkeypatch)
    changed = frozenset({3, 17})
    result, _ = run_counting(db, tiny_archive(20, changed=changed), force=True)

    assert reads == ["CIK0000000003.json", "CIK0000000017.json"]
    assert result.counters["membersSkipped"] == 18
    assert result.selected == 2
    # The two that DID change were reprocessed, not merely counted.
    assert db["us_filers"].find_one({"cik10": "0000000003"})["name"] == "Co v2"
    assert db["us_filers"].find_one({"cik10": "0000000001"})["name"] == "Co v1"


def test_a_fully_converged_resume_pulls_nothing_off_the_stream_after_opening_it(
    db: FakeDatabase,
) -> None:
    """The same claim one layer lower, against a MEASURED ceiling.

    `record_member_reads` counts calls to our own `ZipMember.read`; this counts
    reads on the STREAM, which is what actually costs a GCS request. The ceiling
    is re-derived from the same bytes by `open_and_list_reads` rather than
    written as a literal, so it cannot be a number that happens to match.

    Reading the central directory is unavoidable and is the ceiling. Everything
    above it is a member being decompressed.
    """
    members = tiny_archive(12)
    body = make_zip(members)
    run_counting(db, members)

    result, stream = run_counting(db, members, force=True)

    assert result.counters["membersSkipped"] == 12
    assert result.selected == 0
    assert len(stream.reads) == open_and_list_reads(body), (
        "a converged run must spend reads on the central directory and nothing else"
    )


def test_a_legacy_checkpoint_with_no_stamp_is_read_once_and_then_upgraded_in_place(
    db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every one of the 988,373 checkpoints on prod today has a digest and no stamp.

    The fix therefore has to converge from that state without a migration, and
    without ever trusting a field nothing wrote. A missing stamp is NOT
    agreement: the member is read once, its sha256 decides the skip exactly as
    before, and only then is the stamp recorded — so the SECOND run gets it free.

    The rows/bytes on that row belong to the run that did the work and must
    survive the upgrade; a `$set` of the whole document would zero them, which
    reads afterwards as "processed, wrote nothing".
    """
    members = tiny_archive(3)
    with open_zip_archive("k", opener=zip_from_bytes(make_zip(members))) as archive:
        expected_stamp = archive.member_stamp("CIK0000000001.json")

    write_checkpoints(
        db,
        "edgar-submissions",
        [
            CheckpointEntry(
                item_key="0000000001",
                detail=sha256_hex(members["CIK0000000001.json"]),
                rows=7,
                bytes=123,
            )
        ],
    )
    stored = db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})
    assert "stamp" not in stored, "the pre-MONEY-1283 shape, as it exists on prod"

    reads = record_member_reads(monkeypatch)
    result, _ = run_counting(db, members)

    assert reads.count("CIK0000000001.json") == 1, "a legacy member is read exactly once"
    assert result.counters["membersSkipped"] == 1
    assert db["us_filers"].find_one({"cik10": "0000000001"}) is None, "skipped, not rewritten"

    upgraded = db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})
    assert upgraded["stamp"] == expected_stamp
    assert (upgraded["rows"], upgraded["bytes"]) == (7, 123)

    # ... and it has converged: the next run does not read it at all.
    reads.clear()
    run_counting(db, members, force=True)
    assert "CIK0000000001.json" not in reads


def test_a_stamp_in_an_older_FORMAT_is_rewritten_rather_than_re_read_every_night(
    db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stamp carries no version tag, so a format change must self-heal.

    That is only true if the upgrade fires on a stamp that DISAGREES and not
    merely on one that is absent. Fire it on absence alone and a member whose
    digest still matches would be read on every run for the rest of the job's
    life — the same per-member network read MONEY-1283 removed, reintroduced by
    a future edit to the stamp format and invisible because nothing errors.

    A digest that matches while the stamp does not can only mean the stored
    stamp cannot describe these bytes: identical sha256 IS identical bytes, so
    the CRC and size cannot have moved on their own.
    """
    members = tiny_archive(2)
    with open_zip_archive("k", opener=zip_from_bytes(make_zip(members))) as archive:
        current = archive.member_stamp("CIK0000000001.json")

    write_checkpoints(
        db,
        "edgar-submissions",
        [
            CheckpointEntry(
                item_key="0000000001",
                detail=sha256_hex(members["CIK0000000001.json"]),
                stamp="v0/an-older-stamp-format",
            )
        ],
    )

    reads = record_member_reads(monkeypatch)
    result, _ = run_counting(db, members)

    assert reads.count("CIK0000000001.json") == 1
    assert result.counters["membersSkipped"] == 1
    assert db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})["stamp"] == current

    reads.clear()
    run_counting(db, members, force=True)
    assert "CIK0000000001.json" not in reads, "the stale format was rewritten, not re-read"


def test_a_member_whose_bytes_changed_is_read_and_reprocessed_never_skipped(
    db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The stamp is a NEGATIVE filter only. A member whose CRC moved must fall
    # through to the read, the digest and the parse — the cheap key can defer
    # work, never decide that work is unnecessary.
    members = tiny_archive(2)
    run_counting(db, members)

    reads = record_member_reads(monkeypatch)
    result, _ = run_counting(db, tiny_archive(2, changed=frozenset({2})), force=True)

    assert reads == ["CIK0000000002.json"]
    assert result.selected == 1
    assert result.counters["membersSkipped"] == 1
    assert db["us_filers"].find_one({"cik10": "0000000002"})["name"] == "Co v2"


def test_a_disarmed_run_upgrades_no_stamp_because_it_writes_nothing(db: FakeDatabase) -> None:
    # `EDGAR_PARSE_APPLY=false` reads, parses and counts, and touches no row —
    # including the legacy upgrade. Stamping a checkpoint from a run that wrote
    # nothing is the same MONEY-1235 shape as checkpointing an unwritten member.
    members = tiny_archive(2)
    write_checkpoints(
        db,
        "edgar-submissions",
        [CheckpointEntry(item_key="0000000001", detail=sha256_hex(members["CIK0000000001.json"]))],
    )
    result, _ = run_counting(db, members, apply_writes=False)

    assert result.status == STATUS_WRITE_DISARMED
    stored = db["backfill_checkpoints"].find_one({"itemKey": "0000000001"})
    assert "stamp" not in stored


def test_in_universe_is_decided_by_one_bulk_query_over_active_listings(db: FakeDatabase) -> None:
    db["us_instruments"].documents.append(
        {
            "_id": 1,
            "cik": BRK_CIK,
            "symbol": "BRK-B",
            "assetType": "Stock",
            "listingStatus": "ACTIVE",
        }
    )
    run_job(db, build_archive())
    berkshire = db["us_filers"].find_one({"cik10": BRK_CIK})
    apple = db["us_filers"].find_one({"cik10": "0000320193"})
    assert berkshire is not None and berkshire["inUniverse"] is True
    assert apple is not None and apple["inUniverse"] is False
