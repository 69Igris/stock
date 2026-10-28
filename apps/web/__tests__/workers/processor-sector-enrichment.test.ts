/**
 * Sector Enrichment Processor Tests (workers/src/processors/sector-enrichment.ts) — DE-SHADOWED.
 *
 * The previous version SHADOWED the processor: it declared a local
 * `async function processSectorEnrichment` "(mirrors ...sector-enrichment.ts)"
 * AND a local `yahooSectorFetcher`, asserting the COPIES. Worse, the copy had
 * DIVERGED from production — the shadow defaulted `batchSize=100`,
 * `exchanges=["NSE"]`, `delayMs=2000`, while the REAL source defaults
 * `batchSize=500`, `exchanges=["NSE","BSE"]`, `delayMs=500`. The suite was green
 * asserting the WRONG defaults (the same defaults-divergence class the
 * processors.test de-shadow called out).
 *
 * This rewrite asserts ONLY real shipped code: the pure helpers exported from
 * `workers/src/processors/sector-enrichment-logic.ts`, which `sector-enrichment.ts`
 * now CALLS — `resolveSectorEnrichmentOptions` (the CORRECTED defaults),
 * `parseSectorFromProfile` (the assetProfile→SectorData mapping = the body of
 * `yahooSectorFetcher`), `isMissingFundamentalsError` (the ETF/index error
 * classification = the catch branch), and `capSectorErrorsForLog`. The processor
 * boots the `enrichSectors` Prisma pipeline + Yahoo at module load, so it can't
 * run in a pure unit test; the orchestration harness mirrors its option-passing
 * and the fetcher's success/error split via the SAME real exports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker orchestration helpers under test (no shadow). sector-enrichment.ts CALLS these.
import {
  resolveSectorEnrichmentOptions,
  parseSectorFromProfile,
  isMissingFundamentalsError,
  capSectorErrorsForLog,
  DEFAULT_SECTOR_BATCH_SIZE,
  DEFAULT_SECTOR_EXCHANGES,
  DEFAULT_SECTOR_DELAY_MS,
  SECTOR_ERROR_LOG_CAP,
} from "../../../../workers/src/processors/sector-enrichment-logic";

// ══════════════════════════════════════════════════════════════════════
// resolveSectorEnrichmentOptions — the CORRECT defaults (real export)
//
// These four assertions are the regression for the shadow's defaults-divergence:
// the SHIPPED defaults are 500 / ["NSE","BSE"] / 500 / false — NOT the 100 /
// ["NSE"] / 2000 the old inline copy asserted.
// ══════════════════════════════════════════════════════════════════════

describe("sector-enrichment-logic.resolveSectorEnrichmentOptions defaults (real export)", () => {
  it("defaults batchSize to 500 (NOT the shadow's 100)", () => {
    assert.strictEqual(resolveSectorEnrichmentOptions({}).batchSize, 500);
    assert.strictEqual(DEFAULT_SECTOR_BATCH_SIZE, 500);
  });

  it("defaults exchanges to ['NSE','BSE'] (NOT the shadow's ['NSE'])", () => {
    assert.deepStrictEqual(resolveSectorEnrichmentOptions({}).exchanges, [
      "NSE",
      "BSE",
    ]);
    assert.deepStrictEqual(DEFAULT_SECTOR_EXCHANGES, ["NSE", "BSE"]);
  });

  it("defaults delayMs to 500 (NOT the shadow's 2000)", () => {
    assert.strictEqual(resolveSectorEnrichmentOptions({}).delayMs, 500);
    assert.strictEqual(DEFAULT_SECTOR_DELAY_MS, 500);
  });

  it("defaults forceReEnrich to false", () => {
    assert.strictEqual(resolveSectorEnrichmentOptions({}).forceReEnrich, false);
  });
});

describe("sector-enrichment-logic.resolveSectorEnrichmentOptions custom (real export)", () => {
  it("passes a custom batchSize through", () => {
    assert.strictEqual(
      resolveSectorEnrichmentOptions({ batchSize: 50 }).batchSize,
      50
    );
  });

  it("passes custom exchanges through", () => {
    assert.deepStrictEqual(
      resolveSectorEnrichmentOptions({ exchanges: ["NSE", "BSE", "MCX"] })
        .exchanges,
      ["NSE", "BSE", "MCX"]
    );
  });

  it("preserves a provided-but-empty exchanges array", () => {
    assert.deepStrictEqual(
      resolveSectorEnrichmentOptions({ exchanges: [] }).exchanges,
      []
    );
  });

  it("passes forceReEnrich=true through", () => {
    assert.strictEqual(
      resolveSectorEnrichmentOptions({ forceReEnrich: true }).forceReEnrich,
      true
    );
  });

  it("passes a custom delayMs through", () => {
    assert.strictEqual(
      resolveSectorEnrichmentOptions({ delayMs: 5000 }).delayMs,
      5000
    );
  });

  it("resolves all four custom options together", () => {
    const opts = resolveSectorEnrichmentOptions({
      batchSize: 25,
      exchanges: ["BSE"],
      forceReEnrich: true,
      delayMs: 3000,
    });
    assert.strictEqual(opts.batchSize, 25);
    assert.deepStrictEqual(opts.exchanges, ["BSE"]);
    assert.strictEqual(opts.forceReEnrich, true);
    assert.strictEqual(opts.delayMs, 3000);
  });

  it("returns a fresh exchanges array (not a shared reference to the default)", () => {
    const a = resolveSectorEnrichmentOptions({});
    resolveSectorEnrichmentOptions({}); // second call must be unaffected
    a.exchanges.push("MUTATED");
    assert.deepStrictEqual(resolveSectorEnrichmentOptions({}).exchanges, [
      "NSE",
      "BSE",
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// parseSectorFromProfile — the assetProfile → SectorData mapping (real export)
// (this is the success-path body of the processor's yahooSectorFetcher)
// ══════════════════════════════════════════════════════════════════════

describe("sector-enrichment-logic.parseSectorFromProfile (real export)", () => {
  it("returns sector + industry from a full assetProfile", () => {
    assert.deepStrictEqual(
      parseSectorFromProfile({
        sector: "Technology",
        industry: "Software - Infrastructure",
      }),
      { sector: "Technology", industry: "Software - Infrastructure" }
    );
  });

  it("collapses a missing sector to null", () => {
    const r = parseSectorFromProfile({ industry: "Banking" });
    assert.strictEqual(r!.sector, null);
    assert.strictEqual(r!.industry, "Banking");
  });

  it("collapses a missing industry to null", () => {
    const r = parseSectorFromProfile({ sector: "Financial Services" });
    assert.strictEqual(r!.sector, "Financial Services");
    assert.strictEqual(r!.industry, null);
  });

  it("returns {sector:null, industry:null} for an empty profile", () => {
    assert.deepStrictEqual(parseSectorFromProfile({}), {
      sector: null,
      industry: null,
    });
  });

  it("returns null when the profile is null (no assetProfile module)", () => {
    assert.strictEqual(parseSectorFromProfile(null), null);
  });

  it("returns null when the profile is undefined", () => {
    assert.strictEqual(parseSectorFromProfile(undefined), null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// isMissingFundamentalsError — the benign ETF/index error class (real export)
// (this is the catch-branch classification in yahooSectorFetcher)
// ══════════════════════════════════════════════════════════════════════

describe("sector-enrichment-logic.isMissingFundamentalsError (real export)", () => {
  it("treats 'not found' as benign (→ null, ETF/index)", () => {
    assert.strictEqual(
      isMissingFundamentalsError(new Error("Symbol not found")),
      true
    );
  });

  it("treats 'No fundamentals' as benign (→ null, index)", () => {
    assert.strictEqual(
      isMissingFundamentalsError(new Error("No fundamentals data available")),
      true
    );
  });

  it("does NOT swallow a network timeout", () => {
    assert.strictEqual(
      isMissingFundamentalsError(new Error("Network timeout")),
      false
    );
  });

  it("does NOT swallow a server error", () => {
    assert.strictEqual(
      isMissingFundamentalsError(new Error("Internal server error")),
      false
    );
  });

  it("handles a non-Error thrown value without crashing", () => {
    assert.strictEqual(
      isMissingFundamentalsError("not found in catalog"),
      true
    );
    assert.strictEqual(isMissingFundamentalsError(null), false);
    assert.strictEqual(isMissingFundamentalsError(undefined), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// capSectorErrorsForLog (real export)
// ══════════════════════════════════════════════════════════════════════

describe("sector-enrichment-logic.capSectorErrorsForLog (real export)", () => {
  it("caps a long error list at SECTOR_ERROR_LOG_CAP", () => {
    const errs = Array.from({ length: 40 }, (_, i) => `e-${i}`);
    assert.strictEqual(
      capSectorErrorsForLog(errs).length,
      SECTOR_ERROR_LOG_CAP
    );
  });

  it("returns a short list unchanged", () => {
    assert.deepStrictEqual(capSectorErrorsForLog(["x"]), ["x"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors the processor's option-passing into
// enrichSectors AND the fetcher's success/error split, via the SAME real
// exports. (The real processor boots enrichSectors + Yahoo at import.)
// ══════════════════════════════════════════════════════════════════════

interface EnrichResultFixture {
  totalProcessed: number;
  enriched: number;
  failed: number;
  skipped: number;
  errors: string[];
}

interface SectorDataLike {
  sector: string | null;
  industry: string | null;
}

/** The real fetcher body: success → parseSectorFromProfile, error → classify. */
function yahooSectorFetcherLikeProcessor(
  fetch: () => { assetProfile?: { sector?: string; industry?: string } } | null
): SectorDataLike | null {
  try {
    const result = fetch();
    if (!result) return null;
    return parseSectorFromProfile(result.assetProfile);
  } catch (error) {
    if (isMissingFundamentalsError(error)) return null;
    throw error;
  }
}

async function runSectorEnrichmentSequence(
  data: {
    batchSize?: number;
    exchanges?: string[];
    forceReEnrich?: boolean;
    delayMs?: number;
  },
  enrichSectors: (
    fetcher: (sym: string) => Promise<SectorDataLike | null>,
    opts: {
      batchSize: number;
      delayMs: number;
      exchanges: string[];
      forceReEnrich: boolean;
    }
  ) => Promise<EnrichResultFixture>
): Promise<EnrichResultFixture> {
  const { batchSize, exchanges, forceReEnrich, delayMs } =
    resolveSectorEnrichmentOptions(data);
  return enrichSectors(async () => null, {
    batchSize,
    delayMs,
    exchanges,
    forceReEnrich,
  });
}

const EMPTY_ENRICH: EnrichResultFixture = {
  totalProcessed: 0,
  enriched: 0,
  failed: 0,
  skipped: 0,
  errors: [],
};

describe("sector-enrichment orchestration sequence (real exports)", () => {
  it("forwards the CORRECT default options into enrichSectors", async () => {
    let captured: {
      batchSize: number;
      delayMs: number;
      exchanges: string[];
      forceReEnrich: boolean;
    } | null = null;
    await runSectorEnrichmentSequence({}, async (_f, opts) => {
      captured = opts;
      return EMPTY_ENRICH;
    });

    assert.strictEqual(captured!.batchSize, 500);
    assert.deepStrictEqual(captured!.exchanges, ["NSE", "BSE"]);
    assert.strictEqual(captured!.delayMs, 500);
    assert.strictEqual(captured!.forceReEnrich, false);
  });

  it("forwards custom options into enrichSectors", async () => {
    let captured: {
      batchSize: number;
      delayMs: number;
      exchanges: string[];
      forceReEnrich: boolean;
    } | null = null;
    await runSectorEnrichmentSequence(
      { batchSize: 25, exchanges: ["BSE"], forceReEnrich: true, delayMs: 3000 },
      async (_f, opts) => {
        captured = opts;
        return EMPTY_ENRICH;
      }
    );

    assert.strictEqual(captured!.batchSize, 25);
    assert.deepStrictEqual(captured!.exchanges, ["BSE"]);
    assert.strictEqual(captured!.forceReEnrich, true);
    assert.strictEqual(captured!.delayMs, 3000);
  });

  it("passes a function fetcher to enrichSectors", async () => {
    let isFn = false;
    await runSectorEnrichmentSequence({}, async (fetcher) => {
      isFn = typeof fetcher === "function";
      return EMPTY_ENRICH;
    });
    assert.strictEqual(isFn, true);
  });

  it("propagates a hard enrichSectors failure", async () => {
    await assert.rejects(
      () =>
        runSectorEnrichmentSequence({}, async () => {
          throw new Error("Yahoo quota exhausted");
        }),
      { message: "Yahoo quota exhausted" }
    );
  });

  it("fetcher: maps a real assetProfile to sector/industry", () => {
    const r = yahooSectorFetcherLikeProcessor(() => ({
      assetProfile: { sector: "Energy", industry: "Oil & Gas" },
    }));
    assert.deepStrictEqual(r, { sector: "Energy", industry: "Oil & Gas" });
  });

  it("fetcher: returns null for a benign 'not found' (ETF)", () => {
    const r = yahooSectorFetcherLikeProcessor(() => {
      throw new Error("Symbol not found");
    });
    assert.strictEqual(r, null);
  });

  it("fetcher: rethrows a genuine outage", () => {
    assert.throws(
      () =>
        yahooSectorFetcherLikeProcessor(() => {
          throw new Error("503 Service Unavailable");
        }),
      { message: "503 Service Unavailable" }
    );
  });

  it("fetcher: returns null when the quoteSummary result is null", () => {
    assert.strictEqual(
      yahooSectorFetcherLikeProcessor(() => null),
      null
    );
  });
});
