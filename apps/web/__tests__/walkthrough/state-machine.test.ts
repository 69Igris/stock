/**
 * Walkthrough State Machine Tests
 *
 * Pure-function tests for the reducer + eligibility helpers behind
 * WalkthroughProvider (MONEY-387). No React rendering, no DB.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBootstrapAction,
  initialState,
  isSnoozed,
  pickEligibleTour,
  planMeetsRequirement,
  selectDurationMs,
  selectIsOnLastStep,
  shouldShowVersion,
  walkthroughReducer,
} from "@/components/walkthrough/state-machine";
import type {
  EligibilityContext,
  TriggerCandidate,
} from "@/components/walkthrough/state-machine";
import type {
  TourDefinition,
  WalkthroughState,
} from "@/components/walkthrough/types";

const fixtureTour: TourDefinition = {
  version: "v1-core",
  trigger: { kind: "route", pathPrefix: "/dashboard" },
  steps: [
    {
      id: "a",
      target: "[data-walkthrough='a']",
      placement: "right",
      headline: "A",
      body: "a body",
    },
    {
      id: "b",
      target: "[data-walkthrough='b']",
      placement: "right",
      headline: "B",
      body: "b body",
    },
    {
      id: "c",
      target: "[data-walkthrough='c']",
      placement: "right",
      headline: "C",
      body: "c body",
    },
  ],
};

function activeState(stepIndex = 0): WalkthroughState {
  return {
    phase: "active",
    stepIndex,
    tour: fixtureTour,
    startedAt: 1000,
  };
}

describe("walkthroughReducer", () => {
  describe("BOOTSTRAP_DORMANT", () => {
    it("moves checking → dormant and clears tour", () => {
      const next = walkthroughReducer(initialState, {
        type: "BOOTSTRAP_DORMANT",
      });
      assert.equal(next.phase, "dormant");
      assert.equal(next.tour, null);
      assert.equal(next.stepIndex, 0);
    });
  });

  describe("BOOTSTRAP_ACTIVE", () => {
    it("activates a tour at step 0 with startedAt timestamp", () => {
      const next = walkthroughReducer(initialState, {
        type: "BOOTSTRAP_ACTIVE",
        tour: fixtureTour,
        now: 5000,
      });
      assert.equal(next.phase, "active");
      assert.equal(next.stepIndex, 0);
      assert.equal(next.tour, fixtureTour);
      assert.equal(next.startedAt, 5000);
    });
  });

  describe("NEXT", () => {
    it("advances step within bounds", () => {
      const next = walkthroughReducer(activeState(0), { type: "NEXT" });
      assert.equal(next.stepIndex, 1);
      assert.equal(next.phase, "active");
    });

    it("transitions to completing when advancing past the last step", () => {
      const next = walkthroughReducer(activeState(2), { type: "NEXT" });
      assert.equal(next.phase, "completing");
    });

    it("is a no-op outside the active phase", () => {
      const state = walkthroughReducer(initialState, {
        type: "BOOTSTRAP_DORMANT",
      });
      const next = walkthroughReducer(state, { type: "NEXT" });
      assert.deepEqual(next, state);
    });
  });

  describe("BACK", () => {
    it("decrements step index", () => {
      const next = walkthroughReducer(activeState(2), { type: "BACK" });
      assert.equal(next.stepIndex, 1);
    });

    it("is a no-op on step 0", () => {
      const state = activeState(0);
      const next = walkthroughReducer(state, { type: "BACK" });
      assert.deepEqual(next, state);
    });
  });

  describe("SKIP", () => {
    it("transitions active → completing", () => {
      const next = walkthroughReducer(activeState(1), { type: "SKIP" });
      assert.equal(next.phase, "completing");
    });
  });

  describe("COMPLETE_PERSIST_DONE", () => {
    it("resets to dormant after persistence", () => {
      const state: WalkthroughState = {
        phase: "completing",
        stepIndex: 2,
        tour: fixtureTour,
        startedAt: 1000,
      };
      const next = walkthroughReducer(state, {
        type: "COMPLETE_PERSIST_DONE",
      });
      assert.equal(next.phase, "dormant");
      assert.equal(next.tour, null);
      assert.equal(next.stepIndex, 0);
      assert.equal(next.startedAt, null);
    });
  });
});

/**
 * MONEY-439: eager-persist regression suite.
 *
 * The bug: `markWalkthroughSeenAction` was only invoked when the state
 * machine reached `phase === "completing"` (via NEXT-from-last-step or
 * SKIP). Closing the tab or navigating away mid-tour left the version
 * absent from `User.walkthroughVersionsSeen` in MongoDB. On re-login —
 * especially from a different device — the same tour fired again.
 *
 * The fix lives in WalkthroughProvider's new effect: as soon as a tour
 * is `active` and `state.tour.version` is not already in `seenVersionsRef`,
 * write it through. The pure helper below mirrors that exact branching
 * and the tests pin every branch.
 */

interface EagerPersistOptions {
  phase: WalkthroughState["phase"];
  tourVersion: string | null;
  seenVersions: string[];
  hasUser: boolean;
  isDemo: boolean;
}

interface EagerPersistResult {
  shouldPersist: boolean;
  nextSeen: string[];
}

function shouldEagerPersistOnActive(
  opts: EagerPersistOptions
): EagerPersistResult {
  const { phase, tourVersion, seenVersions, hasUser, isDemo } = opts;
  // Mirrors the guard in apps/web/components/walkthrough/WalkthroughProvider.tsx
  // (the new effect added in MONEY-439).
  if (phase !== "active" || !tourVersion) {
    return { shouldPersist: false, nextSeen: seenVersions };
  }
  if (!hasUser || isDemo) {
    return { shouldPersist: false, nextSeen: seenVersions };
  }
  if (seenVersions.includes(tourVersion)) {
    return { shouldPersist: false, nextSeen: seenVersions };
  }
  return {
    shouldPersist: true,
    nextSeen: [...seenVersions, tourVersion],
  };
}

describe("MONEY-439 eager-persist on BOOTSTRAP_ACTIVE", () => {
  const baseOpts: EagerPersistOptions = {
    phase: "active",
    tourVersion: "v1-core",
    seenVersions: [],
    hasUser: true,
    isDemo: false,
  };

  it("persists the moment a fresh tour goes active for an auth'd user", () => {
    const r = shouldEagerPersistOnActive(baseOpts);
    assert.equal(r.shouldPersist, true);
    assert.deepEqual(r.nextSeen, ["v1-core"]);
  });

  it("is idempotent — does not re-persist a version already in seenVersions", () => {
    const r = shouldEagerPersistOnActive({
      ...baseOpts,
      seenVersions: ["v1-core"],
    });
    assert.equal(r.shouldPersist, false);
    assert.deepEqual(r.nextSeen, ["v1-core"]);
  });

  it("skips persistence for demo sessions (no DB user)", () => {
    const r = shouldEagerPersistOnActive({ ...baseOpts, isDemo: true });
    assert.equal(r.shouldPersist, false);
  });

  it("skips persistence when Clerk user hasn't loaded yet", () => {
    const r = shouldEagerPersistOnActive({ ...baseOpts, hasUser: false });
    assert.equal(r.shouldPersist, false);
  });

  it("does nothing for non-active phases", () => {
    for (const phase of ["checking", "dormant", "completing"] as const) {
      const r = shouldEagerPersistOnActive({ ...baseOpts, phase });
      assert.equal(r.shouldPersist, false, `phase=${phase} should be no-op`);
    }
  });

  it("does nothing when tour version is null", () => {
    const r = shouldEagerPersistOnActive({ ...baseOpts, tourVersion: null });
    assert.equal(r.shouldPersist, false);
  });

  it("regression: completing alone is NOT a precondition — active is enough", () => {
    // Before MONEY-439 only the `completing` phase wrote through. Pin
    // that the new logic writes on `active` so reload / close-tab does
    // not lose the seen-state.
    const completingResult = shouldEagerPersistOnActive({
      ...baseOpts,
      phase: "completing",
    });
    assert.equal(completingResult.shouldPersist, false);

    const activeResult = shouldEagerPersistOnActive(baseOpts);
    assert.equal(activeResult.shouldPersist, true);
  });

  it("appends to existing seenVersions without dropping prior entries", () => {
    const r = shouldEagerPersistOnActive({
      ...baseOpts,
      tourVersion: "v1-roast",
      seenVersions: ["v1-core", "v1-tradebook"],
    });
    assert.equal(r.shouldPersist, true);
    assert.deepEqual(r.nextSeen, ["v1-core", "v1-tradebook", "v1-roast"]);
  });
});

describe("selectIsOnLastStep", () => {
  it("returns false on intermediate steps", () => {
    assert.equal(selectIsOnLastStep(activeState(0)), false);
    assert.equal(selectIsOnLastStep(activeState(1)), false);
  });

  it("returns true on the last step", () => {
    assert.equal(selectIsOnLastStep(activeState(2)), true);
  });

  it("returns false when no tour is loaded", () => {
    assert.equal(selectIsOnLastStep(initialState), false);
  });
});

describe("selectDurationMs", () => {
  it("returns 0 when startedAt is unset", () => {
    assert.equal(selectDurationMs(initialState, 5000), 0);
  });

  it("returns elapsed ms when startedAt is set", () => {
    assert.equal(selectDurationMs(activeState(0), 4500), 3500);
  });

  it("never returns negative durations", () => {
    assert.equal(selectDurationMs(activeState(0), 500), 0);
  });
});

describe("shouldShowVersion", () => {
  it("returns true when version is unseen", () => {
    assert.equal(shouldShowVersion([], "v1-core"), true);
    assert.equal(shouldShowVersion(["v2-roast"], "v1-core"), true);
  });

  it("returns false when version is already seen", () => {
    assert.equal(shouldShowVersion(["v1-core"], "v1-core"), false);
  });
});

describe("buildBootstrapAction", () => {
  it("returns BOOTSTRAP_ACTIVE for unseen version", () => {
    const action = buildBootstrapAction([], "v1-core", fixtureTour, 7000);
    assert.equal(action.type, "BOOTSTRAP_ACTIVE");
  });

  it("returns BOOTSTRAP_DORMANT for already-seen version", () => {
    const action = buildBootstrapAction(
      ["v1-core"],
      "v1-core",
      fixtureTour,
      7000
    );
    assert.equal(action.type, "BOOTSTRAP_DORMANT");
  });
});

describe("planMeetsRequirement", () => {
  it("permits when no plan requirement", () => {
    assert.equal(planMeetsRequirement("FREE", undefined), true);
    assert.equal(planMeetsRequirement(null, undefined), true);
  });

  it("treats undefined plan as FREE", () => {
    assert.equal(planMeetsRequirement(undefined, "FREE"), true);
    assert.equal(planMeetsRequirement(undefined, "PREMIUM"), false);
  });

  it("ranks PRO ≥ PREMIUM ≥ FREE", () => {
    assert.equal(planMeetsRequirement("PRO", "PREMIUM"), true);
    assert.equal(planMeetsRequirement("PREMIUM", "PRO"), false);
    assert.equal(planMeetsRequirement("FREE", "PREMIUM"), false);
  });
});

describe("isSnoozed", () => {
  it("returns false when no snooze entry exists", () => {
    assert.equal(isSnoozed({}, "v1-core", Date.now()), false);
    assert.equal(isSnoozed(null, "v1-core", Date.now()), false);
  });

  it("returns true when snooze timestamp is in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(isSnoozed({ "v1-core": future }, "v1-core", Date.now()), true);
  });

  it("returns false when snooze has elapsed", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(isSnoozed({ "v1-core": past }, "v1-core", Date.now()), false);
  });

  it("gracefully ignores bad ISO strings", () => {
    assert.equal(isSnoozed({ "v1-core": "not-a-date" }, "v1-core", 0), false);
  });
});

describe("pickEligibleTour", () => {
  const routeTour: TourDefinition = {
    version: "v1-route",
    trigger: { kind: "route", pathPrefix: "/dashboard" },
    priority: 10,
    steps: fixtureTour.steps,
  };
  const actionTour: TourDefinition = {
    version: "v1-action",
    trigger: { kind: "action", eventName: "walkthrough:demo-event" },
    priority: 5,
    steps: fixtureTour.steps,
  };
  const manualTour: TourDefinition = {
    version: "v1-manual",
    trigger: { kind: "manual" },
    steps: fixtureTour.steps,
  };
  const proTour: TourDefinition = {
    version: "v1-pro-only",
    trigger: { kind: "route", pathPrefix: "/dashboard" },
    requiresPlan: "PRO",
    priority: 99,
    steps: fixtureTour.steps,
  };
  const registry = [routeTour, actionTour, manualTour, proTour];

  function ctx(
    overrides: Partial<EligibilityContext> = {}
  ): EligibilityContext {
    return {
      seenVersions: [],
      snoozedUntil: {},
      planId: "FREE",
      now: Date.now(),
      ...overrides,
    };
  }

  it("matches a route trigger to its pathPrefix", () => {
    const cand: TriggerCandidate = {
      kind: "route",
      pathname: "/dashboard",
    };
    const t = pickEligibleTour(registry, cand, ctx());
    assert.ok(t);
    assert.equal(t.version, "v1-route");
  });

  it("matches a route prefix (e.g. /dashboard/anything)", () => {
    const cand: TriggerCandidate = {
      kind: "route",
      pathname: "/dashboard/holdings",
    };
    const t = pickEligibleTour(registry, cand, ctx());
    assert.ok(t);
    assert.equal(t.version, "v1-route");
  });

  it("exact: true rejects sub-route matches", () => {
    const exactTour: TourDefinition = {
      version: "v1-exact",
      trigger: { kind: "route", pathPrefix: "/tradebook", exact: true },
      priority: 5,
      steps: fixtureTour.steps,
    };
    // Exact path: matches
    const onPath = pickEligibleTour(
      [exactTour],
      { kind: "route", pathname: "/tradebook" },
      ctx()
    );
    assert.ok(onPath);
    assert.equal(onPath.version, "v1-exact");

    // Sub-route: does NOT match
    const onSub = pickEligibleTour(
      [exactTour],
      { kind: "route", pathname: "/tradebook/import" },
      ctx()
    );
    assert.equal(onSub, null);
  });

  it("returns null when pathname does not match any route trigger", () => {
    const t = pickEligibleTour(
      registry,
      { kind: "route", pathname: "/random" },
      ctx()
    );
    assert.equal(t, null);
  });

  it("matches an action trigger by event name", () => {
    const t = pickEligibleTour(
      registry,
      { kind: "action", eventName: "walkthrough:demo-event" },
      ctx()
    );
    assert.ok(t);
    assert.equal(t.version, "v1-action");
  });

  it("matches a manual trigger by exact version", () => {
    const t = pickEligibleTour(
      registry,
      { kind: "manual", targetVersion: "v1-manual" },
      ctx()
    );
    assert.ok(t);
    assert.equal(t.version, "v1-manual");
  });

  it("skips a tour the user has already seen", () => {
    const t = pickEligibleTour(
      registry,
      { kind: "route", pathname: "/dashboard" },
      ctx({ seenVersions: ["v1-route"], planId: "PRO" })
    );
    // v1-pro-only is the only remaining route-eligible tour for PRO
    assert.ok(t);
    assert.equal(t.version, "v1-pro-only");
  });

  it("respects plan gating", () => {
    const cand: TriggerCandidate = {
      kind: "route",
      pathname: "/dashboard",
    };
    // FREE user: only sees v1-route, not v1-pro-only
    const freePick = pickEligibleTour(registry, cand, ctx({ planId: "FREE" }));
    assert.equal(freePick?.version, "v1-route");
    // PRO user: priority 99 wins
    const proPick = pickEligibleTour(registry, cand, ctx({ planId: "PRO" }));
    assert.equal(proPick?.version, "v1-pro-only");
  });

  it("respects active snooze entries", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const t = pickEligibleTour(
      registry,
      { kind: "route", pathname: "/dashboard" },
      ctx({ snoozedUntil: { "v1-route": future } })
    );
    assert.equal(t, null);
  });

  it("picks higher-priority tour when multiple match", () => {
    const lo: TourDefinition = {
      version: "lo",
      trigger: { kind: "route", pathPrefix: "/x" },
      priority: 1,
      steps: fixtureTour.steps,
    };
    const hi: TourDefinition = {
      version: "hi",
      trigger: { kind: "route", pathPrefix: "/x" },
      priority: 99,
      steps: fixtureTour.steps,
    };
    const t = pickEligibleTour(
      [lo, hi],
      { kind: "route", pathname: "/x" },
      ctx()
    );
    assert.equal(t?.version, "hi");
  });
});
