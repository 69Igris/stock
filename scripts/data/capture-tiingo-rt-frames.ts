/**
 * Capture live Tiingo equity-realtime websocket frames into test fixtures.
 *
 * ## Why this script exists at all
 *
 * The decoder in `tiingo-realtime-logic.ts` reads its payloads POSITIONALLY,
 * and Tiingo's documentation does not give a field-by-field layout for these
 * arrays. Guessing is not an option here: the same vendor's EOD CSV is
 * documented `date,open,high,low,close` and is really
 * `date,close,high,low,open`, so a positional parser written from that page
 * silently swaps open and close on every US security. The layout is therefore
 * derived from captured bytes, and the captured bytes are checked in.
 *
 * Re-run this when the feed changes shape, and let the suite tell you what
 * moved — `tiingo-realtime-logic.test.ts` re-derives `(ask-bid)/mid` against
 * the reported spread across the whole corpus, so a re-ordering fails loudly.
 *
 * ## Usage
 *
 *   TIINGO_API_KEY=... npx tsx scripts/data/capture-tiingo-rt-frames.ts --level=4
 *   TIINGO_API_KEY=... npx tsx scripts/data/capture-tiingo-rt-frames.ts --level=6 --seconds=60
 *
 * Capture during REGULAR TRADING HOURS. Outside 09:30-16:00 ET the consolidated
 * feed still runs (its day is 04:00-20:00 ET) but quotes are sparse, and a thin
 * corpus is a weak contract — the suite requires >= 50 data frames per level and
 * will fail rather than pin a layout on a handful of samples.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  TIINGO_RT_WS_URL,
  buildSubscribePayload,
} from "../../packages/core/src/market-data/tiingo/tiingo-realtime-logic";

const argv = process.argv.slice(2);
const val = (f: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`${f}=`));
  return hit ? hit.slice(f.length + 1) : null;
};

/** The suite's floor. A capture below this is refused rather than written. */
const MIN_DATA_FRAMES = 50;

const level = Number(val("--level") ?? "4");
const seconds = Number(val("--seconds") ?? "30");
const tickers = (val("--tickers") ?? "aapl,msft,nvda,spy,tsla").split(",");
const outDir = join(
  // `fileURLToPath`, not `new URL(...).pathname`: the latter leaves percent
  // escapes in place, so a checkout under a path containing a space resolves to
  // a directory with a literal `%20` in it — and on Windows it yields a leading
  // slash before the drive letter.
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "core",
  "__tests__",
  "fixtures",
  "tiingo-realtime",
);
const out = join(outDir, `equity-intraday-level${level}.json`);

const token = process.env.TIINGO_API_KEY;
if (!token) {
  console.error("TIINGO_API_KEY is required. This script talks to the live feed.");
  process.exit(1);
}

const frames: unknown[] = [];
const ws = new WebSocket(TIINGO_RT_WS_URL);

function finish(): never {
  const data = frames.filter(
    (f) => (f as { messageType?: string }).messageType === "A",
  ).length;

  // COUNT AND REFUSE BEFORE WRITING. This used to write first and warn second,
  // so running it outside regular trading hours — when the feed sends almost
  // nothing — silently replaced the checked-in corpus with a handful of
  // heartbeats, and the warning scrolled past. That corpus is the ONLY evidence
  // for the level-4 column layout; the suite re-derives (ask-bid)/mid against
  // it precisely because this vendor's EOD CSV is documented in one column
  // order and served in another. Overwriting it with a thin capture would
  // quietly retire the tripwire rather than fail anything.
  if (data < MIN_DATA_FRAMES && !argv.includes("--force")) {
    console.error(
      `REFUSING TO WRITE: only ${data} data frames (need >= ${MIN_DATA_FRAMES}).\n` +
        `  ${out} is UNCHANGED.\n` +
        "  The feed is quiet outside regular trading hours (09:30-16:00 ET).\n" +
        "  Capture again during a session, or pass --force to overwrite anyway.",
    );
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, `${JSON.stringify(frames, null, 2)}\n`);
  console.log(`${out}\n  ${frames.length} frames (${data} data)`);
  if (data < MIN_DATA_FRAMES) {
    console.warn(
      `  WROTE A THIN CORPUS UNDER --force: ${data} data frames. The suite ` +
        "requires >= 50 and will fail until this is recaptured.",
    );
  }
  process.exit(0);
}

const timer = setTimeout(finish, seconds * 1000);

ws.on("open", () => {
  // `buildSubscribePayload` refuses a thresholdLevel this account cannot use,
  // so a typo here fails immediately rather than producing the 400 that reads
  // like an entitlement rejection.
  ws.send(JSON.stringify(buildSubscribePayload({ token, tickers, thresholdLevel: level })));
});
ws.on("message", (d: Buffer) => {
  try {
    frames.push(JSON.parse(d.toString()));
  } catch {
    // A frame we cannot even JSON-parse is still evidence; keep the raw text.
    frames.push({ _unparseable: d.toString().slice(0, 500) });
  }
  if (frames.length >= 500) {
    clearTimeout(timer);
    finish();
  }
});
ws.on("error", (e: Error) => {
  clearTimeout(timer);
  console.error("websocket error:", e.message);
  process.exit(1);
});
