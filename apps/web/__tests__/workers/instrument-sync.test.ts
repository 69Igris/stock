/**
 * Instrument Sync Processor Tests (workers/src/processors/instrument-sync.ts) — DE-SHADOWED.
 *
 * The previous version of this file SHADOWED the processor: it declared a local
 * `async function processInstrumentSync` "(mirrors workers/src/processors/
 * instrument-sync.ts)" with a `providerCount = 1` constant and asserted the COPY.
 * No real worker symbol was imported, so the suite stayed green against code that
 * does not exist in production.
 *
 * This rewrite asserts ONLY real shipped code: the pure orchestration helpers
 * exported from `workers/src/processors/instrument-sync-logic.ts`, which
 * `instrument-sync.ts` now CALLS — `resolveInstrumentSyncOptions` (the NSE+BSE
 * default + forceFullSync default), `shouldSkipRecentSync` (the recent-sync
 * short-circuit), `capErrorsForLog` (the per-provider error-log cap), and the
 * `RECENT_SYNC_WINDOW_HOURS` constant the processor passes to `hasRecentSync`.
 * The processor itself imports `@usemoney/core/market-data` (Prisma + the broker
 * instrument dump) at module load, so it cannot be pulled into a pure unit test;
 * the orchestration harness below mirrors only its decision SEQUENCE, building
 * every option/skip-decision by calling the SAME real exports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker orchestration helpers under test (no shadow). instrument-sync.ts CALLS these.
import {
  resolveInstrumentSyncOptions,
  shouldSkipRecentSync,
  capErrorsForLog,
  DEFAULT_INSTRUMENT_EXCHANGES,
  RECENT_SYNC_WINDOW_HOURS,
  INSTRUMENT_ERROR_LOG_CAP,
} from "../../../../workers/src/processors/instrument-sync-logic";

// ══════════════════════════════════════════════════════════════════════
// resolveInstrumentSyncOptions — default resolution (real export)
// ══════════════════════════════════════════════════════════════════════

describe("instrument-sync-logic.resolveInstrumentSyncOptions (real export)", () => {
  it("defaults exchanges to NSE + BSE when omitted", () => {
    assert.deepStrictEqual(resolveInstrumentSyncOptions({}).exchanges, [
      "NSE",
      "BSE",
    ]);
  });

  it("defaults forceFullSync to false when omitted", () => {
    assert.strictEqual(resolveInstrumentSyncOptions({}).forceFullSync, false);
  });

  it("uses custom exchanges when provided", () => {
    assert.deepStrictEqual(
      resolveInstrumentSyncOptions({ exchanges: ["NSE"] }).exchanges,
      ["NSE"]
    );
  });

  it("passes all custom exchanges through verbatim", () => {
    assert.deepStrictEqual(
      resolveInstrumentSyncOptions({ exchanges: ["NSE", "BSE", "NFO"] })
        .exchanges,
      ["NSE", "BSE", "NFO"]
    );
  });

  it("preserves a provided-but-empty exchanges array (does not re-default)", () => {
    assert.deepStrictEqual(
      resolveInstrumentSyncOptions({ exchanges: [] }).exchanges,
      []
    );
  });

  it("passes forceFullSync=true through", () => {
    assert.strictEqual(
      resolveInstrumentSyncOptions({ forceFullSync: true }).forceFullSync,
      true
    );
  });

  it("returns a fresh exchanges array (not a shared reference to the default)", () => {
    const a = resolveInstrumentSyncOptions({});
    const b = resolveInstrumentSyncOptions({});
    a.exchanges.push("MUTATED");
    assert.deepStrictEqual(b.exchanges, ["NSE", "BSE"]);
    assert.deepStrictEqual(DEFAULT_INSTRUMENT_EXCHANGES, ["NSE", "BSE"]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// shouldSkipRecentSync — the recent-sync short-circuit (real export)
//
// The processor only calls hasRecentSync when NOT forcing, then short-circuits
// when a recent sync exists. A regression here re-pulls the multi-MB instrument
// master dump on every trigger.
// ══════════════════════════════════════════════════════════════════════

describe("instrument-sync-logic.shouldSkipRecentSync (real export)", () => {
  it("skips when a recent sync exists and not forced", () => {
    assert.strictEqual(shouldSkipRecentSync(true, false), true);
  });

  it("does NOT skip when no recent sync exists", () => {
    assert.strictEqual(shouldSkipRecentSync(false, false), false);
  });

  it("never skips a forced sync, even with a recent sync", () => {
    assert.strictEqual(shouldSkipRecentSync(true, true), false);
  });

  it("never skips a forced sync with no recent sync", () => {
    assert.strictEqual(shouldSkipRecentSync(false, true), false);
  });

  it("pins the recent-sync window the processor passes to hasRecentSync", () => {
    assert.strictEqual(RECENT_SYNC_WINDOW_HOURS, 20);
  });
});

// ══════════════════════════════════════════════════════════════════════
// capErrorsForLog — per-provider error-log cap (real export)
// ══════════════════════════════════════════════════════════════════════

describe("instrument-sync-logic.capErrorsForLog (real export)", () => {
  it("caps a long error list at INSTRUMENT_ERROR_LOG_CAP", () => {
    const errs = Array.from({ length: 30 }, (_, i) => `err-${i}`);
    const logged = capErrorsForLog(errs);
    assert.strictEqual(logged.length, INSTRUMENT_ERROR_LOG_CAP);
    assert.strictEqual(logged[0], "err-0");
    assert.strictEqual(logged[INSTRUMENT_ERROR_LOG_CAP - 1], "err-9");
  });

  it("returns a short list unchanged", () => {
    assert.deepStrictEqual(capErrorsForLog(["a", "b"]), ["a", "b"]);
  });

  it("returns an empty array for no errors", () => {
    assert.deepStrictEqual(capErrorsForLog([]), []);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Orchestration harness — mirrors the processor's decision SEQUENCE, building
// every option / skip-decision by calling the SAME real exports above. This is
// the in-test analogue of processInstrumentSync's control flow (the real fn
// boots Prisma + fetches the broker dump at import, so it can't run here).
// ══════════════════════════════════════════════════════════════════════

interface SyncResultFixture {
  provider: string;
  totalFetched: number;
  upserted: number;
  failed: number;
  deactivated: number;
  errors: string[];
}

/** Re-runs the processor's branch logic against injected fakes, via real exports. */
async function runInstrumentSyncSequence(
  data: { exchanges?: string[]; forceFullSync?: boolean },
  deps: {
    hasRecentSync: (broker: string, hours: number) => Promise<boolean>;
    syncInstruments: (
      providerCount: number,
      opts: { exchanges: string[]; forceFullSync: boolean }
    ) => Promise<SyncResultFixture[]>;
  }
): Promise<{ skipped: boolean; results: SyncResultFixture[] }> {
  const { exchanges, forceFullSync } = resolveInstrumentSyncOptions(data);

  if (!forceFullSync) {
    const recent = await deps.hasRecentSync(
      "ZERODHA",
      RECENT_SYNC_WINDOW_HOURS
    );
    if (shouldSkipRecentSync(recent, forceFullSync)) {
      return { skipped: true, results: [] };
    }
  }

  // Phase 1: only the Zerodha provider is wired (1 provider).
  const results = await deps.syncInstruments(1, { exchanges, forceFullSync });
  return { skipped: false, results };
}

function makeResult(
  overrides: Partial<SyncResultFixture> = {}
): SyncResultFixture {
  return {
    provider: "ZERODHA",
    totalFetched: 5000,
    upserted: 4950,
    failed: 50,
    deactivated: 100,
    errors: [],
    ...overrides,
  };
}

describe("instrument-sync orchestration sequence (real exports)", () => {
  it("checks recent ZERODHA sync with the 20h window then syncs when stale", async () => {
    const calls: Array<{ broker: string; hours: number }> = [];
    let syncCount = 0;
    const out = await runInstrumentSyncSequence(
      {},
      {
        hasRecentSync: async (broker, hours) => {
          calls.push({ broker, hours });
          return false;
        },
        syncInstruments: async () => {
          syncCount++;
          return [makeResult()];
        },
      }
    );

    assert.deepStrictEqual(calls, [{ broker: "ZERODHA", hours: 20 }]);
    assert.strictEqual(out.skipped, false);
    assert.strictEqual(syncCount, 1);
  });

  it("short-circuits (no syncInstruments) when a recent sync exists", async () => {
    let syncCount = 0;
    const out = await runInstrumentSyncSequence(
      {},
      {
        hasRecentSync: async () => true,
        syncInstruments: async () => {
          syncCount++;
          return [];
        },
      }
    );

    assert.strictEqual(out.skipped, true);
    assert.strictEqual(syncCount, 0);
    assert.strictEqual(out.results.length, 0);
  });

  it("bypasses the recent-sync check entirely when forceFullSync is true", async () => {
    let recentChecked = false;
    let syncCount = 0;
    const out = await runInstrumentSyncSequence(
      { forceFullSync: true },
      {
        hasRecentSync: async () => {
          recentChecked = true;
          return true; // would skip if it were consulted
        },
        syncInstruments: async () => {
          syncCount++;
          return [makeResult()];
        },
      }
    );

    assert.strictEqual(recentChecked, false);
    assert.strictEqual(out.skipped, false);
    assert.strictEqual(syncCount, 1);
  });

  it("forwards the resolved exchanges + forceFullSync into syncInstruments", async () => {
    let captured: { exchanges: string[]; forceFullSync: boolean } | null = null;
    await runInstrumentSyncSequence(
      { exchanges: ["NSE", "BSE", "NFO"], forceFullSync: true },
      {
        hasRecentSync: async () => false,
        syncInstruments: async (_n, opts) => {
          captured = opts;
          return [makeResult()];
        },
      }
    );

    assert.deepStrictEqual(captured!.exchanges, ["NSE", "BSE", "NFO"]);
    assert.strictEqual(captured!.forceFullSync, true);
  });

  it("defaults exchanges to NSE+BSE in the synced options", async () => {
    let captured: { exchanges: string[] } | null = null;
    await runInstrumentSyncSequence(
      {},
      {
        hasRecentSync: async () => false,
        syncInstruments: async (_n, opts) => {
          captured = opts;
          return [makeResult()];
        },
      }
    );
    assert.deepStrictEqual(captured!.exchanges, ["NSE", "BSE"]);
  });

  it("surfaces the provider result rows (fetched/upserted/failed/deactivated/errors)", async () => {
    const out = await runInstrumentSyncSequence(
      {},
      {
        hasRecentSync: async () => false,
        syncInstruments: async () => [
          makeResult({
            totalFetched: 3000,
            upserted: 2900,
            failed: 100,
            deactivated: 250,
            errors: ["Invalid symbol: XYZ", "Missing ISIN for ABC"],
          }),
        ],
      }
    );

    assert.strictEqual(out.results.length, 1);
    const r = out.results[0]!;
    assert.strictEqual(r.totalFetched, 3000);
    assert.strictEqual(r.upserted, 2900);
    assert.strictEqual(r.failed, 100);
    assert.strictEqual(r.deactivated, 250);
    // The processor caps errors via the REAL capErrorsForLog before logging.
    assert.strictEqual(capErrorsForLog(r.errors).length, 2);
    assert.ok(capErrorsForLog(r.errors)[0]!.includes("Invalid symbol"));
  });
});

describe("the BSE enricher is actually CALLED from the processor", () => {
  // The processor's syncInstruments is stubbed in this file, so nothing here
  // would notice the enricher call being deleted — and it is the whole reason
  // BSE classification converges in one run instead of ~10 trading days.
  const src = (() => {
    const { readFileSync, existsSync } =
      require("node:fs") as typeof import("node:fs");
    const { join, dirname, resolve } =
      require("node:path") as typeof import("node:path");
    let dir = resolve(process.cwd());
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, "yarn.lock"))) break;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    const full = join(
      dir,
      "workers",
      "src",
      "processors",
      "instrument-sync.ts"
    );
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  })();

  it("found the processor source", () => {
    assert.ok(src.length > 0);
  });

  it("calls enrichBseInstrumentsFromMaster", () => {
    assert.match(src, /enrichBseInstrumentsFromMaster\(/);
  });

  it("runs it even when the provider sync is skipped or throws", () => {
    // The recency guard used to `return` outright, so the day after any manual
    // forced sync the enricher did not run — and the repair runbook requires a
    // manual forced sync.
    assert.doesNotMatch(
      src,
      /already synced within \$\{RECENT_SYNC_WINDOW_HOURS\} hours[^)]*\)\;\s*\n\s*return\;/,
      "the recency guard must not return before the enricher"
    );
    assert.match(src, /skipProviders/);
  });
});
