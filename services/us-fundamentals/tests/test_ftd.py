"""SEC's Fails-to-Deliver files -> the ``SEC_FTD`` CUSIP tier — MONEY-979.

The guard this file is really about is the LAST section: a fails file names a
ticker, a 13D/G cover page names the subject's CUSIP and CIK together. The
second is a stronger claim and must survive the first, forever. That is the
whole reason ``UsCusipMap.source`` exists, and it is checked here against the
REAL ``cusip_map_logic.plan_writes`` rather than against a copy of its rule.
"""

from __future__ import annotations

import io
import zipfile
from datetime import UTC, datetime
from typing import Any

import pytest

from app.bulk import ftd
from app.bulk.backfill_logic import FTD_INDEX_URL
from app.bulk.common import (
    CHECKPOINT_COLLECTION,
    CHECKPOINT_DONE,
    STATUS_BUDGET_EXHAUSTED,
    STATUS_COMPLETED,
    STATUS_WRITE_DISARMED,
    RunBudget,
)
from app.sec.errors import SecNotFound
from app.store import writers

from .test_backfill_logic import FTD_INDEX_HTML, FTD_TEXT
from .test_store_writers import FakeDatabase
from .test_xbrl_backfill import StepClock

STAMP = datetime(2026, 8, 29, tzinfo=UTC)

AAPL_CUSIP = "037833100"
AMD_CUSIP = "25461H259"
MDXH_CUSIP = "B5950S113"


def make_ftd_zip(period: str = "202607b", text: str = FTD_TEXT) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"cnsfails{period}.txt", text)
    return buffer.getvalue()


# ── Doubles ─────────────────────────────────────────────────────────────────


class FakeClient:
    """Answers the index page and every zip URL. Records the request order."""

    def __init__(
        self, *, zips: dict[str, bytes] | None = None, missing: set[str] | None = None
    ) -> None:
        self.gets: list[str] = []
        self.zips = zips or {}
        self.missing = missing or set()

    def get(self, url: str, **_: Any) -> bytes:
        self.gets.append(url)
        if url == FTD_INDEX_URL:
            return FTD_INDEX_HTML.encode()
        if url in self.missing:
            raise SecNotFound(f"404 {url}")
        period = url.rsplit("/", 1)[-1].removeprefix("cnsfails").removesuffix(".zip")
        return self.zips.get(url, make_ftd_zip(period.split("_")[0]))


class FakeArchive:
    """A dict standing in for GCS. Monkeypatched over ``app.sec.archive``."""

    def __init__(self, seeded: dict[str, bytes] | None = None) -> None:
        self.objects: dict[str, bytes] = dict(seeded or {})
        self.reads: list[str] = []
        self.writes: list[str] = []

    def read_bytes(self, key: str) -> bytes | None:
        self.reads.append(key)
        return self.objects.get(key)

    def write_bytes(self, key: str, data: bytes, *, content_type: str) -> None:
        self.writes.append(key)
        self.objects[key] = data


class FakeSources:
    """``CusipSources`` over dicts. Same two methods this job actually uses."""

    def __init__(
        self,
        *,
        instruments: dict[str, dict[str, Any]] | None = None,
        existing: dict[str, dict[str, Any]] | None = None,
    ) -> None:
        self.instruments = instruments or {}
        self._existing = existing or {}
        self.existing_calls: list[list[str]] = []

    def instruments_by_symbol(self, symbols: Any) -> dict[str, dict[str, Any]]:
        return {s: self.instruments[s] for s in symbols if s in self.instruments}

    def existing(self, cusips: Any) -> dict[str, dict[str, Any]]:
        batch = list(cusips)
        self.existing_calls.append(batch)
        return {c: self._existing[c] for c in batch if c in self._existing}


class RecordingWriter:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.collections: list[str] = []

    def upsert_rows(self, collection: str, rows: Any, *, key: Any) -> int:
        self.collections.append(collection)
        self.rows.extend(dict(r) for r in rows)
        return len(list(rows))


class ExplodingCusipWriter:
    def upsert_rows(self, *_a: Any, **_k: Any) -> int:
        raise AssertionError("a dry run wrote CUSIP rows")


@pytest.fixture
def db() -> FakeDatabase:
    writers.reset_index_cache()
    return FakeDatabase()


@pytest.fixture(autouse=True)
def archive(monkeypatch: pytest.MonkeyPatch) -> FakeArchive:
    fake = FakeArchive()
    monkeypatch.setattr(ftd.archive, "read_bytes", fake.read_bytes)
    monkeypatch.setattr(ftd.archive, "write_bytes", fake.write_bytes)
    ftd.reset_lookup_cache()
    yield fake
    ftd.reset_lookup_cache()


def run_job(db: FakeDatabase, client: FakeClient, **kwargs: Any) -> Any:
    return ftd.run(
        db=db,
        client=client,
        months=kwargs.pop("months", 1),
        sources=kwargs.pop("sources", FakeSources()),
        writer=kwargs.pop("writer", RecordingWriter()),
        apply_writes=kwargs.pop("apply_writes", True),
        now=kwargs.pop("now", STAMP),
        **kwargs,
    )


def rows_by_cusip(writer: RecordingWriter) -> dict[str, dict[str, Any]]:
    return {row["cusip"]: row for row in writer.rows}


# ── The index page is READ, once ────────────────────────────────────────────


def test_the_index_page_is_fetched_once_and_every_url_comes_from_it(
    db: FakeDatabase,
) -> None:
    client = FakeClient()
    run_job(db, client, months=1)

    assert client.gets[0] == FTD_INDEX_URL
    assert client.gets.count(FTD_INDEX_URL) == 1, "the index page was re-fetched"
    # `--months 1` is TWO files, and both URLs are the page's verbatim paths.
    assert client.gets[1:] == [
        "https://www.sec.gov/files/data/fails-deliver-data/cnsfails202607b.zip",
        "https://www.sec.gov/files/data/fails-deliver-data/cnsfails202607a.zip",
    ]


def test_a_file_in_a_non_default_directory_is_fetched_from_that_directory(
    db: FakeDatabase,
) -> None:
    """201 of the 410 real links are NOT under /files/data/fails-deliver-data."""
    client = FakeClient()
    run_job(db, client, months=3)
    assert (
        "https://www.sec.gov/files/data/other/fails-deliver-data/cnsfails202605b.zip" in client.gets
    )


def test_the_raw_zip_is_archived_under_the_dated_ftd_prefix(
    db: FakeDatabase, archive: FakeArchive
) -> None:
    run_job(db, FakeClient(), months=1)
    assert sorted(archive.writes) == [
        "edgar/bulk/ftd/2026-07-01/cnsfails202607a.zip",
        "edgar/bulk/ftd/2026-07-16/cnsfails202607b.zip",
    ]


def test_an_archived_file_is_not_re_fetched(db: FakeDatabase, archive: FakeArchive) -> None:
    archive.objects["edgar/bulk/ftd/2026-07-16/cnsfails202607b.zip"] = make_ftd_zip()
    client = FakeClient()
    run_job(db, client, months=1)
    assert (
        "https://www.sec.gov/files/data/fails-deliver-data/cnsfails202607b.zip" not in client.gets
    ), "archive-first was bypassed; the bytes were pulled from SEC a second time"


# ── The pipe format, end to end ─────────────────────────────────────────────


def test_the_trailers_and_the_trailing_blank_line_never_become_rows(
    db: FakeDatabase,
) -> None:
    result = run_job(db, FakeClient(), months=1)
    # Six data rows per file, two files.
    assert result.counters["rowsParsed"] == 12
    assert result.counters["rowsDropped"] == 0
    assert result.counters["trailerMismatch"] == 0
    assert result.counters["trailerAbsent"] == 0


def test_a_trailer_that_disagrees_with_the_row_count_is_reported(db: FakeDatabase) -> None:
    broken = FTD_TEXT.replace("Trailer record count 6", "Trailer record count 99")
    client = FakeClient(
        zips={
            "https://www.sec.gov/files/data/fails-deliver-data/cnsfails202607b.zip": (
                make_ftd_zip(text=broken)
            )
        }
    )
    result = run_job(db, client, months=1)
    assert result.counters["trailerMismatch"] == 1


def test_a_zip_with_no_text_member_raises_rather_than_reading_as_empty() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("readme.pdf", b"x")
    with pytest.raises(ValueError, match=r"no \.txt member"):
        ftd.unzip_ftd(buffer.getvalue())


# ── Tier precedence — the guard this job most needs ─────────────────────────


@pytest.mark.parametrize("stronger", ["SEC_13DG", "TIINGO_FIGI"])
def test_an_ftd_row_never_overwrites_a_stronger_tier(db: FakeDatabase, stronger: str) -> None:
    sources = FakeSources(
        existing={
            AAPL_CUSIP: {
                "cusip": AAPL_CUSIP,
                "source": stronger,
                "symbol": "APPLE-FROM-COVER-PAGE",
                "cik10": "0000320193",
            }
        }
    )
    writer = RecordingWriter()
    result = run_job(db, FakeClient(), months=1, sources=sources, writer=writer)

    assert AAPL_CUSIP not in rows_by_cusip(writer), (
        f"an FTD row was written over a {stronger} mapping; the provenance "
        "UsCusipMap.source exists to record is gone"
    )
    assert result.counters["cusipsSuppressedByTier"] >= 1
    # And the CUSIPs nothing stronger owns DID land.
    assert AMD_CUSIP in rows_by_cusip(writer)


def test_an_ftd_row_replaces_an_unresolved_row_and_accumulates_its_attempts(
    db: FakeDatabase,
) -> None:
    sources = FakeSources(
        existing={AAPL_CUSIP: {"cusip": AAPL_CUSIP, "source": "UNRESOLVED", "attempts": 3}}
    )
    writer = RecordingWriter()
    run_job(db, FakeClient(), months=1, sources=sources, writer=writer)

    row = rows_by_cusip(writer)[AAPL_CUSIP]
    assert row["source"] == "SEC_FTD"
    assert row["symbol"] == "AAPL"
    assert row["attempts"] == 3, "a recorded failure history was thrown away"


def test_a_weaker_openfigi_row_is_replaced(db: FakeDatabase) -> None:
    sources = FakeSources(existing={AAPL_CUSIP: {"cusip": AAPL_CUSIP, "source": "OPENFIGI"}})
    writer = RecordingWriter()
    run_job(db, FakeClient(), months=1, sources=sources, writer=writer)
    assert rows_by_cusip(writer)[AAPL_CUSIP]["source"] == "SEC_FTD"


def test_the_existing_read_is_chunked_rather_than_one_huge_in_query(
    db: FakeDatabase, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(writers, "DEFAULT_CHUNK", 2)
    sources = FakeSources()
    run_job(db, FakeClient(), months=1, sources=sources)
    assert all(len(batch) <= 2 for batch in sources.existing_calls)
    assert [len(batch) for batch in sources.existing_calls] == [2, 1]


# ── What the rows carry ─────────────────────────────────────────────────────


def test_the_symbol_is_stored_even_when_our_master_does_not_list_it(
    db: FakeDatabase,
) -> None:
    """SEC's own ticker is a primary-source fact; OpenFIGI's is a venue match."""
    writer = RecordingWriter()
    run_job(db, FakeClient(), months=1, sources=FakeSources(), writer=writer)
    row = rows_by_cusip(writer)[MDXH_CUSIP]
    assert row["symbol"] == "MDXH"
    assert row["source"] == "SEC_FTD"
    assert row["confidence"] == 1.0
    assert row["cik10"] is None
    assert row["resolvedAt"] == STAMP


def test_cik_and_figi_are_filled_only_from_a_real_instrument_row(db: FakeDatabase) -> None:
    sources = FakeSources(
        instruments={
            "AAPL": {"cik": "0000320193", "symbol": "AAPL", "openFIGIComposite": "BBG000B9XRY4"}
        }
    )
    writer = RecordingWriter()
    result = run_job(db, FakeClient(), months=1, sources=sources, writer=writer)

    row = rows_by_cusip(writer)[AAPL_CUSIP]
    assert row["cik10"] == "0000320193"
    assert row["compositeFigi"] == "BBG000B9XRY4"
    assert result.counters["instrumentsMatched"] == 1


def test_a_blank_symbol_produces_no_mapping_at_all(db: FakeDatabase) -> None:
    writer = RecordingWriter()
    run_job(db, FakeClient(), months=1, writer=writer)
    assert "11111X111" not in rows_by_cusip(writer)


def test_the_latest_settlement_date_wins_across_the_run(db: FakeDatabase) -> None:
    writer = RecordingWriter()
    run_job(db, FakeClient(), months=1, writer=writer)
    assert rows_by_cusip(writer)[AMD_CUSIP]["symbol"] == "AMDD"


def test_the_hit_count_is_reported_rather_than_a_completion_percentage(
    db: FakeDatabase,
) -> None:
    result = run_job(db, FakeClient(), months=1)
    # Six data rows per file, four distinct CUSIPs, one of which has a BLANK
    # symbol and is therefore not a mapping at all.
    assert result.counters["cusipsSeen"] == 3
    assert result.counters["cusipsResolved"] == 3
    assert result.counters["cusipsAmbiguous"] == 0
    assert result.selected == 3
    assert "completion" not in result.as_dict()


# ── Resume, arming and the clock ────────────────────────────────────────────


def test_a_checkpointed_period_skips_before_the_fetch(db: FakeDatabase) -> None:
    db[CHECKPOINT_COLLECTION].documents.append(
        {
            "_id": 1,
            "jobKey": ftd.CHECKPOINT_JOB_KEY,
            "itemKey": "202607b",
            "scope": "",
            "status": CHECKPOINT_DONE,
            "detail": "cnsfails202607b.zip",
        }
    )
    client = FakeClient()
    result = run_job(db, client, months=1)
    assert (
        "https://www.sec.gov/files/data/fails-deliver-data/cnsfails202607b.zip" not in client.gets
    )
    assert result.counters["filesSkipped"] == 1
    assert result.counters["filesFetched"] == 1


def test_a_re_posted_file_under_a_new_basename_is_fetched_again(db: FakeDatabase) -> None:
    """SEC re-posts a half-month as ``..._0.zip``; the period alone would skip it."""
    db[CHECKPOINT_COLLECTION].documents.append(
        {
            "_id": 1,
            "jobKey": ftd.CHECKPOINT_JOB_KEY,
            "itemKey": "202308b",
            "scope": "",
            "status": CHECKPOINT_DONE,
            "detail": "cnsfails202308b.zip",
        }
    )
    client = FakeClient()
    run_job(db, client, months=2)
    assert any("cnsfails202308b_0.zip" in url for url in client.gets)


def test_the_checkpoint_records_the_basename_it_archived(db: FakeDatabase) -> None:
    run_job(db, FakeClient(), months=1)
    rows = {r["itemKey"]: r for r in db[CHECKPOINT_COLLECTION].documents}
    assert rows["202607b"]["detail"] == "cnsfails202607b.zip"
    assert rows["202607b"]["status"] == CHECKPOINT_DONE


def test_a_dry_run_parses_counts_and_writes_nothing(db: FakeDatabase) -> None:
    result = run_job(db, FakeClient(), months=1, apply_writes=False, writer=ExplodingCusipWriter())
    assert result.status == STATUS_WRITE_DISARMED
    assert result.written == 0
    assert result.counters["cusipsResolved"] == 3, "a dry run must still prove the parse"
    assert db[CHECKPOINT_COLLECTION].documents == []


def test_an_unreachable_file_is_counted_and_left_uncheckpointed(db: FakeDatabase) -> None:
    gone = "https://www.sec.gov/files/data/fails-deliver-data/cnsfails202607b.zip"
    client = FakeClient(missing={gone})
    result = run_job(db, client, months=1)

    assert result.transport_failures == 1
    assert result.status == STATUS_COMPLETED, "one missing file is not a failed run"
    assert {r["itemKey"] for r in db[CHECKPOINT_COLLECTION].documents} == {"202607a"}


def test_the_budget_stops_between_files(db: FakeDatabase) -> None:
    client = FakeClient()
    result = run_job(db, client, months=3, budget=RunBudget(15.0, clock=StepClock(10.0)))
    assert result.status == STATUS_BUDGET_EXHAUSTED
    assert result.resumable is True
    assert result.exit_code == 0
    assert result.counters["filesFetched"] == 1, "the walk continued past its budget"


# ── The lookup that lights up T7's tier ─────────────────────────────────────


def test_no_archived_file_means_the_tier_stays_unavailable(db: FakeDatabase) -> None:
    """``None``, not an empty callable — a third value, distinct from "found nothing"."""
    assert ftd.latest_archived_file(db) is None
    assert ftd.make_ftd_lookup(db) is None


def test_the_lookup_reads_the_newest_archived_file(db: FakeDatabase, archive: FakeArchive) -> None:
    run_job(db, FakeClient(), months=1)
    latest = ftd.latest_archived_file(db)
    assert latest is not None
    assert latest.period == "202607b", "an older half-month was chosen as 'latest'"

    lookup = ftd.make_ftd_lookup(db)
    assert lookup is not None
    assert lookup([AAPL_CUSIP, "NOPE00000"]) == {AAPL_CUSIP: "AAPL"}


def test_the_lookup_lights_up_the_tier_the_resolver_reported_unavailable(
    db: FakeDatabase,
) -> None:
    from app.parsers.cusip_map import NullCusipSources, resolve_cusips

    run_job(db, FakeClient(), months=1)

    without = resolve_cusips([AAPL_CUSIP], sources=NullCusipSources())
    assert without["ftd"] == "unavailable"

    lookup = ftd.make_ftd_lookup(db)
    with_ftd = resolve_cusips([AAPL_CUSIP], sources=NullCusipSources(), ftd_lookup=lookup)
    assert with_ftd["ftd"] == "queried"
    assert with_ftd["byTier"]["SEC_FTD"] == 1
    assert with_ftd["resolutions"][AAPL_CUSIP]["symbol"] == "AAPL"


def test_a_file_that_yields_no_mappings_is_not_cached_as_the_answer(
    archive: FakeArchive,
) -> None:
    """The other half of the same rule: an EMPTY parse is not a remembered answer.

    A header-and-trailers-only file (or one SEC republished after truncating it)
    must not poison the process for its whole lifetime. Only a non-empty map is
    memoised.
    """
    key = "edgar/bulk/ftd/2026-07-16/cnsfails202607b.zip"
    empty = (
        "SETTLEMENT DATE|CUSIP|SYMBOL|QUANTITY (FAILS)|DESCRIPTION|PRICE\nTrailer record count 0\n"
    )
    archive.objects[key] = make_ftd_zip(text=empty)
    assert ftd.symbol_map_from_archive(key) == {}

    archive.objects[key] = make_ftd_zip()
    assert ftd.symbol_map_from_archive(key)[AAPL_CUSIP] == "AAPL", (
        "an empty parse was cached; the corrected file can never be read"
    )


def test_an_unreadable_archive_object_is_not_cached_as_an_empty_answer(
    db: FakeDatabase, archive: FakeArchive
) -> None:
    run_job(db, FakeClient(), months=1)
    key = "edgar/bulk/ftd/2026-07-16/cnsfails202607b.zip"
    stored = archive.objects.pop(key)

    assert ftd.symbol_map_from_archive(key) == {}
    archive.objects[key] = stored
    assert ftd.symbol_map_from_archive(key)[AAPL_CUSIP] == "AAPL", (
        "an empty result was cached; a transient miss became permanent"
    )


# ── the zip member's NAME is not a contract SEC keeps ───────────────────────


def _ftd_zip(names: list[str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as bundle:
        for n in names:
            bundle.writestr(n, f"DATA:{n}")
    return buf.getvalue()


def test_a_single_member_with_NO_extension_is_the_data_file() -> None:
    """THE PROD FAILURE. Measured 2026-08-29 on `edgar-bulk-ftd-prod`:

        ValueError: no .txt member in FTD zip (members: ['cnsfails202604a'])

    SEC ships some periods with the member carrying no extension at all. The
    contents are the same pipe-delimited text; only the name differs. Requiring
    `.txt` is an exact match against a string the upstream owns, and it failed
    the WHOLE run rather than one odd file.
    """
    assert ftd.unzip_ftd(_ftd_zip(["cnsfails202604a"])) == "DATA:cnsfails202604a"


def test_a_single_txt_member_still_works() -> None:
    assert ftd.unzip_ftd(_ftd_zip(["cnsfails202607b.txt"])) == "DATA:cnsfails202607b.txt"


def test_txt_still_DISAMBIGUATES_when_there_are_several_members() -> None:
    """The preference earns its keep only when there is a choice to make."""
    assert ftd.unzip_ftd(_ftd_zip(["readme.pdf", "cnsfails.txt"])) == "DATA:cnsfails.txt"


def test_several_members_and_none_is_txt_RAISES_rather_than_guessing() -> None:
    # Picking `sorted()[0]` here would silently parse a readme as fail data.
    with pytest.raises(ValueError, match=r"no \.txt member"):
        ftd.unzip_ftd(_ftd_zip(["a.pdf", "b.csv"]))


def test_directory_entries_are_never_the_data_member() -> None:
    assert ftd.unzip_ftd(_ftd_zip(["cnsfails202604a"])) == "DATA:cnsfails202604a"
    with pytest.raises(ValueError, match="no file member"):
        ftd.unzip_ftd(_ftd_zip(["adir/"]))
