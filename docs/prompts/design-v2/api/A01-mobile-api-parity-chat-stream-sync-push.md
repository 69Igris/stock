# A01 · apps/api — mobile-specific surface: SSE chat stream · cold-start sync summary · device registration + push · ETag economy · route inventory test

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. This is the backend the mobile app (M00+) depends on; run it before M14 (Sage) and M19 (notifications). Decision (Shaswat, 12-Sep-2026): **SSE streaming from day one**.

**Ticket:** `MONEY-{n}` children of MONEY-402 (mobile parity) → `feat/MONEY-{n}` per area.
**Design/contract sources:** `docs/design/v2-bundle/app/s-sage.jsx` (streaming bubble `msg.streaming`/`shown`, `SrcChips`, follow-up `chips`, research confirm/progress/report, `ModelSheet`), `app/s-home.jsx` (cold-start needs: total value, day P&L, invested, XIRR, broker states, credits, plan, unread, movers, allocation), `app/s-account.jsx` `NotificationsScreenV2`, `app/root2.jsx` `um` store (credits, plan, brokers, watchlists, sync), the earlier parity audit prompt (`~/Documents/Claude/Projects/UseMoney - Research/prompt-apps-api-mobile-parity.md` — Phase 2 items 5–6).

## Read first
- `apps/api/src/{app,app-logic}.ts`, `middleware/{auth,auth-logic,ratelimit,request-id}.ts`, `lib/response.ts`, `routes/v1/index.ts` (`V1_ENDPOINTS` — 38 families pinned by tests), `routes/v1/{chat-history,notifications,dashboard,holdings,positions,trades,watchlist,me,credits,subscription,research}.ts`, `apps/api/__tests__/**`, `apps/api/README.md`, `api/[[...route]].ts` (Vercel entry — **note:** README says Vercel, CLAUDE.md says Cloud Run; check `cloudbuild*.yaml` + `vercel.json`; SSE needs a runtime that streams — Cloud Run/Node does, Vercel serverless may buffer — confirm before choosing the transport and document it)
- Chat pipeline: `apps/web/app/api/chat/route.ts` (≈1,100 lines; JSON response; credits via `consumeAIQuery`/`consumeCredits`, model resolution, `assembleUserContext`, guardrails, tool narrative, `ContentBlock` output), `apps/web/app/api/chat/execute-tool/route.ts`, `apps/web/lib/chat-tools/*`, `apps/web/lib/chat/*`, `apps/web/lib/gemini/*`, `packages/core/src/gemini/*` (`generateWithTimeout`, model registry), `packages/types/src/chat.ts` (`ChatResponse`, `ContentBlock`, `QueryMode`)
- Notifications: `packages/services/src/notifications.service.ts` (+ pagination), `packages/email`, `packages/pubsub`; Prisma `Notification`, `NotificationType`
- Cache: `packages/cache` (L1/L2), `packages/api-utils` (cursor pagination, envelope)
- Push: none exists. FCM HTTP v1 (Android + iOS via APNs through FCM) — service account in GCP project `stock-book-483718`.

## Build
### 1. Chat send + stream (`/v1/chat` sub-paths inside the existing `chat-history` family or a renamed `chat` family — keep the count at 38 by mounting under `/v1/chat-history`'s router if renaming is too invasive; document the choice)
- **Extract the web chat pipeline** into `packages/services/src/chat/` (or `packages/chat`): `runChatTurn({ userId, sessionId?, message, mode, model?, mentions, anchor, personalise })` that yields **events** (`AsyncIterable<ChatEvent>`) — the web route is refactored to consume the same generator and emit its JSON (behaviour-identical: assert with the existing web tests + a golden transcript). Never duplicate the pipeline.
- `POST /v1/chat/messages` — non-streaming JSON (same envelope as web) for clients that cannot stream.
- `POST /v1/chat/stream` — `text/event-stream`. Event schema (document in the route header + `packages/types/src/chat-stream.ts`): `session {sessionId}` · `token {text}` · `block {ContentBlock}` (rendered blocks such as tables/charts/citations) · `tool {name, status: started|done|failed, label}` (renders as status chips) · `credits {consumed, balance}` · `followups {chips[]}` · `sources {items[]}` · `done {messageId}` · `error {code, message}`. Heartbeat comment every 15 s; abort on client disconnect cancels the model call; per-user rate limit (expensive route); credits consumed before the model call and refunded on `error`.
- Slash commands and @-mentions accepted as on web (`/research`, `/roast`, `/tax`, `/compare`, `/focus`, `/clear`); `/research` returns a `research_confirm` block (cost estimate via preview-plan) instead of starting a run.
- Tests: contract test that streams a fixture turn via `curl -N`-equivalent (Hono `app.request`) and asserts event order + refund on injected failure.

### 2. Cold-start `GET /v1/sync/summary` (mount under `/v1/dashboard/summary-lite` if adding a family is refused by the count test; prefer a sub-path)
- One composite call: `{ portfolio: { totalValue, dayPnl, dayPct, invested, xirr }, brokers: [{id, name, state, lastSync}], credits: { balance, max, resetsAt }, plan, unreadNotifications, usSummary?, marketStatus }` from existing services in parallel (dashboard, broker-status, credits, subscription, notifications, market status) with the same Redis caching; strong `ETag` + `If-None-Match` → 304.
- Target < 300 ms warm on QA data (assert with a timing test on cached fixtures).

### 3. Devices + push
- Prisma `Device` (userId, platform `ios|android`, pushToken (unique per user+token), appVersion, locale, lastSeenAt, disabledAt). `POST /v1/devices` (register/refresh), `DELETE /v1/devices/:token` (logout), `PATCH /v1/devices/:token` (prefs: per-category toggles).
- Push dispatch hook in the notification fan-out (`notifications.service` → new `push.service.ts`, FCM HTTP v1; APNs via FCM; behind flag `push-notifications`): events signal triggered, backtest done, research complete, roast complete, ForwardRun divergence, LRS headroom, broker re-auth, US close summary. Payload carries a deep link (`usemoney://…` + https universal link) resolved by the app router (M10). Invalid-token responses disable the device row. Never put amounts in the push body beyond what the user opted into.

### 4. ETag / `updatedAfter` on list endpoints
- Holdings, positions, trades, watchlists, notifications: `ETag` on GET + `?updatedAfter=` cursor for pull-to-refresh economy; 304 short-circuits before serialization.

### 5. Hardening
- Route-middleware inventory test: walk the Hono router and assert every `/v1/*` route has `authMiddleware` + `rateLimitMiddleware`; consistent error envelope; per-user limits on chat/stream/research/screener.
- `X-Request-Id` on SSE responses too.
- OpenAPI-ish doc: `apps/api/README.md` gains the stream schema, sync summary, devices; `apps/api/CLAUDE.md` documents the parity rule + stream protocol + push design.

## Non-goals
Order execution, IAP receipts (A02), WhatsApp channel, web UI changes (the web keeps its JSON route, now backed by the shared generator).

## Acceptance
- `curl -N` against QA streams token-by-token with the documented events; disconnect cancels the upstream call (assert via a spy); refund on error proven.
- Web chat behaviour unchanged after extraction (existing tests + golden transcript).
- `/v1/sync/summary` returns 304 on `If-None-Match`; < 300 ms warm.
- A real push received on an Android emulator (FCM) and an iOS simulator (APNs sandbox via FCM) from a QA notification event; invalid token disables the row.
- Inventory test green; `V1_ENDPOINTS` tests updated deliberately if a family was added; TEST-COVERAGE.md; `verify:push`; `/code-review ultra` (credits + auth).
