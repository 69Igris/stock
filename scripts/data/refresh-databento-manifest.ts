/**
 * Refresh the Databento manifest's S&P baseline from SSGA's SPY holdings —
 * MONEY-1373.
 *
 * DRY RUN IS THE DEFAULT. `--apply` is a BARE flag, never `--apply=true`
 * (MONEY-1252: a wrapper that forwarded `--flag=value` had its `--apply`
 * swallowed and a 54-minute "apply" run wrote nothing while exiting 0).
 *
 * ## Why this exists rather than reusing something
 *
 * The plan this implements said to take the S&P baseline from
 * `tiingo-rt-subscription-logic.ts`. That was a false premise, checked and
 * found wrong: the realtime base set is holdings + watchlists +
 * `ALWAYS_SUBSCRIBED = ["SPY","QQQ","DIA","IWM"]` (`subscription.ts`), and the
 * only S&P list anywhere in this repo is the QA fixture universe, which a core
 * guard forbids production code from touching.
 *
 * So the list is a versioned artefact in `scripts/data/databento-manifest.json`
 * and this script regenerates it. Checked in rather than fetched at run time
 * for the reason every manifest here is checked in: what we BUY should be a
 * reviewable diff, not a list that changes under a job on the day State Street
 * rebalances.
 *
 * ## What it refuses to do
 *
 * - Write a list outside 480..520 symbols. The S&P 500 is ~503 after share
 *   classes; anything else means the workbook layout moved and the parse is
 *   reading the wrong column.
 * - Keep a row that is not ticker-shaped. The live workbook carries a bare "-"
 *   and a SEDOL-shaped "2602335D"; both would resolve to no listing and
 *   quarantine every bar they produced. They are DROPPED and REPORTED, never
 *   silently filtered — a filter that removes rows without saying so is how a
 *   layout change becomes a quietly smaller universe.
 * - Run at all without `--apply` writing anything.
 *
 * ## Usage
 *
 *   node --import tsx scripts/data/refresh-databento-manifest.ts            # dry run
 *   node --import tsx scripts/data/refresh-databento-manifest.ts --apply
 *
 * Founder-run. It touches no database and spends nothing; the only network call
 * is one public XLSX from ssga.com.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as XLSX from "xlsx";

import { parseManifest } from "@usemoney/core/market-data/databento/databento-manifest-logic";

/**
 * The daily holdings workbook.
 *
 * The `/us/en/intermediary/...` path 301-redirects here; this is the settled
 * URL, measured (200, ~54 KB, `application/vnd.openxmlformats-...sheet`). A
 * browser-like User-Agent is sent because the CDN in front of it does not serve
 * a default agent reliably.
 */
const SSGA_SPY_HOLDINGS_URL =
  "https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx";

const MANIFEST_PATH = join("scripts", "data", "databento-manifest.json");

/** After conversion to OUR notation. `BRK-B` passes; `2602335D` does not. */
const TICKER = /^[A-Z]{1,5}(-[A-Z])?$/;

const MIN_CONSTITUENTS = 480;
const MAX_CONSTITUENTS = 520;
const TOP_N = 50;

const argv = process.argv.slice(2);
for (const a of argv) {
  if (a !== "--apply") {
    console.error(
      `Unknown argument "${a}". The only flag is --apply, and it is BARE ` +
        "(never --apply=true).",
    );
    process.exit(1);
  }
}
const APPLY = argv.includes("--apply");

/** SSGA publishes the Nasdaq dot form; our master keys on the dash form. */
function toOurNotation(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/^([A-Z0-9]+)\.([A-Z])$/, "$1-$2");
}

interface Holding {
  ticker: string;
  weight: number;
}

function parseHoldings(buf: Buffer): { asOf: string; rows: Holding[]; dropped: string[] } {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  if (sheetName === undefined) throw new Error("the workbook has no sheets");
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName]!, {
    header: 1,
    blankrows: false,
  });

  // The header is NOT row 0 — the file opens with fund name, ticker and an
  // "As of" line. Find it by content rather than by index, so an extra
  // preamble row does not silently shift every column.
  const headerIdx = grid.findIndex(
    (r) => Array.isArray(r) && r.some((c) => String(c).trim() === "Ticker"),
  );
  if (headerIdx === -1) {
    throw new Error(
      "no header row containing 'Ticker' — the workbook layout has changed, " +
        "and guessing a column index here would produce a plausible wrong list",
    );
  }
  const header = (grid[headerIdx] ?? []).map((h) => String(h).trim());
  const tickerCol = header.indexOf("Ticker");
  const weightCol = header.indexOf("Weight");
  if (tickerCol === -1 || weightCol === -1) {
    throw new Error(`header lacks Ticker/Weight: ${header.join(",")}`);
  }

  const asOfRow = grid
    .slice(0, headerIdx)
    .map((r) => (Array.isArray(r) ? r.map(String).join(" ") : ""))
    .find((t) => /as of/i.test(t));

  const rows: Holding[] = [];
  const dropped: string[] = [];
  for (const r of grid.slice(headerIdx + 1)) {
    if (!Array.isArray(r)) continue;
    const raw = String(r[tickerCol] ?? "").trim();
    if (raw === "") continue;
    const ticker = toOurNotation(raw);
    if (!TICKER.test(ticker)) {
      dropped.push(raw);
      continue;
    }
    const weight = Number(r[weightCol]);
    rows.push({ ticker, weight: Number.isFinite(weight) ? weight : 0 });
  }
  return { asOf: (asOfRow ?? "").trim(), rows, dropped };
}

async function main(): Promise<void> {
  console.log(`[refresh-manifest] fetching ${SSGA_SPY_HOLDINGS_URL}`);
  const res = await fetch(SSGA_SPY_HOLDINGS_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*",
    },
  });
  if (!res.ok) {
    throw new Error(`SSGA returned ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[refresh-manifest] ${buf.length} bytes`);

  const { asOf, rows, dropped } = parseHoldings(buf);
  console.log(`[refresh-manifest] ${asOf || "(no as-of line)"}`);
  if (dropped.length > 0) {
    // REPORTED, never silent. A row the parser cannot use is either a known
    // non-ticker (cash, a pending line) or the first sign of a layout change,
    // and only a human can tell which.
    console.log(
      `[refresh-manifest] dropped ${dropped.length} non-ticker row(s): ` +
        dropped.join(", "),
    );
  }

  const baseline = [...new Set(rows.map((r) => r.ticker))].sort();
  if (baseline.length < MIN_CONSTITUENTS || baseline.length > MAX_CONSTITUENTS) {
    throw new Error(
      `parsed ${baseline.length} constituents, outside ${MIN_CONSTITUENTS}..` +
        `${MAX_CONSTITUENTS}. The S&P 500 is ~503 after share classes, so this ` +
        "means the layout moved and the parse is reading the wrong column. " +
        "Refusing to write a manifest that would buy the wrong universe.",
    );
  }
  const top50 = [...rows]
    .sort((a, b) => b.weight - a.weight)
    .map((r) => r.ticker)
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, TOP_N);

  const current = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const sets = current["symbolSets"] as Record<string, unknown>;
  const previous = Array.isArray(sets["BASELINE"]) ? (sets["BASELINE"] as string[]) : [];

  const added = baseline.filter((s) => !previous.includes(s));
  const removed = previous.filter((s) => !baseline.includes(s));
  console.log(
    `[refresh-manifest] baseline ${previous.length} -> ${baseline.length} ` +
      `(+${added.length} / -${removed.length})`,
  );
  if (added.length > 0) console.log(`  added:   ${added.join(", ")}`);
  if (removed.length > 0) console.log(`  removed: ${removed.join(", ")}`);

  if (!APPLY) {
    console.log(
      "[refresh-manifest] DRY RUN — pass --apply (bare flag) to write. " +
        "Nothing was changed.",
    );
    return;
  }

  sets["BASELINE"] = baseline;
  sets["TOP50"] = top50;
  current["version"] = (Number(current["version"]) || 0) + 1;
  current["updatedAt"] = new Date().toISOString().slice(0, 10);
  current["_generated"] =
    `BASELINE and TOP50 come from SSGA's SPY holdings workbook (${asOf}), ` +
    "converted from the vendor dot form (BRK.B) to our master dash form " +
    "(BRK-B) by scripts/data/refresh-databento-manifest.ts." +
    (dropped.length > 0
      ? ` Non-ticker rows dropped and reported: ${dropped.join(", ")}.`
      : "");

  // Validate BEFORE writing. A manifest that fails its own schema would be
  // found by the next test run rather than by this script, which is one commit
  // too late.
  parseManifest(current);

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `[refresh-manifest] wrote ${MANIFEST_PATH} at version ${String(current["version"])}`,
  );
}

void main().catch((err: unknown) => {
  console.error(
    `[refresh-manifest] FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exitCode = 1;
});
