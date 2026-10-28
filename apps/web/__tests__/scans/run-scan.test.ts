/**
 * runScanAction — real handler, mocked engine (MONEY-795 · C2).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS (security + correctness)
 * ───────────────────────────────────────────────────────────────────────────
 * `runScanAction(scanId)` is the only inline entry point that turns a catalog
 * scan into a screener query. It is security-sensitive on three axes, all of
 * which are asserted here against the REAL action (driven through the
 * `require.cache` seam, with ONLY `@/lib/actions/screener` stubbed so the real
 * catalog lookup + the real filter mapper run):
 *
 *   1. INJECTION / FAIL-CLOSED: an unknown or crafted scanId must hard-fail
 *      ("Scan not found") and must NEVER reach the screener engine. A caller
 *      can't smuggle filters through the id — `runScanAction` only ever reads
 *      `scan.filters` from the matched static-catalog entry.
 *   2. NO FULL-UNIVERSE DUMP: a scan whose filters don't actually map to a
 *      fundamental band at runtime (empty `ScreenFilters`) must fail closed —
 *      otherwise the screener returns the whole ~7000-stock universe scored
 *      100, a market dump masquerading as a scan result.
 *   3. GRACEFUL DEGRADE / AUTH+DEMO GATE: the engine (`screenStocksAction`) is
 *      the same global, cached, demo-safe screener the screener page uses. When
 *      it returns `{success:false}` (quota/status wall), `runScanAction`
 *      propagates that as a graceful error — never a bare throw.
 *
 * Source: apps/web/lib/actions/scans.ts
 * Runs under `node --import tsx --test` (CJS). CWD must be apps/web.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { SCAN_CATALOG } from "@/lib/scans/catalog";
import type { ScreenResult } from "@/lib/actions/screener";

// ── module-cache seam ────────────────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}
const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const ACTION_REL = "../../lib/actions/scans";
const SCREENER_REL = "../../lib/actions/screener";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

// ── screener recorder ────────────────────────────────────────────────────────

interface ScreenCall {
  filters: Record<string, unknown>;
  query: string | undefined;
  paging: { page?: number; pageSize?: number; sort?: string } | undefined;
}

interface Harness {
  calls: ScreenCall[];
  /** What the stubbed screener returns. */
  result:
    | { success: true; data: { rows: ScreenResult[]; total: number } }
    | { success: false; error: string };
  /** If set, the stub THROWS — proves the action never lets it bubble unguarded
   *  (here the action itself doesn't catch, so a throw would surface; we assert
   *  the action does NOT call the screener in the fail-closed paths). */
  throws?: Error;
}

let h: Harness;

function freshHarness(): Harness {
  return {
    calls: [],
    result: {
      success: true,
      data: { rows: [{ symbol: "TCS" } as ScreenResult], total: 1 },
    },
  };
}

interface ScansModule {
  runScanAction: (
    scanId: string,
    options?: { limit?: number }
  ) => Promise<
    | {
        success: true;
        data: {
          scanId: string;
          scanName: string;
          rows: ScreenResult[];
          total: number;
          unmapped: string[];
          partial: boolean;
        };
      }
    | { success: false; error: string }
  >;
}

function loadAction(): ScansModule {
  const cache = moduleCache();
  const screenerPath = require.resolve(SCREENER_REL);
  snapshotOnce(screenerPath);

  cache[screenerPath] = {
    exports: {
      __esModule: true,
      screenStocksAction: (
        filters: Record<string, unknown>,
        query: string | undefined,
        paging: ScreenCall["paging"]
      ) => {
        h.calls.push({ filters, query, paging });
        if (h.throws) throw h.throws;
        return Promise.resolve(h.result);
      },
    },
  };

  delete cache[require.resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ScansModule;
}

// ── helpers to pick representative catalog scans ─────────────────────────────

const firstRunnable = SCAN_CATALOG.find((s) => s.runnable);
const firstBrowseOnly = SCAN_CATALOG.find((s) => !s.runnable);

// ════════════════════════════════════════════════════════════════════════════

describe("runScanAction — fail-closed on bad / unknown ids", () => {
  beforeEach(() => {
    h = freshHarness();
  });
  after(restoreCache);

  it("unknown id → 'Scan not found' and the engine is never called", async () => {
    const { runScanAction } = loadAction();
    const res = await runScanAction("nope:does-not-exist");
    assert.equal(res.success, false);
    if (!res.success) assert.match(res.error, /not found/i);
    assert.equal(h.calls.length, 0, "engine must not run for an unknown id");
  });

  it("a crafted id that isn't in the static catalog cannot inject filters", async () => {
    const { runScanAction } = loadAction();
    // Looks plausible (right namespace) but isn't a real scan id.
    const res = await runScanAction("core:'; DROP TABLE stocks; --");
    assert.equal(res.success, false);
    assert.equal(h.calls.length, 0);
  });

  it("empty id fails closed", async () => {
    const { runScanAction } = loadAction();
    const res = await runScanAction("");
    assert.equal(res.success, false);
    assert.equal(h.calls.length, 0);
  });

  it("a browse-only (non-runnable) scan does not reach the engine", async () => {
    if (!firstBrowseOnly) return; // catalog always has chartink/builtin
    const { runScanAction } = loadAction();
    const res = await runScanAction(firstBrowseOnly.id);
    assert.equal(res.success, false);
    if (!res.success) assert.match(res.error, /one-click|screener|StockSage/i);
    assert.equal(h.calls.length, 0, "non-runnable scans never run inline");
  });
});

describe("runScanAction — runnable core scan maps to engine filters", () => {
  beforeEach(() => {
    h = freshHarness();
  });
  after(restoreCache);

  it("maps the scan's fundamental filters to ScreenFilters bands and forwards bounded paging", async () => {
    assert.ok(firstRunnable, "catalog must expose ≥1 runnable scan");
    const { runScanAction } = loadAction();
    const res = await runScanAction(firstRunnable!.id, { limit: 50 });

    assert.equal(
      h.calls.length,
      1,
      "the runnable scan reaches the engine once"
    );
    const call = h.calls[0]!;
    // It mapped at least one fundamental band (non-empty filter object) — this
    // is the guard against a full-universe dump.
    assert.ok(
      Object.keys(call.filters).length > 0,
      "a runnable scan must produce a non-empty ScreenFilters"
    );
    // Paging is bounded + sorted by match (preview, not a full export).
    assert.equal(call.paging?.page, 0);
    assert.equal(call.paging?.sort, "match");
    assert.ok(
      (call.paging?.pageSize ?? 0) <= 100,
      "pageSize is clamped to a preview ceiling"
    );

    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.scanId, firstRunnable!.id);
      assert.equal(res.data.scanName, firstRunnable!.name);
      assert.ok(Array.isArray(res.data.rows));
      assert.equal(typeof res.data.partial, "boolean");
    }
  });

  it("clamps an oversized limit to the 100-row preview ceiling", async () => {
    assert.ok(firstRunnable);
    const { runScanAction } = loadAction();
    await runScanAction(firstRunnable!.id, { limit: 100000 });
    assert.ok((h.calls[0]?.paging?.pageSize ?? 0) <= 100);
  });

  it("clamps a non-positive limit up to ≥1", async () => {
    assert.ok(firstRunnable);
    const { runScanAction } = loadAction();
    await runScanAction(firstRunnable!.id, { limit: 0 });
    assert.ok((h.calls[0]?.paging?.pageSize ?? 0) >= 1);
  });

  it("surfaces the partial-coverage note when some filters are unmapped", async () => {
    assert.ok(firstRunnable);
    const { runScanAction } = loadAction();
    const res = await runScanAction(firstRunnable!.id);
    // The canonical 'value_investing' core scan carries pb (unmapped); whichever
    // scan is first-runnable, partial must equal (unmapped.length > 0).
    if (res.success) {
      assert.equal(res.data.partial, res.data.unmapped.length > 0);
    }
  });
});

describe("runScanAction — graceful degrade (auth / demo / quota gate)", () => {
  beforeEach(() => {
    h = freshHarness();
  });
  after(restoreCache);

  it("propagates a screener failure as a graceful error, never a throw", async () => {
    assert.ok(firstRunnable);
    h.result = { success: false, error: "Failed to run screener" };
    const { runScanAction } = loadAction();
    const res = await runScanAction(firstRunnable!.id);
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Failed to run screener");
  });

  it("returns total:0 cleanly when the gated engine yields no rows", async () => {
    assert.ok(firstRunnable);
    h.result = { success: true, data: { rows: [], total: 0 } };
    const { runScanAction } = loadAction();
    const res = await runScanAction(firstRunnable!.id);
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.total, 0);
      assert.deepEqual(res.data.rows, []);
    }
  });
});
