import type { PageRoute } from "@/lib/types/feature-flags";
import type { Feature } from "@usemoney/core";

/**
 * Maps page routes to their required subscription features.
 * null = no subscription check needed (free for all users).
 * non-null = requires the minimum plan that grants this feature.
 *
 * MONEY-394 - Free users now reach /analysis + /discover (+ its sub-routes
 * /discover/screener and /discover/markets) and /documents directly. The
 * page-level paywall is replaced with action-level credit + tier gates so
 * users land on the actual product and discover what their 5 free credits /
 * 1 free roast unlock. Heavy-tier actions (advanced/comprehensive research,
 * custom skills, document vault sources, generate report) are still
 * blocked behind tier checks at the individual action surface.
 */
export const PAGE_TO_FEATURE_MAP: Record<PageRoute, Feature | null> = {
  "/tradebook": null, // Free for all - import gated separately for free users
  "/positions": null, // Free for all - manual positions available
  "/holdings": null, // Free for all - manual holdings available
  "/paper-trading": null, // Free for all - charts/strategies locked for free users
  "/discover": null, // MONEY-394 - free users get the screener + markets surface
  "/analysis": null, // MONEY-394 - free users get 5 research credits / month
  "/sage-tutor": "aiLearning",
  // MONEY-1149 — the MAP was the wrong half, not the code.
  //
  // This said `learningContent`, so PageGuard blocked FREE users from the
  // page. Nothing gated the lesson TEXT to match: the only gate on that path
  // is `advancedCourses`, applied in `packages/services/src/learning-logic.ts`
  // and only to ADVANCED lessons and courses. A FREE caller could read any
  // BASIC/INTERMEDIATE lesson in full by invoking the server action directly,
  // while being bounced from the UI that renders exactly that content.
  //
  // What `learningContent` DOES still gate — and this is why setting it null
  // here is safe — is the premium MEDIA: `/api/storage/stream` checks
  // `hasFeatureAccess(planId, "learningContent")` before serving any
  // non-document path, so lesson videos and PDFs stay PREMIUM/ULTIMATE-only
  // regardless of this entry. The paywall lives on the bytes, not on the page.
  //
  // Resolved in favour of the code. `/learning(.*)` is already in
  // PUBLIC_ROUTE_PATTERNS (proxy-routes.ts), so middleware never gated it
  // either — PageGuard was the lone dissenter, and MONEY-394 had already moved
  // `/analysis` and `/discover` to exactly this posture: free users land on the
  // real product and discover what premium unlocks. The ADVANCED gate keeps
  // working for apps/api too, because it lives in the shared service rather
  // than in a route.
  "/learning": null,
  "/watchlist": null,
  "/roast": null, // Free for all - 1 free roast, then upgrade
  "/risk": "riskAnalysis",
  "/tax": "taxAnalysis",
  "/documents": "documentVault", // MONEY-394 - Premium-only. Generate Report has its own app-level FF on top of this tier gate.
  "/strategies": "aiStrategies",
  "/quizzes": "advancedCourses",
  // MONEY-1058: Scans is founder-gated by its feature flag, not by tier —
  // no subscription feature required (null).
  "/discover/scans": null,
};
