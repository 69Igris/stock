/**
 * Static "is feature live yet?" flags.
 *
 * These are intentionally hardcoded (not PostHog-backed) so flipping a
 * surface from coming-soon → live is a single-line code edit with a
 * commit + deploy. Use the AppFeatureFlag system (lib/types/feature-
 * flags.ts) when partial rollout / cohort gating is needed.
 *
 * News & Events + the chat sidebar Feeds / Alerts tabs are LIVE for everyone
 * as of MONEY-408 (RSS ingestion + symbol/sentiment enrichment + unified read +
 * earnings-calendar population + NEWS/VOLUME alert fan-out). The page degrades
 * to an empty state until the news-rss-sync + events-sync workers have run, so
 * deploy the workers and run setup-pubsub.sh / setup-scheduler.sh alongside (or
 * before) the web deploy. Set NEWS_AND_EVENTS_LIVE back to false to re-gate.
 *
 * The allowlist below is retained only for re-gating: if the constant is set
 * back to false, listed accounts keep preview access.
 *
 * TODO(MONEY-408): when the News & Events backend ships (ingestion
 * pipeline + alert engine + notification dispatch), replace this whole
 * file's News & Events gating with a real PostHog flag
 * (`page-visibility-news-events`, tag `gated`, same 4-email allowlist
 * as `page-visibility-risk` / `-tax` / `-strategies`) and delete
 * NEWS_AND_EVENTS_LIVE + NEWS_AND_EVENTS_ALLOWED_EMAILS +
 * isNewsAndEventsVisible. Call sites:
 *   - apps/web/app/discover/news/page.tsx
 *   - apps/web/components/chat/ChatHistorySidebar.tsx
 */

export const NEWS_AND_EVENTS_LIVE = true;

export const NEWS_AND_EVENTS_ALLOWED_EMAILS: readonly string[] = [
  "deepshaswat@gmail.com",
];

export function isNewsAndEventsVisible(
  email: string | null | undefined,
  /**
   * Demo visitors get the live News & Events UI (which has its own
   * sample-data fallback path) so the demo experience is consistent
   * with other Discover surfaces. Without this, demo dead-ends on the
   * "Coming Soon" page while every other tab works.
   */
  isDemo = false
): boolean {
  if (isDemo) return true;
  if (NEWS_AND_EVENTS_LIVE) return true;
  if (!email) return false;
  return NEWS_AND_EVENTS_ALLOWED_EMAILS.includes(email.toLowerCase());
}
