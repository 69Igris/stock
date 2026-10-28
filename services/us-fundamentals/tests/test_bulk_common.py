"""Shared bulk-job machinery — MONEY-979.

The fixture zips are built IN MEMORY. The real files are 1.31 GiB and 1.45 GiB;
a test that touched them would take minutes, need network, and prove nothing the
three-member archive here does not.
"""

from __future__ import annotations

import gzip
import io
import json
import zipfile
import zlib
from pathlib import Path
from typing import Any

import pytest

from app.bulk import common
from app.bulk.common import (
    CHECKPOINT_SCOPE,
    CLEAN_STATUSES,
    DECISION_CHANGED,
    DECISION_FIRST_RUN,
    DECISION_FORCED,
    DECISION_UNCHANGED,
    DECISION_VALIDATORS_ABSENT,
    FEED_COMPANYFACTS,
    FEED_SUBMISSIONS,
    STATUS_FAILED,
    STATUS_NOT_YET_PUBLISHED,
    CheckpointEntry,
    MemberCheckpoint,
    RunBudget,
    budget_seconds,
    check_upstream,
    decide_upstream,
    iter_zip_members,
    load_checkpoints,
    load_member_checkpoints,
    load_universe,
    member_unchanged,
    open_zip_archive,
    sha256_hex,
    stamp_unchanged,
    stream_zip_to_gcs,
    upgrade_checkpoint_stamps,
    write_checkpoints,
    zip_from_bytes,
)

from .test_store_writers import FakeDatabase

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def make_zip(members: dict[str, bytes]) -> bytes:
    """A real zip archive in memory."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def fixture_bytes(name: str) -> bytes:
    return gzip.open(FIXTURES / name).read()


class CountingStream:
    """A seekable stream that RECORDS every read. Stands in for the GCS blob.

    ``_gcs_opener`` hands ``zipfile`` a live ``blob.open("rb")``, so on prod each
    of these reads is a network round trip. The local ``zip_from_bytes`` opener
    makes them free, which is exactly why a timing assertion cannot see the
    MONEY-1283 defect and a COUNT can: the fixture archive is in RAM and the
    production archive is 1.56 GB over the wire, but both do the same number of
    reads.

    Deliberately a WRAPPER and not an ``io.BytesIO`` subclass. ``BytesIO`` is a C
    type whose internals can satisfy a read without re-entering a Python
    override, which would under-count silently — the one failure mode a counter
    must not have.
    """

    def __init__(self, data: bytes) -> None:
        self._buffer = io.BytesIO(data)
        #: Bytes returned by each read, in order.
        self.reads: list[int] = []

    def read(self, size: int = -1) -> bytes:
        chunk = self._buffer.read(size)
        self.reads.append(len(chunk))
        return chunk

    def seek(self, offset: int, whence: int = 0) -> int:
        return self._buffer.seek(offset, whence)

    def tell(self) -> int:
        return self._buffer.tell()

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def close(self) -> None:
        self._buffer.close()

    @property
    def closed(self) -> bool:
        return self._buffer.closed


def counting_opener(data: bytes) -> tuple[Any, CountingStream]:
    """``(opener, stream)`` — the opener a job takes, plus the tape to read after."""
    stream = CountingStream(data)
    return (lambda _key: stream), stream


def open_and_list_reads(data: bytes) -> int:
    """Stream reads spent on OPENING the archive and listing its members.

    The verified ceiling for every "it read nothing" assertion below. A literal
    would be a guess that the next Python release could quietly invalidate; this
    is measured from the same bytes on the same interpreter, so a run that skips
    every member must land on exactly it.
    """
    opener, stream = counting_opener(data)
    with open_zip_archive("k", opener=opener) as archive:
        archive.names()
    return len(stream.reads)


def record_member_reads(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Names of every member DECOMPRESSED, in order. Wraps, never replaces.

    A plain helper rather than a fixture so it needs no ``conftest`` entry and
    each caller can see the instrumentation it is relying on. The wrapper calls
    the real :meth:`ZipMember.read`, so the code under test is unchanged — a
    stub would have hidden the very mutation these counts exist to catch.
    """
    seen: list[str] = []
    original = common.ZipMember.read

    def counting(member: common.ZipMember) -> bytes:
        seen.append(member.name)
        return original(member)

    monkeypatch.setattr(common.ZipMember, "read", counting)
    return seen


class FakeSecClient:
    """Records what was asked of it; answers a scripted HEAD."""

    def __init__(self, head: dict[str, Any] | None = None) -> None:
        self.head_response = head or {
            "status": 200,
            "lastModified": "Fri, 29 Aug 2026 03:57:00 GMT",
            "etag": '"abc"',
            "contentLength": 1560992008,
        }
        self.heads: list[str] = []
        self.streams: list[tuple[str, str]] = []

    def head(self, url: str, **_: Any) -> dict[str, Any]:
        self.heads.append(url)
        return dict(self.head_response)

    def stream_to_gcs(self, url: str, key: str, **_: Any) -> dict[str, Any]:
        self.streams.append((url, key))
        return {
            "key": key,
            "bytes": 10,
            "sha256": "deadbeef",
            "lastModified": self.head_response.get("lastModified"),
            "etag": self.head_response.get("etag"),
        }


@pytest.fixture
def db() -> FakeDatabase:
    from app.store import writers

    writers.reset_index_cache()
    return FakeDatabase()


# ── Upstream freshness ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("head", "previous", "force", "should_process", "reason"),
    [
        ({"etag": '"a"'}, None, False, True, DECISION_FIRST_RUN),
        ({"etag": '"a"'}, {}, False, True, DECISION_FIRST_RUN),
        ({"etag": '"a"'}, {"etag": '"a"'}, False, False, DECISION_UNCHANGED),
        ({"etag": '"b"'}, {"etag": '"a"'}, False, True, DECISION_CHANGED),
        ({"lastModified": "X"}, {"lastModified": "X"}, False, False, DECISION_UNCHANGED),
        ({"lastModified": "Y"}, {"lastModified": "X"}, False, True, DECISION_CHANGED),
        # ETag decides when both sides carry one, even though Last-Modified agrees.
        (
            {"etag": '"b"', "lastModified": "X"},
            {"etag": '"a"', "lastModified": "X"},
            False,
            True,
            DECISION_CHANGED,
        ),
        # ... and the other way round: an unchanged ETag wins over a moved date.
        (
            {"etag": '"a"', "lastModified": "Y"},
            {"etag": '"a"', "lastModified": "X"},
            False,
            False,
            DECISION_UNCHANGED,
        ),
        # No comparable validator is "could not determine", which is NOT
        # "unchanged": skipping would skip every night forever, green.
        ({}, {"etag": '"a"'}, False, True, DECISION_VALIDATORS_ABSENT),
        ({"etag": '"a"'}, {"etag": '"a"'}, True, True, DECISION_FORCED),
    ],
)
def test_decide_upstream_table(
    head: dict[str, Any],
    previous: dict[str, Any] | None,
    force: bool,
    should_process: bool,
    reason: str,
) -> None:
    verdict = decide_upstream(head, previous, force=force)
    assert (verdict.should_process, verdict.reason) == (should_process, reason)


def test_an_empty_string_validator_is_treated_as_absent_not_as_a_match() -> None:
    # Two blank ETags are not evidence that a file has not moved.
    verdict = decide_upstream({"etag": "  "}, {"etag": ""})
    assert verdict.should_process is True
    assert verdict.reason == DECISION_FIRST_RUN


def test_not_yet_published_is_a_clean_outcome_and_failure_is_not() -> None:
    assert STATUS_NOT_YET_PUBLISHED in CLEAN_STATUSES
    assert STATUS_FAILED not in CLEAN_STATUSES


def test_check_upstream_reads_the_stored_watermark(db: FakeDatabase) -> None:
    from app.store import writers
    from app.store.models import UsEdgarCursorRow

    writers.upsert_cursor(db, UsEdgarCursorRow(key="bulk:submissions", meta={"etag": '"abc"'}))
    client = FakeSecClient()
    verdict = check_upstream(client, "https://example.invalid/x.zip", "bulk:submissions", db=db)
    assert client.heads == ["https://example.invalid/x.zip"]
    assert verdict.should_process is False
    assert verdict.reason == DECISION_UNCHANGED


def test_the_watermark_a_good_run_stores_carries_both_validators() -> None:
    verdict = decide_upstream({"etag": '"a"', "lastModified": "X", "contentLength": 7}, None)
    assert verdict.meta() == {"lastModified": "X", "etag": '"a"', "contentLength": 7}


# ── Streaming ───────────────────────────────────────────────────────────────


def test_stream_zip_to_gcs_uses_the_dated_bulk_key() -> None:
    client = FakeSecClient()
    result = stream_zip_to_gcs(client, FEED_SUBMISSIONS, day="2026-08-29")
    assert result["key"] == "edgar/bulk/submissions/2026-08-29/submissions.zip"
    assert client.streams[0][0] == common.BULK_URLS[FEED_SUBMISSIONS]


def test_the_two_feed_urls_are_secs_documented_bulk_endpoints() -> None:
    assert common.BULK_URLS[FEED_SUBMISSIONS].endswith("/bulkdata/submissions.zip")
    assert common.BULK_URLS[FEED_COMPANYFACTS].endswith("/xbrl/companyfacts.zip")


# ── Zip iteration ───────────────────────────────────────────────────────────


def test_members_are_read_through_the_stream_and_never_extracted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("a bulk member was extracted to disk")

    monkeypatch.setattr(zipfile.ZipFile, "extract", refuse)
    monkeypatch.setattr(zipfile.ZipFile, "extractall", refuse)

    payload = {"CIK0000320193.json": b'{"cik": 320193}', "CIK0001067983.json": b'{"cik": 1067983}'}
    # Read INSIDE the loop: the archive is a live stream, not a staging area.
    seen = [
        (member.name, member.read())
        for member in iter_zip_members("edgar/bulk/x", opener=zip_from_bytes(make_zip(payload)))
    ]
    assert [name for name, _ in seen] == sorted(payload)
    assert dict(seen) == payload


def test_a_member_used_after_the_archive_closes_raises_rather_than_reading_empty() -> None:
    # The streaming contract, asserted: a caller that hoards members past the
    # iteration gets an error, not silently empty bytes that would be stored as
    # a filer with no filings.
    escaped = None
    for member in iter_zip_members("k", opener=zip_from_bytes(make_zip({"a.json": b"1"}))):
        escaped = member
    assert escaped is not None
    with pytest.raises(ValueError):
        escaped.read()


def test_names_are_sorted_so_two_runs_walk_the_archive_identically() -> None:
    body = make_zip({"c.json": b"3", "a.json": b"1", "b.json": b"2"})
    with open_zip_archive("k", opener=zip_from_bytes(body)) as archive:
        assert archive.names() == ["a.json", "b.json", "c.json"]


def test_a_member_is_decompressed_once_and_reports_its_own_hash() -> None:
    body = make_zip({"a.json": b"hello"})
    with open_zip_archive("k", opener=zip_from_bytes(body)) as archive:
        member = archive.member("a.json")
        assert member.size == 5
        assert member.read() is member.read(), "the bytes must be cached, not re-inflated"
        assert member.sha256() == sha256_hex(b"hello")


def test_a_real_submissions_fixture_survives_the_round_trip() -> None:
    raw = fixture_bytes("submissions_brk.json.gz")
    body = make_zip({"CIK0001067983.json": raw})
    with open_zip_archive("k", opener=zip_from_bytes(body)) as archive:
        payload = json.loads(archive.member("CIK0001067983.json").read())
    assert payload["cik"] == "0001067983"
    assert payload["name"] == "BERKSHIRE HATHAWAY INC"


def test_the_stream_is_closed_even_when_the_caller_raises() -> None:
    body = make_zip({"a.json": b"1"})
    stream = io.BytesIO(body)
    with pytest.raises(RuntimeError), open_zip_archive("k", opener=lambda _key: stream):
        raise RuntimeError("boom")
    assert stream.closed


# ── Per-member skip ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("previous", "current", "expected"),
    [
        ("abc", "abc", True),
        ("abc", "def", False),
        (None, "abc", False),
        ("", "abc", False),
        # A hash we could not compute is not a match either.
        ("abc", "", False),
    ],
)
def test_member_unchanged_truth_table(previous: str | None, current: str, expected: bool) -> None:
    assert member_unchanged(previous, current) is expected


# ── The central-directory stamp (MONEY-1283) ────────────────────────────────


def test_a_member_stamp_costs_no_reads_because_the_central_directory_is_in_memory() -> None:
    """The whole fix, measured at its source.

    ``zipfile`` parses the central directory ONCE when it opens the stream, so
    ``CRC`` and ``file_size`` are already resident. On prod the stream is a live
    GCS object, which is what turned "hash the member to see if it changed" into
    a network round trip per finished filer — 1,691/min against 988,373 members,
    so the walk stalled at 25.7% and reported BUDGET_EXHAUSTED forever.

    Falsifiable against a MEASURED ceiling, not a literal: `open_and_list_reads`
    re-derives what opening the same bytes costs, so a `member_stamp` that ever
    touched the stream would land above it.
    """
    body = make_zip({"a.json": b"hello", "b.json": b"world"})
    baseline = open_and_list_reads(body)

    opener, stream = counting_opener(body)
    with open_zip_archive("k", opener=opener) as archive:
        stamps = [archive.member_stamp(name) for name in archive.names()]

    assert len(stream.reads) == baseline, "computing a stamp must not read the stream"
    assert stamps == [f"{zlib.crc32(b'hello'):08x}:5", f"{zlib.crc32(b'world'):08x}:5"]


def test_the_stamp_moves_with_the_bytes_and_not_with_the_archive_that_carries_them() -> None:
    """CRC is over the UNCOMPRESSED content, so a rebuild of the same file agrees.

    This is the property the skip rests on. SEC rebuilds both bulk zips nightly;
    if the stamp tracked anything about the ARCHIVE rather than the MEMBER, every
    member would read as changed every night and the fix would quietly do nothing
    while looking correct.

    ``date_time`` is the specific trap — it is available on the same ``ZipInfo``
    and it moves on every rebuild, so the assertion below is written against two
    archives built at different times with different compression.
    """
    first = make_zip({"a.json": b"same-bytes"})
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        info = zipfile.ZipInfo("a.json", date_time=(2001, 1, 1, 0, 0, 0))
        archive.writestr(info, b"same-bytes")
    second = buffer.getvalue()

    assert first != second, "the two archives really do differ on the wire"
    with (
        open_zip_archive("k", opener=zip_from_bytes(first)) as one,
        open_zip_archive("k", opener=zip_from_bytes(second)) as two,
    ):
        assert one.member_stamp("a.json") == two.member_stamp("a.json")


def test_a_changed_member_gets_a_different_stamp() -> None:
    with (
        open_zip_archive("k", opener=zip_from_bytes(make_zip({"a.json": b"v1"}))) as before,
        open_zip_archive("k", opener=zip_from_bytes(make_zip({"a.json": b"v2"}))) as after,
    ):
        assert before.member_stamp("a.json") != after.member_stamp("a.json")


def test_a_group_stamp_is_ordered_so_a_reordered_shard_is_not_the_same_group() -> None:
    # The digest a group is compared against is taken over `b"".join(blobs)` in
    # read order, so the stamp has to be a SEQUENCE too. A set-like join would
    # call a filer whose paging shards were re-cut "unchanged".
    body = make_zip({"CIK1.json": b"index", "CIK1-submissions-001.json": b"page"})
    with open_zip_archive("k", opener=zip_from_bytes(body)) as archive:
        forward = archive.group_stamp(["CIK1.json", "CIK1-submissions-001.json"])
        reverse = archive.group_stamp(["CIK1-submissions-001.json", "CIK1.json"])
        assert forward != reverse
        # ... and a group that LOSES a shard is not the same group either.
        assert archive.group_stamp(["CIK1.json"]) != forward
        assert archive.group_stamp(["CIK1.json"]) == archive.member_stamp("CIK1.json")


@pytest.mark.parametrize(
    ("previous", "current", "expected"),
    [
        ("2f0e5b:9", "2f0e5b:9", True),
        ("2f0e5b:9", "2f0e5b:8", False),
        # ABSENT is the LEGACY checkpoint, and it is never a match. Skipping on a
        # field nothing ever wrote would skip a genuinely changed member forever.
        (None, "2f0e5b:9", False),
        ("", "2f0e5b:9", False),
        ("2f0e5b:9", "", False),
    ],
)
def test_stamp_unchanged_truth_table(previous: str | None, current: str, expected: bool) -> None:
    assert stamp_unchanged(previous, current) is expected


def test_load_member_checkpoints_carries_the_stamp_and_still_ignores_error_rows(
    db: FakeDatabase,
) -> None:
    write_checkpoints(
        db,
        "edgar-submissions",
        [
            CheckpointEntry(item_key="0000320193", detail="sha-apple", stamp="crc-apple"),
            CheckpointEntry(item_key="0001067983", detail="sha-brk"),  # LEGACY: no stamp
            CheckpointEntry(item_key="0000000009", detail="ValueError", status="ERROR"),
        ],
    )
    loaded = load_member_checkpoints(db, "edgar-submissions")
    assert loaded == {
        "0000320193": MemberCheckpoint(sha256="sha-apple", stamp="crc-apple"),
        "0001067983": MemberCheckpoint(sha256="sha-brk", stamp=""),
    }


def test_load_checkpoints_keeps_its_old_signature_for_the_jobs_that_share_it(
    db: FakeDatabase,
) -> None:
    """`ownership_backfill`, `xbrl_backfill` and `ftd` call THIS function.

    None of them walks a zip, so none has a stamp to give. Widening
    `load_checkpoints` to serve the two bulk walkers would have edited three jobs
    to fix two; the stamp went into a SECOND loader instead. Asserted rather than
    commented, because a later "tidy-up" that merges the two would otherwise turn
    `{itemKey: sha}` into `{itemKey: object}` under three callers at once and the
    only symptom would be a comparison that is never equal — a backfill that
    re-does everything, forever, reporting success.
    """
    write_checkpoints(
        db, "edgar-companyfacts", [CheckpointEntry(item_key="0000320193", detail="sha", stamp="c")]
    )
    loaded = load_checkpoints(db, "edgar-companyfacts")
    assert loaded == {"0000320193": "sha"}
    assert all(isinstance(value, str) for value in loaded.values())


def test_a_checkpoint_written_without_a_stamp_stores_no_stamp_field_at_all(
    db: FakeDatabase,
) -> None:
    # `None` and "absent" must not be the same state, and the three non-zip jobs
    # legitimately have no stamp. A written null would make "this job has none"
    # indistinguishable from "we tried and failed to compute one".
    write_checkpoints(db, "edgar-ownership", [CheckpointEntry(item_key="0000320193", detail="sha")])
    stored = db["backfill_checkpoints"].find_one({"itemKey": "0000320193"})
    assert stored is not None
    assert "stamp" not in stored


def test_upgrading_a_stamp_touches_only_that_field_and_never_creates_a_row(
    db: FakeDatabase,
) -> None:
    """The legacy path's write, pinned on both of its guarantees.

    A pre-MONEY-1283 checkpoint has a digest and no stamp, so the run reads that
    member once and then records the stamp so it is never read again. What it
    must NOT do is restate the rest of the row: `rows` and `bytes` belong to the
    run that did the work, and re-`$set`ting them from here would zero the row
    count of every legacy member on the night it is upgraded — which reads
    afterwards as "processed, wrote nothing", the exact signal the zero-write
    monitor exists to fire on.
    """
    write_checkpoints(
        db,
        "edgar-submissions",
        [CheckpointEntry(item_key="0000320193", detail="sha-apple", rows=42, bytes=999)],
    )
    stored = db["backfill_checkpoints"].find_one({"itemKey": "0000320193"})
    assert stored is not None
    stamped_at = stored["at"]

    upgrade_checkpoint_stamps(db, "edgar-submissions", {"0000320193": "crc-apple"})

    upgraded = db["backfill_checkpoints"].find_one({"itemKey": "0000320193"})
    assert upgraded is not None
    assert upgraded["stamp"] == "crc-apple"
    assert (upgraded["rows"], upgraded["bytes"]) == (42, 999)
    assert upgraded["detail"] == "sha-apple"
    assert upgraded["at"] == stamped_at, "`at` records the run that did the WORK"

    # And it is UPSERT-FALSE. Manufacturing a checkpoint for a member that has
    # none is the MONEY-1235 shape — the member would be skipped forever having
    # produced nothing.
    upgrade_checkpoint_stamps(db, "edgar-submissions", {"0009999999": "crc-ghost"})
    assert db["backfill_checkpoints"].find_one({"itemKey": "0009999999"}) is None


def test_load_checkpoints_returns_only_finished_members(db: FakeDatabase) -> None:
    write_checkpoints(
        db,
        "edgar-submissions",
        [
            CheckpointEntry(item_key="0000320193", detail="sha-apple"),
            CheckpointEntry(item_key="0001067983", detail="ValueError", status="ERROR"),
            CheckpointEntry(item_key="0001769628", detail="sha-core", status="EMPTY"),
        ],
    )
    loaded = load_checkpoints(db, "edgar-submissions")
    # An ERROR checkpoint records that the member was ATTEMPTED. Returning it
    # here would make one bad night permanent — the member would be skipped
    # forever and the failure never retried.
    assert loaded == {"0000320193": "sha-apple"}


def test_checkpoints_are_namespaced_by_job_key(db: FakeDatabase) -> None:
    write_checkpoints(db, "edgar-submissions", [CheckpointEntry(item_key="0000320193", detail="a")])
    write_checkpoints(
        db, "edgar-companyfacts", [CheckpointEntry(item_key="0000320193", detail="b")]
    )
    assert load_checkpoints(db, "edgar-submissions") == {"0000320193": "a"}
    assert load_checkpoints(db, "edgar-companyfacts") == {"0000320193": "b"}
    assert db["backfill_checkpoints"].count_documents({}) == 2


def test_a_checkpoint_write_is_idempotent_and_carries_an_explicit_scope(db: FakeDatabase) -> None:
    entries = [CheckpointEntry(item_key="0000320193", detail="sha", rows=12, bytes=99)]
    write_checkpoints(db, "edgar-submissions", entries)
    write_checkpoints(db, "edgar-submissions", entries)
    stored = db["backfill_checkpoints"].find({})
    assert len(stored) == 1
    # An ABSENT `scope` compares equal to every other absent one on a MongoDB
    # unique index, so every checkpoint in the job would collide on one row.
    assert stored[0]["scope"] == CHECKPOINT_SCOPE
    assert stored[0]["rows"] == 12


def test_the_checkpoint_unique_index_is_ensured(db: FakeDatabase) -> None:
    load_checkpoints(db, "edgar-submissions")
    assert (("jobKey", "itemKey", "scope"), True) in db["backfill_checkpoints"].indexes


# ── Budget ──────────────────────────────────────────────────────────────────


def test_run_budget_is_measured_on_an_injected_clock() -> None:
    now = [100.0]
    budget = RunBudget(120.0, clock=lambda: now[0])
    assert budget.exhausted() is False
    now[0] = 219.0
    assert budget.exhausted() is False, "119s of a 120s budget is not exhausted"
    now[0] = 220.0
    assert budget.exhausted() is True, "the budget is exhausted the instant it is reached"
    assert budget.elapsed() == 120.0
    assert budget.remaining() == 0.0


def test_budget_seconds_reads_the_environment_per_call(monkeypatch: pytest.MonkeyPatch) -> None:
    assert budget_seconds(FEED_COMPANYFACTS) == common.DEFAULT_BUDGET_SECONDS[FEED_COMPANYFACTS]
    monkeypatch.setenv("EDGAR_BULK_BUDGET_SECONDS", "42")
    # A module-scope read would have frozen the default at import, before this
    # line ran, and this assertion would pass for the wrong reason.
    assert budget_seconds(FEED_COMPANYFACTS) == 42.0
    monkeypatch.setenv("EDGAR_BULK_BUDGET_SECONDS", "not-a-number")
    assert budget_seconds(FEED_COMPANYFACTS) == common.DEFAULT_BUDGET_SECONDS[FEED_COMPANYFACTS]
    monkeypatch.setenv("EDGAR_BULK_BUDGET_SECONDS", "-5")
    assert budget_seconds(FEED_COMPANYFACTS) == common.DEFAULT_BUDGET_SECONDS[FEED_COMPANYFACTS]


def test_the_companyfacts_budget_leaves_room_under_its_task_timeout() -> None:
    """Each budget must finish cleanly rather than be killed; the true wall is
    `budget + one worst member`.

    The submissions arm of this test read `< 3 * 3600` — a LITERAL COPY of a
    task timeout that lives in `scripts/ops/setup-us-fundamentals-jobs.sh`.
    MONEY-1283 raised that timeout to Cloud Run's 86400 maximum (988,373 members,
    not the ~15k the original sizing assumed) and this copy did not move, so the
    test went on asserting a pairing that no longer existed and failed the moment
    the budget was corrected to match the real timeout.

    The numbers below are still literals and can still rot. What CANNOT rot is
    `test_every_job_budget_fits_inside_its_own_task_timeout` in
    `test_deploy_contract.py`, which PARSES the timeouts out of the script for
    all five jobs — that is the authoritative pairing, and this case is kept only
    as a fast unit-level smoke test of the two feeds this module owns.
    """
    assert common.DEFAULT_BUDGET_SECONDS[FEED_SUBMISSIONS] < 24 * 3600
    assert common.DEFAULT_BUDGET_SECONDS[FEED_COMPANYFACTS] < 6 * 3600


# ── Universe ────────────────────────────────────────────────────────────────


def test_load_universe_is_one_query_and_picks_the_common_share(db: FakeDatabase) -> None:
    instruments = db["us_instruments"]
    instruments.documents.extend(
        [
            {
                "_id": 1,
                "cik": "0000070858",
                "symbol": "BAC-PB",
                "assetType": "Stock",
                "listingStatus": "ACTIVE",
            },
            {
                "_id": 2,
                "cik": "0000070858",
                "symbol": "BAC",
                "assetType": "Stock",
                "listingStatus": "ACTIVE",
            },
            {
                "_id": 3,
                "cik": "0000070858",
                "symbol": "BAC-PK",
                "assetType": "Stock",
                "listingStatus": "ACTIVE",
            },
            {
                "_id": 4,
                "cik": "0001067983",
                "symbol": "BRK-B",
                "assetType": "Stock",
                "listingStatus": "ACTIVE",
            },
            {
                "_id": 5,
                "cik": "0000320193",
                "symbol": "AAPL",
                "assetType": "Stock",
                "listingStatus": "DELISTED",
            },
            {"_id": 6, "symbol": "NOCIK", "assetType": "Stock", "listingStatus": "ACTIVE"},
        ]
    )
    universe = load_universe(db)
    assert universe.contains("0000070858")
    assert universe.symbol_for("0000070858") == "BAC"
    assert universe.symbol_for("0001067983") == "BRK-B"
    # A DELISTED listing is not our universe, and a row with no `cik` at all is
    # excluded by a POSITIVE filter rather than by `{$ne: null}`.
    assert not universe.contains("0000320193")
    assert len(universe.ciks) == 2


def test_load_universe_normalises_an_unpadded_cik(db: FakeDatabase) -> None:
    db["us_instruments"].documents.append(
        {
            "_id": 1,
            "cik": "320193",
            "symbol": "AAPL",
            "assetType": "Stock",
            "listingStatus": "ACTIVE",
        }
    )
    universe = load_universe(db)
    assert universe.contains("0000320193")


def test_an_etf_listing_puts_the_cik_in_the_universe_but_names_no_symbol(db: FakeDatabase) -> None:
    db["us_instruments"].documents.append(
        {
            "_id": 1,
            "cik": "0000884394",
            "symbol": "SPY",
            "assetType": "ETF",
            "listingStatus": "ACTIVE",
        }
    )
    universe = load_universe(db)
    assert universe.contains("0000884394")
    assert universe.symbol_for("0000884394") is None
