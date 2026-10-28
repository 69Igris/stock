"""The backtest cold-shard reader — MONEY-1384 B0.

`scripts/quant/read_candles.py` is a standalone script at the repo root, not a
member of this package, so it is loaded by PATH. It lives here anyway because
its CODEC is this service's (`app/sec/archive_logic.py`) and its round-trip test
is only meaningful beside the writer it round-trips against.

Every test drives the REAL implementation. Nothing here restates a key format, a
factor or a query — a test that rebuilt `candles/US/M1/AAPL/2024` inline would
stay green after the builder was deleted.
"""

from __future__ import annotations

import gzip
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
import pytest

from app.sec import archive
from app.sec.archive_logic import ShardFormatError
from tests._lake_release_fixture import (
    RELEASE_ID,
    build_release,
    cold_shard_rows,
    gold_rows,
)

_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "quant" / "read_candles.py"
_spec = importlib.util.spec_from_file_location("read_candles", _SCRIPT)
assert _spec and _spec.loader
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)


def bar(
    ts: str, close: float, *, div: float = 0.0, split: float = 1.0, symbol: str = "AAPL"
) -> dict[str, Any]:
    """One shard row in the STORED short-key shape (`ColdShardRow`)."""
    return {
        "s": symbol,
        "x": "NASDAQ",
        "tf": "M1",
        "t": ts,
        "l": f"{symbol}:NASDAQ:1980-12-12",
        "o": close,
        "h": close,
        "lo": close,
        "c": close,
        "v": 1000,
        "d": div,
        "sf": split,
        "src": "TIINGO",
    }


class FakeBucket:
    """An in-memory object store wired into the SERVICE's own read/write pair.

    Not a mock of the reader: `archive.write_shard` really encodes (gzip, mtime
    0, sorted, compact) and `archive.read_bytes` really answers `None` for a key
    that was never written. The round trip therefore proves the reader consumes
    what the writer produces, which is the only version of that claim worth
    having.
    """

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.raise_on: set[str] = set()

    def read_bytes(self, key: str) -> bytes | None:
        if key in self.raise_on:
            # What a 403 / connection reset looks like from `read_bytes`: it
            # RAISES. Only a genuine 404 becomes None.
            raise RuntimeError(f"GCS transport failure on {key}")
        return self.objects.get(key)

    def write_bytes(self, key: str, data: bytes, *, content_type: str) -> None:
        self.objects[key] = data


class FakeCandles:
    """A `candles` collection that APPLIES the query it is given.

    A fake that ignored the filter would let `hot_query` drop its source clause
    and still pass — testing the opposite of the property. So `$in`, `$gte` and
    `$lte` are honoured for real, and the RT row is excluded only because the
    query excludes it.
    """

    def __init__(self, docs: list[dict[str, Any]]) -> None:
        self.docs = docs

    def find(self, query: dict[str, Any], _projection: Any = None) -> list[dict[str, Any]]:
        return [doc for doc in self.docs if self._matches(doc, query)]

    @staticmethod
    def _matches(doc: dict[str, Any], query: dict[str, Any]) -> bool:
        for field, clause in query.items():
            value = doc.get(field)
            if not isinstance(clause, dict):
                if value != clause:
                    return False
                continue
            if "$in" in clause and value not in clause["$in"]:
                return False
            if "$gte" in clause and value < clause["$gte"]:
                return False
            if "$lte" in clause and value > clause["$lte"]:
                return False
        return True


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> FakeBucket:
    fake = FakeBucket()
    monkeypatch.setattr(archive, "read_bytes", fake.read_bytes)
    monkeypatch.setattr(archive, "write_bytes", fake.write_bytes)
    return fake


def day(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=UTC)


# ── 1. Round trip through the service's own shard writer ────────────────────


def test_round_trip_through_write_shard(bucket: FakeBucket) -> None:
    key = rc.cold_key("US", "M1", "AAPL", 2024)
    rows = [
        bar("2024-01-03T14:30:00.000Z", 100.0),
        bar("2024-01-03T14:31:00.000Z", 101.5),
        bar("2024-01-04T14:30:00.000Z", 99.25),
    ]
    archive.write_shard(key, rows)
    assert bucket.objects[key][:2] == b"\x1f\x8b"  # it really is a gz shard

    df, counts = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2024-01-01"),
        end=day("2024-12-31"),
    )

    assert counts == {
        "shards": 1,
        "hit": 1,
        "missed": 0,
        "dropped": 0,
        "rejected": 0,
        "excluded": 0,
        "multiListing": 0,
    }
    assert list(df.columns) == list(rc.COLUMNS)
    assert len(df) == 3
    assert df["close"].tolist() == [100.0, 101.5, 99.25]
    assert df["symbol"].unique().tolist() == ["AAPL"]
    assert df["exchange"].unique().tolist() == ["NASDAQ"]
    assert df["listingId"].unique().tolist() == ["AAPL:NASDAQ:1980-12-12"]
    assert df["source"].unique().tolist() == ["TIINGO"]
    assert df["ts"].iloc[0] == rc.pd.Timestamp("2024-01-03T14:30:00Z")
    assert df["volume"].tolist() == [1000.0, 1000.0, 1000.0]
    assert df["splitFactor"].tolist() == [1.0, 1.0, 1.0]


def test_a_missing_symbol_year_is_absent_not_empty(bucket: FakeBucket) -> None:
    # Two symbols, one year, one shard written: the other is a NORMAL absence.
    archive.write_shard(
        rc.cold_key("US", "M1", "AAPL", 2024), [bar("2024-01-03T14:30:00.000Z", 100.0)]
    )
    df, counts = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL", "MSFT"],
        start=day("2024-01-01"),
        end=day("2024-12-31"),
    )
    assert counts == {
        "shards": 2,
        "hit": 1,
        "missed": 1,
        "dropped": 0,
        "rejected": 0,
        "excluded": 0,
        "multiListing": 0,
    }
    assert df["symbol"].unique().tolist() == ["AAPL"]


# ── 2. Adjustment: REFUSED without a release ────────────────────────────────
#
# Four tests lived here and exercised `rc.adjust_series` / `rc.add_adjusted` —
# a hand port of `computeAdjustedSeries`. MONEY-1518 DELETED the port, so they
# tested nothing that exists. They are not replaced by four weaker ones: the
# arithmetic they checked (a 2:1 split, compounding across two actions, no
# bleed between two symbols, a non-positive split factor) is now checked by
# `packages/core/__tests__/market-data/adjustment-sql-parity.test.ts`, which
# EXECUTES the SQL in node:sqlite against the TypeScript over a 64-row fixture
# and carries SEVEN permanent mutation cases. That is strictly more than these
# four ever were, and it grades the implementation that actually runs.
#
# What is left to assert here is the thing a caller can still get wrong.


def test_adjusted_without_a_release_refuses_rather_than_returning_raw(
    bucket: FakeBucket,
) -> None:
    """A raw frame labelled adjusted is wrong by a MULTIPLE and renders perfectly.

    So the refusal is the test. A fall back to raw — or to a re-derivation
    here — would be the third implementation of one policy that MONEY-1518
    exists to remove, and nothing downstream could detect either.
    """
    with pytest.raises(ValueError, match="needs --release"):
        rc.read_candles(
            market="US",
            timeframe="D1",
            symbols=["AAPL"],
            start=datetime(2024, 1, 1, tzinfo=UTC),
            end=datetime(2024, 1, 3, tzinfo=UTC),
            adjusted=True,
        )


def test_the_python_crsp_port_is_GONE_not_merely_unused() -> None:
    """Deleted, not bypassed — the ticket's own acceptance item.

    A module-level `hasattr` rather than a grep: a port left importable is a
    port the next caller reaches for, and `--adjusted` silently working again
    against unverified arithmetic is exactly the drift this closed.
    """
    assert not hasattr(rc, "adjust_series")
    assert not hasattr(rc, "add_adjusted")


# ── 3. TIINGO_RT is excluded unless asked for ───────────────────────────────


def hot_docs() -> list[dict[str, Any]]:
    common = {
        "exchange": "NASDAQ",
        "timeframe": "M1",
        "listingId": "AAPL:NASDAQ:1980-12-12",
        "open": 1.0,
        "high": 1.0,
        "low": 1.0,
        "divCash": 0.0,
        "splitFactor": 1.0,
    }
    return [
        {
            **common,
            "symbol": "AAPL",
            "ts": datetime(2026, 9, 5, 14, 30, tzinfo=UTC),
            "close": 100.0,
            "volume": 5000,
            "source": "DATABENTO",
        },
        {
            **common,
            "symbol": "AAPL",
            "ts": datetime(2026, 9, 5, 14, 31, tzinfo=UTC),
            "close": 101.0,
            "volume": 0,
            "source": "TIINGO_RT",
        },
    ]


def test_realtime_bars_are_excluded_by_default(bucket: FakeBucket) -> None:
    df, _ = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2026-08-01"),
        end=day("2026-09-06"),
        hot=True,
        hot_collection=FakeCandles(hot_docs()),
    )
    assert df["source"].tolist() == ["DATABENTO"]
    # The reason, restated as an assertion: no structural volume-0 bar survives.
    assert (df["volume"] > 0).all()


def test_realtime_bars_are_included_on_request(bucket: FakeBucket) -> None:
    df, _ = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2026-08-01"),
        end=day("2026-09-06"),
        hot=True,
        include_rt=True,
        hot_collection=FakeCandles(hot_docs()),
    )
    assert sorted(df["source"].tolist()) == ["DATABENTO", "TIINGO_RT"]


def test_cold_wins_over_hot_on_the_same_bar(bucket: FakeBucket) -> None:
    ts = "2026-09-05T14:30:00.000Z"
    archive.write_shard(rc.cold_key("US", "M1", "AAPL", 2026), [bar(ts, 999.0)])
    df, _ = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2026-08-01"),
        end=day("2026-09-06"),
        hot=True,
        hot_collection=FakeCandles(hot_docs()),
    )
    at = df[df["ts"] == rc.pd.Timestamp(ts)]
    assert len(at) == 1
    assert at.iloc[0]["close"] == 999.0


# ── 4. A miss is not a failure ──────────────────────────────────────────────


def test_a_transport_error_propagates_and_is_never_counted_as_absent(
    bucket: FakeBucket,
) -> None:
    """The load-bearing distinction, in both directions at once.

    MSFT's shard was never written — a normal absence. AAPL's read RAISES. If
    the two were folded together the run would report a healthy 1 hit / 1 miss
    and a backtest would silently run on half its universe.
    """
    archive.write_shard(
        rc.cold_key("US", "M1", "MSFT", 2024), [bar("2024-01-03T20:00:00.000Z", 1.0, symbol="MSFT")]
    )
    bucket.raise_on.add(rc.cold_key("US", "M1", "AAPL", 2024))

    with pytest.raises(rc.ShardFetchError) as caught:
        rc.read_candles(
            market="US",
            timeframe="M1",
            symbols=["AAPL", "MSFT"],
            start=day("2024-01-01"),
            end=day("2024-12-31"),
        )
    assert "1 of 2 shards failed" in str(caught.value)
    assert isinstance(caught.value.__cause__, RuntimeError)


def test_unrecognised_bytes_raise_rather_than_reading_as_an_empty_year(
    bucket: FakeBucket,
) -> None:
    """Absence and unreadability must never look alike (the MONEY-1189 shape).

    The codec's own `ShardFormatError` propagates untouched — it names the cause
    precisely, and wrapping it would only blur a decode failure into a transport
    one. What matters is that neither ever becomes zero rows.
    """
    bucket.objects[rc.cold_key("US", "M1", "AAPL", 2024)] = b"not a shard at all"
    with pytest.raises(ShardFormatError):
        rc.read_candles(
            market="US",
            timeframe="M1",
            symbols=["AAPL"],
            start=day("2024-01-01"),
            end=day("2024-12-31"),
        )


# ── Keys ────────────────────────────────────────────────────────────────────


def test_cold_key_is_the_documented_path_with_no_extension() -> None:
    assert rc.cold_key("US", "M1", "AAPL", 2024) == "candles/US/M1/AAPL/2024"


def test_cold_key_refuses_a_segment_that_would_reshape_the_hierarchy() -> None:
    # A `/` in a symbol files the object one level deeper. Nothing errors at any
    # layer; the object is simply somewhere no reader computes.
    for bad in ("A/B", "", "A\nB"):
        with pytest.raises(ValueError):
            rc.cold_key("US", "M1", bad, 2024)


def test_years_in_range_is_utc_and_inclusive() -> None:
    assert rc.years_in_range(day("2023-03-28"), day("2026-09-06")) == [2023, 2024, 2025, 2026]
    assert rc.years_in_range(day("2024-06-01"), day("2024-06-02")) == [2024]


# ── 5. The source rule applies to the COLD tier too (A1) ────────────────────
#
# RT bars really do reach cold shards: `candle-evict-logic.ts` `buildEvictWhere`
# selects WINDOW-tier intraday rows below the hot floor with NO source clause and
# archives them to these keys. Gating only `hot_query` left the default flag
# reading quote-mid bars with a structural `volume: 0` off disk, at 100% shard
# hits — a backtest filling at prices nobody printed while every counter is green.


def cold_shard_with_one_rt_bar() -> str:
    key = rc.cold_key("US", "M1", "AAPL", 2024)
    rt = bar("2024-01-03T14:31:00.000Z", 101.0)
    rt["src"] = "TIINGO_RT"
    rt["v"] = 0  # the structural zero: "this feed cannot report volume"
    archive.write_shard(key, [bar("2024-01-03T14:30:00.000Z", 100.0), rt])
    return key


def test_cold_realtime_bars_are_excluded_by_default(bucket: FakeBucket) -> None:
    cold_shard_with_one_rt_bar()
    df, counts = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2024-01-01"),
        end=day("2024-12-31"),
    )
    assert df["source"].tolist() == ["TIINGO"]
    assert (df["volume"] > 0).all()
    # Excluded, not merely absent: a silent exclusion and an empty shard read the
    # same from the summary, which is the half of this finding that survives.
    assert counts["excluded"] == 1
    assert counts["rejected"] == 0  # an RT bar is a valid bar, refused by POLICY


def test_cold_realtime_bars_are_included_on_request(bucket: FakeBucket) -> None:
    cold_shard_with_one_rt_bar()
    df, counts = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2024-01-01"),
        end=day("2024-12-31"),
        include_rt=True,
    )
    assert sorted(df["source"].tolist()) == ["TIINGO", "TIINGO_RT"]
    assert counts["excluded"] == 0


# ── 6. Dropped and rejected rows are COUNTED, not silently discarded (A4) ───


def test_a_shard_with_malformed_lines_reports_them_as_dropped(bucket: FakeBucket) -> None:
    """`ShardParse.dropped` reaches the summary instead of being thrown away.

    Written as raw gz-JSONL rather than through `write_shard`, because the writer
    cannot produce a broken line — which is the point: this is what a truncated
    or partially-rewritten object looks like on the way back in. Without the
    counter, a shard that lost 40% of its lines reads exactly like a shard
    written with 60% of the rows.
    """
    body = "\n".join(
        [
            json.dumps(bar("2024-01-03T14:30:00.000Z", 100.0)),
            "{not json at all",  # invalid JSON  -> dropped
            "[1, 2, 3]",  # valid JSON, not a row -> dropped
        ]
    )
    bucket.objects[rc.cold_key("US", "M1", "AAPL", 2024)] = gzip.compress(body.encode())

    df, counts = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2024-01-01"),
        end=day("2024-12-31"),
    )
    assert len(df) == 1
    assert counts["dropped"] == 2
    assert counts["rejected"] == 0


def test_a_row_that_is_not_a_bar_is_counted_as_rejected_on_both_paths(
    bucket: FakeBucket,
) -> None:
    """A short-key rename empties the frame; only this counter shows it.

    Cold: a row whose close is not a number. Hot: the same, from Mongo. Both
    decode fine and neither is a bar, so both are `rejected` — a category the
    summary must not fold into `dropped` (a codec failure) or `excluded` (a
    policy refusal).
    """
    broken = bar("2024-01-03T14:30:00.000Z", 100.0)
    broken["c"] = "not-a-price"
    archive.write_shard(
        rc.cold_key("US", "M1", "AAPL", 2024),
        [bar("2024-01-03T14:29:00.000Z", 99.0), broken],
    )
    # Inside the trailing 45d hot window of `end`, or the query never returns it
    # and this half of the assertion would pass for the wrong reason.
    hot_broken = dict(
        hot_docs()[0], ts=datetime(2024, 12, 20, 14, 32, tzinfo=UTC), close=float("nan")
    )

    df, counts = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["AAPL"],
        start=day("2024-01-01"),
        end=day("2024-12-31"),
        hot=True,
        hot_collection=FakeCandles([hot_broken]),
    )
    assert len(df) == 1
    assert counts["rejected"] == 2  # one cold, one hot
    assert counts["dropped"] == 0


# ── 7. Two listings under one ticker both survive, and are announced (A6) ───


def test_two_listings_of_one_ticker_both_survive_the_merge(
    bucket: FakeBucket, capsys: pytest.CaptureFixture[str]
) -> None:
    """`DOW` is Dow Chemical to 2017 and Dow Inc. from 2019 — two securities.

    The two rows share a `ts` DELIBERATELY. That is artificial (the real seam is
    decades wide) and it is the only shape that can see the defect: with
    `listingId` out of the dedup key the two collide on
    (symbol, exchange, timeframe, ts) and cold-wins DELETES the other company's
    bar — silently, at full shard-hit health.
    """
    ts = "2026-09-05T14:30:00.000Z"
    old = bar(ts, 60.0, symbol="DOW")
    old["l"] = "DOW:NYSE:1972-01-03"
    old["x"] = "NYSE"
    archive.write_shard(rc.cold_key("US", "M1", "DOW", 2026), [old])

    new = dict(
        hot_docs()[0],
        symbol="DOW",
        exchange="NYSE",
        listingId="DOW:NYSE:2019-04-02",
        ts=datetime(2026, 9, 5, 14, 30, tzinfo=UTC),
        close=55.0,
    )

    df, counts = rc.read_candles(
        market="US",
        timeframe="M1",
        symbols=["DOW"],
        start=day("2026-08-01"),
        end=day("2026-09-06"),
        hot=True,
        hot_collection=FakeCandles([new]),
    )

    assert len(df) == 2
    assert sorted(df["listingId"].tolist()) == ["DOW:NYSE:1972-01-03", "DOW:NYSE:2019-04-02"]
    assert counts["multiListing"] == 1
    assert "more than one listing" in capsys.readouterr().err


# ── 8. `--to` is END-INCLUSIVE for the whole day (A3) ───────────────────────


def test_to_returns_intraday_bars_on_the_final_day(
    bucket: FakeBucket, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Driven through `main()`, because the convention lives in the CLI parser.

    `--to 2026-09-06` used to parse to midnight and the filter is `<= end`, so a
    session's 09:30-16:00 bars were all dropped and the day rendered as "the
    vendor has not published yet" — the module's own usage example does exactly
    this. Asserting `_day_end` alone would not prove `--to` is wired to it.
    """
    archive.write_shard(
        rc.cold_key("US", "M1", "AAPL", 2026),
        [
            bar("2026-09-06T00:00:00.000Z", 100.0),
            bar("2026-09-06T13:30:00.000Z", 101.0),
            bar("2026-09-06T19:59:00.000Z", 102.0),
        ],
    )
    out = tmp_path / "out.parquet"
    assert (
        rc.main(
            ["--symbols", "AAPL", "--from", "2026-09-01", "--to", "2026-09-06", "--out", str(out)]
        )
        == 0
    )
    assert "rows=3" in capsys.readouterr().out
    assert len(rc.pd.read_parquet(out)) == 3


def test_a_to_carrying_a_time_is_an_instant_and_is_not_widened() -> None:
    """A bare date is a DAY; a timestamp is an instant. Widening it would make
    `--to 2026-09-06T15:30:00` quietly return the next four and a half hours."""
    assert rc._day_end("2026-09-06") == datetime(2026, 9, 6, 23, 59, 59, 999999, tzinfo=UTC)
    assert rc._day_end("2026-09-06T15:30:00") == datetime(2026, 9, 6, 15, 30, tzinfo=UTC)
    assert rc._day("2026-09-06") == datetime(2026, 9, 6, tzinfo=UTC)  # `--from` unchanged


# ── 9. `--release` is a DROP-IN for the cold path (MONEY-1518) ──────────────
#
# The ticket's proof: "read_candles.py's CLI produces the SAME parquet as before
# on the fixture release — byte-compare the row set, not a row count". So ONE
# input is written twice — as a release (`bars_d1` is B4's 64 rows through B4's
# SQL) and as the cold shards those rows would have been — and the two CLI runs
# are compared value for value, schema included. A consumer of `--out` must not
# be able to tell which reader ran.

SYMBOLS = "CLEAN,DIVO,SPLT,BOTH,DOW"
ARGS = ["--market", "US", "--symbols", SYMBOLS, "--from", "2017-01-01", "--to", "2020-12-31"]
EVERYTHING = ("2017-01-01", "2020-12-31")


@pytest.fixture
def release(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = build_release(tmp_path / "cache")
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("LAKE_ENV", "qa")
    return root


def _cli(tmp_path: Path, name: str, *argv: str) -> Any:
    out = tmp_path / f"{name}.parquet"
    assert rc.main([*argv, "--out", str(out)]) == 0
    return pq.read_table(out)


@pytest.mark.parametrize(
    ("timeframe", "window", "rows"),
    [
        ("D1", EVERYTHING, 64),
        ("M1", EVERYTHING, 7),
        # ONE UTC day. It holds the 9th's two bars AND the 8th's post-market bar,
        # which is on the 9th in UTC while its session is the 8th — the case a
        # read that selects on `session_date` alone gets wrong in both directions.
        ("M1", ("2020-01-09", "2020-01-09"), 3),
        ("M1", ("2020-01-08", "2020-01-08"), 2),
    ],
)
def test_release_output_is_IDENTICAL_to_the_cold_path(
    bucket: FakeBucket,
    release: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    timeframe: str,
    window: tuple[str, str],
    rows: int,
) -> None:
    for (symbol, year), shard in cold_shard_rows(timeframe).items():
        archive.write_shard(rc.cold_key("US", timeframe, symbol, year), shard)
    argv = ["--market", "US", "--symbols", SYMBOLS, "--from", window[0], "--to", window[1]]

    cold = _cli(tmp_path, "cold", "--timeframe", timeframe, *argv)
    rel = _cli(tmp_path, "rel", "--timeframe", timeframe, *argv, "--release", RELEASE_ID)
    assert "mode=release(" in capsys.readouterr().out

    # Not a row count: every value of every column, and every column's TYPE.
    assert cold.num_rows == rows, "the cold path read nothing — the comparison proves nothing"
    assert rel.schema.remove_metadata() == cold.schema.remove_metadata()
    key = [("symbol", "ascending"), ("listingId", "ascending"), ("ts", "ascending")]
    assert rel.sort_by(key).equals(cold.sort_by(key))


def test_a_NULL_volume_or_factor_reads_as_the_cold_path_reads_it(
    bucket: FakeBucket, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Silver's volume and factor columns are nullable. The cold path turns a
    missing volume and cash into 0.0 and a missing split into 1.0; the release
    path must write the same row, or `--out` depends on which reader ran."""

    def doctor(d1: list[dict[str, Any]]) -> None:
        d1[0].update(volume=None, div_cash=None, split_factor=None)

    build_release(tmp_path / "cache", edit_d1=doctor)
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("LAKE_ENV", "qa")
    for (symbol, year), shard in cold_shard_rows("D1", edit=doctor).items():
        archive.write_shard(rc.cold_key("US", "D1", symbol, year), shard)

    cold = _cli(tmp_path, "cold", "--timeframe", "D1", *ARGS)
    rel = _cli(tmp_path, "rel", "--timeframe", "D1", *ARGS, "--release", RELEASE_ID)
    key = [("symbol", "ascending"), ("listingId", "ascending"), ("ts", "ascending")]
    assert cold.num_rows == rel.num_rows == 64
    assert rel.sort_by(key).equals(cold.sort_by(key))


def test_adjusted_via_release_writes_the_SQLs_numbers(release: Path, tmp_path: Path) -> None:
    """`--adjusted` appends the five columns the deleted port wrote, in its order,
    holding what B4's SQL computed — selected, never re-derived."""
    table = _cli(tmp_path, "adj", "--timeframe", "D1", *ARGS, "--adjusted", "--release", RELEASE_ID)
    df = table.to_pandas()
    assert list(df.columns) == [
        *rc.COLUMNS,
        "adjOpen",
        "adjHigh",
        "adjLow",
        "adjClose",
        "adjVolume",
    ]
    assert len(df) == 64
    gold = {(r["listing_id"], r["session_date"]): r for r in gold_rows()}
    for _, row in df.iterrows():
        g = gold[(row["listingId"], row["ts"].date().isoformat())]
        for mine, theirs in (
            ("adjClose", "adj_close"),
            ("adjOpen", "adj_open"),
            ("adjVolume", "adj_volume"),
        ):
            assert row[mine] == g[theirs], (row["listingId"], row["ts"], mine)


@pytest.mark.parametrize("flag", [["--hot"], ["--include-rt"], ["--workers", "4"]])
def test_a_flag_a_release_cannot_honour_is_refused_BY_NAME(
    release: Path, tmp_path: Path, flag: list[str]
) -> None:
    """Ignored, `--include-rt` would return no RT bars and report nothing wrong;
    `--hot` would silently drop the last 45 days of a Mongo window."""
    with pytest.raises(ValueError, match=f"{flag[0]} cannot be honoured by --release"):
        rc.main(
            [
                "--timeframe",
                "D1",
                *ARGS,
                "--release",
                RELEASE_ID,
                *flag,
                "--out",
                str(tmp_path / "x.parquet"),
            ]
        )


def test_a_null_price_in_a_release_is_rejected_and_COUNTED(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """The cold path's rule on the release path: a NULL close is not a bar.
    Silver's NUMERIC columns are nullable, so this is a reachable state."""

    def doctor(d1: list[dict[str, Any]]) -> None:
        d1[0]["close"] = None

    build_release(tmp_path / "cache", edit_d1=doctor)
    monkeypatch.setenv("LAKE_RELEASE_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("LAKE_ENV", "qa")
    table = _cli(tmp_path, "rel", "--timeframe", "D1", *ARGS, "--release", RELEASE_ID)
    assert table.num_rows == 63
    assert "rejected=1" in capsys.readouterr().out
