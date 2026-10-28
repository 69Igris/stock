/**
 * MONEY-1204 / 14e.3 — the New Alert drawer must build conditions the
 * EVALUATOR ACTUALLY READS, for every trigger it offers.
 *
 * Six triggers (flag / delivery / pledge / insider / mwpl / flow) shipped with
 * tiles in Step 1 and entries in `TRIGGER_TO_KIND`, but no Step 2 panel and no
 * `buildConditions()` branch. The if-chain fell through to the custom-rule
 * builder, whose demo seed is two rows, so picking "Insider cluster" saved an
 * INSIDER_CLUSTER alert carrying `{combinator:"AND", rules:[price>2800,
 * volume>2]}` on a symbol the user never chose — and toasted "Alert created".
 *
 * Two layers, both table-driven over the drawer's OWN exported trigger list so
 * a 13th trigger added without a builder fails here automatically:
 *
 *   1. SHAPE  — the exact condition keys, per trigger, and the proof that no
 *               non-custom trigger emits the custom `{combinator, rules}` blob.
 *   2. EFFECT — the built conditions are fed to the REAL evaluator functions
 *               (`workers/src/processors/alert-evaluator-logic.ts`) with data
 *               engineered so the USER'S value and the evaluator's hardcoded
 *               DEFAULT disagree. A key the evaluator never reads would default
 *               silently and the verdict would not move — which is exactly the
 *               failure mode a shape-only assertion cannot see.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import {
  DEFAULT_FLAG_KINDS,
  OPT_IN_FLAG_KINDS,
  evaluateDeliverySpike,
  evaluateFiiFlowStreak,
  evaluateFlagTransition,
  evaluateInsiderCluster,
  evaluateMwplHigh,
  evaluatePledgeIncrease,
} from "../../../../workers/src/processors/alert-evaluator-logic";
import type {
  ConditionDraft,
  TriggerKind,
} from "../../app/discover/news/NewAlertDrawer";

// ── Loading the drawer in node ──────────────────────────────────────────────
// It is a client component: it imports a CSS module (and PfSymbolPicker imports
// another) plus the `@/lib/actions/alerts` server action, none of which node can
// load. Stub exactly those two edges — the builders under test are the REAL
// ones. node:test runs each file in its own process, so the patch is local.

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
    return { createAlertAction: async () => ({ success: true }) };
  }
  return originalLoad.call(loader, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const drawer =
  require("../../app/discover/news/NewAlertDrawer") as typeof import("../../app/discover/news/NewAlertDrawer");
const {
  TRIGGER_KINDS,
  TRIGGER_SPECS,
  DEFAULT_DATA_ENGINE_DRAFT,
  buildAlertConditions,
  triggerNeedsSymbol,
} = drawer;

// ── The drawer's own default draft ──────────────────────────────────────────

function draft(patch: Partial<ConditionDraft> = {}): ConditionDraft {
  return {
    priceOp: "below",
    priceThreshold: "2800",
    volMultiplier: "2.0",
    keywordText: "downgrade",
    daysBefore: "1",
    corpActions: ["DIVIDEND"],
    customConditions: [
      { field: "price", op: ">", value: "2800" },
      { field: "volume", op: ">", value: "2" },
    ],
    customCombinator: "AND",
    ...DEFAULT_DATA_ENGINE_DRAFT,
    ...patch,
  };
}

/**
 * The condition keys each kind's evaluator reads, with the read site.
 * Anything not listed here is a key nobody consumes.
 */
const EXPECTED_KEYS: Record<TriggerKind, string[]> = {
  // evaluatePrice — alert-evaluator.ts PriceConditions {threshold, direction}
  price: ["direction", "threshold"],
  // evaluateVolume — VolumeConditions {multiplier}
  volume: ["multiplier"],
  // evaluateNews — NewsConditions {keyword | keywords}
  keyword: ["keyword"],
  // evaluateEarningsDate — EarningsConditions {daysBefore}
  earnings: ["daysBefore"],
  // evaluateCorporateAction — CorpActionConditions {actions, daysBefore?}
  corp: ["actions"],
  // CUSTOM has no generic evaluator by design — free-form rule blob.
  custom: ["combinator", "rules"],
  // stringArrayOption(conditions, "kinds") — evaluateFlagTransition
  flag: ["kinds"],
  // numberOption(conditions, "multiplier") — evaluateDeliverySpike
  delivery: ["multiplier"],
  // numberOption(conditions, "minDeltaPp") — evaluatePledgeIncrease
  pledge: ["minDeltaPp"],
  // numberOption(conditions, "minEvents" | "windowDays") — evaluateInsiderCluster
  insider: ["minEvents", "windowDays"],
  // numberOption(conditions, "threshold") — evaluateMwplHigh
  mwpl: ["threshold"],
  // conditions.category (the shell's evaluateDataEngineAlert) +
  // numberOption(conditions, "minDays") — evaluateFiiFlowStreak
  flow: ["category", "minDays"],
};

const DAY = 86_400_000;
const day = (n: number) => new Date(Date.UTC(2026, 7, n));

describe("MONEY-1204 · alert drawer trigger coverage", () => {
  it("offers exactly the 12 documented triggers", () => {
    assert.equal(TRIGGER_KINDS.length, 12);
    assert.deepEqual(
      [...TRIGGER_KINDS].sort(),
      [
        "corp",
        "custom",
        "delivery",
        "earnings",
        "flag",
        "flow",
        "insider",
        "keyword",
        "mwpl",
        "price",
        "volume",
      ]
        .concat("pledge")
        .sort()
    );
  });

  it("every trigger is covered by this test's key table", () => {
    for (const trigger of TRIGGER_KINDS) {
      assert.ok(
        EXPECTED_KEYS[trigger],
        `trigger "${trigger}" has no expected-key entry — add its evaluator ` +
          `keys here (and a builder in TRIGGER_SPECS) before shipping the tile`
      );
    }
  });
});

describe("MONEY-1204 · buildConditions shape, per trigger", () => {
  for (const trigger of TRIGGER_KINDS) {
    it(`${trigger} → the keys its evaluator reads`, () => {
      const built = buildAlertConditions(trigger, draft());
      assert.ok(
        built,
        `${trigger} built no conditions from the drawer's own defaults`
      );
      assert.deepEqual(
        Object.keys(built).sort(),
        [...EXPECTED_KEYS[trigger]].sort(),
        `${trigger} wrote keys the evaluator does not read`
      );
    });

    it(`${trigger} never falls through to the custom-rule builder`, () => {
      if (trigger === "custom") return;
      const built = buildAlertConditions(trigger, draft());
      assert.ok(built);
      assert.equal(
        "rules" in built,
        false,
        `${trigger} emitted the custom rule blob`
      );
      assert.equal("combinator" in built, false);
    });
  }

  it("refuses to build when a required value is blank", () => {
    assert.equal(buildAlertConditions("flag", draft({ flagKinds: [] })), null);
    assert.equal(
      buildAlertConditions("delivery", draft({ deliveryMultiplier: "" })),
      null
    );
    assert.equal(
      buildAlertConditions("mwpl", draft({ mwplThreshold: "abc" })),
      null
    );
    assert.equal(
      buildAlertConditions("insider", draft({ insiderWindowDays: "0" })),
      null
    );
    assert.equal(
      buildAlertConditions("flow", draft({ flowMinDays: "-3" })),
      null
    );
  });

  it("only the market-wide and free-form triggers may skip the symbol", () => {
    const optional = TRIGGER_KINDS.filter((t) => !triggerNeedsSymbol(t));
    assert.deepEqual([...optional].sort(), ["custom", "flow"]);
    // Everything else must demand one — the RELIANCE seed used to satisfy this
    // guard on a symbol the user had never been shown.
    for (const trigger of TRIGGER_KINDS) {
      if (trigger === "custom" || trigger === "flow") continue;
      assert.equal(TRIGGER_SPECS[trigger].needsSymbol, true, trigger);
    }
  });

  it("the flag panel offers real kinds, defaulted to what the evaluator watches", () => {
    const panel = TRIGGER_SPECS.flag.panel;
    assert.notEqual(panel, "bespoke");
    if (panel === "bespoke") return;
    const field = panel.fields[0];
    assert.ok(field && field.control === "multi");
    const offered = field.options.map((o) => o.id);
    const known = [...DEFAULT_FLAG_KINDS, ...OPT_IN_FLAG_KINDS];
    for (const id of offered) {
      assert.ok(known.includes(id), `unknown flag kind offered: ${id}`);
    }
    // The two whole-universe daily families stay OUT of the picker: offering
    // them is offering a notification every trading day forever.
    for (const id of OPT_IN_FLAG_KINDS) {
      assert.equal(offered.includes(id), false, `${id} must not be offered`);
    }
    // The pre-ticked boxes must equal what the evaluator does with no `kinds`,
    // or the form lies about what the alert will watch.
    assert.deepEqual(
      [...DEFAULT_DATA_ENGINE_DRAFT.flagKinds].sort(),
      [...DEFAULT_FLAG_KINDS].sort()
    );
  });

  it("every trigger declares a Step 2 panel", () => {
    for (const trigger of TRIGGER_KINDS) {
      const panel = TRIGGER_SPECS[trigger].panel;
      if (panel === "bespoke") continue;
      assert.ok(
        panel.fields.length > 0,
        `${trigger} declares a fields panel with no fields`
      );
    }
  });
});

describe("MONEY-1204 · the evaluator actually reads what the drawer wrote", () => {
  it("FLAG_TRANSITION honours the chosen kinds", () => {
    const rows = [{ date: day(5), kind: "SURVEILLANCE", value: "ASM ST-I" }];
    // Per-KIND publication days, the evaluator's `observations` shape.
    const observations = [
      { kind: "SURVEILLANCE", date: day(4) },
      { kind: "SURVEILLANCE", date: day(5) },
      { kind: "FO_BAN", date: day(4) },
      { kind: "FO_BAN", date: day(5) },
    ];
    const built = buildAlertConditions(
      "flag",
      draft({ flagKinds: ["FO_BAN"] })
    );
    assert.ok(built);

    // Default watch list includes SURVEILLANCE → an entry fires.
    assert.ok(
      evaluateFlagTransition({
        symbol: "TCS",
        rows,
        observations,
        conditions: {},
      })
    );
    // The user asked for F&O bans only → silent, even though the F&O-ban file
    // published on both days.
    assert.equal(
      evaluateFlagTransition({
        symbol: "TCS",
        rows,
        observations,
        conditions: built,
      }),
      null
    );
  });

  it("DELIVERY_SPIKE honours the chosen multiplier", () => {
    const baseline = Array.from({ length: 8 }, (_, i) => ({
      date: day(i + 1),
      deliveryPct: 15,
    }));
    const latest = { date: day(10), deliveryPct: 45 }; // 3x the mean
    const built = buildAlertConditions(
      "delivery",
      draft({ deliveryMultiplier: "5" })
    );
    assert.ok(built);

    assert.ok(
      evaluateDeliverySpike({
        symbol: "TCS",
        latest,
        baseline,
        conditions: {},
      })
    );
    assert.equal(
      evaluateDeliverySpike({
        symbol: "TCS",
        latest,
        baseline,
        conditions: built,
      }),
      null
    );
  });

  it("PLEDGE_INCREASE honours the chosen percentage-point delta", () => {
    const rows = [
      { quarter: "2026-03", pledgedPct: 15 },
      { quarter: "2025-12", pledgedPct: 10 }, // +5pp
    ];
    const built = buildAlertConditions(
      "pledge",
      draft({ pledgeMinDeltaPp: "10" })
    );
    assert.ok(built);

    assert.ok(evaluatePledgeIncrease({ symbol: "TCS", rows, conditions: {} }));
    assert.equal(
      evaluatePledgeIncrease({ symbol: "TCS", rows, conditions: built }),
      null
    );
  });

  it("INSIDER_CLUSTER honours the chosen event count", () => {
    const events = [1, 3, 6].map((d) => ({
      date: day(d),
      action: "BUY",
      category: "PIT",
      person: `Insider ${d}`,
    }));
    const built = buildAlertConditions(
      "insider",
      draft({ insiderMinEvents: "5" })
    );
    assert.ok(built);

    assert.ok(
      evaluateInsiderCluster({ symbol: "TCS", events, conditions: {} })
    );
    assert.equal(
      evaluateInsiderCluster({ symbol: "TCS", events, conditions: built }),
      null
    );
  });

  it("MWPL_HIGH honours a threshold BELOW the default", () => {
    // The flip runs the other way here: 70% is silent at the default 80 and
    // fires at the user's 65 — so a defaulted key could not fake this pass.
    const rows = [{ date: day(10), utilisationPct: 70 }];
    const built = buildAlertConditions("mwpl", draft({ mwplThreshold: "65" }));
    assert.ok(built);

    assert.equal(
      evaluateMwplHigh({ symbol: "TCS", rows, conditions: {} }),
      null
    );
    assert.ok(evaluateMwplHigh({ symbol: "TCS", rows, conditions: built }));
  });

  it("FII_FLOW_STREAK honours minDays, directions and category", () => {
    const days = [day(3), day(4), day(5)];
    const rows = days.map((d) => ({ date: d, netValue: 500 }));
    const built = buildAlertConditions(
      "flow",
      draft({ flowMinDays: "3", flowDirection: "BUY", flowCategory: "DII" })
    );
    assert.ok(built);

    // Default is a 5-day streak → a 3-day run is silent.
    assert.equal(
      evaluateFiiFlowStreak({
        category: "DII",
        rows,
        tradingDates: days,
        conditions: {},
      }),
      null
    );
    assert.ok(
      evaluateFiiFlowStreak({
        category: "DII",
        rows,
        tradingDates: days,
        conditions: built,
      })
    );

    // `directions` is a real filter, not decoration.
    const sellOnly = buildAlertConditions(
      "flow",
      draft({ flowMinDays: "3", flowDirection: "SELL" })
    );
    assert.ok(sellOnly);
    assert.equal(
      evaluateFiiFlowStreak({
        category: "FII",
        rows,
        tradingDates: days,
        conditions: sellOnly,
      }),
      null
    );

    // `category` is read by the I/O shell (alert-evaluator.ts:503-509), which
    // picks the InstitutionalFlow rows the pure evaluator then judges.
    assert.equal(built.category, "DII");
    assert.equal(sellOnly.category, "FII");
  });

  it("the streak window is calendar-real, not an off-by-one", () => {
    // Sanity anchor for the fixtures above: three consecutive UTC days.
    assert.equal(day(4).getTime() - day(3).getTime(), DAY);
  });
});
