/**
 * API v1 Routes
 *
 * Aggregates all v1 API routes.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success } from "../../lib/response";
import dashboardRoutes from "./dashboard";
import holdingsRoutes from "./holdings";
import positionsRoutes from "./positions";
import tradesRoutes from "./trades";
import pairedRoutes from "./paired";
import paperRoutes from "./paper";
import fireRoutes from "./fire";
import mutualfundsRoutes from "./mutualfunds";
import watchlistRoutes from "./watchlist";
import notificationsRoutes from "./notifications";
import researchRoutes from "./research";
import riskRoutes from "./risk";
import taxRoutes from "./tax";
import subscriptionRoutes from "./subscription";
import brokersRoutes from "./brokers";
import jobsRoutes from "./jobs";
import marketRoutes from "./market";
import discoverRoutes from "./discover";
// MONEY-402 Phase C P4 — engagement surface (mobile-parity)
import meRoutes from "./me";
import roastRoutes from "./roast";
import documentsRoutes from "./documents";
import learningRoutes from "./learning";
import creditsRoutes from "./credits";
import chatHistoryRoutes from "./chat-history";
import quizRoutes from "./quiz";
import feedbackRoutes from "./feedback";
import alertsRoutes from "./alerts";
import consentRoutes from "./consent";
// MONEY-1062 parity P2 — async-trigger tier
import importsRoutes from "./imports";
import compareRoutes from "./compare";
import analysisRoutes from "./analysis";
// MONEY-1062 parity P4 — heavy-extraction tier
import stocksRoutes from "./stocks";
import newsRoutes from "./news";
import resultFeedbackRoutes from "./result-feedback";
import screenerRoutes from "./screener";
import scansRoutes from "./scans";
import strategiesRoutes from "./strategies";
import savedScreensRoutes from "./saved-screens";

/**
 * Canonical list of v1 endpoints, surfaced by `GET /v1/`.
 *
 * Exported (and consumed by the info handler below) so the route catalogue is
 * tested against the real source rather than an inline copy.
 *
 * @see apps/api/__tests__/routes/v1-helpers.test.ts
 */
export const V1_ENDPOINTS: ReadonlyArray<{
  path: string;
  description: string;
}> = [
  { path: "/v1/dashboard", description: "Dashboard data" },
  { path: "/v1/holdings", description: "Holdings CRUD" },
  { path: "/v1/positions", description: "Positions CRUD" },
  { path: "/v1/trades", description: "Trades CRUD" },
  { path: "/v1/paired", description: "Paired trades" },
  { path: "/v1/paper", description: "Paper trading" },
  { path: "/v1/fire", description: "FIRE calculator scenarios" },
  { path: "/v1/mutualfunds", description: "Mutual fund holdings" },
  { path: "/v1/watchlists", description: "Watchlist management" },
  { path: "/v1/notifications", description: "User notifications" },
  { path: "/v1/research", description: "AI research sessions" },
  { path: "/v1/risk", description: "Portfolio risk analysis" },
  { path: "/v1/tax", description: "Tax analysis & reports" },
  { path: "/v1/subscription", description: "Subscription management" },
  { path: "/v1/brokers", description: "Broker connections (read/manage)" },
  { path: "/v1/jobs", description: "Background job status polling" },
  {
    // THIS ARRAY IS SERVED TO CLIENTS, so the blanket "Delayed market data" it
    // used to carry was a compliance claim the family no longer makes for all
    // of its routes. `us/quotes` is advertised INSIDE the family rather than as
    // a 39th entry, which is the same shape P14 used for the nine discover
    // mirrors: this list is mounted `route()` FAMILIES, not endpoints, and
    // `v1-helpers.test.ts` + `parity-p14-discover-sections-contract.test.ts`
    // both pin the count at 38 for that reason.
    path: "/v1/market",
    description:
      "Market data. India (quotes, historical, indices, mf-nav, sparklines, " +
      "fund-composition) is Yahoo/MFAPI DELAYED — `delayed: true`. " +
      "us/quotes serves US symbols from our own realtime + EOD stores with " +
      "per-quote provenance and a DERIVED `delayed` (live only when every " +
      "quote in the batch is).",
  },
  {
    path: "/v1/discover",
    description:
      "Stock/MF/sector discovery & search " +
      "+ MONEY-1204 data-engine sections (flows, positioning, macro, ipos, ipos/dashboard, circulars, indices/:slug, mfs/:schemeCode/portfolio)",
  },
  // MONEY-402 Phase C P4 — engagement surface (mobile-parity)
  {
    path: "/v1/me",
    description:
      "Authenticated profile, persona & preferences, terms/trial, account deletion (OTP)",
  },
  {
    path: "/v1/roast",
    description: "Portfolio roast sessions (history, results, status, manage)",
  },
  { path: "/v1/documents", description: "User document list, detail & delete" },
  {
    path: "/v1/learning",
    description: "Courses, lessons, enrollment, glossary & progress",
  },
  { path: "/v1/credits", description: "Credit balance & usage history" },
  { path: "/v1/chat-history", description: "AI chat session history" },
  { path: "/v1/quizzes", description: "Lesson quizzes (read & score)" },
  { path: "/v1/feedback", description: "Feedback tickets (submit & list)" },
  { path: "/v1/alerts", description: "Price/news alert CRUD" },
  {
    path: "/v1/consent",
    description: "AI-advisory consent ledger (SEBI 18(9))",
  },
  // MONEY-1062 parity P2 — async-trigger tier
  {
    path: "/v1/imports",
    description: "Trade import (async enqueue, history, retry, delete)",
  },
  {
    path: "/v1/compare",
    description: "Fund/stock comparison sessions (start + poll)",
  },
  {
    path: "/v1/analysis",
    description: "L3 comprehensive analysis sessions (start, poll, cancel)",
  },
  // MONEY-1062 parity P4 — heavy-extraction tier
  {
    path: "/v1/stocks",
    description:
      "Stock detail tabs (financials, peers, news, returns, shareholding, ratios, technicals, corporate actions) " +
      "+ MONEY-1204 data-engine sections (flags, delivery, derivatives, shareholding-pattern, insider-activity, deals, filings, financials-source, funds-holding, circulars)",
  },
  {
    path: "/v1/news",
    description: "News feed, stock news, market pulse, events, daily brief",
  },
  {
    path: "/v1/result-feedback",
    description: "Per-AI-result thumbs feedback (submit, clear, hydrate)",
  },
  { path: "/v1/screener", description: "Stock/MF/ETF screeners" },
  { path: "/v1/scans", description: "Scan catalog + run" },
  {
    path: "/v1/strategies",
    description: "Strategy presets + custom strategies (CRUD, async run)",
  },
  { path: "/v1/saved-screens", description: "Saved screener configs (CRUD)" },
];

const v1Routes = new Hono<AppContext>();

// Mount route handlers
v1Routes.route("/dashboard", dashboardRoutes);
v1Routes.route("/holdings", holdingsRoutes);
v1Routes.route("/positions", positionsRoutes);
v1Routes.route("/trades", tradesRoutes);
v1Routes.route("/paired", pairedRoutes);
v1Routes.route("/paper", paperRoutes);
v1Routes.route("/fire", fireRoutes);
v1Routes.route("/mutualfunds", mutualfundsRoutes);
v1Routes.route("/watchlists", watchlistRoutes);
v1Routes.route("/notifications", notificationsRoutes);
v1Routes.route("/research", researchRoutes);
v1Routes.route("/risk", riskRoutes);
v1Routes.route("/tax", taxRoutes);
v1Routes.route("/subscription", subscriptionRoutes);
v1Routes.route("/brokers", brokersRoutes);
v1Routes.route("/jobs", jobsRoutes);
v1Routes.route("/market", marketRoutes);
v1Routes.route("/discover", discoverRoutes);
// MONEY-402 Phase C P4 — engagement surface (mobile-parity). /me carries the
// profile GET (moved from the inline handler below) + persona/preferences PATCH.
v1Routes.route("/me", meRoutes);
v1Routes.route("/roast", roastRoutes);
v1Routes.route("/documents", documentsRoutes);
v1Routes.route("/learning", learningRoutes);
v1Routes.route("/credits", creditsRoutes);
v1Routes.route("/chat-history", chatHistoryRoutes);
v1Routes.route("/quizzes", quizRoutes);
v1Routes.route("/feedback", feedbackRoutes);
v1Routes.route("/alerts", alertsRoutes);
v1Routes.route("/consent", consentRoutes);
v1Routes.route("/imports", importsRoutes);
v1Routes.route("/compare", compareRoutes);
v1Routes.route("/analysis", analysisRoutes);
v1Routes.route("/stocks", stocksRoutes);
v1Routes.route("/news", newsRoutes);
v1Routes.route("/result-feedback", resultFeedbackRoutes);
v1Routes.route("/screener", screenerRoutes);
v1Routes.route("/scans", scansRoutes);
v1Routes.route("/strategies", strategiesRoutes);
v1Routes.route("/saved-screens", savedScreensRoutes);

// API info endpoint
v1Routes.get("/", (c) => {
  return c.json(
    success({
      version: "v1",
      endpoints: V1_ENDPOINTS,
    }),
  );
});

export default v1Routes;
