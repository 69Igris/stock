export type WalkthroughPlacement = "top" | "right" | "bottom" | "left";

export interface TourStep {
  id: string;
  target: string;
  placement: WalkthroughPlacement;
  headline: string;
  body: string;
  // When true, the provider opens the mobile sidebar Sheet before
  // anchoring (sidebar nav items are inside the Sheet on <lg screens).
  requiresMobileSidebar?: boolean;
  // Optional route (path + optional query) the provider navigates to before
  // anchoring this step. Use for steps whose target only renders on a
  // different page/view than where the tour fired — e.g. the StockSage chat
  // composer lives at `/dashboard?view=chat`, not on the `/dashboard`
  // overview. The provider router.push()es here when the current location
  // doesn't already match, and grants the step the longer first-step target
  // timeout to absorb navigation + render latency.
  navigateTo?: string;
}

// Route trigger: tour auto-fires when user lands on the given pathPrefix.
// When `exact: true`, the pathname must equal pathPrefix (no sub-route
// match). Use for pages with sub-routes whose anchors only exist on the
// parent (e.g., /tradebook has /tradebook/import + /tradebook/export
// but v1-tradebook's anchors only live on /tradebook).
export interface TourTriggerRoute {
  kind: "route";
  pathPrefix: string;
  exact?: boolean;
}

// Action trigger: tour fires when a window CustomEvent of the given name
// is dispatched (e.g., first time a feature is used).
export interface TourTriggerAction {
  kind: "action";
  eventName: string;
}

// Manual trigger: tour only fires via explicit `walkthrough:trigger`
// CustomEvent with `{ detail: version }`. Used for opt-in CTAs.
export interface TourTriggerManual {
  kind: "manual";
}

export type TourTrigger =
  | TourTriggerRoute
  | TourTriggerAction
  | TourTriggerManual;

export type PlanTier = "FREE" | "PREMIUM" | "PRO";

export interface TourDefinition {
  version: string;
  steps: TourStep[];
  trigger: TourTrigger;
  // Higher priority fires first when multiple tours are eligible.
  // Defaults to 0.
  priority?: number;
  // If set, tour only fires when the user is on this plan or higher.
  requiresPlan?: PlanTier;
}

export type WalkthroughPhase = "checking" | "dormant" | "active" | "completing";

export interface WalkthroughState {
  phase: WalkthroughPhase;
  stepIndex: number;
  tour: TourDefinition | null;
  startedAt: number | null;
}

export type WalkthroughAction =
  | { type: "BOOTSTRAP_DORMANT" }
  | { type: "BOOTSTRAP_ACTIVE"; tour: TourDefinition; now: number }
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "SKIP" }
  | { type: "COMPLETE_PERSIST_STARTED" }
  | { type: "COMPLETE_PERSIST_DONE" };

export interface WalkthroughContextValue {
  phase: WalkthroughPhase;
  stepIndex: number;
  tour: TourDefinition | null;
  currentStep: TourStep | null;
  next: () => void;
  back: () => void;
  skip: () => void;
  pauseForNow: () => void;
  restart: () => void;
}
