/**
 * @usemoney/services
 *
 * Shared service layer consumed by:
 * - apps/web (Next.js Server Actions)
 * - apps/api (Hono REST API)
 * - workers/ (Pub/Sub processors)
 *
 * Each service accepts an internal userId (MongoDB _id) and returns ServiceResult<T>.
 * Auth resolution (Clerk → userId) is the caller's responsibility.
 */

export type { ServiceResult } from "./types";

// Batch 1: Core Data
export * from "./holdings.service";
export * from "./positions.service";
export * from "./trades.service";
export * from "./dashboard.service";
// Pure, Prisma-free dashboard aggregation helpers (finite-guarded). Exported so
// the LIVE service path and its regression tests execute the SAME guarded math.
export * from "./dashboard-logic";
export * from "./mutualfunds.service";
export * from "./mf-nav-propagation.service";
export * from "./peers-sync.service";

// Batch 2: Portfolio Features
export * from "./paper.service";
// MONEY-1062 (P3a) — order/cash paper model (matches the web UI) for apps/api
// parity. Additive to paper.service (the legacy position model); see the file
// header for the web-action → service port map + the duplication note.
export * from "./paper-portfolio.service";
export * from "./fire.service";
export * from "./watchlist.service";
export * from "./notifications.service";
export * from "./notifications-pagination";
export * from "./chat-history.service";

// Batch 3: AI & Premium
export * from "./roast.service";
export * from "./comparison.service";
export * from "./research.service";
// MONEY-1062 (P2b) — L3/L4 comprehensive-analysis lifecycle (start/status/
// result/cancel) for apps/api parity. New file: no prior service touched
// AnalysisSession (the web action drove Prisma directly).
export * from "./analysis.service";
// MONEY-840/844 — corporate-actions persist + DB-first reader
export * from "./corporate-actions.service";
export * from "./risk.service";
export * from "./risk-stress-test";
export * from "./news-ingest";
export * from "./tax.service";
export * from "./documents.service";
export * from "./credit-reservation.service";
export * from "./credit.service";

// Batch 4: Discovery & Content
export * from "./discover.service";
// MONEY-1062 (P4a) — GLOBAL stock-detail tabs (financials/peers/news/returns/
// shareholding/ratios/technicals) for apps/api /v1/stocks/:symbol/*. Faithful
// port of apps/web/lib/actions/stock-tabs.ts; corporate-actions reuses the
// existing corporate-actions.service (getCorporateActions).
export * from "./stock-tabs.service";
// MONEY-1062 (P4d) — additive discover parity for apps/api: sector performance,
// treemap heatmap, sector deep-dive, ETFs, and instruments-by-symbol. Extracted
// from Prisma-local apps/web actions (discover-sectors / discover-heatmap /
// sectors / discover-indices) with their web-local pure seams ported verbatim.
export * from "./discover-market.service";
export * from "./learning.service";
export * from "./strategy.service";
export * from "./fund-comparison.service";
export * from "./fund-composition.service";
// MONEY-1405 D4 — the AMC-disclosure composition builder + the `source`
// discriminator the panel renders. Pure (no I/O at import), so exporting it
// from the barrel costs a consumer nothing.
export * from "./fund-composition-from-disclosure";
export * from "./sparkline.service";
// MONEY-1062 (P4b) — News & Events reads (feed, per-symbol, market pulse,
// upcoming events, daily brief) + per-result 👍/👎 feedback (incl. the MONEY-800
// bandit outcome side effect) for apps/api parity. New files: the web actions
// drove Prisma + the cache directly (no prior service touched these models).
export * from "./news.service";
export * from "./result-feedback.service";

// Batch 5: Complex Orchestration
export * from "./subscription.service";
// MONEY-1062 (W1-B) — subscription-domain grant + Dodo lifecycle writes. The
// payments transport (payment-provisioning.service) calls into these; hard
// boundary — this module never imports the payment webhook/envelope types.
export * from "./subscription-grants.service";
export * from "./coupon.service";
// MONEY-865 #4 — paid plan-change routing (pure, testable; checkout vs
// in-place changePlan vs scheduled-downgrade + flat/% discount per cycle).
export * from "./paid-plan-change-logic";
export * from "./admin-audit-logic";
export * from "./admin-audit.service";
export * from "./payment-grant.service";
// MONEY-1062 (W1-B) — PAYMENTS-domain transport: Dodo webhook envelope dispatch,
// Payment-row bookkeeping, and the appliedAt claim-once mechanics. Calls into the
// subscription-domain grant (subscription-grants.service) after claiming.
// `*-logic` is the pure, Prisma-free seam (types + envelope table + sanitisers).
export * from "./payment-provisioning-logic";
export * from "./payment-provisioning.service";
// scheduled-plan-changes: subscription plan-lifecycle cron body (may call
// core/payments dodoClient for the Dodo changePlan I/O).
export * from "./scheduled-plan-changes-logic";
export * from "./scheduled-plan-changes.service";
// MONEY-1062 (P4e) — the USER-INITIATED side of the scheduled-plan-change
// surface (schedule cancel/downgrade, unschedule, preview, AI-credit pre-flight)
// for apps/api parity. Distinct from the CRON twin above (which APPLIES a due
// schedule); this is where the user STAMPS one. Dodo I/O stays in the service.
export * from "./subscription-management.service";
// MONEY-1062 (W1-A) — Dodo product catalog sync (system-level, moved from
// apps/web/lib/payments/product-sync).
export * from "./product-sync.service";
export * from "./platform-config.service";
export * from "./broker-connection.service";
// MONEY-1062 (W2-B) — pure MF-diagnostics logic (diagnose + ISIN populate seams)
// extracted from apps/web broker-connection actions.
export * from "./broker-diagnostics-logic";
export * from "./broker-sync.service";
export * from "./trade-import.service";
export * from "./user.service";
// MONEY-731 — user-scoped BackgroundJob status polling for apps/api (/v1/jobs).
export * from "./job.service";
export * from "./user-sync.service";
export * from "./account-deletion.service";
export * from "./content.service";

// Batch 6: GST / Billing (MONEY-212 → MONEY-217)
export * as gst from "./gst";

// Batch 7: User preferences (MONEY-219+)
export * as preferences from "./preferences";
// MONEY-402 mobile-parity — flat named aliases for the composer-preference
// read/write consumed by apps/api `PATCH /v1/me/persona`. The `preferences`
// namespace above still exposes the full surface; these flat exports let the
// apps/api routes (and their flat `@usemoney/services` Proxy test seam) import
// the persona setter/reader the same way every other route imports a service.
export {
  getComposerPreferences,
  setComposerPreferences,
} from "./preferences/composer-preferences";

// Batch 8: Engagement surface (MONEY-402 Phase C P4 — apps/api mobile-parity).
// Non-AI quiz CRUD/score, feedback tickets, alert CRUD, and the SEBI consent
// ledger. Each service takes a Mongo userId, returns ServiceResult<T>, and keeps
// its pure seam in a sibling *-logic.ts.
export * from "./quiz.service";
export * from "./quiz-logic";
export * from "./feedback.service";
export * from "./feedback-logic";
export * from "./alerts.service";
export * from "./alerts-logic";
export * from "./consent.service";
export * from "./consent-logic";

// Batch 9: Discovery-power surface (MONEY-1062 P4c — apps/api parity).
// Faithful extractions of the web screener/scans/strategies/saved-screens
// actions; each service header carries the action → service port map. The
// screener ships its pure helpers (match-score, etf-derive, index
// constituents) ported verbatim from the web-local lib/ copies.
export * from "./screener.service";
export * from "./scans.service";
export * from "./strategies.service";
export * from "./saved-screens.service";
export { invalidateEntitlement } from "./entitlement-invalidation";
export { mapWithConcurrency } from "./concurrency-logic";

// Provenance envelope for the Lane 14c/14d data-engine sections (MONEY-1204).
// Defined once here because the web action and its apps/api mirror must return
// the SAME shape, and one imported definition is the only version of that
// standing rule a reviewer does not have to enforce by eye.
export {
  withProvenance,
  latestAsOf,
  type Provenance,
  type WithProvenance,
} from "./provenance";

// MF Portfolio tab (MONEY-1204 / P14 14d.1) — official AMC disclosure first,
// Kuvera/AI-derived FundHolding only as a LABELLED fallback.
export * from "./mf-portfolio-section.service";

// Stock-page market sections (MONEY-1204 / P14 · 14c.1-14c.3): exchange flags +
// index chips, delivery trend, F&O. Ports of the web actions in
// apps/web/lib/actions/stock-sections-market.ts, which wrap these directly so
// the two surfaces cannot drift.
export * from "./stock-sections-market.service";

// Ownership sections for the stock page (MONEY-1204 / P14 · 14c.4-14c.6):
// shareholding precedence (NSE primary, Tickertape fallback, LABELLED), insider
// netting, and bulk/block repeat-counterparty detection.
export * from "./stock-sections-ownership.service";

// Filings / financials-source / funds-holding sections (MONEY-1204 / P14 ·
// 14c.7-14c.9).
export * from "./stock-sections-docs.service";

// Discover surfaces (MONEY-1204 / P14 · 14d.2/3/5/6): FII/DII flows,
// participant positioning (filtered on `metric` -- that table now holds TWO
// incompatible grains), the macro strip, IPO phases, the heuristic circular
// matcher, and index detail.
export * from "./discover-sections.service";
