"""A lake RELEASE on local disk, built the way `lake-release.ts` builds one — MONEY-1518 (B7).

`bars_d1` is B4's own fixture — `adjustment-parity.csv`, the 64 rows
`adjustment-sql-parity.test.ts` proves the SQL equal to the TypeScript on — run
through B4's own SQL (`dataform/includes/adjustment.js`) in `node:sqlite`, the
engine that parity test uses. So the factor and adjusted columns are the ONE
implementation's output, computed at test time: never a Python re-derivation
(the port MONEY-1518 deleted) and never a checked-in golden that drifts from the
SQL it claims to be.

The SQL's input tables are created from the parity test's OWN `CREATE TABLE`
statements, read out of that file. The SQL gains input columns as its tickets
land (`observed_ratio`, MONEY-1528, arrived while this was written), and a copy
of the schema here would go stale on the next one.

Layout and types are EXPORT DATA's under `doubleReplacements`:

    {cache}/stockbook-lake-{env}/releases/{id}/
      manifest.json                                  crc32c AND sha256 per file
      bars_d1/market=US/year=YYYY/part-000000000000.parquet
      bars_m1/market=US/year=YYYY/month=MM/part-000000000000.parquet
      corporate_actions/part-000000000000.parquet
      instruments/listing/part-000000000000.parquet
      instruments/symbol_history/part-000000000000.parquet

Every INT64 and NUMERIC column is a DOUBLE — the builder's rule, and the ticket's
("VOLUME MUST BE WRITTEN AS DOUBLE") — DATE is date32, TIMESTAMP is us/UTC.
"""

from __future__ import annotations

import base64
import functools
import hashlib
import json
import re
import subprocess
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

REPO_ROOT = Path(__file__).resolve().parents[3]
B4_CSV = REPO_ROOT / "packages/core/__tests__/market-data/fixtures/adjustment-parity.csv"
B4_PARITY_TEST = REPO_ROOT / "packages/core/__tests__/market-data/adjustment-sql-parity.test.ts"
ADJUSTMENT_JS = REPO_ROOT / "dataform/includes/adjustment.js"

RELEASE_ID = "2026-09-23T00-00-00Z"
PART = "part-000000000000.parquet"

_NODE = r"""
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const [includePath, csvPath, ddlJson] = process.argv.slice(1);
const include = require(includePath);
const db = new DatabaseSync(":memory:");
for (const stmt of JSON.parse(ddlJson)) db.exec(stmt);
const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
const header = lines[0].split(",");
const numeric = new Set(["open", "high", "low", "close", "volume", "div_cash", "split_factor"]);
const insert = db.prepare(
  `INSERT INTO price_bar_d1 (${header.join(", ")}) VALUES (${header.map(() => "?").join(", ")})`,
);
for (const line of lines.slice(1)) {
  const cells = line.split(",");
  insert.run(...cells.map((c, i) => (numeric.has(header[i]) ? Number(c) : c)));
}
const sql = include.adjustedBarD1Sql("price_bar_d1", "corporate_action");
process.stdout.write(JSON.stringify(db.prepare(`${sql} ORDER BY listing_id, session_date`).all()));
"""

#: The DOUBLE rule's columns in `adjusted_bar_d1`'s output.
_D1_DOUBLES = (
    "open",
    "high",
    "low",
    "close",
    "volume",
    "div_cash",
    "split_factor",
    "price_factor",
    "split_factor_cum",
    "adj_open",
    "adj_high",
    "adj_low",
    "adj_close",
    "adj_volume",
)


@functools.cache
def gold_rows() -> tuple[dict[str, Any], ...]:
    """`adjusted_bar_d1` over B4's fixture, from B4's SQL. Cached: it spawns node."""
    ddl = re.findall(r"db\.exec\(`(CREATE TABLE \w+ \([^`]*\))`\)", B4_PARITY_TEST.read_text())
    tables = {re.match(r"CREATE TABLE (\w+)", s).group(1) for s in ddl}  # type: ignore[union-attr]
    if not {"price_bar_d1", "corporate_action"} <= tables:
        raise RuntimeError(
            f"read {sorted(tables)} out of {B4_PARITY_TEST.name}; the fixture needs "
            "price_bar_d1 and corporate_action. The parity harness moved — follow it here."
        )
    out = subprocess.run(
        ["node", "-e", _NODE, str(ADJUSTMENT_JS), str(B4_CSV), json.dumps(ddl)],
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        raise RuntimeError(f"B4's SQL did not run in node:sqlite:\n{out.stderr[-2000:]}")
    rows = json.loads(out.stdout)
    if len(rows) < 60:
        raise RuntimeError(f"B4's SQL returned {len(rows)} rows; the fixture holds 64")
    return tuple(rows)


def _d1_table(rows: list[dict[str, Any]]) -> pa.Table:
    # None stays NULL: silver's NUMERIC columns are nullable, and a NULL price is
    # a state a reader must refuse rather than a value a fixture may not hold.
    doubles = {
        c: pa.array([None if r[c] is None else float(r[c]) for r in rows], pa.float64())
        for c in _D1_DOUBLES
    }
    return pa.table(
        {
            "market": [r["market"] for r in rows],
            "listing_id": [r["listing_id"] for r in rows],
            "symbol": [r["symbol"] for r in rows],
            "exchange": [r["exchange"] for r in rows],
            "session_date": pa.array(
                [date.fromisoformat(r["session_date"]) for r in rows], pa.date32()
            ),
            **{c: doubles[c] for c in _D1_DOUBLES[:7]},
            "source": [r["source"] for r in rows],
            **{c: doubles[c] for c in _D1_DOUBLES[7:]},
            "adjustment_policy_version": [r["adjustment_policy_version"] for r in rows],
        }
    )


#: (symbol, session_date, ts UTC, o, h, l, c, v). SPLT around its 3:1 split on
#: 2020-01-09 — the only shape that can tell a joined factor from none —
#: including a POST-MARKET bar of the 8th that sits on the 9th in UTC (19:30 ET
#: under EST), and one session (the 11th, a Saturday) with NO D1 row, which an
#: adjusted read must drop. DIVO on the 6th, ahead of two DIVIDENDS and no
#: split: its price factor is not 1 and its split factor is, which is the one
#: shape that tells "volume divides by the split factor" from "by the price one".
M1_BARS = (
    ("SPLT", "2020-01-08", "2020-01-08T14:30", 30.10, 30.40, 30.05, 30.20, 1200.0),
    ("SPLT", "2020-01-08", "2020-01-08T14:31", 30.20, 30.30, 30.10, 30.25, 800.0),
    ("SPLT", "2020-01-08", "2020-01-09T00:30", 30.25, 30.25, 30.20, 30.22, 50.0),
    ("SPLT", "2020-01-09", "2020-01-09T14:30", 10.20, 10.21, 10.11, 10.15, 3600.0),
    ("SPLT", "2020-01-09", "2020-01-09T14:31", 10.15, 10.20, 10.10, 10.18, 2400.0),
    ("SPLT", "2020-01-11", "2020-01-11T14:30", 10.00, 10.00, 10.00, 10.00, 100.0),
    ("DIVO", "2020-01-06", "2020-01-06T14:30", 249.20, 249.60, 249.00, 249.40, 700.0),
)


def _m1_table(bars: tuple[tuple[Any, ...], ...]) -> pa.Table:
    n = len(bars)
    return pa.table(
        {
            "market": ["US"] * n,
            "listing_id": [f"{b[0]}:NASDAQ:2020-01-02" for b in bars],
            "symbol": [b[0] for b in bars],
            "exchange": ["NASDAQ"] * n,
            "publisher_id": pa.array([95.0] * n, pa.float64()),  # INT64 in silver
            "ts": pa.array(
                [datetime.fromisoformat(f"{b[2]}:00+00:00") for b in bars],
                pa.timestamp("us", tz="UTC"),
            ),
            "session_date": pa.array([date.fromisoformat(b[1]) for b in bars], pa.date32()),
            **{
                col: pa.array([b[i] for b in bars], pa.float64())
                for i, col in enumerate(("open", "high", "low", "close", "volume"), start=3)
            },
            "source": ["DATABENTO"] * n,
        }
    )


#: The day identity-sync first ran on prod: before MONEY-1544's rebase every
#: listing's FIRST version starts here, in both markets (measured 2026-09-23).
IDENTITY_SEED_DAY = date(2026, 9, 22)

# (listing_id, market, venue, symbol, name, valid_from, valid_to, status, source)
_ListingRow = tuple[str, str, str, str, str | None, date, date | None, str, str]
# (listing_id, symbol, venue, valid_from, valid_to)
_HistoryRow = tuple[str, str, str, date | None, date | None]


def _tables(
    listing_rows: list[_ListingRow],
    history_rows: list[_HistoryRow],
    parser_version: str | list[str],
) -> tuple[pa.Table, pa.Table]:
    versions = (
        [parser_version] * len(listing_rows) if isinstance(parser_version, str) else parser_version
    )
    listing = pa.table(
        {
            "listing_id": [r[0] for r in listing_rows],
            "market": [r[1] for r in listing_rows],
            "venue": [r[2] for r in listing_rows],
            "symbol": [r[3] for r in listing_rows],
            "isin": pa.array([None] * len(listing_rows), pa.string()),
            "name": [r[4] for r in listing_rows],
            "asset_type": ["Stock"] * len(listing_rows),
            "currency": ["INR" if r[1] == "IN" else "USD" for r in listing_rows],
            "valid_from": pa.array([r[5] for r in listing_rows], pa.date32()),
            "valid_to": pa.array([r[6] for r in listing_rows], pa.date32()),
            "status": [r[7] for r in listing_rows],
            "source": [r[8] for r in listing_rows],
            "parser_version": versions,
        }
    )
    history = pa.table(
        {
            "listing_id": [r[0] for r in history_rows],
            "symbol": [r[1] for r in history_rows],
            "venue": [r[2] for r in history_rows],
            "valid_from": pa.array([r[3] for r in history_rows], pa.date32()),
            "valid_to": pa.array([r[4] for r in history_rows], pa.date32()),
        }
    )
    return listing, history


def _identity() -> tuple[pa.Table, pa.Table]:
    """DATED identity — what identity-sync writes after MONEY-1544's rebase.

    Prod-shaped (`firstVersions` in identity-logic.ts):

    - DOW twice, as Tiingo's master dates them. Dow Chemical is ACTIVE to its
      last session (2017-08-31, so `valid_to` 2017-09-01) and DELISTED from
      the day after; Dow Inc. from 2019-03-20. Their labels are UNDATED at the
      start — no source dates when a label began — and Dow Chemical's closes
      with its listing.
    - GONE: delisted 2019-05-31, so tradable in 2018 and not in 2020.
    - UNDT: a dated listing whose only labels are undated — its own symbol
      (admitted) and a previous one, UNDTX (never).
    - India, dated by the first bar in `price_bar_d1`: GRASIM from 1994-11-03,
      NSE's archive floor (its first bar on prod); ETERNAL from 2021-07-23
      with ZOMATO an undated previous symbol; NOBAR, with no bar, from the day
      identity-sync first observed it; BSEONE from 2024-01-01, BSE's archive
      floor — which is what makes an India as_of before 2024 unanswerable
      unless narrowed to NSE.
    - India no master row lists any more (MONEY-1602), dated by its bars:
      HDFC (a bar id with no master row, so no name) traded to 2023-07-12;
      MANBRO traded to 2026-08-18 and was renamed KDGREEN the next session,
      so the pre-rename era lives on MANBRO's own listing — and KDGREEN's
      undated MANBRO alias must not put it in both.

    Dated LABEL history no source provides today, for the reader's own rules:

    - DIVO renamed from DIVX on 2020-01-10 — `valid_to` is EXCLUSIVE, so the
      rename day must answer ONE ticker, not both. It also carries an undated
      row for its current symbol, which a dated row beats.
    - CLEAN in two SCD-2 versions (a name change on 2020-01-10) — joined whole,
      the listing appeared twice.
    - SPLTOLD, an UNDATED alias — it matches every as-of and must match none.
    """
    d = date.fromisoformat
    seed = IDENTITY_SEED_DAY
    # fmt: off
    listing_rows: list[_ListingRow] = [
        ("CLEAN:NASDAQ:2020-01-02", "US", "NASDAQ", "CLEAN", "Clean Old", d("2020-01-02"), d("2020-01-10"), "ACTIVE", "TIINGO"),
        ("CLEAN:NASDAQ:2020-01-02", "US", "NASDAQ", "CLEAN", "Clean Co", d("2020-01-10"), None, "ACTIVE", "TIINGO"),
        ("DIVO:NASDAQ:2020-01-02", "US", "NASDAQ", "DIVO", "Divo Inc", d("2020-01-02"), None, "ACTIVE", "TIINGO"),
        ("SPLT:NASDAQ:2020-01-02", "US", "NASDAQ", "SPLT", "Split Inc", d("2020-01-02"), None, "ACTIVE", "TIINGO"),
        ("BOTH:NASDAQ:2020-01-02", "US", "NASDAQ", "BOTH", "Both Inc", d("2020-01-02"), None, "ACTIVE", "TIINGO"),
        ("DOW:NYSE:1972-01-03", "US", "NYSE", "DOW", "Dow Chemical", d("1972-01-03"), d("2017-09-01"), "ACTIVE", "TIINGO"),
        ("DOW:NYSE:1972-01-03", "US", "NYSE", "DOW", "Dow Chemical", d("2017-09-01"), None, "DELISTED", "TIINGO"),
        ("DOW:NYSE:2019-03-20", "US", "NYSE", "DOW", "Dow Inc.", d("2019-03-20"), None, "ACTIVE", "TIINGO"),
        ("UNDT:NASDAQ:2020-01-02", "US", "NASDAQ", "UNDT", "Undated Inc", d("2020-01-02"), None, "ACTIVE", "TIINGO"),
        ("GONE:NYSE:2001-05-01", "US", "NYSE", "GONE", "Gone Corp", d("2001-05-01"), d("2019-06-01"), "ACTIVE", "TIINGO"),
        ("GONE:NYSE:2001-05-01", "US", "NYSE", "GONE", "Gone Corp", d("2019-06-01"), None, "DELISTED", "TIINGO"),
        ("GRASIM:NSE:unknown", "IN", "NSE", "GRASIM", "Grasim Ltd", d("1994-11-03"), None, "ACTIVE", "NSE"),
        ("ETERNAL:NSE:unknown", "IN", "NSE", "ETERNAL", "Eternal Ltd", d("2021-07-23"), None, "ACTIVE", "NSE"),
        ("NOBAR:NSE:unknown", "IN", "NSE", "NOBAR", "No Bar Ltd", seed, None, "ACTIVE", "NSE"),
        ("BSEONE:BSE:unknown", "IN", "BSE", "BSEONE", "Bse One Ltd", d("2024-01-01"), None, "ACTIVE", "BSE"),
        ("HDFC:NSE:unknown", "IN", "NSE", "HDFC", None, d("1994-11-03"), d("2023-07-13"), "ACTIVE", "NSE"),
        ("HDFC:NSE:unknown", "IN", "NSE", "HDFC", None, d("2023-07-13"), None, "DELISTED", "NSE"),
        ("MANBRO:BSE:unknown", "IN", "BSE", "MANBRO", "Manbro Ltd", d("2024-01-01"), d("2026-08-19"), "ACTIVE", "BSE"),
        ("MANBRO:BSE:unknown", "IN", "BSE", "MANBRO", "Manbro Ltd", d("2026-08-19"), None, "DELISTED", "BSE"),
        ("KDGREEN:BSE:unknown", "IN", "BSE", "KDGREEN", "KD Green Ltd", d("2026-08-19"), None, "ACTIVE", "BSE"),
    ]
    history_rows: list[_HistoryRow] = [
        ("CLEAN:NASDAQ:2020-01-02", "CLEAN", "NASDAQ", d("2020-01-02"), None),
        ("DIVO:NASDAQ:2020-01-02", "DIVX", "NASDAQ", d("2020-01-02"), d("2020-01-10")),
        ("DIVO:NASDAQ:2020-01-02", "DIVO", "NASDAQ", d("2020-01-10"), None),
        ("DIVO:NASDAQ:2020-01-02", "DIVO", "NASDAQ", None, None),
        ("SPLT:NASDAQ:2020-01-02", "SPLT", "NASDAQ", d("2020-01-02"), None),
        ("SPLT:NASDAQ:2020-01-02", "SPLTOLD", "NASDAQ", None, None),
        ("BOTH:NASDAQ:2020-01-02", "BOTH", "NASDAQ", d("2020-01-02"), None),
        ("DOW:NYSE:1972-01-03", "DOW", "NYSE", None, d("2017-09-01")),
        ("DOW:NYSE:2019-03-20", "DOW", "NYSE", None, None),
        ("UNDT:NASDAQ:2020-01-02", "UNDT", "NASDAQ", None, None),
        ("UNDT:NASDAQ:2020-01-02", "UNDTX", "NASDAQ", None, None),
        ("GONE:NYSE:2001-05-01", "GONE", "NYSE", None, d("2019-06-01")),
        ("GRASIM:NSE:unknown", "GRASIM", "NSE", None, None),
        ("ETERNAL:NSE:unknown", "ETERNAL", "NSE", None, None),
        ("ETERNAL:NSE:unknown", "ZOMATO", "NSE", None, None),
        ("NOBAR:NSE:unknown", "NOBAR", "NSE", None, None),
        ("BSEONE:BSE:unknown", "BSEONE", "BSE", None, None),
        ("HDFC:NSE:unknown", "HDFC", "NSE", None, d("2023-07-13")),
        ("MANBRO:BSE:unknown", "MANBRO", "BSE", None, d("2026-08-19")),
        ("KDGREEN:BSE:unknown", "KDGREEN", "BSE", None, None),
        ("KDGREEN:BSE:unknown", "MANBRO", "BSE", None, None),
    ]
    # fmt: on
    return _tables(listing_rows, history_rows, "identity/2")


def _seed_identity(partial: bool = False) -> tuple[pa.Table, pa.Table]:
    """UNDATED identity — prod as identity/1 left it, before the rebase.

    Every listing opened on the seed day, one version each; a delisted listing
    is a single open DELISTED version; every label NULL at both ends.

    `partial`: a rebase that died after re-dating ONE listing — Dow Chemical,
    now dated from 1972 and stamped identity/2 — beside the rest still undated.
    """
    seed = IDENTITY_SEED_DAY
    # fmt: off
    listing_rows: list[_ListingRow] = [
        ("DOW:NYSE:1972-01-03", "US", "NYSE", "DOW", "Dow Chemical", seed, None, "DELISTED", "TIINGO"),
        ("DOW:NYSE:2019-03-20", "US", "NYSE", "DOW", "Dow Inc.", seed, None, "ACTIVE", "TIINGO"),
        ("ETERNAL:NSE:unknown", "IN", "NSE", "ETERNAL", "Eternal Ltd", seed, None, "ACTIVE", "NSE"),
    ]
    history_rows: list[_HistoryRow] = [
        ("DOW:NYSE:1972-01-03", "DOW", "NYSE", None, None),
        ("DOW:NYSE:2019-03-20", "DOW", "NYSE", None, None),
        ("ETERNAL:NSE:unknown", "ETERNAL", "NSE", None, None),
        ("ETERNAL:NSE:unknown", "ZOMATO", "NSE", None, None),
    ]
    # fmt: on
    versions = ["identity/1"] * len(listing_rows)
    if partial:
        d = date.fromisoformat
        listing_rows[0] = (
            "DOW:NYSE:1972-01-03",
            "US",
            "NYSE",
            "DOW",
            "Dow Chemical",
            d("1972-01-03"),
            d("2017-09-01"),
            "ACTIVE",
            "TIINGO",
        )
        listing_rows.append(
            (
                "DOW:NYSE:1972-01-03",
                "US",
                "NYSE",
                "DOW",
                "Dow Chemical",
                d("2017-09-01"),
                None,
                "DELISTED",
                "TIINGO",
            )
        )
        versions = ["identity/2", "identity/1", "identity/1", "identity/2"]
    return _tables(listing_rows, history_rows, versions)


def _corporate_actions() -> pa.Table:
    return pa.table(
        {
            "market": ["US"],
            "listing_id": ["SPLT:NASDAQ:2020-01-02"],
            "action_type": ["SPLIT"],
            "ex_date": pa.array([date(2020, 1, 9)], pa.date32()),
            "ratio": pa.array([3.0], pa.float64()),  # NUMERIC in silver
            "cash": pa.array([None], pa.float64()),
            "source": ["TIINGO"],
            "published_at": pa.array(
                [datetime(2020, 1, 8, tzinfo=UTC)], pa.timestamp("us", tz="UTC")
            ),
        }
    )


def _crc32c(data: bytes) -> str:
    """GCS's `crc32c` metadata spelling: base64 of the big-endian Castagnoli CRC."""
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 if crc & 1 else 0)
    return base64.b64encode((crc ^ 0xFFFFFFFF).to_bytes(4, "big")).decode()


def build_release(
    cache: Path,
    *,
    env: str = "qa",
    release_id: str = RELEASE_ID,
    edit_d1: Callable[[list[dict[str, Any]]], None] | None = None,
    with_manifest: bool = True,
    identity: str = "dated",
) -> Path:
    """Write the fixture release under `cache` and return its directory.

    `edit_d1` may alter the gold rows before they are written — the way a test
    proves a reader SELECTS a value rather than recomputing it. `identity` is
    "dated" (after MONEY-1544's rebase), "seed" (before it) or "partial" (a
    rebase that died part-way).
    """
    root = cache / f"stockbook-lake-{env}" / "releases" / release_id
    d1 = [dict(r) for r in gold_rows()]
    if edit_d1 is not None:
        edit_d1(d1)

    files: dict[str, pa.Table] = {}
    for (market, year), group in _group(d1, lambda r: (r["market"], r["session_date"][:4])):
        files[f"bars_d1/market={market}/year={year}/{PART}"] = _d1_table(group)
    for (year, month), group in _group(list(M1_BARS), lambda b: (b[1][:4], b[1][5:7])):
        files[f"bars_m1/market=US/year={year}/month={month}/{PART}"] = _m1_table(tuple(group))
    listing, history = (
        _identity() if identity == "dated" else _seed_identity(partial=identity == "partial")
    )
    files[f"instruments/listing/{PART}"] = listing
    files[f"instruments/symbol_history/{PART}"] = history
    files[f"corporate_actions/{PART}"] = _corporate_actions()

    entries = []
    for rel, table in sorted(files.items()):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, path, compression="snappy")
        body = path.read_bytes()
        entries.append(
            {
                "path": rel,
                "bytes": len(body),
                "checksum": {"algo": "crc32c", "value": _crc32c(body)},
                "sha256": hashlib.sha256(body).hexdigest(),
            }
        )

    if with_manifest:
        policies = {r["adjustment_policy_version"] for r in d1}
        (root / "manifest.json").write_text(
            json.dumps(
                {
                    "manifestVersion": 1,
                    "releaseId": release_id,
                    "env": env,
                    "snapshotAt": "2026-09-23T00:00:00.000Z",
                    "gitSha": "fixture",
                    "adjustmentPolicy": policies.pop() if len(policies) == 1 else None,
                    "universeRule": "fixture: B4's six listings",
                    "calendars": ["XNYS (US, 04:00-20:00 ET sessions)"],
                    "licence": ["fixture data, not market data"],
                    "rowCounts": {
                        "bars_d1": len(d1),
                        "bars_m1": len(M1_BARS),
                        "corporate_actions": 1,
                        "instruments/listing": listing.num_rows,
                        "instruments/symbol_history": history.num_rows,
                    },
                    "files": entries,
                },
                indent=2,
            )
        )
    return root


def _group(items: list[Any], key: Callable[[Any], Any]) -> list[tuple[Any, list[Any]]]:
    out: dict[Any, list[Any]] = {}
    for item in items:
        out.setdefault(key(item), []).append(item)
    return sorted(out.items())


def cold_shard_rows(
    timeframe: str, edit: Callable[[list[dict[str, Any]]], None] | None = None
) -> dict[tuple[str, int], list[dict[str, Any]]]:
    """The release's RAW bars as cold-shard rows (`ColdShardRow`), keyed (symbol, year).

    The same bars the release was built from, in the shape the cold path reads —
    so the two readers can be compared on ONE input. A D1 bar's `t` is its
    session date at 00:00Z, which is how Tiingo D1 is stored; an M1 bar's is its
    open instant, and it carries no corporate action (`d` 0, `sf` 1).
    """
    out: dict[tuple[str, int], list[dict[str, Any]]] = {}
    if timeframe == "D1":
        d1 = [dict(r) for r in gold_rows()]
        if edit is not None:
            edit(d1)  # the SAME doctoring `build_release(edit_d1=)` applies
        for r in d1:
            out.setdefault((r["symbol"], int(r["session_date"][:4])), []).append(
                {
                    "s": r["symbol"],
                    "x": r["exchange"],
                    "tf": "D1",
                    "t": f"{r['session_date']}T00:00:00.000Z",
                    "l": r["listing_id"],
                    "o": r["open"],
                    "h": r["high"],
                    "lo": r["low"],
                    "c": r["close"],
                    "v": r["volume"],
                    "d": r["div_cash"],
                    "sf": r["split_factor"],
                    "src": r["source"],
                }
            )
        return out
    for symbol, _, ts, o, h, lo, c, v in M1_BARS:
        out.setdefault((symbol, int(ts[:4])), []).append(
            {
                "s": symbol,
                "x": "NASDAQ",
                "tf": "M1",
                "t": f"{ts}:00.000Z",
                "l": f"{symbol}:NASDAQ:2020-01-02",
                "o": o,
                "h": h,
                "lo": lo,
                "c": c,
                "v": v,
                "d": 0.0,
                "sf": 1.0,
                "src": "DATABENTO",
            }
        )
    return out
