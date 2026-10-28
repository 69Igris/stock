#!/usr/bin/env python3
"""Reader for a lake RELEASE — MONEY-1518 (data-platform B7).

    from lake import open_release, bars, universe, manifest, verify_release

    df  = bars(["AAPL", "MSFT"], "D1", "2023-01-01", "2026-09-01", release="2026-09-22T00-00-00Z")
    uni = universe("2019-06-30", release="2026-09-22T00-00-00Z", market="US")  # see universe(): the LIMITS
    con = open_release("2026-09-22T00-00-00Z")          # duckdb, if installed
    con.sql("SELECT COUNT(*) FROM bars_d1").show()

## A RELEASE IS PINNED, NEVER "LATEST"

Every entry point REQUIRES a `release`. There is deliberately no default and
no implicit newest: a backtest run against March's release and re-run in
September against September's produces two different P&Ls from identical
inputs, with nothing in either result to say why. That is the reasoning
`us_cost_model_versions` already carries, and a release is the same artifact
one layer out. `latest_release()` exists and is a SEPARATE, explicit call, so
pinning is what happens when nobody thought about it.

## GCS, OR A LOCAL SYNC CACHE

`LAKE_RELEASE_CACHE` unset reads `gs://stockbook-lake-{env}/releases/` through
pyarrow's `GcsFileSystem`. Set, it reads the SAME layout from local disk:

    gcloud storage rsync -r gs://stockbook-lake-prod/releases/<id> \\
        "$LAKE_RELEASE_CACHE/stockbook-lake-prod/releases/<id>"

The bucket name is kept in the local path so a prod and a QA copy of one id can
never answer for each other. A copy is only as complete as the sync that made
it, so run `verify_release()` once after syncing: a sync killed part-way leaves
a cache that reads perfectly and holds a fraction of the universe.

## DEPENDENCIES: `scripts/quant/requirements.txt`, AND DUCKDB IS OPTIONAL

`pandas` + `pyarrow`, pinned to the versions `services/us-fundamentals`
ships (`test_lake.py` holds the two files in agreement). `pyarrow` carries
`pyarrow.fs.GcsFileSystem` in the box — column projection, predicate pushdown
and hive partition pruning over `gs://` need nothing else.

`duckdb` is NOT in this repo and is NOT added by this file. `open_release`
imports it lazily and raises a NAMED error naming the install when it is
absent; `bars()` and `universe()` never touch it. So DuckDB is a
consumer-side choice (a ~40 MB wheel, MIT, no system libraries) bought for SQL
ergonomics, not a platform dependency this reader forces on the algo VM.

It is also registered over the SAME pyarrow datasets rather than over
`read_parquet('gs://...')`, which would need duckdb's `httpfs` extension
downloaded at runtime plus its own GCS credentials. One credential path, one
filesystem, no extension.

## THE ADJUSTMENT IS READ, NEVER RECOMPUTED

`read_candles.py` re-implemented CRSP in Python because it had raw bars and no
factors — and its own header said the port was the risk ("ports drift").
`bars_d1` in a release carries `price_factor` and `split_factor_cum` from
`gold.adjusted_bar_d1`, the SQL that
`packages/core/__tests__/market-data/adjustment-sql-parity.test.ts` proves
equal to `computeAdjustedSeries`. So:

  * a D1 adjusted read SELECTS the `adj_*` columns;
  * an INTRADAY adjusted read JOINS the factors on (market, listing_id,
    session_date) and multiplies.

Both are the same numbers from the same implementation. There is no third one.

## EVERY NUMERIC COLUMN IS A DOUBLE

The builder exports every INT64 and NUMERIC column as FLOAT64
(`doubleReplacements` in lake-release-logic.ts). A NUMERIC reaches pandas as an
object column of `Decimal`, and `Decimal * float` raises — the intraday
adjustment below would TypeError on the first real release.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import date, datetime
from typing import Any

import pandas as pd
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs

#: `LAKE_PREFIXES` in packages/core/src/ops/lake-layout.ts — `releases/` routes
#: to the LAKE bucket, never the content one. Spelled here because a Python
#: reader cannot import the TypeScript, and pinned by `test_lake.py`.
LAKE_BUCKET_BASE = "stockbook-lake"
RELEASE_PREFIX = "releases"

#: `releaseId()` in lake-release-logic.ts. Colon-free so the id survives a
#: shell argument, a Windows path and a local sync cache intact.
_RELEASE_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$")

#: The two factor columns `bars_d1` carries. Named as a constant because
#: dropping them from a release is the one edit that silently restores the
#: need for a second CRSP implementation.
FACTOR_COLUMNS = ("price_factor", "split_factor_cum")

_ADJ = {"open": "adj_open", "high": "adj_high", "low": "adj_low", "close": "adj_close"}


class ReleaseNotFound(RuntimeError):
    """The release does not exist, or its manifest was never written.

    DISTINCT from an empty read. A cut killed part-way leaves parquet with no
    `manifest.json`, and that is the state this names — reading its bars
    anyway would be a backtest on a fraction of a universe, reported as a
    clean run.
    """


def lake_env() -> str:
    """`qa` or `prod`, REFUSED rather than defaulted.

    A silent fall back to `qa` makes a production backtest read the wrong
    warehouse and report a healthy result — the reason `ledger.ts` and
    `gold.ts` refuse the same variable on the TypeScript side.
    """
    env = os.environ.get("LAKE_ENV", "")
    if env not in ("qa", "prod"):
        raise RuntimeError(f'LAKE_ENV must be "qa" or "prod" (got {env!r})')
    return env


def parse_release_id(raw: str) -> str:
    """Shape-check an id BEFORE it becomes half of an object path."""
    rid = (raw or "").strip()
    if not _RELEASE_ID_RE.match(rid):
        raise ValueError(
            f"Not a release id: {raw!r}. Expected YYYY-MM-DDTHH-mm-ssZ (e.g. 2026-09-22T00-00-00Z)."
        )
    return rid


def _cache_dir() -> str:
    """`LAKE_RELEASE_CACHE`, read PER CALL — same rule as `LAKE_ENV`."""
    raw = os.environ.get("LAKE_RELEASE_CACHE", "").strip()
    return os.path.abspath(os.path.expanduser(raw)) if raw else ""


def _bucket_root(env: str | None) -> str:
    bucket = f"{LAKE_BUCKET_BASE}-{env or lake_env()}"
    cache = _cache_dir()
    return f"{cache}/{bucket}" if cache else bucket


def release_root(release: str, env: str | None = None) -> str:
    """`{bucket}/releases/{id}` — a pyarrow path, so no `gs://` scheme.

    Under `LAKE_RELEASE_CACHE` the same path is rooted at the cache directory.
    The id is parsed FIRST, so a typo is reported as a typo even on a shell
    with no LAKE_ENV.
    """
    rid = parse_release_id(release)
    return f"{_bucket_root(env)}/{RELEASE_PREFIX}/{rid}"


def _fs() -> pafs.FileSystem:
    return pafs.LocalFileSystem() if _cache_dir() else pafs.GcsFileSystem()


def _shown(path: str) -> str:
    return path if _cache_dir() else f"gs://{path}"


def manifest(release: str, env: str | None = None) -> dict[str, Any]:
    """The release's own provenance — policy, universe rule, row counts, licence.

    Read it before trusting a number out of a release. It is also the
    completeness signal: parquet present with no manifest is a cut that died,
    and {@link ReleaseNotFound} says so rather than letting the bars read.
    """
    path = f"{release_root(release, env)}/manifest.json"
    try:
        with _fs().open_input_stream(path) as handle:
            return json.loads(handle.readall().decode("utf-8"))
    except FileNotFoundError as exc:
        raise ReleaseNotFound(
            f"No manifest at {_shown(path)}. Either the release does not exist, or a "
            "cut died before publishing its inventory — do not read its bars."
        ) from exc


def verify_release(release: str, env: str | None = None) -> list[str]:
    """Every file against the manifest: size AND sha256. Returns DISAGREEMENTS.

    The Python half of `verifyManifest` (lake-release-logic.ts), with the same
    four words, because they need four different fixes: MISSING (a sync that
    stopped short — re-sync), SIZE / SHA256 (a file that changed — re-sync
    that file), UNLISTED (a file no manifest names — a crashed partial cut, or
    two cuts on one id, and a `bars_d1/**` scan reads it either way). An empty
    list is the only pass.

    It reads every byte, so it is an explicit call after a sync — never
    something `bars()` does on your behalf.
    """
    rid = parse_release_id(release)
    root = release_root(rid, env)
    fs = _fs()
    want = {f["path"]: f for f in manifest(rid, env)["files"]}
    found = {
        info.path[len(root) + 1 :]: info
        for info in fs.get_file_info(pafs.FileSelector(root, recursive=True))
        if info.type == pafs.FileType.File
    }
    found.pop("manifest.json", None)

    problems: list[str] = []
    for path, entry in want.items():
        info = found.pop(path, None)
        if info is None:
            problems.append(f"MISSING {path}")
        elif info.size != entry["bytes"]:
            problems.append(f"SIZE {path}: manifest {entry['bytes']}, found {info.size}")
        elif _sha256(fs, f"{root}/{path}") != entry.get("sha256"):
            problems.append(f"SHA256 {path}")
    problems.extend(f"UNLISTED {path}" for path in sorted(found))
    return problems


def _sha256(fs: pafs.FileSystem, path: str) -> str:
    digest = hashlib.sha256()
    with fs.open_input_stream(path) as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def latest_release(env: str | None = None) -> str:
    """The newest release id. EXPLICIT — nothing calls this on your behalf.

    Release ids sort lexically in time order by construction, so `max` is the
    whole implementation.
    """
    prefix = f"{_bucket_root(env)}/{RELEASE_PREFIX}/"
    selector = pafs.FileSelector(prefix, recursive=False, allow_not_found=True)
    ids = [
        info.base_name
        for info in _fs().get_file_info(selector)
        if _RELEASE_ID_RE.match(info.base_name)
    ]
    if not ids:
        raise ReleaseNotFound(f"No releases under {_shown(prefix)}")
    return max(ids)


def dataset(name: str, release: str, env: str | None = None) -> ds.Dataset:
    """One release directory as a partition-pruning parquet dataset.

    `hive_partitioning` is what makes `market=US/year=2024` a COLUMN a filter
    can prune on rather than a path a reader has to walk.
    """
    return ds.dataset(
        f"{release_root(release, env)}/{name}",
        filesystem=_fs(),
        format="parquet",
        partitioning="hive",
    )


def _as_date(value: str | date | datetime) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def bars(
    symbols: list[str],
    timeframe: str,
    start: str | date | datetime,
    end: str | date | datetime,
    *,
    release: str,
    adjusted: bool = True,
    env: str | None = None,
    market: str | None = None,
) -> pd.DataFrame:
    """Bars for `symbols` over `[start, end]`, INCLUSIVE at both ends.

    The range is in SESSION dates, never UTC ones, for every timeframe. A US
    post-market bar at 00:30Z on the 9th under EST belongs to the 8th's session:
    it comes back for `end="…-08"` and not for `start="…-09"`.

    ONE FRAME PER LISTING, NOT PER SYMBOL. A ticker is not a security — `DOW`
    is Dow Chemical to 2017 and Dow Inc. from 2019 — so both occupants come
    back under one `symbol` and `listing_id` is the column to group on. A
    consumer doing `df[df.symbol == "DOW"].sort_values("ts")` still gets two
    companies as one series; nothing downstream can detect that, so it is said
    here, exactly as `read_candles.py` said it.
    """
    # The CALLER'S arguments first, the ENVIRONMENT second: every argument is
    # checked before anything resolves LAKE_ENV or touches storage, so a
    # `--release latest` on a shell with no LAKE_ENV reports the typo rather
    # than sending the reader to their shell profile.
    release = parse_release_id(release)
    tf = timeframe.upper()
    lo, hi = _as_date(start), _as_date(end)
    if lo > hi:
        raise ValueError(f"bars: start {lo} is after end {hi}")
    if not symbols:
        raise ValueError("bars: refusing an empty symbol list — it would read the whole universe")

    # A cut that died before its manifest is not a release — ReleaseNotFound,
    # never a read of whatever fraction of the universe it got to.
    manifest(release, env)
    name = "bars_d1" if tf == "D1" else f"bars_{tf.lower()}"
    data = dataset(name, release, env)
    flt = (
        pc.field("symbol").isin(symbols)
        & (pc.field("session_date") >= pa_date(lo))
        & (pc.field("session_date") <= pa_date(hi))
    )
    if market is not None:
        flt = flt & (pc.field("market") == market)
    frame = data.to_table(filter=flt).to_pandas()

    if not adjusted or frame.empty:
        return frame.sort_values(["symbol", "listing_id", _ts_column(frame)]).reset_index(drop=True)

    if tf == "D1":
        missing = [c for c in _ADJ.values() if c not in frame.columns]
        if missing:
            # NOT a silent fall back to raw. A frame labelled adjusted and
            # holding raw prices is wrong by a multiple with nothing on the
            # rows to reveal it — and re-deriving here would be the second CRSP
            # implementation this whole ticket exists to delete.
            raise ValueError(
                f"{name} in release {release} has no {missing} column(s). This release "
                "was cut without the adjusted columns; it cannot answer adjusted=True."
            )
        return frame.sort_values(["symbol", "listing_id", "session_date"]).reset_index(drop=True)

    return _apply_d1_factors(frame, release=release, env=env, lo=lo, hi=hi)


def _ts_column(frame: pd.DataFrame) -> str:
    return "ts" if "ts" in frame.columns else "session_date"


def _apply_d1_factors(
    frame: pd.DataFrame, *, release: str, env: str | None, lo: date, hi: date
) -> pd.DataFrame:
    """Adjust INTRADAY bars with the D1 factors, joined on the session date.

    The factors are per (market, listing_id, session_date) and apply to every
    bar of that session — which is what makes one implementation of CRSP
    enough for every timeframe. Volume divides by the SPLIT factor alone: a
    split changes the share count and a dividend does not.

    A session with no D1 row is DROPPED, not passed through unadjusted. An
    unadjustable bar silently sitting in an adjusted frame is a step
    discontinuity on real prices that renders perfectly.

    `[lo, hi]` is enough for the factors because `bars()` selected these bars
    on the SAME `session_date` range. Select bars on `ts` instead and a bar
    whose session is the day before `lo` loses its factor and is dropped.
    """
    keys = ["market", "listing_id", "session_date"]
    factors = (
        dataset("bars_d1", release, env)
        .to_table(
            columns=[*keys, *FACTOR_COLUMNS],
            filter=pc.field("listing_id").isin(frame["listing_id"].unique().tolist())
            & (pc.field("session_date") >= pa_date(lo))
            & (pc.field("session_date") <= pa_date(hi)),
        )
        .to_pandas()
    )
    merged = frame.merge(factors, on=keys, how="inner", validate="many_to_one")
    for raw, adj in _ADJ.items():
        merged[adj] = merged[raw] * merged["price_factor"]
    # JS `Math.round` is floor(x + 0.5); Python's round() is banker's rounding
    # and disagrees on every exact .5. The SQL uses BigQuery ROUND (half away
    # from zero), which agrees with floor(x+0.5) for the non-negative volumes
    # this column holds. Vectorised: a Python lambda per row is minutes on an
    # M1 universe, and `int(nan)` raised on the first NULL volume.
    merged["adj_volume"] = (merged["volume"] / merged["split_factor_cum"] + 0.5) // 1
    return merged.sort_values(["symbol", "listing_id", _ts_column(merged)]).reset_index(drop=True)


def _valid_on(day: date) -> Any:
    """The half-open `[valid_from, valid_to)` window containing `day`, as a pushed-down filter.

    `valid_to` is EXCLUSIVE (003_silver_identity.sql) — a close-and-open on
    the same day must match exactly ONE row, and an inclusive `>=` returned a
    renamed listing twice on its rename day, once under each ticker.

    NULL is OPEN-ENDED at either end — `windowContains` in identity-logic.ts.
    It has to be: identity-sync writes EVERY `symbol_history` row with a NULL
    `valid_from` (no source dates when a label began — see `universe()`), so a
    filter that dropped NULL returned an empty universe for every as-of.
    Telling a retired alias from a listing's own label is `universe()`'s job,
    not this filter's.
    """
    return (pc.field("valid_from").is_null() | (pc.field("valid_from") <= pa_date(day))) & (
        pc.field("valid_to").is_null() | (pc.field("valid_to") > pa_date(day))
    )


#: Parser versions whose FIRST versions start on the day identity-sync RAN, not
#: on a source date (MONEY-1544). A listing whose first version carries one is
#: not dated, so its start says nothing about when it began trading.
UNDATED_PARSER_VERSIONS = frozenset({"identity/1"})


def _refuse_before_coverage(listing: Any, scoped: Any, day: date) -> None:
    """Refuse an as-of before the earliest window a SOURCE dates, per source in scope.

    Identity is dated per `listing.source` (MONEY-1544): every US listing by
    Tiingo's master, every Indian listing by its own venue's bhavcopy archive.
    Each source's earliest window is a COVERAGE floor — before it, that source
    cannot say what traded, and an empty or partial frame would read as
    "nothing traded". The floor is per source and not per venue on purpose: a
    US venue's first listing is history (NASDAQ opened in 1971), while India's
    NSE and BSE archives simply start on different days (1994-11-03 and
    2024-01-01 on prod), so an India universe before 2024 is refused unless it
    is narrowed to `venue="NSE"`.

    THE FLOOR IS EARNED ONLY BY A WHOLLY DATED SOURCE (MONEY-1602). One dated
    listing moves MIN(`valid_from`), so a table re-dated part-way — a rebase that
    died mid-chunk, India held back until its bar archive is whole — would
    answer a historical as_of with the dated few and call it the market. So a
    (market, source) with ANY listing whose first version is undated
    (`UNDATED_PARSER_VERSIONS`) keeps the undated floor, the latest such start
    (2026-09-22 on prod), and the refusal names how many are undated. A release
    with no `parser_version` column is undated throughout.

    `listing` is the market-scoped table the floors are read from; `scoped` is
    what the caller asked for, which decides which floors apply.
    """
    cols = ["listing_id", "market", "source", "valid_from"]
    has_version = "parser_version" in listing.column_names
    frame = listing.select(cols + (["parser_version"] if has_version else [])).to_pandas()
    first = frame.sort_values("valid_from", kind="stable").drop_duplicates("listing_id")
    first["undated"] = (
        first["parser_version"].isin(UNDATED_PARSER_VERSIONS) if has_version else True
    )
    in_scope = {
        (r["market"], r["source"])
        for r in scoped.group_by(["market", "source"]).aggregate([]).to_pylist()
    }
    late = []
    for (mkt, src), group in first.groupby(["market", "source"]):
        if (mkt, src) not in in_scope:
            continue
        undated = group[group["undated"]]
        if len(undated):
            floor = undated["valid_from"].max()
            why = f"{len(undated):,} listing(s) not yet re-dated by identity-sync"
        else:
            floor = group["valid_from"].min()
            why = "the earliest window that source dates"
        if floor > day:
            late.append(f"{mkt}/{src} {floor} ({why})")
    if late:
        raise ValueError(
            f"universe: as_of {day} precedes this release's identity for {', '.join(sorted(late))}. "
            "This release cannot say what traded then; narrow `market`/`venue` or ask an "
            "as_of on/after that date."
        )


def universe(
    as_of: str | date | datetime,
    *,
    release: str,
    env: str | None = None,
    market: str | None = None,
    venue: str | None = None,
) -> pd.DataFrame:
    """Every listing tradable on `as_of` — SURVIVORSHIP-FREE in membership.

    From `symbol_history`, not from `listing.symbol`: the point is the ticker
    as it stood THEN. Resolving today's tickers and calling that the past is
    the error that always flatters a strategy, because the names that changed
    or delisted are disproportionately the ones that did badly.

    `listing` is SCD-2 — one row per validity window — so it is cut to the
    version valid on `as_of` BEFORE the join. Joined whole, a listing with
    three versions appeared three times. The join is `many_to_one`, so
    overlapping windows in the data RAISE rather than fan out quietly. A
    version whose `status` is DELISTED is not tradable.

    An UNDATED `symbol_history` row (NULL `valid_from`) matches every as-of,
    so it is admitted only as the listing's OWN label — its symbol equals the
    listing version's — and only when no dated row of that listing matched
    (`resolveSymbol`'s dated-beats-undated rule). Otherwise an undated alias
    (`previousSymbols`) would put ZOMATO beside ETERNAL in every universe.

    ## WHAT THE WINDOWS ARE — MONEY-1544

    A listing's FIRST version is dated by its source (`firstVersions` in
    identity-logic.ts); a change identity-sync observes later is dated the day
    it observed it.

      US  Tiingo's `listingStartDate`. A delisted listing is ACTIVE through its
          last session (`listingEndDate`, inclusive) and DELISTED from the day
          after, so DOW is Dow Chemical in 2017, nobody in 2018 and Dow Inc. in
          2020.
      IN  NO inception date exists. The lower bound is the listing's first
          session in `price_bar_d1` — the archive's first evidence it traded,
          truncated by the archive (NSE 1994-11-03, BSE 2024-01-01). A listing
          with no bar starts the day identity-sync first observed it, so it is
          in no earlier universe: we hold no evidence it traded. An Indian
          instrument the master no longer lists — or never did (HDFC Ltd) — is
          a listing from its BARS (MONEY-1602): ACTIVE to its last session,
          DELISTED after. A rename's pre-rename era is the OLD symbol's own
          listing, because that is the id its bars sit on. So India is
          survivorship-free back to each venue's archive floor, and no further:
          a company that stopped trading before the floor has no bar and no
          listing.

    An as_of before the earliest window a source dates is REFUSED, naming
    `market/source` — see `_refuse_before_coverage`. A source earns that floor
    only when EVERY one of its listings is dated: a release cut before
    identity-sync's MONEY-1544 rebase, or part-way through it, refuses every
    as_of before 2026-09-22 for that source and says how many are undated. An
    unknown `venue`, or one outside `market`, is refused by name.

    ## THE LABELS ARE NOT DATED

    Every `symbol_history.valid_from` is NULL: no source dates when a label
    BEGAN. Tiingo keys a renamed company's whole history under its CURRENT
    ticker (META from 2012-05-18) and `previousSymbols` carries no dates. So a
    listing comes back under its LAST known label — membership is point in
    time, the ticker string is not. Group on `listing_id`, never `symbol`.
    """
    release = parse_release_id(release)  # caller's argument before the environment
    day = _as_date(as_of)
    manifest(release, env)  # a manifest-less cut is refused — see bars()
    data = dataset("instruments/listing", release, env)
    extra = ["parser_version"] if "parser_version" in data.schema.names else []
    listing = data.to_table(
        columns=[
            "listing_id",
            "market",
            "venue",
            "symbol",
            "name",
            "asset_type",
            "currency",
            "isin",
            "status",
            "source",
            "valid_from",
            "valid_to",
            *extra,
        ],
        filter=None if market is None else pc.field("market") == market,
    )
    if venue is not None:
        known = sorted(set(listing.column("venue").to_pylist()))
        if venue not in known:
            # An empty frame here reads as "nothing traded on that venue" — the
            # answer to `venue="nse"` or to `market="US", venue="NSE"` is a typo.
            raise ValueError(
                f"universe: venue {venue!r} is not in this release's "
                f"{market or 'any-market'} listings. Known venues: {', '.join(known)}."
            )
    scoped = listing if venue is None else listing.filter(pc.field("venue") == venue)
    _refuse_before_coverage(listing, scoped, day)
    live = (
        scoped.filter(_valid_on(day) & (pc.field("status") != "DELISTED"))
        .drop_columns(["venue", "status", "source", "valid_from", "valid_to", *extra])
        .rename_columns({"symbol": "listing_symbol"})
        .to_pandas()
    )
    hist = (
        dataset("instruments/symbol_history", release, env)
        .to_table(columns=["listing_id", "symbol", "venue", "valid_from"], filter=_valid_on(day))
        .to_pandas()
    )
    out = hist.merge(live, on="listing_id", how="inner", validate="many_to_one")
    undated = out["valid_from"].isna()
    dated_ids = out.loc[~undated, "listing_id"]
    own_label = (out["symbol"] == out["listing_symbol"]) & ~out["listing_id"].isin(dated_ids)
    out = out[~undated | own_label].drop(columns=["valid_from", "listing_symbol"])
    return out.sort_values(["market", "symbol"]).reset_index(drop=True)


def open_release(release: str, env: str | None = None) -> Any:
    """A DuckDB connection with one view per release dataset.

    OPTIONAL. `duckdb` is not a dependency of this repo; this raises a named
    error naming the install rather than an ImportError from three frames
    down. `bars()` and `universe()` do not need it.

    The views are registered over the pyarrow datasets, so duckdb reads
    through pyarrow's filesystem — no `httpfs` extension downloaded at
    runtime, no second set of credentials, and filters still push down.
    """
    try:
        import duckdb  # optional by design — see this function's docstring
    except ImportError as exc:
        raise RuntimeError(
            "open_release() needs duckdb, which this repo does not depend on: "
            "`pip install duckdb`. bars() and universe() work without it."
        ) from exc

    rid = parse_release_id(release)
    manifest(rid, env)  # ReleaseNotFound rather than a view over a half-written cut
    con = duckdb.connect()
    for name in (
        "bars_d1",
        "bars_m1",
        "corporate_actions",
        "instruments/listing",
        "instruments/symbol_history",
    ):
        view = name.split("/")[-1]
        try:
            con.register(view, dataset(name, rid, env))
        except FileNotFoundError:
            # A release may legitimately omit a dataset (bars_m1 until B5's
            # loader runs). An ABSENT view is better than an empty one: a query
            # against it errors by name instead of returning zero rows.
            continue
    return con


def pa_date(value: date) -> Any:
    """`session_date` is a parquet DATE; comparing it to a string silently matches nothing."""
    return value


__all__ = [
    "FACTOR_COLUMNS",
    "ReleaseNotFound",
    "bars",
    "dataset",
    "lake_env",
    "latest_release",
    "manifest",
    "open_release",
    "parse_release_id",
    "release_root",
    "universe",
    "verify_release",
]
