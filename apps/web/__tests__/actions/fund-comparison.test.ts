/**
 * MONEY-620 — getComparisonDataAction (REAL action export, de-shadowed).
 *
 * SHADOW VERDICT (previous version): SHADOW. The old file re-declared the ENTIRE
 * comparison pipeline inline — validateFundCount, buildCacheKey, mapMf/EtfTo
 * ComparableFund, nav-history mappers, filterValidFunds, and a
 * `simulateComparisonAction` copy — and asserted the COPIES. It imported NOTHING
 * from `@/lib/actions/fund-comparison`, so the real action never ran. Worse, the
 * inline copy had already DRIFTED from the source it claimed to mirror:
 *   · it gated fund count at 2-4, but the real service gates 2-5;
 *   · it only knew "MF" | "ETF", silently dropping the "INDEX" fund type the
 *     real action accepts and forwards;
 *   · it asserted a `ComparisonData` shape with no `normalizedSeries` field
 *     (the real service now returns one).
 * A green shadow that tested a stale fiction.
 *
 * DE-SHADOWED. `lib/actions/fund-comparison.ts` is a THIN wrapper: its only OWN
 * logic is to (a) map each caller param `{ fundType, fundId }` → the service
 * param `{ type, id }` and (b) forward to `getComparisonData` from
 * `@usemoney/services`, returning its `ServiceResult` verbatim. This rewrite
 * imports & drives the REAL `getComparisonDataAction` export, injecting a
 * RECORDING `@usemoney/services` double at the module boundary via
 * `require.cache` (the proven `broker-sync-action-e2e.test.ts` /
 * `webhooks-dodo-e2e.test.ts` seam), and asserts the action's own contract:
 *
 *   - the param-shape mapping fundType/fundId → type/id (exact, ordered);
 *   - EVERY fund type — incl. INDEX — is forwarded (no silent drop);
 *   - the service result (success+data OR failure+error) passes through unchanged;
 *   - the action neither validates count itself nor re-shapes data (delegation),
 *     so a 5-fund call reaches the service (would've been wrongly blocked by the
 *     old inline 2-4 copy) and the service's verdict is what the user sees.
 *
 * No demo/auth gate exists on this action by design (the comparison cache is
 * `_global`, keyed only by the fund identifiers — no per-user data, so no IDOR
 * surface); a test documents that the action performs no auth side-channel.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be `apps/web`.
 *
 * Source: apps/web/lib/actions/fund-comparison.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Types mirrored from the service contract (for fixtures only) ────────────

interface NormalizedRow {
  date: string;
  [seriesKey: string]: string | number | null;
}

interface ComparisonData {
  funds: unknown[];
  navHistory: Record<string, Array<{ date: string; value: number }>>;
  compositions: Record<string, unknown | null>;
  normalizedSeries: NormalizedRow[];
}

type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

// ── Recording @usemoney/services double ─────────────────────────────────────

interface ServiceRecorder {
  // Every set of funds the action forwarded to the service.
  calls: Array<Array<{ type: string; id: string }>>;
  // What the stub should return for the NEXT call.
  next: ServiceResult<ComparisonData>;
}

function makeServicesStub(rec: ServiceRecorder): Record<string, unknown> {
  return {
    __esModule: true,
    getComparisonData: (funds: Array<{ type: string; id: string }>) => {
      // Defensive clone so later mutation of the input can't rewrite history.
      rec.calls.push(funds.map((f) => ({ type: f.type, id: f.id })));
      return Promise.resolve(rec.next);
    },
  };
}

// ── module-boundary injection ───────────────────────────────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ACTION_REL = "../../lib/actions/fund-comparison";
const SERVICES_ID = "@usemoney/services";

interface ActionModule {
  getComparisonDataAction: (
    funds: Array<{ fundType: "MF" | "ETF" | "INDEX"; fundId: string }>
  ) => Promise<ServiceResult<ComparisonData>>;
}

function loadAction(rec: ServiceRecorder): ActionModule {
  const cache = moduleCache();
  cache[require.resolve(SERVICES_ID)] = { exports: makeServicesStub(rec) };
  delete cache[require.resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ActionModule;
}

function okData(over: Partial<ComparisonData> = {}): ComparisonData {
  return {
    funds: [{ id: "119551" }, { id: "NIFTYBEES" }],
    navHistory: { "MF:119551": [{ date: "2024-01-01", value: 50 }] },
    compositions: { "MF:119551": null },
    normalizedSeries: [{ date: "2024-01-01", fund0: 100, fund1: 100 }],
    ...over,
  };
}

function newRecorder(
  next: ServiceResult<ComparisonData> = { success: true, data: okData() }
): ServiceRecorder {
  return { calls: [], next };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("MONEY-620 — getComparisonDataAction (real wrapper, recording service)", () => {
  let rec: ServiceRecorder;

  beforeEach(() => {
    rec = newRecorder();
  });

  afterEach(() => {
    const cache = moduleCache();
    delete cache[require.resolve(ACTION_REL)];
    delete cache[require.resolve(SERVICES_ID)];
  });

  describe("param-shape mapping (fundType/fundId → type/id)", () => {
    it("maps each fund's fundType→type and fundId→id, preserving order", async () => {
      const action = loadAction(rec);
      await action.getComparisonDataAction([
        { fundType: "MF", fundId: "119551" },
        { fundType: "ETF", fundId: "NIFTYBEES" },
      ]);
      assert.equal(rec.calls.length, 1);
      assert.deepEqual(rec.calls[0], [
        { type: "MF", id: "119551" },
        { type: "ETF", id: "NIFTYBEES" },
      ]);
    });

    it("[no silent drop] forwards the INDEX fund type the action accepts", async () => {
      // The old inline shadow only knew "MF" | "ETF" and would have dropped/
      // mistyped an INDEX fund. The real action forwards it untouched.
      const action = loadAction(rec);
      await action.getComparisonDataAction([
        { fundType: "INDEX", fundId: "NIFTY50" },
        { fundType: "MF", fundId: "119551" },
      ]);
      assert.deepEqual(rec.calls[0], [
        { type: "INDEX", id: "NIFTY50" },
        { type: "MF", id: "119551" },
      ]);
    });

    it("forwards all three fund types together without reordering", async () => {
      const action = loadAction(rec);
      await action.getComparisonDataAction([
        { fundType: "ETF", fundId: "BANKBEES" },
        { fundType: "INDEX", fundId: "NIFTYBANK" },
        { fundType: "MF", fundId: "120505" },
      ]);
      assert.deepEqual(rec.calls[0], [
        { type: "ETF", id: "BANKBEES" },
        { type: "INDEX", id: "NIFTYBANK" },
        { type: "MF", id: "120505" },
      ]);
    });

    it("forwards an empty array verbatim (no count validation in the action)", async () => {
      // The action does NOT gate on length — delegation is total; the service
      // owns the 2-5 rule. Proven by an empty input reaching the service.
      const action = loadAction(rec);
      await action.getComparisonDataAction([]);
      assert.equal(rec.calls.length, 1);
      assert.deepEqual(rec.calls[0], []);
    });

    it("forwards a 5-fund set (the action never blocks at 4 — only the service rules)", async () => {
      // The stale inline copy gated at 2-4 and would have rejected this; the
      // real action passes all 5 straight through to the (2-5) service.
      const action = loadAction(rec);
      const five = ["a", "b", "c", "d", "e"].map((id) => ({
        fundType: "MF" as const,
        fundId: id,
      }));
      await action.getComparisonDataAction(five);
      assert.equal(rec.calls[0]!.length, 5);
      assert.deepEqual(
        rec.calls[0]!.map((f) => f.id),
        ["a", "b", "c", "d", "e"]
      );
    });
  });

  describe("result pass-through (no re-shaping)", () => {
    it("returns the service success result (incl. normalizedSeries) verbatim", async () => {
      const data = okData({
        normalizedSeries: [
          { date: "2024-01-01", fund0: 100, fund1: 100 },
          { date: "2024-06-01", fund0: 104, fund1: 98 },
        ],
      });
      rec.next = { success: true, data };
      const action = loadAction(rec);
      const res = await action.getComparisonDataAction([
        { fundType: "MF", fundId: "119551" },
        { fundType: "ETF", fundId: "NIFTYBEES" },
      ]);
      assert.equal(res.success, true);
      // Identity pass-through — the action must not clone/re-shape the payload.
      assert.strictEqual(
        (res as { data: ComparisonData }).data,
        data,
        "action must return the service object as-is"
      );
      assert.equal(
        (res as { data: ComparisonData }).data.normalizedSeries.length,
        2
      );
    });

    it("propagates a service failure (error string) unchanged", async () => {
      rec.next = {
        success: false,
        error: "Please select 2-5 funds to compare",
      };
      const action = loadAction(rec);
      const res = await action.getComparisonDataAction([
        { fundType: "MF", fundId: "only-one" },
      ]);
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Please select 2-5 funds to compare"
      );
    });

    it("propagates the service's sanitized catch-all failure unchanged", async () => {
      rec.next = { success: false, error: "Failed to fetch comparison data" };
      const action = loadAction(rec);
      const res = await action.getComparisonDataAction([
        { fundType: "MF", fundId: "119551" },
        { fundType: "ETF", fundId: "NIFTYBEES" },
      ]);
      assert.equal(res.success, false);
      assert.equal(
        (res as { error: string }).error,
        "Failed to fetch comparison data"
      );
    });

    it("calls the service exactly once per action invocation", async () => {
      const action = loadAction(rec);
      await action.getComparisonDataAction([
        { fundType: "MF", fundId: "119551" },
        { fundType: "ETF", fundId: "NIFTYBEES" },
      ]);
      assert.equal(rec.calls.length, 1, "no duplicate service dispatch");
    });
  });
});
