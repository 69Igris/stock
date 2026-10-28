export type PageRoute =
  | "/tradebook"
  | "/positions"
  | "/holdings"
  | "/paper-trading"
  | "/discover"
  | "/analysis"
  | "/sage-tutor"
  | "/learning"
  | "/watchlist"
  | "/roast"
  | "/risk"
  | "/tax"
  | "/documents"
  | "/strategies"
  | "/quizzes"
  | "/discover/scans";

/**
 * Routes that are fully shipped and always accessible - no PostHog evaluation.
 * Removing these from the flag pipeline eliminates a currentUser() + PostHog
 * Decide API call for these pages.
 */
export const ALWAYS_ON_ROUTES: readonly PageRoute[] = [
  "/tradebook",
  "/positions",
  "/holdings",
  "/discover",
  "/analysis",
  "/watchlist",
  "/roast",
  // MONEY-394 E - /documents page is now accessible to all. The
  // Generate Report button is gated independently via the new
  // AppFeatureFlag system (key: 'generate-report').
  "/documents",
] as const;

/** Routes that still require PostHog feature flag gating */
export type GatedPageRoute =
  | "/paper-trading"
  | "/sage-tutor"
  | "/learning"
  | "/risk"
  | "/tax"
  | "/strategies"
  | "/quizzes"
  | "/discover/scans";

export type FeatureFlagMap = Record<PageRoute, boolean>;

export interface FeatureFlagState {
  flags: FeatureFlagMap;
  isLoading: boolean;
  isDemoMode: boolean;
}

export interface PageAccessInfo {
  route: PageRoute;
  isEnabled: boolean;
  showComingSoon: boolean;
  showUpgrade: boolean;
  requiredPlan?: string;
}

export interface FeatureFlagsResponse {
  flags: FeatureFlagMap;
  version: string;
  timestamp: number;
}

// ── US / International Feature Flags ──────────────────────────────

export type UsFeatureFlag =
  | "us-stocks-listing"
  | "us-stocks-search"
  | "us-broker-ib"
  | "global-mf"
  | "us-stock-research";

export type UsFeatureFlagMap = Record<UsFeatureFlag, boolean>;

export interface UsFeatureFlagsResponse {
  flags: UsFeatureFlagMap;
  version: string;
  timestamp: number;
}

// ── App-level Feature Flags ────────────────────────────────────────
// Non-route, non-locale flags that gate individual UI surfaces (e.g.
// a single button) rather than a whole page. Modelled after the
// UsFeatureFlag system. Add new keys here as the need arises.

/**
 * MONEY-394 E - `generate-report` gates the Generate Report button on
 * /documents. The page itself is no longer FF-gated (see
 * ALWAYS_ON_ROUTES); only the report generation surface requires
 * access.
 *
 * MONEY-298/204/297/192/203/396/400 - Cycle 3 design implementations.
 * Each surface ships behind its own AppFeatureFlag so partial rollout
 * is safe and the legacy chrome remains the default until each gate
 * is flipped on per cohort in PostHog.
 */
export type AppFeatureFlag =
  | "generate-report"
  | "terminal-luxe-sectors"
  | "terminal-luxe-news"
  | "terminal-luxe-analysis-v2"
  | "terminal-luxe-risk-v2"
  | "terminal-luxe-tax-v2"
  | "terminal-luxe-strategies-v2"
  | "doc-vault-research-pin"
  | "holdings-research-trigger"
  // MONEY-566: routes market-data quote fetching through the provider seam
  // (lib/market/providers). Default OFF → legacy inline path stays live;
  // ON → provider-registry path (behaviour-identical in v1, extensible to a
  // licensed NSE/BSE feed or a free fallback without touching call sites).
  | "federated-data";

export type AppFeatureFlagMap = Record<AppFeatureFlag, boolean>;

export interface AppFeatureFlagsResponse {
  flags: AppFeatureFlagMap;
  version: string;
  timestamp: number;
}
