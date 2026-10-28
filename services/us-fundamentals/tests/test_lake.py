"""`scripts/quant/lake.py` — the release reader. MONEY-1518 (B7).

Only the decisions that are SILENT WHEN WRONG are asserted here; the GCS reads
are not mocked, because a fake object store would assert that a fake object
store works. What is left is exactly the set a running backtest cannot report:

  a defaulted LAKE_ENV     a production backtest reads QA's warehouse and
                           reports a healthy result.
  a loose release id       `..` or a `/` in the id reshapes the object path;
                           at best it 404s, at worst it reads ANOTHER release.
  the wrong bucket base    `releases/` routes to the LAKE bucket, never the
                           content one. Reading the wrong bucket 404s, which
                           is indistinguishable from "not cut yet".
  a dropped factor column  `bars_d1` without `split_factor_cum` adjusts prices
                           and leaves volume on the pre-split share count —
                           every bar plausible, every size wrong.
  an empty symbol list     reads the WHOLE universe instead of nothing, which
                           on a release is tens of millions of rows and looks
                           like a slow query rather than a bug.
  an inverted range        returns an empty frame that reads as "no data for
                           that window" rather than as a caller error.

And, since MONEY-1518's second pass, the READS themselves — against a fixture
release on local disk (`_lake_release_fixture.py`), whose `bars_d1` is B4's own
64 rows run through B4's own SQL. A local copy is not a fake object store: it is
the `LAKE_RELEASE_CACHE` read path a synced algo VM uses, through the same
pyarrow datasets as GCS.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from datetime import UTC, date, datetime
from pathlib import Path

import pytest

from tests._lake_release_fixture import M1_BARS, RELEASE_ID, build_release, gold_rows

SPLT_M1 = [b for b in M1_BARS if b[0] == "SPLT"]

_REPO_ROOT = Path(__file__).resolve().parents[3]
_LAKE_PATH = _REPO_ROOT / "scripts" / "quant" / "lake.py"

_spec = importlib.util.spec_from_file_location("lake_under_test", _LAKE_PATH)
assert _spec is not None and _spec.loader is not None
lake = importlib.util.module_from_spec(_spec)
sys.modules["lake_under_test"] = lake
_spec.loader.exec_module(lake)


@pytest.fixture(autouse=True)
def _no_ambient_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """A developer's exported LAKE_RELEASE_CACHE must not reach these tests."""
    monkeypatch.delenv("LAKE_RELEASE_CACHE", raising=False)


# ── LAKE_ENV is refused, never defaulted ────────────────────────────────────


def test_lake_env_refuses_anything_but_qa_or_prod(monkeypatch: pytest.MonkeyPatch) -> None:
    for bad in ["", "staging", "development", "PROD", "test"]:
        monkeypatch.setenv("LAKE_ENV", bad)
        with pytest.raises(RuntimeError, match='must be "qa" or "prod"'):
            lake.lake_env()
    monkeypatch.delenv("LAKE_ENV", raising=False)
    with pytest.raises(RuntimeError):
        lake.lake_env()


def test_lake_env_accepts_exactly_the_two(monkeypatch: pytest.MonkeyPatch) -> None:
    for good in ["qa", "prod"]:
        monkeypatch.setenv("LAKE_ENV", good)
        assert lake.lake_env() == good


def test_lake_env_is_read_per_call_not_at_import(monkeypatch: pytest.MonkeyPatch) -> None:
    """A module-scope read freezes at import — the warm-container defect."""
    monkeypatch.setenv("LAKE_ENV", "qa")
    assert lake.lake_env() == "qa"
    monkeypatch.setenv("LAKE_ENV", "prod")
    assert lake.lake_env() == "prod"


# ── The release id is shape-checked before it becomes a path ────────────────


def test_parse_release_id_accepts_what_the_builder_emits() -> None:
    assert lake.parse_release_id("2026-09-22T00-00-00Z") == "2026-09-22T00-00-00Z"
    assert lake.parse_release_id("  2026-01-02T03-04-05Z  ") == "2026-01-02T03-04-05Z"


def test_parse_release_id_refuses_anything_that_reshapes_the_path() -> None:
    for bad in [
        "",
        "latest",
        "2026-09-22",
        "2026-09-22T00:00:00Z",  # colons: the spelling that survives nothing
        "../2026-09-22T00-00-00Z",
        "2026-09-22T00-00-00Z/../other",
        "2026-09-22T00-00-00",
    ]:
        with pytest.raises(ValueError, match="Not a release id"):
            lake.parse_release_id(bad)


def test_release_ids_sort_lexically_in_time_order() -> None:
    """`latest_release` is `max()` and nothing else — this is why that is safe."""
    ids = ["2026-10-01T00-00-00Z", "2026-09-22T23-59-59Z", "2026-09-22T00-00-00Z"]
    assert max(ids) == "2026-10-01T00-00-00Z"
    assert sorted(ids) == [
        "2026-09-22T00-00-00Z",
        "2026-09-22T23-59-59Z",
        "2026-10-01T00-00-00Z",
    ]


# ── The path lands in the LAKE bucket ───────────────────────────────────────


def test_release_root_is_the_lake_bucket_never_the_content_one() -> None:
    assert (
        lake.release_root("2026-09-22T00-00-00Z", "prod")
        == "stockbook-lake-prod/releases/2026-09-22T00-00-00Z"
    )
    assert (
        lake.release_root("2026-09-22T00-00-00Z", "qa")
        == "stockbook-lake-qa/releases/2026-09-22T00-00-00Z"
    )
    assert "content" not in lake.release_root("2026-09-22T00-00-00Z", "prod")


def test_release_root_validates_the_id_it_is_handed() -> None:
    with pytest.raises(ValueError):
        lake.release_root("../../tiles", "prod")


def test_release_root_falls_through_to_LAKE_ENV(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LAKE_ENV", "qa")
    assert lake.release_root("2026-09-22T00-00-00Z").startswith("stockbook-lake-qa/")
    monkeypatch.setenv("LAKE_ENV", "prod")
    assert lake.release_root("2026-09-22T00-00-00Z").startswith("stockbook-lake-prod/")


# ── BOTH factor columns, or volume is silently wrong ────────────────────────


def test_both_adjustment_factors_are_named() -> None:
    """Prices take `price_factor`; VOLUME takes `split_factor_cum` and only that.

    A dividend must not touch a share count. Dropping the split column would
    leave volume on the pre-split basis with every price adjusted — plausible
    bars, wrong sizes, nothing to notice it by.
    """
    assert lake.FACTOR_COLUMNS == ("price_factor", "split_factor_cum")


# ── bars() refuses the two inputs that read as "no data" ────────────────────


def test_bars_refuses_an_empty_symbol_list() -> None:
    with pytest.raises(ValueError, match="empty symbol list"):
        lake.bars([], "D1", "2024-01-01", "2024-12-31", release="2026-09-22T00-00-00Z")


def test_bars_refuses_an_inverted_range() -> None:
    with pytest.raises(ValueError, match="is after end"):
        lake.bars(["AAPL"], "D1", "2024-12-31", "2024-01-01", release="2026-09-22T00-00-00Z")


def test_bars_validates_the_release_id_before_touching_the_network() -> None:
    """The id is checked ahead of any GCS call, so a typo is a ValueError."""
    with pytest.raises(ValueError, match="Not a release id"):
        lake.bars(["AAPL"], "D1", "2024-01-01", "2024-12-31", release="latest")


# ── Dates ───────────────────────────────────────────────────────────────────


def test_dates_are_accepted_as_string_date_and_datetime() -> None:
    assert lake._as_date("2024-03-05") == date(2024, 3, 5)
    assert lake._as_date(date(2024, 3, 5)) == date(2024, 3, 5)
    assert lake._as_date(datetime(2024, 3, 5, 23, 59, tzinfo=UTC)) == date(2024, 3, 5)


# ── duckdb is OPTIONAL, and says so ─────────────────────────────────────────


def test_open_release_names_the_install_when_duckdb_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`duckdb` is not a dependency of this repo, and this file does not add one.

    An ImportError three frames down reads as a broken reader; a named error
    reads as a choice the caller has not made yet.
    """
    monkeypatch.setitem(sys.modules, "duckdb", None)
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __import__

    def refuse(name: str, *rest: object) -> object:
        if name == "duckdb":
            raise ImportError("No module named 'duckdb'")
        return real_import(name, *rest)  # type: ignore[arg-type]

    monkeypatch.setattr("builtins.__import__", refuse)
    with pytest.raises(RuntimeError, match="pip install duckdb"):
        lake.open_release("2026-09-22T00-00-00Z", "qa")


def test_duckdb_is_not_a_declared_dependency() -> None:
    """Pinned so adding it becomes a deliberate edit that fails this first."""
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text()
    assert "duckdb" not in pyproject
    assert "pyarrow" in pyproject, "pyarrow IS the zero-new-dependency read path"


def test_the_module_imports_without_duckdb_present() -> None:
    """`bars()` and `universe()` must work on a box that has never seen duckdb."""
    assert "duckdb" not in sys.modules or sys.modules["duckdb"] is None
    assert callable(lake.bars)
    assert callable(lake.universe)


def test_os_is_the_only_environment_read() -> None:
    """Guards the per-call rule above from being refactored into a constant."""
    source = _LAKE_PATH.read_text()
    assert 'os.environ.get("LAKE_ENV"' in source
    # A module-level `LAKE_ENV = os.environ...` would freeze at import.
    assert "\nLAKE_ENV = " not in source
    assert os.environ is not None


# ── The READS, against a fixture release (MONEY-1518 second pass) ───────────


@pytest.fixture
def release(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = build_release(tmp_path)
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path))
    monkeypatch.setenv("LAKE_ENV", "qa")
    return root


def _gold(listing_id: str, session_date: str) -> dict:
    return next(
        r
        for r in gold_rows()
        if r["listing_id"] == listing_id and r["session_date"] == session_date
    )


def test_a_d1_adjusted_read_SELECTS_the_release_columns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One implementation of CRSP: the frame carries what the SQL wrote.

    The release is doctored so that one `adj_close` is NOT `close *
    price_factor`. A reader that re-derives the adjustment returns the product;
    only a reader that SELECTS returns the doctored value. That difference is
    the whole of "the Python port is deleted, not bypassed".
    """

    def doctor(rows: list[dict]) -> None:
        for r in rows:
            if r["listing_id"] == "SPLT:NASDAQ:2020-01-02" and r["session_date"] == "2020-01-08":
                r["adj_close"] = 12345.0

    build_release(tmp_path, edit_d1=doctor)
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path))
    df = lake.bars(["SPLT"], "D1", "2020-01-01", "2020-01-31", release=RELEASE_ID, env="qa")
    row = df[df["session_date"] == date(2020, 1, 8)].iloc[0]
    assert row["adj_close"] == 12345.0
    assert len(df) == 12


def test_an_intraday_bar_takes_the_factor_of_its_OWN_session(release: Path) -> None:
    """SPLT splits 3:1 on 2020-01-09, so the 8th and the 9th carry different factors.

    A join on the wrong key — listing alone, or the UTC date of a US bar — gives
    both sessions one factor and a series that jumps 3x overnight. A bar on the
    11th has NO D1 row and must be DROPPED: an unadjustable bar silently passed
    through an adjusted frame is a step on real prices that renders perfectly.
    """
    df = lake.bars(["SPLT"], "M1", "2020-01-01", "2020-01-31", release=RELEASE_ID)
    assert len(df) == len(SPLT_M1) - 1
    assert date(2020, 1, 11) not in set(df["session_date"])
    # The post-market bar sits on the 9th in UTC and takes the 8th's factor.
    post = df[df["ts"] == datetime(2020, 1, 9, 0, 30, tzinfo=UTC)].iloc[0]
    assert post["session_date"] == date(2020, 1, 8)
    assert post["price_factor"] == _gold("SPLT:NASDAQ:2020-01-02", "2020-01-08")["price_factor"]
    for _, bar in df.iterrows():
        gold = _gold("SPLT:NASDAQ:2020-01-02", bar["session_date"].isoformat())
        assert bar["adj_close"] == bar["close"] * gold["price_factor"]
        assert bar["adj_volume"] == float(int(bar["volume"] / gold["split_factor_cum"] + 0.5))
    # Continuous across the split, which is what an adjusted series is FOR.
    closes = df.sort_values("ts")["adj_close"].tolist()
    assert max(closes) / min(closes) < 1.05


def test_intraday_VOLUME_divides_by_the_split_factor_alone(release: Path) -> None:
    """A dividend changes the price basis and never the share count.

    DIVO's bar on the 6th sits ahead of two dividends and no split, so its
    price factor is below 1 and its split factor is exactly 1: the price moves
    and the volume must not. SPLT cannot show this — with no dividend its two
    factors are equal, and dividing by the wrong one reads identically.
    """
    df = lake.bars(["DIVO"], "M1", "2020-01-01", "2020-01-31", release=RELEASE_ID)
    (bar,) = df.to_dict("records")
    assert bar["price_factor"] < 1
    assert bar["split_factor_cum"] == 1
    assert bar["adj_volume"] == bar["volume"]
    assert bar["adj_close"] == bar["close"] * bar["price_factor"] != bar["close"]


def test_the_range_is_in_SESSION_dates_so_no_bar_loses_its_factor(release: Path) -> None:
    """The post-market bar at 00:30Z on the 9th is the 8th's session (19:30 ET).

    `bars()` selects on `session_date` and looks the factors up over the SAME
    range, so every bar it selects has its session's factor. Select bars on
    their UTC day instead and a window starting on the 9th picks that bar up
    with no factor row to join: the adjusted frame silently holds one bar fewer
    than the raw one. Only the 11th (no D1 row at all) may be missing.
    """
    post = datetime(2020, 1, 9, 0, 30, tzinfo=UTC)
    for lo, hi, holds_post in (("2020-01-09", "2020-01-31", False), ("2020-01-01", "2020-01-08", True)):  # fmt: skip
        raw = lake.bars(["SPLT"], "M1", lo, hi, release=RELEASE_ID, adjusted=False)
        adj = lake.bars(["SPLT"], "M1", lo, hi, release=RELEASE_ID)
        assert bool((raw["ts"] == post).any()) is holds_post, (lo, hi)
        adjustable = raw[raw["session_date"] != date(2020, 1, 11)]
        assert adj["ts"].tolist() == adjustable["ts"].tolist(), (lo, hi)
        assert adj[["adj_close", "adj_volume"]].notna().all().all()


def test_a_raw_intraday_read_keeps_every_bar(release: Path) -> None:
    df = lake.bars(["SPLT"], "M1", "2020-01-01", "2020-01-31", release=RELEASE_ID, adjusted=False)
    assert len(df) == len(SPLT_M1)
    assert "adj_close" not in df.columns


def test_every_price_and_volume_reads_as_float64(release: Path) -> None:
    """The DOUBLE rule, observed from the reading side: a NUMERIC column reaches
    pandas as an object column of `Decimal`, and `Decimal * float` raises."""
    df = lake.bars(["SPLT"], "D1", "2020-01-01", "2020-01-31", release=RELEASE_ID)
    for col in ("open", "close", "volume", "price_factor", "adj_close", "adj_volume"):
        assert str(df[col].dtype) == "float64", col


def test_a_cut_with_no_manifest_is_refused_not_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Parquet with no manifest is a cut that died part-way. Its bars read
    PERFECTLY — as a fraction of a universe, reported as a clean run."""
    build_release(tmp_path, with_manifest=False)
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path))
    with pytest.raises(lake.ReleaseNotFound, match="do not read its bars"):
        lake.bars(["SPLT"], "D1", "2020-01-01", "2020-01-31", release=RELEASE_ID, env="qa")
    with pytest.raises(lake.ReleaseNotFound):
        lake.universe("2020-01-06", release=RELEASE_ID, env="qa")


def test_the_env_is_part_of_the_cache_path(release: Path) -> None:
    """A QA copy must never answer a prod read of the same id."""
    with pytest.raises(lake.ReleaseNotFound):
        lake.bars(["SPLT"], "D1", "2020-01-01", "2020-01-31", release=RELEASE_ID, env="prod")


def test_latest_release_reads_the_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build_release(tmp_path, release_id="2026-09-01T00-00-00Z")
    build_release(tmp_path, release_id="2026-09-23T00-00-00Z")
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path))
    assert lake.latest_release("qa") == "2026-09-23T00-00-00Z"


# ── universe(): survivorship-free, and each listing ONCE ────────────────────


def _universe(
    day: str, market: str | None = "US", venue: str | None = None
) -> list[tuple[str, str]]:
    # US by default: India's BSE identity starts 2024-01-01, so an earlier
    # as-of across BOTH markets is refused (see the IN tests).
    u = lake.universe(day, release=RELEASE_ID, market=market, venue=venue)
    return sorted(zip(u["listing_id"], u["symbol"], strict=True))


def test_a_rename_day_answers_ONE_ticker(release: Path) -> None:
    """`valid_to` is EXCLUSIVE. Inclusive, DIVO appeared twice on its rename
    day — once as DIVX, once as DIVO — and a universe count double-weighted it.
    And its undated current-symbol row must not add DIVO beside DIVX the day
    before: a dated row beats an undated one (`resolveSymbol`)."""
    before = [s for lid, s in _universe("2020-01-09") if lid.startswith("DIVO")]
    assert before == ["DIVX"]
    on_the_day = [s for lid, s in _universe("2020-01-10") if lid.startswith("DIVO")]
    assert on_the_day == ["DIVO"]


def test_an_scd2_listing_is_joined_as_the_version_valid_THEN(release: Path) -> None:
    """CLEAN has two `listing` versions. Joined whole, it appeared twice."""
    for day, name in (("2020-01-05", "Clean Old"), ("2020-01-10", "Clean Co")):
        u = lake.universe(day, release=RELEASE_ID, market="US")
        clean = u[u["listing_id"] == "CLEAN:NASDAQ:2020-01-02"]
        assert clean["name"].tolist() == [name]


def test_an_UNDATED_label_is_the_listings_own_ticker(release: Path) -> None:
    """identity-sync writes every `symbol_history` row with BOTH dates NULL
    (prod 2026-09-23: 98,941 of 98,941). A filter that dropped NULL returned an
    empty universe for every as-of on every real release. UNDT's own undated
    label is admitted, once; its undated previous symbol UNDTX never is."""
    undt = [s for lid, s in _universe("2020-01-06") if lid.startswith("UNDT:")]
    assert undt == ["UNDT"]


def test_a_delisted_listing_is_tradable_to_its_last_session_then_not(release: Path) -> None:
    """identity-sync dates a delisting from Tiingo's master (MONEY-1544): ACTIVE
    through `listingEndDate`, a DELISTED version from the day after. Before it,
    all 33,140 delisted US listings sat in one DELISTED version from the day
    identity-sync first ran, so they were tradable on no date at all."""
    assert ("GONE:NYSE:2001-05-01", "GONE") in _universe("2019-05-31")
    assert "GONE" not in [s for _, s in _universe("2019-06-01")]
    assert "GONE" not in [s for _, s in _universe("2020-01-06")]


def test_india_is_dated_by_its_first_bar_and_a_listing_with_none_by_its_first_sighting(
    release: Path,
) -> None:
    """India has no inception date; a listing starts at its first bar in
    `price_bar_d1`, or — with no bar — the day identity-sync first saw it. Its
    labels stay undated, so ETERNAL answers and ZOMATO never does."""
    grasim = ("GRASIM:NSE:unknown", "GRASIM")
    eternal = ("ETERNAL:NSE:unknown", "ETERNAL")
    hdfc = ("HDFC:NSE:unknown", "HDFC")
    assert _universe("2021-07-22", market="IN", venue="NSE") == [grasim, hdfc]
    assert _universe("2021-07-23", market="IN", venue="NSE") == [eternal, grasim, hdfc]
    assert _universe("2026-09-23", market="IN") == [
        ("BSEONE:BSE:unknown", "BSEONE"),
        eternal,
        grasim,
        ("KDGREEN:BSE:unknown", "KDGREEN"),
        ("NOBAR:NSE:unknown", "NOBAR"),
    ]


def test_an_Indian_company_the_master_no_longer_lists_traded_until_its_last_bar(
    release: Path,
) -> None:
    """MONEY-1602. India's master is current-only, so HDFC Ltd — merged into
    HDFC Bank, last session 2023-07-12, and in no master row at all — was in
    no universe, for any date: survivorship bias with no error and no count.
    identity-sync now lists it from its bars."""
    nse = [s for _, s in _universe("2023-07-12", market="IN", venue="NSE")]
    assert "HDFC" in nse
    assert "HDFC" not in [s for _, s in _universe("2023-07-13", market="IN", venue="NSE")]


def test_a_renamed_Indian_listing_is_its_OLD_symbol_until_the_rename_and_never_both(
    release: Path,
) -> None:
    """MANBRO became KDGREEN on 2026-08-19 (BSE, measured on prod). The bars
    before the rename sit on MANBRO's id, so that era is MANBRO's listing;
    KDGREEN's undated MANBRO alias must not add it a second time."""
    assert _universe("2026-08-18", market="IN", venue="BSE") == [
        ("BSEONE:BSE:unknown", "BSEONE"),
        ("MANBRO:BSE:unknown", "MANBRO"),
    ]
    assert _universe("2026-08-19", market="IN", venue="BSE") == [
        ("BSEONE:BSE:unknown", "BSEONE"),
        ("KDGREEN:BSE:unknown", "KDGREEN"),
    ]


def test_an_as_of_before_a_SOURCES_first_window_is_refused_by_name(release: Path) -> None:
    """Each source's earliest window is a coverage floor. India's two archives
    start on different days (BSE 2024-01-01 here and on prod), so an India
    universe before 2024 would silently hold NSE alone — refused, unless the
    caller narrows to NSE, whose floor it does not precede."""
    for market in ("IN", None):
        with pytest.raises(
            ValueError, match=r"precedes this release's identity for IN/BSE 2024-01-01"
        ):
            lake.universe("2022-01-03", release=RELEASE_ID, market=market)
    with pytest.raises(ValueError, match=r"for IN/NSE 1994-11-03"):
        lake.universe("1994-11-02", release=RELEASE_ID, market="IN", venue="NSE")
    with pytest.raises(ValueError, match=r"for US/TIINGO 1972-01-03"):
        lake.universe("1971-12-31", release=RELEASE_ID, market="US")


def test_a_US_venue_that_listed_later_is_history_not_a_floor(release: Path) -> None:
    """The floor is per SOURCE, not per venue: every US listing is dated by
    Tiingo's one master, so a venue whose first listing is later (NASDAQ opened
    in 1971) answers an empty universe before it — that IS what traded."""
    assert _universe("2000-01-03", venue="NASDAQ") == []
    assert _universe("2000-01-03") == [("DOW:NYSE:1972-01-03", "DOW")]


def test_the_frame_carries_ONE_venue_column(release: Path) -> None:
    u = lake.universe("2020-01-06", release=RELEASE_ID, market="US")
    assert [c for c in u.columns if c.startswith("venue")] == ["venue"]
    assert "source" not in u.columns
    assert "parser_version" not in u.columns


def test_a_release_with_no_parser_version_is_undated_throughout(release: Path) -> None:
    """Nothing in such a release says which starts are dates. Without this, a
    missing column would read as "every listing dated"."""
    import pyarrow.parquet as pq

    path = release / "instruments/listing/part-000000000000.parquet"
    pq.write_table(pq.read_table(path).drop_columns(["parser_version"]), path)
    # All undated: the floor is the LATEST first start, 2020-01-02 here.
    with pytest.raises(ValueError, match=r"US/TIINGO 2020-01-02 \(8 listing\(s\) not yet"):
        lake.universe("2017-06-01", release=RELEASE_ID, market="US")


def test_an_UNDATED_release_refuses_every_as_of_before_its_seed_day(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Prod as identity/1 left it — and any release cut before the rebase:
    every first version starts 2026-09-22, every label is undated, a delisted
    listing is one DELISTED version. It answers "listed now" from that day and
    refuses, per market, before it."""
    build_release(tmp_path, identity="seed")
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path))
    monkeypatch.setenv("LAKE_ENV", "qa")
    assert _universe("2026-09-23", market=None) == [
        ("DOW:NYSE:2019-03-20", "DOW"),
        ("ETERNAL:NSE:unknown", "ETERNAL"),
    ]
    with pytest.raises(
        ValueError,
        match=r"IN/NSE 2026-09-22 \(1 listing\(s\) not yet re-dated.*"
        r"US/TIINGO 2026-09-22 \(2 listing\(s\) not yet re-dated",
    ):
        lake.universe("2017-06-01", release=RELEASE_ID)


def test_a_PARTLY_re_dated_source_keeps_the_undated_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rebase that died after dating ONE listing: Dow Chemical now starts in
    1972, so MIN(valid_from) says the US identity reaches 1972 — and a 2017
    universe would be Dow Chemical alone, reported as the market. A source earns
    its floor only when every listing in it is dated."""
    build_release(tmp_path, identity="partial")
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path))
    monkeypatch.setenv("LAKE_ENV", "qa")
    with pytest.raises(ValueError, match=r"US/TIINGO 2026-09-22 \(1 listing\(s\) not yet re-dated"):
        lake.universe("2017-06-01", release=RELEASE_ID, market="US")
    assert _universe("2026-09-23") == [("DOW:NYSE:2019-03-20", "DOW")]


def test_an_unknown_or_mismatched_venue_is_refused_by_name(release: Path) -> None:
    """An empty frame would read as "nothing traded on that venue"."""
    with pytest.raises(ValueError, match=r"venue 'nse' is not in this release"):
        lake.universe("2022-01-03", release=RELEASE_ID, market="IN", venue="nse")
    with pytest.raises(ValueError, match=r"venue 'NSE' is not in this release's US"):
        lake.universe("2022-01-03", release=RELEASE_ID, market="US", venue="NSE")
    assert _universe("2022-01-03", market="IN", venue="NSE")  # the real one answers


def test_an_undated_alias_is_in_no_universe(release: Path) -> None:
    """SPLTOLD has NULL validity: it matches every as-of by construction.
    It used to CRASH here (`date.fromisoformat("None")`); admitted, it would
    put a retired ticker beside the live one in every universe."""
    symbols = [s for _, s in _universe("2020-01-06")]
    assert "SPLT" in symbols
    assert "SPLTOLD" not in symbols


def test_a_recycled_ticker_resolves_by_date(release: Path) -> None:
    def dow(day: str) -> list[tuple[str, str]]:
        return [x for x in _universe(day) if x[1] == "DOW"]

    assert dow("2017-06-01") == [("DOW:NYSE:1972-01-03", "DOW")]
    assert dow("2017-08-31") == [("DOW:NYSE:1972-01-03", "DOW")]  # its last session
    assert dow("2018-01-01") == []  # delisted, and not yet re-used
    assert dow("2020-01-06") == [("DOW:NYSE:2019-03-20", "DOW")]


# ── verify_release(): four words, four fixes ────────────────────────────────


def test_verify_release_is_silent_on_a_complete_copy(release: Path) -> None:
    assert lake.verify_release(RELEASE_ID) == []


def test_verify_release_names_what_is_wrong(release: Path) -> None:
    listing = release / "instruments/listing/part-000000000000.parquet"
    listing.unlink()
    (release / "bars_d1/market=US/year=2020/part-000000000001.parquet").write_bytes(b"PAR1")
    target = release / "corporate_actions/part-000000000000.parquet"
    body = bytearray(target.read_bytes())
    body[len(body) // 2] ^= 0xFF  # same size, different bytes
    target.write_bytes(bytes(body))
    shortened = release / "bars_d1/market=US/year=2017/part-000000000000.parquet"
    shortened.write_bytes(shortened.read_bytes()[:-1])

    assert sorted(lake.verify_release(RELEASE_ID)) == sorted(
        [
            "MISSING instruments/listing/part-000000000000.parquet",
            "UNLISTED bars_d1/market=US/year=2020/part-000000000001.parquet",
            "SHA256 corporate_actions/part-000000000000.parquet",
            f"SIZE bars_d1/market=US/year=2017/part-000000000000.parquet: manifest "
            f"{shortened.stat().st_size + 1}, found {shortened.stat().st_size}",
        ]
    )


# ── DuckDB, where it is installed ───────────────────────────────────────────


def test_duckdb_counts_bars_d1_in_under_ten_seconds(release: Path) -> None:
    """The ticket's proof, on the fixture: `SELECT COUNT(*) FROM bars_d1`.

    Skipped where duckdb is absent — which is CI, by design (it is not a
    dependency). The number that matters is a real release on a laptop; this
    proves the path works end to end and reads every partition.
    """
    pytest.importorskip("duckdb")
    import time

    started = time.perf_counter()
    con = lake.open_release(RELEASE_ID)
    (count,) = con.sql("SELECT COUNT(*) FROM bars_d1").fetchone()
    assert count == lake.manifest(RELEASE_ID)["rowCounts"]["bars_d1"] == len(gold_rows())
    assert time.perf_counter() - started < 10


# ── Declared dependencies ───────────────────────────────────────────────────


def test_scripts_quant_requirements_agree_with_the_service_pins() -> None:
    """A version the laptop venv installs must be a version this suite ran on."""
    pins = dict(
        line.split("==", 1)
        for line in (_REPO_ROOT / "scripts/quant/requirements.txt").read_text().splitlines()
        if line and not line.startswith("#")
    )
    constraints = dict(
        line.split("==", 1)
        for line in (Path(__file__).resolve().parents[1] / "constraints.txt")
        .read_text()
        .splitlines()
        if "==" in line and not line.startswith("#")
    )
    assert {"pandas", "pyarrow"} <= pins.keys()
    assert "duckdb" not in pins, "duckdb is optional by design — see open_release()"
    for name, version in pins.items():
        assert constraints.get(name) == version, f"{name}=={version} vs constraints.txt"
