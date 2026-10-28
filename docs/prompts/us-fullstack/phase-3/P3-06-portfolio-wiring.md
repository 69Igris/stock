# P3-06 · US portfolio wired into Sage, Roast, watchlist and the dashboard card, via shared services

Ticket: MONEY-1640 (4) · Branch: `feat/MONEY-1640` · Flag(s): no new flag. It composes `us-holdings`, `us-stock-research`, `us-sage-entrypoints`, `us-watchlist` and `us-dashboard`, and each piece lights up under the flag of the surface it lives on. · Screens: Roast verdict rows, Home US card, Sage @-picker Brokers tab (small deltas) · Depends on: P3-04 (MONEY-1639), P2-02 (MONEY-1588/1634), P2-04 (MONEY-913 `complianceRulesFor`), P1-08 (MONEY-1589/1631/912) · Parallel-safe with: none (it runs last in Phase 3)

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Money + AI output: `/code-review ultra`.**

## Goal

Apply the founder's rule, "each implementation creates access to StockSage, the watchlist and other places", to broker data. Five pieces:

1. **Sage portfolio questions include US holdings**, currency-correct.
2. **Roast scores US stocks, or states per row that it cannot.** It never drops a row silently.
3. **A US holding suggests adding its peers to the watchlist**, or shows nothing when no honest peer source exists.
4. **The dashboard US card shows real holdings.**
5. **Two items handed over from P2-02:**
   - the Sage quick chip "US book vs India" (W06 §1);
   - the @-picker Brokers tab listing US accounts (W06 §4: `US · SNAPTRADE` accounts plus imported statements).

Every change goes through a shared service that both the action and `/v1` call.

## Why / measured state today (verified)

**Places that sum or compare holdings as if they were all rupees.** Mixed-currency rows would silently corrupt each of these:

- `packages/core/src/investor/context.ts:375`: `prisma.holding.findMany` then `topWeightFromValues(currentValue)` (`:385`). A $ row and a ₹ row compared raw make the concentration and HHI signals wrong.
- `apps/web/lib/gemini/indexer.ts:92`: `prisma.holding.findMany` for chat RAG.
- `apps/web/lib/chat-tools/registry.ts:235`: `getHoldingsAction(filters)`. This one is already on the shared service, so P3-04's `currency` and `totals` reach it for free.
- `packages/research/src/data-sources/db-store.ts`: portfolio reads for research.

**Roast**

- `packages/roast/src/steps/fetch-portfolio.ts:54` reads holdings through `packages/roast/src/lib/portfolio-query.ts:52-68`.
- `packages/roast/src/prompts.ts` hardcodes ₹ and India:
  - the table rows at `:53`;
  - the sector values at `:58`;
  - the totals at `:64-66`, `:102-104` and `:150`;
  - "Focus on Indian market context (NSE/BSE, ₹)" at `:83` and "Use Indian market context (NSE/BSE, ₹, lakhs, crores)" at `:274`.
- The service entry point is `packages/services/src/roast.service.ts`.

**Peers**

- `packages/services/src/peers-sync.service.ts` (MONEY-1145, `PEERS_SOURCE = "DERIVED"`) is India-only.
- There is no US peer table. `UsFiler` has `sic` + `sicDescription` (`schema.prisma:8144`, `@@index([sic])`), and `UsInstrument` has no sector.
- Check whether P1-04 (MONEY-1586) shipped a US peers read for the stock page. **If it did, reuse it. If it did not, same-SIC listings are the only derivable signal:** there is no market cap unless P1-01's `us_screener_row` carries one. Use SIC plus the screener row only if both exist; otherwise the suggestion is ABSENT, with no invented ranking.

## Read first (verified paths)

- The files above, plus `packages/services/src/{roast,roast-logic,watchlist,dashboard}.service.ts|.ts`, `packages/roast/src/steps/*`, `apps/web/components/chat/{QuickActionChips,StockMentionPicker}.tsx`, `apps/web/lib/gemini/anchor-roast.ts`
- P3-01's `effectiveCurrency` + `portfolio-fx-logic.ts` (`convertTotals`, `totalsByCurrency`); P3-04's `groupHoldingsByMarket`; P2-04's `complianceRulesFor` / `disclaimerFor`; P1-08's watchlist add action (`{market:"US", listingId}`) and US Home card; P3-03's `listSnapTradeConnections`

## Build, in this order

### 1. Services

**a. One portfolio snapshot for AI consumers.** Create `packages/services/src/portfolio-snapshot.service.ts` with `getPortfolioSnapshot(userId, { displayCurrency })`. It is built on `getHoldings` (P3-04) and returns plain JSON:

```
{ rows: [{ symbol, market, currency, qty, valueNative, valueDisplay,
           weightPct }],
  totals: { display, spotRate, spotAsOf, excluded } }
```

- Weights are computed in ONE currency (display, at spot).
- Rows with no rate are excluded and counted.
- Replace the three raw reads with it:
  - `context.ts:375` (seed-signal top-weight/HHI);
  - `indexer.ts:92`;
  - the portfolio reads in `db-store.ts`.
- Do NOT touch their India-only outputs. An India-only snapshot must produce identical numbers; prove it with a golden.

**b. Sage portfolio prompts.** When the snapshot has US rows:

- the context block states each row's currency, and states the display-currency total "at spot ₹88.12 · 23 Sep";
- the answer is composed under `complianceRulesFor(complianceMarket(...))` (P2-04). A portfolio answer about US holdings describes them and never directs.

**c. Roast.**

- `fetch-portfolio.ts` reads the snapshot's rows.
- `prompts.ts` becomes market-aware:
  - the India text is unchanged when there are no US rows;
  - with US rows, money is formatted per row currency through `formatMoney` (P2-03), and the context line reads "Indian (NSE/BSE) and US-listed holdings".
- **Per-row outcome.** Pure `roastRowOutcome(row)` in `packages/services/src/roast-logic.ts` returns `SCORED | NOT_SCORED_US_DATA_MISSING | NOT_SCORED_UNPRICED`. A US row is scored only if it has an EOD price and US fundamentals (EDGAR); otherwise it gets a named reason.
- The verdict lists the not-scored rows with their reason. The row count in the verdict equals the holdings count. Assert that.

**d. Watchlist suggestions.** `packages/services/src/us/holding-suggestions.service.ts` exposes `suggestPeersForHolding(userId, listingId)`:

- it returns up to 5 `{ listingId, symbol, name, reason: "same SIC 3571" }`, excluding already-held and already-watched listings;
- it returns `[]` when no peer source exists (see "Why"). The UI then renders nothing: no placeholder, no "coming soon".

**e. Dashboard US card.** P1-08's card reads `getPortfolioSnapshot`: US value (native + display), day change (EOD), and top 3 US holdings. With 0 US holdings it shows the P3-03 "Connect a US broker" CTA (under `us-broker-connect`).

**f. Sage Brokers tab.** `listSnapTradeConnections` (P3-03) plus imported US batches, as `US · SNAPTRADE` / `US · IMPORT` rows. The quick chip "US book vs India" shows when the snapshot has both markets and `us-stock-research` is on; it prefills a portfolio comparison prompt.

### 2. Server actions

- `apps/web/lib/actions/us-portfolio.ts`: `getPortfolioSnapshotAction` and `suggestPeersForHoldingAction`. Both are thin.
- `roast.ts` and `dashboard.ts` keep their existing actions, which now call the services changed above.

### 3. `/v1` routes + `US_SURFACES` rows

- `GET /v1/us/portfolio/snapshot?currency=` and `GET /v1/us/portfolio/:listingId/peer-suggestions`.
- `/v1/roast` and `/v1/dashboard` are unchanged in path and gain fields through their services. Update the contract tests.
- Rows (P0-01 field names; both `usAccess:"required"`, `actionFile:"apps/web/lib/actions/us-portfolio.ts"`, `routeFile:"apps/api/src/routes/v1/us/portfolio.ts"`, mounted with `usRoutes.route("/portfolio", …)`):
  - `{surface:"portfolio-snapshot", flag:"us-holdings", serviceExport:"getPortfolioSnapshot", serviceFile:"packages/services/src/portfolio-snapshot.service.ts", routePath:"/v1/us/portfolio/snapshot"}`. The service lives outside `us/`; P0-01 rule 3 derives `@usemoney/services/portfolio-snapshot.service`, so add that subpath to `packages/services/package.json` `exports`.
  - `{surface:"holding-suggestions", flag:"us-watchlist", serviceExport:"suggestPeersForHolding", serviceFile:"packages/services/src/us/holding-suggestions.service.ts", routePath:"/v1/us/portfolio/:listingId/peer-suggestions"}`

### 4. UI

- **Roast verdict:** a "Not scored" group for US rows that could not be scored, each with its reason.
- **Holdings row expand (P3-04):** "Also watch: MSFT · DELL · HPQ ☆" under `us-watchlist`.
- **Home US card:** real rows.
- **Sage:** the Brokers tab rows and the quick chip.

## Screens

### Roast verdict, US rows (375px)

```
┌──────────────────────────────────────┐
│ YOUR ROAST · 15 holdings             │
│ Score 64 / 100                       │
├──────────────────────────────────────┤
│ SCORED · 13                          │
│ IN  INFY     71   steady compounder  │
│ US  AAPL     68   pricey vs its 5y   │
│ …                                    │
├──────────────────────────────────────┤
│ NOT SCORED · 2                       │
│ US  XYZW   no US filings on file     │
│ US  ABCD   no end-of-day price yet   │
│ We list these rather than guess.     │
├──────────────────────────────────────┤
│ Analysis and education only — not    │
│ investment advice.                   │
└──────────────────────────────────────┘
```

At 1280px it is the existing roast verdict layout, with the NOT SCORED group as a collapsed section under the scored table.

### Home US card (375px)

```
┌──────────────────────────────────────┐
│ US · ◷ EOD 23 SEP CLOSE              │
│ $58,640   ≈ ₹51,67,357               │
│ spot ₹88.12 · 23 Sep                 │
│ AAPL  $27,377  ·  NVDA  $14,130      │
│ MSFT  $9,842                         │
│ See holdings ›        Ask Sage ›     │
└──────────────────────────────────────┘
```

### States

| State    | Roast                                                  | Home card                                                          | Peer suggestions                            |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------- |
| loading  | The existing 5-step run                                | Skeleton at final height                                           | No placeholder; the row appears when loaded |
| empty    | No holdings → the `/start` paths (existing)            | 0 US holdings → the Connect CTA                                    | No peers → nothing rendered                 |
| error    | "Couldn't roast right now · no credit used" (existing) | "Couldn't load · retry"                                            | Silent (non-essential)                      |
| DataGap  | Unpriced rows → NOT SCORED with a reason               | Spot missing: USD only + "₹ view unavailable · no rate for 23 Sep" | n/a                                         |
| gated    | Roast gating is unchanged                              | FREE: GateInline (P1-08)                                           | Under `us-watchlist` only                   |
| flag-off | No US rows → roast is byte-identical                   | `us-dashboard` off → absent                                        | `us-watchlist` off → absent                 |
| demo     | A mixed demo roast fixture                             | The mixed demo fixture                                             | The demo fixture (MSFT, DELL, HPQ)          |

### Users

| User         | Behaviour                                                                       |
| ------------ | ------------------------------------------------------------------------------- |
| U1           | Roast, Sage and Home are byte-identical to today                                |
| U2 / U6 / U7 | US rows in the roast (scored or named), Sage sees US holdings, a real Home card |
| U3           | As U1 until a US row exists                                                     |
| U4           | Mixed demo fixtures                                                             |
| U5           | Roast per the existing free quota; Home card GateInline                         |

## Cross-surface access (§6)

| #   | Line      | Answer                                                                                                          |
| --- | --------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Search    | n/a: this ticket consumes existing search                                                                       |
| 2   | Watchlist | Peer suggestions ☆ → `{market:"US", listingId}`                                                                 |
| 3   | Sage      | Portfolio context + Brokers tab + quick chip                                                                    |
| 4   | Home      | The US card, now with real holdings                                                                             |
| 5   | Deep link | Existing routes; no new URL                                                                                     |
| 6   | API       | `/v1/us/portfolio/*` + rows; `/v1/roast` and `/v1/dashboard` contracts                                          |
| 7   | Demo      | The mixed fixtures                                                                                              |
| 8   | Telemetry | `roast_us_rows` {scored, notScored}, `peer_suggestion_added` {flag:"us-watchlist"}, `sage_us_book_chip_clicked` |

## Tests

**Snapshot (`packages/services/__tests__/portfolio-snapshot.test.ts`):**

- weights computed in one currency;
- an excluded count for rows with no rate;
- **an India-only golden that equals the old `topWeightFromValues` output**;
- **Mutation:** feed raw `currentValue` across currencies and watch the mixed test fail.

**Roast (`packages/services/__tests__/roast-logic-us-rows.test.ts`):**

- `roastRowOutcome` truth table;
- the verdict row count equals the holdings count, so no silent drops.

**Roast prompt (`packages/roast/__tests__/prompts-market.test.ts`):**

- India-only prompt is byte-identical;
- mixed prompt formats `$` rows with `$`;
- **no ₹ on a USD row**.

**Peer suggestions (`packages/services/__tests__/us/holding-suggestions.test.ts`):**

- no source gives `[]`;
- held and watched listings are excluded;
- the reason string is present.

**Routes and render:**

- `apps/api/__tests__/routes/us-portfolio.test.ts`: flag-off gives absence; shape; schema identity.
- `apps/web/__tests__/components/home-us-card.test.ts`: USD renders with no bare ₹ (only the dated line); `◷ EOD` present.

## Acceptance

- [ ] "What's my biggest position?" on a mixed QA account compares in one currency and names the rate date.
- [ ] Roast lists every holding: scored, or not scored with a reason.
- [ ] The peer suggestion shows only when a real peer source exists.
- [ ] The Home card shows real US holdings.
- [ ] India-only users see byte-identical Sage context, roast and Home (goldens).
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Out of scope / hand-offs

- A US peers table (a derived-peers job like MONEY-1145 for the US). File it if P1-04 did not build one.
- US tax in the roast.
- The per-broker SnapTrade prompts P19–P29.
- Crypto P30–P33.
