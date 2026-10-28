import type {
  PlanTier,
  TourDefinition,
  WalkthroughAction,
  WalkthroughState,
} from "./types";

export const initialState: WalkthroughState = {
  phase: "checking",
  stepIndex: 0,
  tour: null,
  startedAt: null,
};

export function walkthroughReducer(
  state: WalkthroughState,
  action: WalkthroughAction
): WalkthroughState {
  switch (action.type) {
    case "BOOTSTRAP_DORMANT":
      return { ...state, phase: "dormant", stepIndex: 0, tour: null };

    case "BOOTSTRAP_ACTIVE":
      return {
        phase: "active",
        stepIndex: 0,
        tour: action.tour,
        startedAt: action.now,
      };

    case "NEXT": {
      if (state.phase !== "active" || !state.tour) return state;
      const last = state.tour.steps.length - 1;
      if (state.stepIndex >= last) {
        return { ...state, phase: "completing" };
      }
      return { ...state, stepIndex: state.stepIndex + 1 };
    }

    case "BACK": {
      if (state.phase !== "active") return state;
      if (state.stepIndex === 0) return state;
      return { ...state, stepIndex: state.stepIndex - 1 };
    }

    case "SKIP": {
      if (state.phase !== "active") return state;
      return { ...state, phase: "completing" };
    }

    case "COMPLETE_PERSIST_STARTED":
      return state;

    case "COMPLETE_PERSIST_DONE":
      return {
        phase: "dormant",
        stepIndex: 0,
        tour: null,
        startedAt: null,
      };

    default:
      return state;
  }
}

export function selectIsOnLastStep(state: WalkthroughState): boolean {
  if (!state.tour) return false;
  return state.stepIndex >= state.tour.steps.length - 1;
}

export function selectDurationMs(state: WalkthroughState, now: number): number {
  if (state.startedAt == null) return 0;
  return Math.max(0, now - state.startedAt);
}

export function shouldShowVersion(
  seenVersions: string[],
  currentVersion: string
): boolean {
  return !seenVersions.includes(currentVersion);
}

export function buildBootstrapAction(
  seenVersions: string[],
  currentVersion: string,
  tour: TourDefinition,
  now: number
): WalkthroughAction {
  if (shouldShowVersion(seenVersions, currentVersion)) {
    return { type: "BOOTSTRAP_ACTIVE", tour, now };
  }
  return { type: "BOOTSTRAP_DORMANT" };
}

const PLAN_RANK: Record<PlanTier, number> = {
  FREE: 0,
  PREMIUM: 1,
  PRO: 2,
};

export function planMeetsRequirement(
  userPlan: string | null | undefined,
  required: PlanTier | undefined
): boolean {
  if (!required) return true;
  const user = (userPlan ?? "FREE") as PlanTier;
  const userRank = PLAN_RANK[user] ?? 0;
  return userRank >= PLAN_RANK[required];
}

export function isSnoozed(
  snoozedUntil: Record<string, string> | null | undefined,
  version: string,
  now: number
): boolean {
  if (!snoozedUntil) return false;
  const until = snoozedUntil[version];
  if (!until) return false;
  const t = Date.parse(until);
  if (Number.isNaN(t)) return false;
  return t > now;
}

export interface EligibilityContext {
  seenVersions: string[];
  snoozedUntil: Record<string, string> | null | undefined;
  planId: string | null | undefined;
  now: number;
}

export interface RouteCandidate {
  kind: "route";
  pathname: string;
}

export interface ActionCandidate {
  kind: "action";
  eventName: string;
}

export interface ManualCandidate {
  kind: "manual";
  targetVersion: string;
}

export type TriggerCandidate =
  | RouteCandidate
  | ActionCandidate
  | ManualCandidate;

function tourMatchesCandidate(
  tour: TourDefinition,
  candidate: TriggerCandidate
): boolean {
  const t = tour.trigger;
  if (t.kind === "route" && candidate.kind === "route") {
    if (t.exact) {
      return candidate.pathname === t.pathPrefix;
    }
    return (
      candidate.pathname === t.pathPrefix ||
      candidate.pathname.startsWith(t.pathPrefix + "/")
    );
  }
  if (t.kind === "action" && candidate.kind === "action") {
    return t.eventName === candidate.eventName;
  }
  if (t.kind === "manual" && candidate.kind === "manual") {
    return candidate.targetVersion === tour.version;
  }
  return false;
}

export function pickEligibleTour(
  registry: TourDefinition[],
  candidate: TriggerCandidate,
  ctx: EligibilityContext
): TourDefinition | null {
  const eligible = registry
    .filter((tour) => tourMatchesCandidate(tour, candidate))
    .filter((tour) => !ctx.seenVersions.includes(tour.version))
    .filter((tour) => !isSnoozed(ctx.snoozedUntil, tour.version, ctx.now))
    .filter((tour) => planMeetsRequirement(ctx.planId, tour.requiresPlan));

  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return eligible[0] ?? null;
}

export const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
