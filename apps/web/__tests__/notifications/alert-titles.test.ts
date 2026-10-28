/**
 * MONEY-1204 / 14e.3 — the alerts list must NAME each alert, not label it "TCS alert".
 *
 * `AlertsTabBody` built its row title from a five-branch ternary that fell
 * through to `${symbol ?? "Custom"} alert`. All six data-engine kinds hit that
 * fall-through, so a saved MWPL alert listed as "TCS alert" and a correctly
 * symbol-less FII_FLOW_STREAK as "Custom alert" — while `KIND_ICON`, two lines
 * above in the same file, was an EXHAUSTIVE `Record<AlertKind, …>` and had been
 * right the whole time. That pairing is the shape of nearly every defect this
 * feature had: what the compiler checked was correct, what it did not was not.
 *
 * The map is now a Record over `AlertKind`, so a 13th kind is a compile error.
 * The compiler cannot check the part this file exists for: that each formatter
 * reads the condition keys the DRAWER actually writes and the EVALUATOR
 * actually reads. Read the wrong key and the clause silently disappears — the
 * title still renders, just without the setting, which is the same class of
 * quiet wrongness as the fall-through it replaced.
 *
 * Source: apps/web/components/chat/sidebar/AlertsTabBody.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

// Stub the client component's CSS + server-action edges so it loads in node.
interface ModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}
const loader = Module as unknown as ModuleLoader;
const originalLoad = loader._load;
loader._load = function patchedLoad(
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request.endsWith(".css")) return {};
  if (request === "@/lib/actions/alerts") {
    return { listAlertsAction: async () => ({ success: true, data: [] }) };
  }
  return originalLoad.call(loader, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mod = require("../../components/chat/sidebar/AlertsTabBody") as {
  KIND_TITLE: Record<
    string,
    (a: { symbol?: string }, c: Record<string, unknown>) => string
  >;
};
const { KIND_TITLE } = mod;

const ALL_KINDS = [
  "PRICE",
  "VOLUME",
  "NEWS",
  "EARNINGS_DATE",
  "CORPORATE_ACTION",
  "CUSTOM",
  "FLAG_TRANSITION",
  "DELIVERY_SPIKE",
  "PLEDGE_INCREASE",
  "INSIDER_CLUSTER",
  "MWPL_HIGH",
  "FII_FLOW_STREAK",
] as const;

/** The keys the drawer writes, per kind. Wrong key ⇒ the clause vanishes. */
const CASES: ReadonlyArray<{
  kind: string;
  conditions: Record<string, unknown>;
  symbol?: string;
  mustContain: readonly string[];
}> = [
  {
    kind: "FLAG_TRANSITION",
    symbol: "TCS",
    conditions: { kinds: ["SURVEILLANCE", "FO_BAN", "SERIES_CHANGE"] },
    mustContain: ["TCS", "3"],
  },
  {
    kind: "DELIVERY_SPIKE",
    symbol: "TCS",
    conditions: { multiplier: 3 },
    mustContain: ["TCS", "3"],
  },
  {
    kind: "PLEDGE_INCREASE",
    symbol: "TCS",
    conditions: { minDeltaPp: 5 },
    mustContain: ["TCS", "5"],
  },
  {
    kind: "INSIDER_CLUSTER",
    symbol: "TCS",
    conditions: { minEvents: 4, windowDays: 30 },
    mustContain: ["TCS", "4", "30"],
  },
  {
    kind: "MWPL_HIGH",
    symbol: "TCS",
    conditions: { threshold: 65 },
    mustContain: ["TCS", "65"],
  },
  {
    kind: "FII_FLOW_STREAK",
    conditions: { category: "FII", minDays: 7 },
    mustContain: ["FII", "7"],
  },
];

describe("alerts list titles", () => {
  it("has a formatter for every kind — no fall-through", () => {
    for (const k of ALL_KINDS) {
      assert.equal(
        typeof KIND_TITLE[k],
        "function",
        `${k} has no title formatter and would fall through`
      );
    }
    assert.equal(
      Object.keys(KIND_TITLE).length,
      ALL_KINDS.length,
      "KIND_TITLE and the AlertKind union have diverged"
    );
  });

  it("names each data-engine kind and echoes its configured value", () => {
    for (const c of CASES) {
      const title = KIND_TITLE[c.kind]!({ symbol: c.symbol }, c.conditions);
      for (const needle of c.mustContain) {
        assert.ok(
          title.includes(needle),
          `${c.kind}: expected "${needle}" in ${JSON.stringify(title)} — ` +
            "either the formatter reads a condition key the drawer does not " +
            "write, or it fell back to a generic label"
        );
      }
      // The exact string the bug produced, in both its forms.
      assert.ok(
        !/^(TCS|Custom) alert$/.test(title),
        `${c.kind} still renders the generic fall-through: ${title}`
      );
    }
  });

  it("a market-wide kind is never given a symbol it does not have", () => {
    const title = KIND_TITLE.FII_FLOW_STREAK!(
      {},
      { category: "DII", minDays: 5 }
    );
    assert.ok(!title.includes("undefined"), title);
    assert.ok(!title.includes("Custom"), title);
    assert.ok(title.includes("DII"), title);
  });

  it("omits a clause rather than inventing a default it did not read", () => {
    // The evaluator's fallback lives in alert-evaluator-logic.ts and can change
    // without this file knowing, so printing a number we never read would be a
    // guess presented to the user as their setting.
    const title = KIND_TITLE.MWPL_HIGH!({ symbol: "TCS" }, {});
    assert.ok(title.includes("TCS"), title);
    assert.ok(!/\d/.test(title), `must not invent a threshold: ${title}`);
  });
});
