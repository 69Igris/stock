#!/usr/bin/env python3
"""Bulk cold-shard reader for backtests — MONEY-1384 B0.

    python scripts/quant/read_candles.py --market US --timeframe M1 \
        --symbols AAPL,MSFT --from 2023-03-28 --to 2026-09-06 --out out.parquet

## Why this exists instead of `CandleRepository`

`packages/core/src/market-data/candles/candle-repository.ts` is a SERVING-tier
API: one GCS GET per symbol-year, a full gunzip plus line-by-line `JSON.parse`,
and its cached path writes every decoded shard into Redis TWICE with no size
guard. 507 symbols x 4 years of M1 is ~2,028 GETs, ~16 GB gzipped and ~72 GB of
JSON parsed on one thread — through a cache that would try to hold all of it. A
backtest must not go through it, and this is not a tuning problem: the two have
different jobs. That one answers "draw this chart"; this one answers "hand me
the whole universe once".

## What is reused rather than re-spelled

The shard CODEC is `services/us-fundamentals/app/sec/archive_logic.py` — the
same gz-JSONL idiom, the same magic-byte sniff. The GCS read is
`app/sec/archive.read_bytes`, which already draws the line this reader depends
on most: a 404 answers `None`, and every other failure RAISES. Conflating those
two is how a transport error becomes "that symbol-year was never archived",
which is a backtest quietly run on a subset of its universe.

Two implementations of one codec is how the bytes drift apart, so there is one.

## THE PYTHON CRSP PORT IS GONE — MONEY-1518 (B7)

This file used to re-implement `computeAdjustedSeries`
(`packages/core/src/market-data/tiingo/tiingo-logic.ts:394`) in Python, and
its own header named the risk: "ports drift". It is DELETED, not bypassed.
There were three implementations of one policy; there are now two, and
`packages/core/__tests__/market-data/adjustment-sql-parity.test.ts` EXECUTES
the SQL one and proves it equal to the TypeScript over a 64-row fixture
(worst relative disagreement 2.8e-16, worst adjusted-volume difference 0).

`--adjusted` therefore needs `--release`, and REFUSES without one:

    python scripts/quant/read_candles.py --market US --timeframe M1 \
        --symbols AAPL,MSFT --from 2023-03-28 --to 2026-09-06 \
        --adjusted --release 2026-09-22T00-00-00Z --out out.parquet

The release's `bars_d1` carries `price_factor` and `split_factor_cum` from
`gold.adjusted_bar_d1`, so `lake.py` adjusts any timeframe by joining the
session date. Refusal rather than a silent raw frame: a frame labelled
adjusted and holding raw prices is wrong by a multiple, renders perfectly, and
nothing downstream can detect it.

`--release` is a DROP-IN: the parquet it writes has this file's columns,
dtypes, row rules and `--from`/`--to` semantics, byte-compared against the cold
path on one fixture by `test_read_candles.py`. `--hot`, `--include-rt` and
`--workers` describe the cold walk and are REFUSED with `--release` by name.

The RAW cold-shard path below is still the right reader for "hand me the whole
universe once" until a release exists — and none can yet: a cut needs
`gold.adjusted_bar_d1` (Dataform has never run on prod) and a loaded
`trade_bar_m1` (0 rows). It is also the only reader of the Mongo hot window and
of TIINGO_RT bars, which no release will ever hold. Delete it when a release
covers its callers, not before.

## THE FRAME IS PER LISTING. Group on `listingId`, never on `symbol`

The adjustment resolving per listing is not the same as the FRAME holding one:
both occupants of a recycled ticker are returned, under one `symbol`, which is
correct — a bulk read must not silently drop a company. So `listingId` is in the
merge dedup key, and a symbol resolving to more than one listing in the range is
COUNTED (`multiListing`) and warned about on stderr. A consumer doing
`df[df.symbol == "DOW"].sort_values("ts")` still gets two companies as one
series; nothing downstream can detect that, so it is stated here.
"""

from __future__ import annotations

import argparse
import io
import math
import os
import resource
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from datetime import time as time_of_day
from pathlib import Path
from typing import Any, NamedTuple

import numpy as np
import pandas as pd

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "services" / "us-fundamentals"))

from app.sec import archive  # noqa: E402
from app.sec.archive_logic import decode_shard, sniff_shard_format  # noqa: E402

#: `candle-logic.ts:389` INTRADAY_HOT_WINDOW_DAYS. The hot tier holds only this
#: much intraday history, so it is also how far back `--hot` can usefully look.
INTRADAY_HOT_WINDOW_DAYS = 45

#: Backtest-safe sources. TIINGO_RT is EXCLUDED and `--include-rt` is the only
#: way in: those bars are built from the quote MID and carry `volume: 0`, which
#: means "this feed cannot report volume" and never "nothing traded". A backtest
#: sizing against them fills at prices nobody printed, in size nobody offered.
BACKTEST_SOURCES = ("DATABENTO", "TIINGO")
REALTIME_SOURCE = "TIINGO_RT"


def allowed_sources(*, include_rt: bool) -> list[str]:
    """The one source rule, read by BOTH tiers.

    It has to be both. RT bars genuinely reach cold shards:
    `workers/src/processors/candle-evict-logic.ts` `buildEvictWhere` selects
    `{tier:"WINDOW", timeframe: INTRADAY, ts < intradayHotFloorTs}` with NO source
    clause and archives the result to the very keys `cold_key` builds. The RT
    socket subscribes up to 3,000 symbols against a ~507-symbol Databento
    manifest, so every subscribed symbol OUTSIDE it accumulates quote-mid bars
    that are archived 45 days later and never displaced. Gating only the hot
    query would leave the default flag reading them anyway, and reporting 100%
    shard hits while it did.
    """
    return [*BACKTEST_SOURCES, REALTIME_SOURCE] if include_rt else list(BACKTEST_SOURCES)


#: `@@map("candles")` on the Prisma `Candle` model.
HOT_COLLECTION = "candles"

COLUMNS = (
    "symbol",
    "exchange",
    "timeframe",
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "source",
    "listingId",
    "divCash",
    "splitFactor",
)

#: Cold JSONL uses short keys (`candle-logic.ts:796` ColdShardRow). A parquet
#: shard may use either spelling, so both resolve through one table.
_ALIASES = {
    "s": "symbol",
    "x": "exchange",
    "tf": "timeframe",
    "t": "ts",
    "l": "listingId",
    "o": "open",
    "h": "high",
    "lo": "low",
    "c": "close",
    "v": "volume",
    "d": "divCash",
    "sf": "splitFactor",
    "src": "source",
}


class ShardFetchError(RuntimeError):
    """At least one shard failed to READ. Never confused with "not archived"."""


# ── Keys ────────────────────────────────────────────────────────────────────


def cold_key(market: str, timeframe: str, symbol: str, year: int) -> str:
    """`candles/{market}/{timeframe}/{symbol}/{year}` — NO extension.

    Mirrors `buildCandleColdKey` (`candle-logic.ts:223`), including the two
    things about it that look like mistakes: the exchange is absent (a shard
    follows the SECURITY across an uplisting; every row carries its own exchange
    and listingId), and so is any file suffix (the format is sniffed from the
    bytes, so a parquet producer can publish to these same keys).
    """
    for field, value in (("market", market), ("timeframe", timeframe), ("symbol", symbol)):
        if (
            not isinstance(value, str)
            or value == ""
            or any(ch == "/" or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in value)
        ):
            raise ValueError(f"cold_key: {field} {value!r} is empty or reshapes the key")
    return f"candles/{market}/{timeframe}/{symbol}/{int(year)}"


def years_in_range(start: datetime, end: datetime) -> list[int]:
    """UTC years a `[start, end]` range touches. `coldYearsForRange`, ported.

    UTC and not local: `Candle.ts` is a UTC instant, and a boundary computed in
    another zone files December 31st in two shards.
    """
    return list(range(start.astimezone(UTC).year, end.astimezone(UTC).year + 1))


# ── Decode ──────────────────────────────────────────────────────────────────


def _finite(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def normalize_row(raw: dict[str, Any]) -> dict[str, Any] | None:
    """One stored row -> one frame row, or `None` if it is not a bar.

    Ports `parseColdShard`'s per-row validation (`candle-logic.ts:845`), which is
    tolerant per line and strict about nothing else: a NaN price is not a bar, it
    is the poison this codebase has chased through five subsystems, and one bad
    line must not cost a whole symbol-year.
    """
    row = {_ALIASES.get(k, k): v for k, v in raw.items()}

    ts = row.get("ts")
    if isinstance(ts, str):
        ts = pd.to_datetime(ts, utc=True, errors="coerce")
    elif isinstance(ts, datetime):
        ts = (
            pd.Timestamp(ts).tz_localize(UTC)
            if ts.tzinfo is None
            else pd.Timestamp(ts).tz_convert(UTC)
        )
    else:
        ts = pd.to_datetime(ts, utc=True, errors="coerce")
    if ts is None or pd.isna(ts):
        return None

    prices = {k: _finite(row.get(k)) for k in ("open", "high", "low", "close")}
    if any(v is None for v in prices.values()):
        return None
    if not all(isinstance(row.get(k), str) for k in ("symbol", "exchange", "timeframe")):
        return None

    split = _finite(row.get("splitFactor"))
    return {
        "symbol": row["symbol"],
        "exchange": row["exchange"],
        "timeframe": row["timeframe"],
        "ts": ts,
        **prices,
        "volume": _finite(row.get("volume")) or 0.0,
        # A zero or negative split factor divides by zero in the adjustment.
        "splitFactor": split if split is not None and split > 0 else 1.0,
        "divCash": _finite(row.get("divCash")) or 0.0,
        "listingId": row["listingId"] if isinstance(row.get("listingId"), str) else "",
        "source": row["source"] if isinstance(row.get("source"), str) else "TIINGO",
    }


class ShardRows(NamedTuple):
    """Rows kept, and every reason a stored line is not one of them.

    Three counters rather than one, because they mean three different things and
    only the first is a defect: `dropped` is a line the CODEC could not decode
    (`ShardParse.dropped`, which `archive_logic.py` returns precisely so a shard
    that lost 40% of its lines cannot read as a shard written with 60%),
    `rejected` is a line that decoded but is not a bar (NaN price, missing
    symbol — or a short-key rename, which would otherwise print a perfect health
    line over an empty frame), and `excluded` is a real bar from a source this
    run refuses. Folding them together makes a rename look like a policy.
    """

    rows: list[dict[str, Any]]
    dropped: int
    rejected: int
    excluded: int


def decode_shard_bytes(body: bytes, *, include_rt: bool = False) -> ShardRows:
    """Stored bytes -> rows. Format from MAGIC BYTES, never from the key."""
    if sniff_shard_format(body) == "PARQUET":  # raises on anything that is neither
        import pyarrow.parquet as pq

        # pyarrow reads the whole file or raises; there is no per-line drop.
        raw, dropped = pq.read_table(io.BytesIO(body)).to_pylist(), 0
    else:
        # The service's own decoder, not a second gunzip: a TRUNCATED member
        # raises ShardCorruptError there rather than reading as an empty year,
        # and unreadable must never look like absent.
        parsed = decode_shard(body)
        raw, dropped = parsed.rows, parsed.dropped

    keep = allowed_sources(include_rt=include_rt)
    rows: list[dict[str, Any]] = []
    rejected = excluded = 0
    for candidate in raw:
        row = normalize_row(candidate)
        if row is None:
            rejected += 1
        elif row["source"] not in keep:
            excluded += 1
        else:
            rows.append(row)
    return ShardRows(rows, dropped, rejected, excluded)


# ── Fetch ───────────────────────────────────────────────────────────────────


def fetch_cold(
    keys: list[str], *, workers: int = 16, include_rt: bool = False
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Read every key concurrently. Returns `(rows, counts)`.

    A MISSING key is a normal answer — that symbol-year was never archived — and
    is counted. A transport error is NOT: it is collected, counted separately,
    and RAISED once the pool drains. Folding the two together is the failure this
    repo keeps rediscovering, where a permission blip renders as a thin universe
    and every count downstream looks merely small.

    ponytail: the shared client's HTTPS pool defaults to 10 connections, so
    `--workers` above that queues on TLS rather than failing. Widen the session
    adapter if a measurement ever shows it binding.
    """
    rows: list[dict[str, Any]] = []
    hit = missed = dropped = rejected = excluded = 0
    errors: list[tuple[str, BaseException]] = []

    def one(key: str) -> bytes | None:
        return archive.read_bytes(key)

    # Decoded AS RESULTS ARRIVE, a bounded batch at a time. `map` over the whole
    # key list submits every task at once, so all ~2,028 shard BODIES (~16 GB
    # gzipped for a 507-symbol M1 universe) would be held in memory before the
    # first one was parsed — an OOM dressed up as concurrency. The window is
    # small enough that peak RSS is a few hundred MB and wide enough that the
    # pool never starves.
    window = max(1, workers) * 4
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for start in range(0, len(keys), window):
            batch = keys[start : start + window]
            for body in pool.map(_safe(one, errors), batch):
                if body is _FAILED:
                    continue
                if body is None:
                    missed += 1
                    continue
                hit += 1
                parsed = decode_shard_bytes(body, include_rt=include_rt)
                rows.extend(parsed.rows)
                dropped += parsed.dropped
                rejected += parsed.rejected
                excluded += parsed.excluded

    if errors:
        key, err = errors[0]
        raise ShardFetchError(
            f"{len(errors)} of {len(keys)} shards failed to read "
            f"(hit={hit} missed={missed}); first: {key}: {type(err).__name__}: {err}"
        ) from err
    return rows, {
        "shards": len(keys),
        "hit": hit,
        "missed": missed,
        "dropped": dropped,
        "rejected": rejected,
        "excluded": excluded,
    }


_FAILED = object()


def _safe(fn: Any, errors: list[tuple[str, BaseException]]) -> Any:
    """Record a failure and keep the pool draining — then `fetch_cold` raises.

    Deliberately NOT a catch-all that returns "absent": the error is preserved
    and re-raised. Swallowing it here is the mutation the test suite checks for.
    """

    def wrapped(key: str) -> Any:
        try:
            return fn(key)
        except BaseException as exc:  # re-raised by fetch_cold, never swallowed
            errors.append((key, exc))
            return _FAILED

    return wrapped


def hot_query(
    symbols: list[str], timeframe: str, floor_ts: datetime, end_ts: datetime, *, include_rt: bool
) -> dict[str, Any]:
    """The Mongo filter for the hot window. This tier's half of the source gate.

    Server-side rather than in a pandas filter afterwards, so the RT rows are
    never transferred at all — which also means there is nothing to COUNT as
    excluded here, unlike the cold tier where the bytes arrive regardless.
    """
    return {
        "symbol": {"$in": symbols},
        "timeframe": timeframe,
        "ts": {"$gte": floor_ts, "$lte": end_ts},
        "source": {"$in": allowed_sources(include_rt=include_rt)},
    }


def fetch_hot(
    symbols: list[str],
    timeframe: str,
    end_ts: datetime,
    *,
    include_rt: bool = False,
    collection: Any | None = None,
    days: int = INTRADAY_HOT_WINDOW_DAYS,
) -> tuple[list[dict[str, Any]], int]:
    """The trailing hot window from Mongo. Returns `(rows, rejected)`.

    `rejected` for the same reason the cold tier counts it: a row the query
    returned and `normalize_row` refused is invisible otherwise, so a field
    rename empties the frame while the run reports perfect health.
    """
    if collection is None:
        from pymongo import MongoClient

        url = os.environ.get("DATABASE_URL")
        if not url:
            raise RuntimeError("--hot needs DATABASE_URL")
        collection = MongoClient(url).get_database()[HOT_COLLECTION]

    floor_ts = end_ts - timedelta(days=days)
    query = hot_query(symbols, timeframe, floor_ts, end_ts, include_rt=include_rt)
    rows: list[dict[str, Any]] = []
    rejected = 0
    for raw in collection.find(query, {"_id": 0}):
        row = normalize_row(dict(raw))
        if row is None:
            rejected += 1
        else:
            rows.append(row)
    return rows, rejected


# ── Adjustment: NOT HERE ────────────────────────────────────────────────────
#
# `adjust_series` and `add_adjusted` lived here and were a hand port of
# `computeAdjustedSeries`. MONEY-1518 deleted them. The policy has two
# implementations left — the TypeScript and `dataform/includes/adjustment.js` —
# and a test executes the SQL against the TypeScript rather than trusting a
# commit message that they agree. A third copy in a third language, verified by
# nothing that runs the other two, is the drift this deletion ends.
#
# `_from_release` below reads what that SQL already computed.


#: The release's spelling of the adjusted columns -> this CLI's historical one.
ADJUSTED_COLUMNS = {
    "adj_open": "adjOpen",
    "adj_high": "adjHigh",
    "adj_low": "adjLow",
    "adj_close": "adjClose",
    "adj_volume": "adjVolume",
}


def _from_release(
    *,
    market: str,
    timeframe: str,
    symbols: list[str],
    start: datetime,
    end: datetime,
    adjusted: bool,
    release: str,
) -> tuple[pd.DataFrame, dict[str, int]]:
    """Delegate the read to `lake.py`, then hand back THE COLD PATH'S FRAME.

    Same columns in the same order, same dtypes, same row normalisation, same
    instant filter — so a consumer of `--out` cannot tell which reader ran, and
    `test_read_candles.py` byte-compares the two on one fixture. `--adjusted`
    appends the five `adj*` columns in the order the deleted port did.

    `lake.bars` selects on the venue's `session_date`; a US post-market bar
    sits on the NEXT UTC date. So the window is widened a day each side and the
    cold path's own `[start, end]` filter is applied to `ts` afterwards.

    The shard counters are ABSENT rather than zero — `shards`, `hit`, `missed`,
    `dropped` describe a cold-shard walk this path does not do, and reporting
    `hit=0` would read as "every shard was missing" on a perfectly complete
    release. `rejected` is kept: it means here what it means there.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import lake  # local to this branch: the cold path does not need it

    frame = lake.bars(
        symbols,
        timeframe,
        (start - timedelta(days=1)).date(),
        (end + timedelta(days=1)).date(),
        release=release,
        adjusted=adjusted,
        market=market,
    )
    df, rejected = _cold_shaped(frame, timeframe.upper(), adjusted=adjusted)
    if not df.empty:
        df = df[(df["ts"] >= pd.Timestamp(start)) & (df["ts"] <= pd.Timestamp(end))]
        df = df.sort_values(["symbol", "exchange", "timeframe", "ts", "listingId"])
        df = df.reset_index(drop=True)
    return df, {"rows": len(df), "rejected": rejected, "multiListing": _multi_listing(df)}


def _cold_shaped(
    frame: pd.DataFrame, timeframe: str, *, adjusted: bool
) -> tuple[pd.DataFrame, int]:
    """A release frame in `to_frame`'s shape, under `normalize_row`'s rules.

    Vectorised rather than routed through `normalize_row` a row at a time — an
    M1 universe is tens of millions of rows — so the rules are restated here
    and the drop-in test holds the two readers to one answer:

      * a non-finite price is not a bar: the row is REJECTED and counted;
      * volume and divCash that are not finite read 0.0;
      * a split factor that is not finite and > 0 reads 1.0 (it divides);
      * `ts` is the bar's UTC instant — a D1 bar's is its session date at
        00:00Z, which is how the cold shards store it.
    """
    extra = list(ADJUSTED_COLUMNS.values()) if adjusted else []
    if frame.empty:
        empty = to_frame([])
        return empty.assign(**{c: pd.Series(dtype="float64") for c in extra}), 0

    def number(column: str, default: float) -> pd.Series:
        if column not in frame.columns:
            return pd.Series(default, index=frame.index, dtype="float64")
        values = frame[column].astype("float64")
        return values.where(np.isfinite(values), default)

    prices = frame[["open", "high", "low", "close"]].astype("float64")
    split = number("split_factor", 1.0)
    if "ts" in frame.columns:
        ts = pd.to_datetime(frame["ts"], utc=True)
    else:
        ts = pd.to_datetime(frame["session_date"].astype(str) + "T00:00:00.000Z", utc=True)
    out = pd.DataFrame(
        {
            "symbol": frame["symbol"],
            "exchange": frame["exchange"],
            "timeframe": timeframe,
            "ts": ts,
            **{c: prices[c] for c in ("open", "high", "low", "close")},
            "volume": number("volume", 0.0),
            "source": frame["source"],
            "listingId": frame["listing_id"],
            "divCash": number("div_cash", 0.0),
            "splitFactor": split.where(split > 0, 1.0),
            **{
                cold: frame[rel].astype("float64")
                for rel, cold in ADJUSTED_COLUMNS.items()
                if adjusted
            },
        },
        columns=[*COLUMNS, *extra],
    )
    out["timeframe"] = out["timeframe"].astype(out["symbol"].dtype)
    keep = np.isfinite(prices).all(axis=1)
    return out[keep], int((~keep).sum())


def _multi_listing(df: pd.DataFrame) -> int:
    """Symbols resolving to more than one listing — COUNTED, and named on stderr.

    A recycled ticker survives as TWO listings under ONE symbol — which is the
    frame behaving correctly, and is also exactly what a consumer doing
    `df[df.symbol == "DOW"].sort_values("ts")` turns into one continuous series
    spanning two companies. The adjustment already groups per listing; nothing
    else can, so the ambiguity is named here rather than left to be discovered.
    """
    if df.empty:
        return 0
    per_symbol = df.groupby("symbol")["listingId"].nunique()
    multi = per_symbol[per_symbol > 1]
    if len(multi):
        print(
            f"WARNING: {len(multi)} symbol(s) resolve to more than one listing in this "
            f"range ({', '.join(sorted(multi.index)[:10])}) — group on listingId, "
            "never on symbol.",
            file=sys.stderr,
        )
    return len(multi)


# ── Assembly ────────────────────────────────────────────────────────────────


def to_frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=list(COLUMNS))
    if df.empty:
        df["ts"] = pd.to_datetime(df["ts"], utc=True)
        return df
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


def merge_hot_and_cold(cold: pd.DataFrame, hot: pd.DataFrame) -> pd.DataFrame:
    """Cold WINS on a collision.

    Both tiers hold the same bar during the overlap, and the cold shard is the
    archived, already-reconciled copy. Preferring it keeps a re-run of the same
    range reproducible, which is the property a backtest is bought for.

    `listingId` is IN the key. A ticker is not a security — `DOW` is Dow Chemical
    to 2017 and Dow Inc. from 2019 — so without it two occupants of one ticker
    collide on (symbol, exchange, timeframe, ts) and one company's bar silently
    deletes the other's. The cost of including it is that a row stored WITHOUT a
    listingId (normalised to `""`) no longer dedups against the same bar stored
    with one; that is a visible duplicate rather than a silent deletion, which is
    the right way round.
    """
    if hot.empty:
        return cold
    key = ["symbol", "exchange", "timeframe", "listingId", "ts"]
    both = pd.concat([cold, hot], ignore_index=True)
    return both.drop_duplicates(subset=key, keep="first").reset_index(drop=True)


def read_candles(
    *,
    market: str,
    timeframe: str,
    symbols: list[str],
    start: datetime,
    end: datetime,
    hot: bool = False,
    include_rt: bool = False,
    adjusted: bool = False,
    release: str | None = None,
    workers: int | None = None,
    hot_collection: Any | None = None,
) -> tuple[pd.DataFrame, dict[str, int]]:
    """One frame per LISTING, not per symbol. Group on `listingId`.

    `end` is used AS GIVEN and the range is inclusive at both ends, so a caller
    passing midnight gets midnight. The CLI's `--to` therefore parses a bare date
    to that day's LAST instant (`_day_end`) — a `--to` of midnight would drop
    every intraday bar of the final session and read as "not published yet".

    `release` routes the WHOLE read through `lake.py` — the release already
    holds the adjustment, so the cold-shard path below is not walked at all.
    `hot`, `include_rt` and `workers` describe that walk, and a release can
    honour none of them: it holds no Mongo hot window, no TIINGO_RT bars and no
    shard pool. Asking for one with a release is REFUSED by name — ignored, a
    `--include-rt` run would return no RT bars and report nothing wrong.
    """
    if release is not None:
        refused = [
            flag
            for flag, asked in (
                ("--hot", hot),
                ("--include-rt", include_rt),
                ("--workers", workers is not None),
            )
            if asked
        ]
        if refused:
            raise ValueError(
                f"{', '.join(refused)} cannot be honoured by --release: a release holds no "
                "Mongo hot window, no TIINGO_RT bars and no shard pool. Drop the flag, or "
                "drop --release to read the cold shards."
            )
        return _from_release(
            market=market,
            timeframe=timeframe,
            symbols=symbols,
            start=start,
            end=end,
            adjusted=adjusted,
            release=release,
        )
    if adjusted:
        # REFUSAL, not a silent raw frame. MONEY-1518 deleted this file's CRSP
        # port rather than leaving a third implementation of one policy; the
        # factors live in a release. A frame labelled adjusted and holding raw
        # prices is wrong by a multiple and renders perfectly.
        raise ValueError(
            "--adjusted needs --release: the Python CRSP port was deleted (MONEY-1518). "
            "Cut a release with scripts/jobs/lake-release.ts, or drop --adjusted for raw bars."
        )
    keys = [
        cold_key(market, timeframe, symbol, year)
        for symbol in symbols
        for year in years_in_range(start, end)
    ]
    rows, counts = fetch_cold(
        keys, workers=16 if workers is None else workers, include_rt=include_rt
    )
    df = to_frame(rows)

    if hot:
        hot_rows, hot_rejected = fetch_hot(
            symbols, timeframe, end, include_rt=include_rt, collection=hot_collection
        )
        counts["rejected"] += hot_rejected
        df = merge_hot_and_cold(df, to_frame(hot_rows))

    if not df.empty:
        df = df[(df["ts"] >= pd.Timestamp(start)) & (df["ts"] <= pd.Timestamp(end))]
        df = df.sort_values(["symbol", "exchange", "timeframe", "ts"]).reset_index(drop=True)

    counts["multiListing"] = _multi_listing(df)
    return df, counts


# ── CLI ─────────────────────────────────────────────────────────────────────


def _peak_rss_mb() -> float:
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # ru_maxrss is BYTES on macOS and KILOBYTES on Linux.
    return raw / (1024 * 1024) if sys.platform == "darwin" else raw / 1024


def _day(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=UTC)


def _day_end(value: str) -> datetime:
    """`--to`, END-INCLUSIVE: a bare date covers its WHOLE day.

    Midnight is the wrong end of the final day. The range filter is `<= end`, so
    `--to 2026-09-06` at midnight returned exactly the 00:00 bar and dropped
    every other minute of that session — and a missing last session reads as "the
    vendor has not published yet", which is the one explanation that stops you
    looking. `time.max` is 23:59:59.999999; stored timestamps come from
    millisecond ISO strings and millisecond Mongo dates, so there is nothing
    between it and midnight.

    A value that carries a TIME is used verbatim — `--to 2026-09-06T15:30:00` is
    an instant, not a day, and must not be silently widened to 16 hours.
    """
    try:
        return datetime.combine(date.fromisoformat(value), time_of_day.max, tzinfo=UTC)
    except ValueError:  # not a bare date — a full timestamp, or genuinely invalid
        return _day(value)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--market", default="US")
    p.add_argument("--timeframe", default="M1")
    p.add_argument("--symbols", help="comma-separated")
    p.add_argument("--symbols-file", help="one symbol per line")
    p.add_argument("--from", dest="start", required=True, type=_day, help="inclusive, from 00:00Z")
    p.add_argument(
        "--to",
        dest="end",
        required=True,
        type=_day_end,
        help="INCLUSIVE of the whole day: a bare date covers to 23:59:59.999999Z, "
        "so intraday bars on this day are returned. Pass a full timestamp for an instant.",
    )
    p.add_argument("--out", required=True)
    p.add_argument(
        "--hot",
        action="store_true",
        help=f"also read the trailing {INTRADAY_HOT_WINDOW_DAYS}d from Mongo",
    )
    p.add_argument(
        "--include-rt",
        action="store_true",
        help="include TIINGO_RT bars (quote-mid, volume 0 — backtest-UNSAFE)",
    )
    p.add_argument(
        "--adjusted",
        action="store_true",
        help="REQUIRES --release: the Python CRSP port was deleted (MONEY-1518)",
    )
    p.add_argument(
        "--release",
        help="read a lake RELEASE (e.g. 2026-09-22T00-00-00Z) instead of the cold shards. "
        "Needs LAKE_ENV. The release carries the adjustment, so --adjusted works.",
    )
    p.add_argument(
        "--workers",
        type=int,
        help="cold-shard fetch concurrency (default 16). Refused with --release.",
    )
    args = p.parse_args(argv)

    if args.symbols_file:
        symbols = [s.strip() for s in Path(args.symbols_file).read_text().splitlines() if s.strip()]
    elif args.symbols:
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    else:
        p.error("one of --symbols or --symbols-file is required")

    started = time.monotonic()
    df, counts = read_candles(
        market=args.market,
        timeframe=args.timeframe,
        symbols=symbols,
        start=args.start,
        end=args.end,
        hot=args.hot,
        include_rt=args.include_rt,
        adjusted=args.adjusted,
        release=args.release,
        workers=args.workers,
    )
    df.to_parquet(args.out, index=False)

    span = f"{df['ts'].min()} .. {df['ts'].max()}" if not df.empty else "empty"
    # The shard counters are ABSENT on the release path, never zero: `hit=0`
    # over a complete release would read as "every shard was missing".
    shard_line = (
        f"shards={counts['hit']}/{counts['shards']} hit missed={counts['missed']} "
        f"dropped={counts['dropped']} rejected={counts['rejected']} "
        f"excludedSource={counts['excluded']} "
        if "shards" in counts
        else f"mode=release({args.release}) rejected={counts['rejected']} "
    )
    print(
        f"rows={len(df)} symbols={df['symbol'].nunique() if not df.empty else 0} "
        f"range=[{span}] {shard_line}"
        f"multiListing={counts['multiListing']} wall={time.monotonic() - started:.1f}s "
        f"peakRSS={_peak_rss_mb():.0f}MB -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
