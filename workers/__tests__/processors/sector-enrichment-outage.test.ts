/**
 * MONEY-1238 (#7) — the worker fetcher, against fixtures, with no network.
 *
 * `yahooFetchQuoteSummary` catches every error and returns `null`, so this
 * fetcher's own `catch` was DEAD for network faults: a Yahoo outage arrived as
 * `null`, `enrichSectors` wrote the permanent `SECTOR_SKIPPED` sentinel, and
 * the job logged `failed=0`. `makeYahooSectorFetcher` takes the quoteSummary
 * call as a parameter so the outage/absence split runs against the REAL
 * production body rather than a copy of it.
 *
 * Source: workers/src/processors/sector-enrichment.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  makeYahooSectorFetcher,
  type QuoteSummaryFetch,
} from "../../src/processors/sector-enrichment";
import {
  SECTOR_SKIPPED,
  isSectorFetchUnavailable,
  decideFetchOutcome,
  decideErrorOutcome,
  type EnrichableInstrument,
  type EnrichmentOutcome,
} from "@usemoney/core/market-data/instruments/sector-enrichment-logic";

/** A fetch that fails the way `yahooFetch` does: reports via onError, returns null. */
function failing(message: string): QuoteSummaryFetch {
  return async (_symbol, _modules, opts) => {
    opts?.onError?.(new Error(message), "fetchQuoteSummary");
    return null;
  };
}

/** A fetch that SUCCEEDS and returns the given quoteSummary result body. */
function returning(body: Record<string, unknown> | null): QuoteSummaryFetch {
  return async () => body;
}

// ═══════════════════════════════════════════════════════════════════════════
// The fetcher's three states
// ═══════════════════════════════════════════════════════════════════════════

describe("makeYahooSectorFetcher separates an outage from an absence", () => {
  it("a 5xx THROWS a tagged unavailable error — it does not return null", () => {
    const fetch = makeYahooSectorFetcher(
      failing("Yahoo Finance API error: 503 Service Unavailable"),
    );
    return assert.rejects(
      () => fetch("DLF.NS"),
      (err: unknown) => {
        assert.equal(isSectorFetchUnavailable(err), true);
        return true;
      },
    );
  });

  it("a 403 egress block THROWS too — the failure that hid for five months", () => {
    const fetch = makeYahooSectorFetcher(
      failing("Yahoo Finance API error: 403 Forbidden"),
    );
    return assert.rejects(fetch("DLF.NS"), (err: unknown) =>
      isSectorFetchUnavailable(err),
    );
  });

  it("a timeout and a network fault THROW", async () => {
    for (const msg of [
      "Yahoo Finance API request timed out after 15000ms",
      "Yahoo Finance API network error: fetch failed",
      "Yahoo Finance API: max retries exceeded",
    ]) {
      await assert.rejects(makeYahooSectorFetcher(failing(msg))("DLF.NS"));
    }
  });

  it("a 404 throws RAW, so the permanent-skip rule still reaches it", async () => {
    const fetch = makeYahooSectorFetcher(
      failing("Yahoo Finance API error: 404 Not Found"),
    );
    await assert.rejects(fetch("DLF.NS"), (err: unknown) => {
      assert.equal(isSectorFetchUnavailable(err), false);
      return true;
    });
  });

  it("the legacy 'no fundamentals' shape returns null, not a throw", async () => {
    assert.equal(
      await makeYahooSectorFetcher(failing("No fundamentals data found"))(
        "NIFTYBEES.NS",
      ),
      null,
    );
  });

  it("a 200 with no assetProfile returns null — a real, writable absence", async () => {
    assert.equal(await makeYahooSectorFetcher(returning({}))("DLF.NS"), null);
    assert.equal(await makeYahooSectorFetcher(returning(null))("DLF.NS"), null);
  });

  it("a 200 with a profile returns the SectorData", async () => {
    assert.deepEqual(
      await makeYahooSectorFetcher(
        returning({ assetProfile: { sector: "Realty", industry: "REIT" } }),
      )("DLF.NS"),
      { sector: "Realty", industry: "REIT" },
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// End to end through the REAL decision functions: the counters
// ═══════════════════════════════════════════════════════════════════════════

const BATCH: EnrichableInstrument[] = Array.from({ length: 4 }, (_, i) => ({
  id: `id-${i}`,
  symbol: `SYM${i}`,
  exchange: "NSE",
  yahooSymbol: `SYM${i}.NS`,
}));

/** `enrichSectors`' per-instrument body, over the real fetcher + decisions. */
async function run(fetchSummary: QuoteSummaryFetch) {
  const fetcher = makeYahooSectorFetcher(fetchSummary);
  const counters = { enriched: 0, skipped: 0, failed: 0 };
  const writes: Array<{ id: string; sector: string }> = [];
  for (const instrument of BATCH) {
    let outcome: EnrichmentOutcome;
    try {
      outcome = decideFetchOutcome(
        instrument,
        await fetcher(instrument.yahooSymbol),
      );
    } catch (error) {
      outcome = decideErrorOutcome(instrument, error);
    }
    if (outcome.kind === "enriched") {
      if (outcome.update) writes.push(outcome.update);
      counters.enriched++;
    } else if (outcome.kind === "skipped") {
      if (outcome.update) writes.push(outcome.update);
      counters.skipped++;
    } else {
      counters.failed++;
    }
  }
  return { counters, writes };
}

describe("the job's counters tell an outage from a profileless batch", () => {
  it("OUTAGE: failed=4, skipped=0, ZERO writes", async () => {
    const { counters, writes } = await run(
      failing("Yahoo Finance API error: 503 Service Unavailable"),
    );
    assert.deepEqual(counters, { enriched: 0, skipped: 0, failed: 4 });
    assert.equal(writes.length, 0, "an outage wrote a permanent N/A");
  });

  it("PROFILELESS ETFs: skipped=4, failed=0, four N/A writes", async () => {
    const { counters, writes } = await run(returning({}));
    assert.deepEqual(counters, { enriched: 0, skipped: 4, failed: 0 });
    assert.equal(writes.length, 4);
    assert.ok(writes.every((w) => w.sector === SECTOR_SKIPPED));
  });

  it("404s are SKIPPED, not failed — a dead symbol must not be re-fetched forever", async () => {
    const { counters, writes } = await run(
      failing("Yahoo Finance API error: 404 Not Found"),
    );
    assert.deepEqual(counters, { enriched: 0, skipped: 4, failed: 0 });
    assert.equal(writes.length, 4);
  });

  it("the outage and the ETF batch no longer report the same thing", async () => {
    const outage = await run(
      failing("Yahoo Finance API error: 503 Service Unavailable"),
    );
    const etfs = await run(returning({}));
    assert.notDeepEqual(outage.counters, etfs.counters);
    assert.notEqual(outage.writes.length, etfs.writes.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The processor must actually USE the seam (structural)
// ═══════════════════════════════════════════════════════════════════════════

describe("the production path runs the same fetcher the tests do", () => {
  const RAW = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "processors",
      "sector-enrichment.ts",
    ),
    "utf8",
  );
  /** LINE comments first, then BLOCK comments (repo guard, MONEY-1143). */
  const SRC = RAW.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("the default fetcher is the factory's default, not a second copy", () => {
    assert.match(SRC, /const yahooSectorFetcher = makeYahooSectorFetcher\(\);/);
    assert.equal(
      (SRC.match(/yahooFetchQuoteSummary\(/g) ?? []).length,
      0,
      "a direct call site would bypass the injected seam",
    );
    assert.match(
      SRC,
      /fetchSummary: QuoteSummaryFetch = yahooFetchQuoteSummary/,
    );
  });

  it("the onError observer is what captures the swallowed error", () => {
    // `yahooFetchQuoteSummary` never throws, so without this the transport
    // failure is unobservable and the fetcher's own catch is dead code.
    assert.match(SRC, /onError:\s*\(error\)\s*=>\s*\{/);
    assert.match(SRC, /throw toSectorFetchError\(yahooSymbol, swallowed\)/);
  });

  it("the completion log distinguishes failed (unwritten) from skipped (written)", () => {
    assert.match(SRC, /if \(result\.failed > 0\)/);
    assert.match(SRC, /failed=\$\{result\.failed\}/);
  });
});
