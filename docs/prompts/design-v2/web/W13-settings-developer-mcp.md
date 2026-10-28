# W13 · Settings → Developer (Module H re-anchored) — API keys · hosted MCP connect · usage · provenance-badged tool catalog

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisite: W00. **Backend prerequisite:** Epic 13 (`archive-docs/quant-prompts/13` — offer ladder, `dataProvenance` manifest + CI gate, `packages/mcp-server` cloned from `packages/video-studio`'s MCP server pattern). If `packages/mcp-server` does not exist, build its **v1 read-only tool set in this prompt** as specified below (the console is useless without it).

**Ticket:** `MONEY-{n}` "Settings → Developer + hosted MCP v1" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/v2 Settings Developer.dc.html` (settings sub-nav Profile · Brokers · Plan & credits · Notifications · Privacy & memory · Developer NEW; "Developer — API keys, MCP, and the tool catalog. Read-only by design — no tool can place an order." + "moved: was 'Dev Console' — now it lives here"; API KEYS table (name · id `um_live_4f2…9a1` · scopes · LAST · REVOKE/REVOKED); CONNECT VIA MCP · CLAUDE · CURSOR · ANY MCP CLIENT with the JSON `snippet` + "Copy config" + "Send test ping" → "● 200 OK · 84MS · TOOLS LISTED: 5"; USAGE — 30 DAYS (TOOL CALLS · CREDITS SPENT · sparkline · "RATE LIMIT 60/MIN · BILLING VIA CREDITS, NOTHING HIDDEN"); TOOL CATALOG · EVERY TOOL CARRIES ITS DATA PROVENANCE rows + legend "CONSENTED-BROKER = USER'S OWN SYNCED DATA · BHAVCOPY-DERIVED = NSE EOD PUBLIC · PURE-COMPUTE = MATH ONLY · EDGAR = SEC FILINGS") · `web/mod-h.jsx` (create key → "shown once — copy it now" band; revoked rows struck "kept for audit"; MCP connect 3 numbered steps + Claude/ChatGPT snippets; usage cards; catalog cards "READ-ONLY · PER-CALL LOGGED · DOCS →") · `web/wdata.js` `API_KEYS`, `MCP_TOOLS`, `USAGE` (shapes) · `Module Specs A-H.dc.html` §H states (no keys → single-CTA empty; rate-limited banner with reset time).

## Read first
- `apps/web/app/settings/client.tsx` (tab registry), `settings/tabs/{IntegrationsTab,UsageTab,primitives}.tsx`
- `packages/video-studio/src/index.ts` (the existing `@modelcontextprotocol/sdk` 1.22 server pattern), `packages/security/src/{encryption,rate-limit,cron-auth}.ts`, `packages/services/src/{admin-audit,credit,subscription,entitlement-invalidation}.service.ts`, `packages/core/src/subscription/plans.ts`
- Data for the tools: `packages/services/src/{holdings,tax,risk,roast,dashboard}.service.ts` (read paths), `packages/services/src/provenance.ts` (existing provenance helper — extend), `apps/api/src/middleware/{auth,ratelimit}.ts` (JWT verify; the MCP endpoint needs key/OAuth auth instead)
- Clerk OAuth for MCP: Clerk docs on OAuth 2.1 resource servers + dynamic client registration (`@clerk/backend`), `apps/web/app/api/webhooks/clerk`
- Deployment: host the MCP endpoint in `apps/api` (Hono) under `/mcp` (stateless streamable-HTTP handlers), domain `mcp.usemoney.ai` → same service. **Confirm the runtime first:** `apps/api/vercel.json` + `api/[[...route]].ts` deploy it on Vercel, while root `CLAUDE.md` says Cloud Run — streamable HTTP needs a runtime that streams responses (see README open item 7).

## Current state
No developer console, no API keys, no hosted MCP. Video-studio has an MCP server (pattern only). Provenance ids exist on some data paths.

## Build (flag `developer-console`, default OFF; visible to PRO+ and founder allowlist)
1. **Settings tab "Developer"** (sub-nav gets the NEW tag): header copy; API KEYS section (table; "+ CREATE KEY" sheet: name + scope checkboxes `portfolio:read` · `tax:read` · `analysis:run`; key shown **once** with copy; rotate; revoke keeps the row struck "revoked · kept for audit"; empty state single CTA); CONNECT VIA MCP card (endpoint `https://mcp.usemoney.ai/v1`, JSON config snippet with the selected key, tabs Claude Desktop / Cursor / ChatGPT connector, "Copy config", "Send test ping" → live result "● 200 OK · {ms} · TOOLS LISTED: {n}" or the error, OAuth explainer 3 steps); USAGE — 30 DAYS (tool calls, credits spent, sparkline from daily aggregates, rate-limit line with the real limit, rate-limited banner with reset time when applicable); TOOL CATALOG (name · description · provenance badge · calls/mo; legend; "DOCS →" link-out).
2. **`packages/mcp-server` v1 (read-only Portfolio-Context tools):** `get_portfolio_summary`, `get_holdings`, `get_paired_trades` / `get_tax_summary`, `get_risk_metrics`, `get_roast_summary`, `get_quote_eod` (NSE bhavcopy-derived), `compute_xirr` (pure compute), `get_us_fundamentals` (EDGAR) — **every tool declares `dataProvenance`** ∈ `CONSENTED_BROKER | BHAVCOPY_DERIVED | PURE_COMPUTE | EDGAR` in a manifest (`packages/mcp-server/src/manifest.ts`) and a **CI test fails if any exposed tool reads Tickertape/Yahoo/screener.in-provenance data** (assert by walking each tool's declared sources against the service provenance helper). No tool with write/order semantics can exist (test the manifest for forbidden verbs).
3. **Hosted endpoint:** `apps/api` route `/mcp` (streamable HTTP, stateless per 2026 MCP spec) with two auth modes: Bearer API key (`um_live_…`, hashed at rest, scoped) and Clerk OAuth 2.1 (resource-server metadata, DCR, scopes = the three above). Per-key rate limit via `packages/security/src/rate-limit.ts` (default 60/min); every call audit-logged (who/tool/when/latency; no PII payloads) into a new `ApiToolCall` model with daily rollups for Usage.
4. **Billing:** metered tools consume credits through `credit.service` (same ledger as the app; "BILLING VIA CREDITS, NOTHING HIDDEN"); plan card stubs to "contact us" for a DEV plan in v1.

## Data wiring
- Prisma: `ApiKey` (userId, name, prefix, hash, scopes[], createdAt, lastUsedAt, revokedAt), `ApiToolCall` (apiKeyId|oauthClientId, userId, tool, provenance, ms, credits, at), `ApiUsageDaily` rollup.
- Actions: `listApiKeysAction`, `createApiKeyAction` (returns plaintext once), `rotateApiKeyAction`, `revokeApiKeyAction`, `getDeveloperUsageAction`, `getToolCatalogAction` (from the manifest), `sendMcpTestPingAction` (server-side call to the hosted endpoint with the user's key).
- Services: `packages/services/src/developer.service.ts` (+ `api-key-logic.ts`: prefix/hash/scope checks — tested).
- `apps/api` mirror: `/v1/me/developer/{keys,usage,tools}` (GET/POST/DELETE) — mobile M21 renders the same section.
- Docs: `docs/reference/mcp-server.md` (endpoint, scopes, snippets) + a 10-question eval set (`packages/mcp-server/evals/`) with verified answers (mcp-builder Phase-4 pattern).

## Non-goals
Third-party developer billing/self-serve plans, write tools, non-consented data resale.

## Acceptance
- MCP Inspector session end-to-end against QA lists exactly the manifest tools; Claude Desktop connects via OAuth and via key; a revoked key returns 401 immediately (cache invalidation tested).
- Provenance CI gate demonstrably fails when a tool with a forbidden source is added in a test fixture and passes after removal.
- Keys are never stored in plaintext (test); "shown once" enforced (no read-back endpoint); audit log has no PII (test on a sample call).
- Usage numbers reconcile with `ApiToolCall` rollups; rate-limit banner appears at the real threshold.
- TEST-COVERAGE.md; `verify:push`; `/code-review ultra` (external data exposure).
