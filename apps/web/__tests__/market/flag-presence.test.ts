/**
 * A never-seeded `PlatformConfig` row and one deliberately set to false are the
 * same value at every reader, and QA sat unconfigured because of it. MONEY-1484.
 *
 * These pin the two things that make the report worth having: it fires ONLY on
 * a genuinely absent row, and it does not repeat. An un-deduped warn behind a
 * 30s cache puts a line in the log for every render in an environment that is
 * merely unconfigured, which is how a real signal gets filtered out.
 *
 * They drive `flag-presence-logic.ts` rather than `flag-presence.ts` because
 * the latter carries `import "server-only"`, whose default export THROWS
 * outside a React Server Component — which is exactly what makes that anchor
 * worth having, and exactly why the decision was split out. The last case here
 * checks the anchor is still on the shell, since losing it is silent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  flagAbsenceMessage,
  shouldReportFlagAbsence,
} from "../../lib/market/flag-presence-logic";

describe("shouldReportFlagAbsence", () => {
  it("reports when the row is absent", () => {
    const seen = new Set<string>();
    assert.equal(
      shouldReportFlagAbsence("MARKET_DATA_QUOTES", true, seen),
      true
    );
  });

  it("stays SILENT when a row exists — even one set to false", () => {
    // The whole point: a deliberate off is not a defect and must not be noise.
    const seen = new Set<string>();
    assert.equal(
      shouldReportFlagAbsence("MARKET_DATA_QUOTES", false, seen),
      false
    );
    assert.equal(seen.size, 0, "a present read must record nothing");
  });

  it("reports ONCE per key, not once per render", () => {
    const seen = new Set<string>();
    const calls = [1, 2, 3].map(() =>
      shouldReportFlagAbsence("MARKET_DATA_TILES", true, seen)
    );
    assert.deepEqual(calls, [true, false, false]);
  });

  it("tracks keys independently — one seeded flag does not mask another", () => {
    const seen = new Set<string>();
    assert.equal(
      shouldReportFlagAbsence("MARKET_DATA_TILES", true, seen),
      true
    );
    assert.equal(
      shouldReportFlagAbsence("MARKET_DATA_INTRADAY", true, seen),
      true
    );
  });

  it("a PRESENT read does not consume the key's one report", () => {
    const seen = new Set<string>();
    shouldReportFlagAbsence("MARKET_DATA_QUOTES", false, seen); // silent
    assert.equal(
      shouldReportFlagAbsence("MARKET_DATA_QUOTES", true, seen),
      true,
      "a row deleted after boot would otherwise never be reported"
    );
  });
});

describe("flagAbsenceMessage", () => {
  it("names the key and the command that fixes it", () => {
    const msg = flagAbsenceMessage("MARKET_DATA_QUOTES");
    assert.match(msg, /MARKET_DATA_QUOTES/);
    assert.match(msg, /NO ROW/);
    assert.match(
      msg,
      /set-market-data-flags/,
      "an operator reading this must be told what to run"
    );
  });
});

describe("the flag-presence shell stays server-only", () => {
  it("declares the anchor its two importers also carry", () => {
    // Process-global state plus an internal ops command path. Without the
    // anchor a client component can bundle both for the browser with no error:
    // `warned` becomes per-TAB so the dedupe silently stops working, and the
    // command is printed into a visitor's console.
    // A URL relative to THIS file, not `import.meta.dirname` (undefined under
    // tsx here) and not a cwd-relative path — a path that throws inside the
    // callback is reported as a dropped suite with `fail 0`, so the guard
    // would silently disappear instead of failing.
    const src = readFileSync(
      new URL("../../lib/market/flag-presence.ts", import.meta.url),
      "utf-8"
    );
    assert.match(src, /^import ["']server-only["'];/m);
  });
});
