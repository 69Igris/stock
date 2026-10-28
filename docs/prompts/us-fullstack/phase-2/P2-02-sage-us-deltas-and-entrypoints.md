# P2-02 · Sage US deltas (W06 §1–8) + Ask-Sage entry points on every US surface

Ticket: MONEY-1588 (8) + MONEY-1634 (4) · Branch: `feat/MONEY-1588` · Flag(s): `us-sage-entrypoints` (S2.1, S2.3; also requires `us-stock-research`), `us-stock-research` (gate/confirm), `us-stocks-search` (@-picker US pill) · Screens: S2.1, S2.3 (+ the W06 confirm/gate sheets) · Depends on: P2-01 (MONEY-1583/1585), P1-08 (MONEY-1631 dark CTAs, MONEY-1589 watchlist market), P2-03 (MONEY-1633 `formatMoney`; see the note) · Parallel-safe with: P2-05

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Credits/entitlement path: `/code-review ultra`.**

## Goal

1. Execute the US half of `docs/prompts/design-v2/web/W06-stocksage-us-deltas-model-picker.md` (Build §1–8), with the deltas listed below.
2. Light up the Phase-1 "Ask Sage" CTAs, so every US surface opens a mobile bottom sheet, or a side panel at ≥768px. The sheet carries `{market:"US", listingId}` through ONE shared function into the chat route and the research planner, with **no symbol re-resolution**.

## Why / measured state today (verified)

**Routes**

- There is no `/sage` route. Sage lives at `/stocksage`: `apps/web/app/stocksage/{page,client}.tsx`.
- The deep link `?chatId=` already reopens a thread (`client.tsx:458`).
- README S2.1/S2.2 name `/sage`. **Keep `/stocksage` and do not add `/sage`.**

**Chat**

- Chat is a Next route handler, not a server action: `apps/web/app/api/chat/route.ts` (2,899 lines).
- It casts the body with no zod validation: `const body: ChatDashboardRequest = await request.json()` (`:328`, type at `packages/types/src/chat.ts:687`). `context` is a mode string union (`chat.ts:623`), not a market or listing.
- **There is no `/v1/chat` route.** The only chat family is `apps/api/src/routes/v1/chat-history.ts`, and chat streaming (A01) is not in this program.
- So "web and `/v1/chat` accept the context identically" becomes this: ONE `resolveSageContext` export that the chat route calls today, and that the new `/v1/us/sage/context` and the future A01 `/v1/chat` both call.

**Pickers**

- `StockMentionPicker.tsx` + `stock-mention-logic.ts` search India only.
- `options/PromptOptionsPopover.tsx:3758` renders `₹${it.px}` for stock rows. A US row there would print rupees.
- `apps/web/lib/market/us-instrument-search.ts` is the US search leg.

**Components and persistence**

- `drawer.tsx` (vaul) and `sheet.tsx` exist in `apps/web/components/ui/`. Use them.
- There is no `DualCurrency`, `GateInline` or `DataGapBanner` in the repo yet. They come from P0-04 / P0-08.
- `ChatHistory` (`schema.prisma:1123`) has no field for a market or listing context.

## Read first (verified paths)

- W06 (above): Build §1–8 and the `v2 StockSage.dc.html` sources it lists (`docs/design/v2-bundle/`)
- `apps/web/app/stocksage/{client,page,layout}.tsx`, `apps/web/components/chat/{ChatPromptArea,StockMentionPicker,stock-mention-logic,QuickActionChips,ResearchConfirmSheet,CitationsRail,EmbeddedChatPanel,MessageRenderer}.tsx|ts`, `components/chat/options/PromptOptionsPopover.tsx`
- `apps/web/app/api/chat/route.ts` (:152-200 resolver, :284-360 body), `apps/web/lib/chat-tools/{intent-mapper,executor-logic}.ts` (`run_research`)
- `packages/services/src/chat-history.service.ts`, `packages/types/src/chat.ts` (`ContentBlock` :576)
- `apps/web/app/stock/[symbol]/us-client.tsx`, plus the MONEY-1631 CTA component, which you find by grepping `us-sage-entrypoints`. **If it is absent, stop:** P1-08 is not merged.
- P2-01's `startResearchJob`, `previewResearchPlan` and `research-logic.ts`

## Build, in this order

### 1. Service

**`packages/services/src/us/sage-logic.ts` (pure):**

```ts
export const SageContextSchema = z.object({
  market: z.literal("US"),
  listingId: z.string().min(3).max(80),
  surface: z.enum(["stock", "screener", "markets", "watchlist", "holdings"]),
});

export function suggestedPrompts(surface, { symbol, name }): string[];
// ≤ 4 per surface. The stock surface's first prompt is exactly
// "Is AAPL expensive vs its 5y PE?"

export function sageDeepLink(chatId: string): string; // "/stocksage?chatId=…"
```

**`packages/services/src/us/sage.service.ts`:**

- `resolveSageContext(userId, raw, deps: { usGate })` validates with `SageContextSchema`.
  - If `!usGate.access`, return `NOT_FOUND`, exactly as an unknown listing would.
  - Otherwise load the listing by `listingId` from `us_instruments` (ACTIVE, current occupant). A missing listing also returns `NOT_FOUND`.
  - Return plain JSON: `{ market, listingId, symbol, exchange, name, surface, suggestedPrompts, researchEnabled: usGate.researchFlag }`.
- `openSageThread(userId, raw, deps)` calls `resolveSageContext` and then persists `usContext` on a new or existing `ChatHistory`:
  - Add `usContext Json?` to the model. Write the `{ isSet: false }` arm test first.
  - Return `{ chatId, deepLink, context }`.

**Chat route:**

- `ChatDashboardRequest` gains `usContext?: unknown`.
- The route calls `resolveSageContext` BEFORE any credit or classifier work. A refusal gets the unknown-context answer: the turn proceeds as a plain chat with no US context, and nothing names the listing.
- When resolved:
  - the listing is used directly;
  - `run_research` is invoked with `{ market: "US", listingIds: [listingId] }` through P2-01's `startResearchJob`;
  - `resolveStockSymbol` (`route.ts:186`) is not called for that symbol.
- Assert "no re-resolution" in a test that counts `resolveInstrument` calls.

### 2. Server action

`apps/web/lib/actions/us-sage.ts` (`"use server"`), following the contract shape exactly:

- `openSageThreadAction(input)`: authenticate → DB user → `resolveUsLayer()` + flags `us-sage-entrypoints` && `us-stock-research` → `openSageThread`.
- If either flag is off, return the not-found shape.

### 3. `/v1` route + `US_SURFACES` row

- `apps/api/src/routes/v1/us/sage.ts` exposes `POST /v1/us/sage/context` with the same body schema (imported, never copied) and the same service.
- Row: `{ surface: "sage", flag: "us-sage-entrypoints", usAccess: "required", serviceExport: "openSageThread", serviceFile: "packages/services/src/us/sage.service.ts", actionFile: "apps/web/lib/actions/us-sage.ts", routeFile: "apps/api/src/routes/v1/us/sage.ts", routePath: "/v1/us/sage/context" }`. Mount with one `usRoutes.route("/sage", …)` line.
- The research preview route is P2-01's `/v1/research/preview-plan`. Do not duplicate it.

### 4. UI

**W06 §1–8, with these deltas:**

- **§1 quick chip "US book vs India".** Hand this to P3-06; it needs US holdings.
- **§2 exchange badges** as specified.
- **§3 `provenance` ContentBlock.**
  - Add `ProvenanceBlock` to the `ContentBlock` union (`chat.ts:576`).
  - The chat route emits it when an answer cites both markets.
  - The ₹ figure in it comes from `convertUsd` VALUE with its date. The vendor is never named.
- **§4 @-picker market pill (INDIA | US).** Show it when `us-stocks-search` && US access pass.
  - The US rows come from `us-instrument-search.ts`, and the row value is `{market:"US", listingId}`, never the bare symbol.
  - The Brokers tab (SnapTrade accounts) is P3-06.
  - Fix `PromptOptionsPopover.tsx:3758` to format through `formatMoney(px, currency)`.
- **§5 gate before spend.**
  - `US_RESEARCH_OFF` renders the gate sheet: "Deep research on US symbols isn't on yet … This stops you before a credit is spent.", plus "Research INFY instead".
  - `NOT_FOUND` renders the ordinary "we couldn't find that symbol".
  - This sheet can only appear where a US listing is already on screen, which requires US access. So it does not break "flag off = absent". Keep it that way.
- **§6 confirm sheet.** Shows P2-01's preview verbatim: MARKET: US · NASDAQ · LISTING {listingId}, the SOURCES · US ARM list with ✕ excluded sources, the scope note and the credits before/after.
- **§7 JobProgress US task rows.** Source labels are EDGAR / "Third-party EOD tape". Never name Tiingo.
- **§8 CitationsRail EDGAR group.**
- **S2.1 Sage market pill (India · US · Both).**
  - It sits in the `/stocksage` top bar and only preselects the picker market.
  - It arrives preset to US when opened from a US surface (`?market=US`).
  - It renders only when `us-sage-entrypoints` && `us-stock-research` && access pass.
- **S2.3 Ask-Sage.**
  - Below 768px it is a vaul `Drawer` (bottom sheet). At 768px and above it is a right `Sheet` side panel, reusing `EmbeddedChatPanel.tsx` if it fits.
  - Opening it calls `openSageThreadAction`. The first send goes through the normal chat route carrying `usContext`.
  - "Open in Sage" → `sageDeepLink(chatId)`.
  - Wire the dark CTAs from MONEY-1631 on: the stock page (`/stock/[symbol]`, US variant), screener rows, `/markets/us`, watchlist rows and holdings rows (holdings rows only once P3-04 ships them; until then leave the CTA dark).

**Money rendering.** Use `formatMoney` from P2-03. If P2-03 is not merged, stop and say so. Do NOT add a second formatter.

## Screens

### S2.1 · `/stocksage`, market pill preset to US (375px)

```
┌──────────────────────────────────────┐
│ ☰ Sage          India │[US]│ Both    │
├──────────────────────────────────────┤
│ US ◷ EOD · 23 SEP CLOSE              │
│                                      │
│ Try asking                           │
│ › Is AAPL expensive vs its 5y PE?    │
│ › What changed in MSFT's last 10-Q?  │
│ › Who sold NVDA stock? (Form 4)      │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ @AAPL · NASDAQ  ×                │ │
│ │ Ask Sage…              @  /   ➤  │ │
│ └──────────────────────────────────┘ │
│ Analysis and education only — not    │
│ investment advice.                   │
├──────────────────────────────────────┤
│ Home  Portfolio  Sage  Discover  You │
└──────────────────────────────────────┘
```

At 1280px, the v2 sidebar and chat layout are unchanged. The pill sits in the top bar to the right of the title. Suggested prompts are a 2-column chip grid. The composer has max-w 760px, centred.

### S2.3 · Ask-Sage sheet from the AAPL page (375px, bottom sheet)

```
┌──────────────────────────────────────┐
│ AAPL  $228.14  ◷ EOD 23 Sep          │
│ ≈ ₹20,104 · spot ₹88.12 · 23 Sep     │
├───────────────── ▬ ──────────────────┤
│ Ask Sage about Apple Inc.        ✕   │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Is AAPL expensive vs its 5y PE?  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ What changed in the last 10-Q?   │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ Insider buys & sells, 90 days    │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ Deep research AAPL         ⚡3    │ │
│ └──────────────────────────────────┘ │
│ ┌─────────────────────────────┐ ┌──┐ │
│ │ Ask anything about AAPL…    │ │➤ │ │
│ └─────────────────────────────┘ └──┘ │
│ Open in Sage ›                       │
└──────────────────────────────────────┘
```

At 1280px it is a right side panel, 420px wide, full height, with the same content and the page still visible. `Esc` closes it and focus returns to the CTA.

### Gate sheet (licence on, `us-stock-research` off), 375px

```
┌──────────────────────────────────────┐
│ ───────────────── ▬ ──────────────── │
│ Research · India only today          │
│                                      │
│ Deep research on US symbols isn't    │
│ on yet. This stops you before a      │
│ credit is spent.                     │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Research INFY instead            │ │
│ └──────────────────────────────────┘ │
│ Not now                              │
└──────────────────────────────────────┘
```

### States

| State    | S2.1 pill                                                                                                                                                            | S2.3 sheet                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| loading  | Pill renders instantly (client flag state from the registry); prompt chips are skeletons                                                                             | Header skeleton at final height; 3 chip skeletons                                            |
| empty    | No recent threads: suggested prompts only                                                                                                                            | Listing has no fundamentals: prompts drop to price/filings ones; no "expensive vs PE" prompt |
| error    | `openSageThreadAction` fails: inline "Couldn't open Sage · retry" in the sheet, no toast storm                                                                       | Same                                                                                         |
| DataGap  | Spot FX missing: the ₹ line is replaced by "₹ view unavailable · no rate for 23 Sep" (MONEY-1578 copy)                                                               | Same                                                                                         |
| gated    | FREE (U5): pill absent; the sheet's research row shows `GateInline` "US research is part of PRO" → `/upgrade?market=US`; chat prompts still work if US access passes | `US_RESEARCH_OFF`: gate sheet above                                                          |
| flag-off | `us-sage-entrypoints` off: no pill, no CTA anywhere, `/v1/us/sage/context` answers not-found                                                                         | CTA absent                                                                                   |
| demo     | Demo fixture thread for AAPL (MONEY-919 fixture); send is disabled with "Sign up to ask"                                                                             | Opens with fixture prompts; research row disabled                                            |

### Users

| User              | S2.1 / S2.3 behaviour                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| U1 India-only     | Absent. The pill never renders and no US CTA exists.                                                         |
| U2 US-interested  | Full layer if US access passes; otherwise the CTA is absent and the page GateInline (P0-04) leads to upgrade |
| U3 existing India | Absent until they add US (S0.7); then as U2                                                                  |
| U4 demo           | Fixture thread, send disabled, "Make this mine"                                                              |
| U5 FREE, flag on  | Chat chips per US access rule; research row = GateInline                                                     |
| U6 paid           | Full, including research with `CreditChip` ⚡ cost from `CREDIT_COSTS`                                       |
| U7 founder        | Full on any plan                                                                                             |

## Cross-surface access (§6)

| #   | Line      | Answer                                                                                                            |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Search    | The @-picker US pill (§4); a picked row carries `listingId`.                                                      |
| 2   | Watchlist | Watchlist rows get the Ask-Sage CTA. ☆ from the sheet header adds `{market:"US", listingId}` via P1-08's action.  |
| 3   | Sage      | This ticket.                                                                                                      |
| 4   | Home      | The US card's "Ask Sage" (P1-08 card) lights up under `us-sage-entrypoints`.                                      |
| 5   | Deep link | `/stocksage?chatId=` round-trips the `usContext` stored on `ChatHistory`. It is not in the sitemap (auth-only).   |
| 6   | API       | `POST /v1/us/sage/context` plus a row. `/v1/research*` comes from P2-01.                                          |
| 7   | Demo      | AAPL fixture thread.                                                                                              |
| 8   | Telemetry | `sage_us_sheet_opened` {surface, flag:"us-sage-entrypoints"}, `sage_us_prompt_sent` {surface, suggested:boolean}. |

## Tests

- `packages/services/__tests__/us/sage-logic.test.ts`: schema rejects bare symbols; `suggestedPrompts` per surface; deep link.
- `packages/services/__tests__/us/sage-service.test.ts`:
  - licence off → `NOT_FOUND`, byte-equal to an unknown listingId;
  - a delisted listingId → `NOT_FOUND`;
  - `usContext` is persisted;
  - the `isSet:false` arm on `ChatHistory.usContext`.
- `apps/web/__tests__/api/chat-us-context.test.ts`:
  - `resolveInstrument` is called 0 times for a resolved `usContext`;
  - `run_research` receives `market:"US"` + `listingIds`;
  - an invalid `usContext` is ignored and credits behave exactly as a plain turn.
- `apps/api/__tests__/routes/us-sage.test.ts`: 401; not-found on flag off; the schema identity is the one imported from the service; shape.
- `apps/web/__tests__/components/ask-sage-sheet.test.ts` (`renderToStaticMarkup`):
  - flag-off renders nothing;
  - US prices render `$` and the ₹ line carries a date;
  - **USD-renders-no-bare-₹:** outside the dated "≈ ₹" line, no `₹` glyph appears;
  - no "Tiingo" string.
- `apps/web/__tests__/components/stock-mention-us-pill.test.ts`: US rows only under the US pill, each with an exchange badge.
- **Money, gate sheet:** a functional test that clicking "Deep research" with `US_RESEARCH_OFF` produces zero `consumeCredits` calls. Record the mutation check: remove the refusal branch and watch the test fail.

## Acceptance

- [ ] W06 §2–8 behave as specified behind their flags. §1 and the Brokers tab are handed to P3-06.
- [ ] With all flags off, `/stocksage`, the picker and reports are byte-identical to today (snapshot tests).
- [ ] The sheet opens from the stock page, screener, `/markets/us` and watchlist, and the listing context reaches the planner without re-resolution.
- [ ] Deep link reopens the same thread with context.
- [ ] No US price renders without `◷ EOD`, and no vendor is named.
- [ ] 375/1280 × light/dark screenshots for U1, U2 and U5 are in the PR.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Out of scope / hand-offs

- **W06 §9–11 (model picker, ConsensusBadge, report provenance chips).** These are Module G under `model-picker-v2` / `consensus-badges`, and they are not US. MONEY-1588's title names them, but they are not in this program. Leave them for a separate ticket.
- The "US book vs India" chip and the SnapTrade accounts in the Brokers tab go to P3-06.
- Chat streaming and `/v1/chat` belong to A01, which is not in this program. It imports `resolveSageContext` when it lands.
