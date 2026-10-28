# P3-04 · Mixed India + US holdings (S3.2), plus US lots in FIFO pairing

Ticket: MONEY-1639 (8) + MONEY-916 · Branch: `feat/MONEY-1639` · Flag(s): `us-holdings` (S3.2 US layer), `us-currency-toggle` ($ ↔ ₹ display) · Screens: S3.2 · Depends on: P3-01 (MONEY-1636 currency + `portfolio-fx-logic`), P3-03 (US rows exist), P0-08 (toggle + `DualCurrency`), P1-04 (US stock page for row taps) · Parallel-safe with: none (it touches holdings + pairing)

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Money path: `/code-review ultra`.**

## Goal

1. **One portfolio view.** A market chip sits on every row. Grouping is BY MARKET, which is the default when the user holds both markets. The header total is in the chosen display currency (₹ default, $ with the toggle), with the rate date. There is a combined allocation donut.
2. **P&L split.** P&L shows local return and FX return, from P3-01's `pnlSplit`.
3. **Row taps.** Tapping a US row opens the US stock page and has an Ask-Sage entry.
4. **`/v1/holdings`** carries currency on every row.
5. **MONEY-916, FIFO on US lots:**
   - the pairing key includes currency, so it never pairs across currencies;
   - calendar-year attribution is available for US lots;
   - there is a wash-sale DISCLOSURE note;
   - no US tax is computed.

This is the holdings half of `docs/prompts/design-v2/web/W10-holdings-watchlist-tradebook-us-deltas.md`, plus its tradebook §3. W10 §2 (watchlist) was done in P1-08.

## Why / measured state today (verified)

**Holdings**

- `apps/web/app/holdings/{page,client}.tsx`, `apps/web/lib/actions/holdings.ts:33` → `getHoldings` in `packages/services/src/holdings.service.ts:111`, which is also what `apps/api/src/routes/v1/holdings.ts:10,33` calls.
- The groupings are `groupHoldingsBySector` and `groupHoldingsByExchange` (`holdings.service.ts:27-28, :265-266`). There is no BY MARKET grouping.

**FIFO**

- `packages/core/src/pairing/algorithm.ts:185`:

  ```
  getGroupKey = `${isin||symbol}|${exchange}|${productType}|${broker}|${brokerUserId}`
  ```

  It has no currency. `TradeInput` (`:104`) has no currency.

- It is called by `workers/src/processors/pairing.ts:127` (`pairTradesFIFO`), which builds its inputs through `pairing-logic.ts`.
- The tests are at `apps/web/__tests__/pairing/{algorithm,algorithm-edge-cases,corp-actions}.test.ts` and `apps/web/__tests__/core/pairing/algorithm.test.ts`.
- `PairedTradeView` (`schema.prisma:3418`) has no currency and no `fxAtTrade`.

**Tax**

- STCG/LTCG classification lives in `packages/services/src/tax-logic.ts:20` and is India-only.
- **W10 ("no STCG/LTCG for US lots") and MONEY-916 ("calendar-year") are compatible.** US lots get a calendar-year attribution (the Schedule FA year) and "—" for term/tax, with the tooltip "US gains not computed for Indian tax yet".

## Read first (verified paths)

- W10 (above): Build §1, §3, §4 and Data wiring
- `docs/design/v2-bundle/v2 US Launch.dc.html` "Holdings, both markets, one ledger."; `app/s-portfolio.jsx` (US lots section)
- `apps/web/app/holdings/*`, `apps/web/app/tradebook/*`, `apps/web/lib/actions/{holdings,trades}.ts`, `packages/services/src/{holdings,trades,tax}.service.ts` + `-logic.ts`
- `packages/core/src/pairing/{algorithm,corp-actions,index}.ts`, `workers/src/processors/{pairing,pairing-logic}.ts`
- P3-01's `portfolio-fx-logic.ts`, `effectiveCurrency`, and `Trade.fxAtTrade` (the RBI ref cost-basis rate)
- DS-ST3 row "Mixed holdings" (`docs/gstack/ceo-review-2026-09-23-product-roadmap/product-plan-and-roadmap.md:859`)

**FX rule (binding).** Values use `convertUsd` VALUE (spot). Cost uses COST (RBI ref, per lot `fxAtTrade`). This supersedes P18 §7a/§7b's `FxRate`-by-display-date. A missing `fxAtTrade` is flagged and counted, never spot-filled (MONEY-217: in prod today there is no RBI source).

## Build, in this order

### 1. Service

**`packages/services/src/holdings-logic.ts`:**

- **`groupHoldingsByMarket(rows)`** returns `{ IN: {...}, US: {...} }`.
  - Market comes from `effectiveCurrency` + exchange. It is NOT currency alone, because a USD-priced ETF could list in India.
  - Each group carries count, native value and cost, and a provenance label: `US ◷ EOD · {date} CLOSE`, `IN ◷ EXCHANGE-DELAYED`.
- **`allocationSlices(rows, fx)`** returns donut slices in the display currency, with an `excluded` count.

**`getHoldings(userId, filters)`** is extended additively:

- `filters.group: "market" | "broker" | "flat"`;
- `filters.displayCurrency: "INR" | "USD"`;
- the response gains:

```
groups, totals            // P3-01's { inr, usd, spotRate, spotAsOf,
                          //   spotStale, excluded }
pnl: { local, fx, total } // per row and total
rows[].market, rows[].currency
```

- The default group is `market` when both markets are present; otherwise it is today's default.

**Pairing (core):**

- `TradeInput` gains `currency: string`, filled by `pairing-logic.ts` via `effectiveCurrency`.
- `getGroupKey` appends `|${currency}`, but ONLY when currency ≠ INR. INR keys stay byte-identical, so existing `PairedTradeView` rows re-pair to the same keys.
- `PairedTradeView` gains `currency String?` and `fxAtTrade Float?` (entry lot). Write the isSet arm tests first.

**New `packages/services/src/us-lots-logic.ts` (pure):**

- `calendarYearOf(date)`: the date is taken as the US trade date. Do not shift it to IST.
- `washSaleNote(pairs)`: flags a USD loss exit with a same-symbol BUY within ±30 days.
  - It is DISCLOSURE only: "A repurchase within 30 days may make this loss a wash sale for US tax filers. Not computed."
  - No adjustment is made.

**`trades-logic.ts` / `tax-logic.ts`:**

- US lots are excluded from term/tax (a test).
- The CSV export gains `currency` and `fx_at_trade` columns.

### 2. Server action

`getHoldingsAction` (`apps/web/lib/actions/holdings.ts:33`) passes `group` and `displayCurrency`, and stays thin.

The display currency is read from the P0-08 preference. When `us-currency-toggle` is off, `displayCurrency` is forced to INR on the server and the toggle is absent.

### 3. `/v1` route + `US_SURFACES` row

- `GET /v1/holdings?group=market&currency=USD` goes through the same service.
- The shared zod query schema lives in `holdings-logic.ts`, and both callers import it.
- Every row carries `currency`.
- `US_SURFACES` row: `{ surface: "holdings", flag: "us-holdings", usAccess: "required", serviceExport: "getHoldings", serviceFile: "packages/services/src/holdings.service.ts", actionFile: "apps/web/lib/actions/holdings.ts", routeFile: "apps/api/src/routes/v1/holdings.ts", routePath: "/v1/holdings", familyException: "existing holdings family; US rows are one more market in the same list" }`. `familyException` is what makes it legal (P0-01 rule 1); no parity-test change is needed. Confirm `serviceFile` and `routeFile` against the tree before writing the row, and add `"./holdings.service"` to `packages/services/package.json` `exports` if missing (P0-01 rule 3).

### 4. UI (375 first)

- **Header:** the total in the display currency with "at spot ₹88.12 · 23 Sep". The `$ | ₹` toggle is shown under `us-currency-toggle`, and is disabled with a reason when the rate is missing (MONEY-1578).
- **Grouping control:** BY MARKET · BY BROKER · FLAT.
- **Rows:** below 768px, rows are a card list (never a scrolling table), each with an `IN` / `US` chip.
  - US rows: SOURCE (broker, or "Imported · Apr 26"), QTY, AVG (native), LAST (EOD close `$`, `◷ EOD`), VALUE as `DualCurrency`, and P&L as native %, with the local/FX split on expand.
- **Total band:** "VALUES AT SPOT ₹88.12/$ · COST BASIS AT RBI REF OF TRADE DATE".
  - Lots missing `fxAtTrade`: "3 lots excluded from ₹ cost · no RBI rate yet".
  - FX stale by more than 24 h: `DataGapBanner` "FX rate from {date} · values approximate" on the totals only; rows still render native.
  - US sync failed while India is fine (DS-ST3 D28): a per-market chip "US sync delayed", and India renders normally.
- **Donut:** a combined allocation by market and sector, with an excluded count below it.
- **Row tap:** US rows go to the US stock page (P1-04's route) and carry the Ask-Sage CTA (P2-02, under `us-sage-entrypoints`).
- **Tradebook (`apps/web/app/tradebook`):**
  - US lots show the `US` chip and an "RBI REF ON TRADE" tag;
  - term reads "—" with the tooltip;
  - the calendar year appears in the lot detail;
  - there is a wash-sale note where it is flagged;
  - disclaimer under the ledger: "Imported lots keep the RBI reference rate from their trade date, so your ₹ cost basis doesn't drift with today's rate. Values use the hourly spot rate."

## Screens

### S3.2 · `/holdings`, mixed, ₹ display (375px)

```
┌──────────────────────────────────────┐
│ Holdings                  [₹] │  $   │
│ ₹74,52,318                           │
│ +₹6,12,440 · +8.9%                   │
│ local +₹4,98,100 · FX +₹1,14,340     │
│ values at spot ₹88.12 · 23 Sep       │
├──────────────────────────────────────┤
│ BY MARKET · by broker · flat         │
│                                      │
│ UNITED STATES · ◷ EOD 23 SEP CLOSE   │
│ 3 symbols · $58,640 · ≈ ₹51,67,357   │
│ ┌──────────────────────────────────┐ │
│ │ US AAPL        Robinhood         │ │
│ │ 120 sh · avg $171.20 · $228.14   │ │
│ │ $27,377   ≈ ₹24,12,461   +33.3%  │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ US NVDA        Imported · Apr 26 │ │
│ │ 80 sh · avg $118.40 · $176.62    │ │
│ └──────────────────────────────────┘ │
│                                      │
│ INDIA · ◷ EXCHANGE-DELAYED           │
│ 12 symbols · ₹22,84,961              │
│ ┌──────────────────────────────────┐ │
│ │ IN INFY        Zerodha           │ │
│ └──────────────────────────────────┘ │
│ COST BASIS AT RBI REF OF TRADE DATE  │
│ 3 lots excluded · no RBI rate yet    │
├──────────────────────────────────────┤
│ Home  Portfolio  Sage  Discover  You │
└──────────────────────────────────────┘
```

At 1280px, the header totals sit on the left with the donut on the right, and the market groups are tables with the columns SYMBOL · SOURCE · QTY · AVG · LAST · VALUE (primary + secondary) · P&L. The total band is full width under the tables.

The US group total is illustrative and does not reconcile with the three rows shown.

### States

| State    | Behaviour                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| loading  | Skeleton at the final layout: header, 2 group headers, 4 card rows. Never "₹0"                                                               |
| empty    | No US holdings: the US group is replaced by the "Connect a US broker" card (P3-03), shown only under `us-broker-connect`; India is unchanged |
| error    | Per-market: "Couldn't load US holdings · retry" while India renders                                                                          |
| DataGap  | Spot stale or missing: the banner on the totals; the toggle is disabled with a reason; rows stay native                                      |
| gated    | FREE (U5): the US group is GateInline "US holdings are part of PRO"; India is unchanged                                                      |
| flag-off | `us-holdings` off: the page is byte-identical to today (snapshot)                                                                            |
| demo     | The mixed-market demo fixture (W10 "Demo" + MONEY-919): AAPL/MSFT/NVDA + INFY/TCS                                                            |

### Users

| User    | S3.2                                                           |
| ------- | -------------------------------------------------------------- |
| U1      | Byte-identical India page                                      |
| U2 NRI  | $ is the default display if `primaryCurrency = USD`; BY MARKET |
| U2 LRS  | ₹ is the default display; BY MARKET                            |
| U3      | India page; the US group appears once a US row exists          |
| U4      | Mixed demo                                                     |
| U5      | GateInline US group                                            |
| U6 / U7 | Full                                                           |

## Cross-surface access (§6)

| #   | Line      | Answer                                                                                                    |
| --- | --------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Search    | Holdings are the user's own; the search result for AAPL shows "You hold 120 sh" when `us-holdings` is on  |
| 2   | Watchlist | ☆ on US rows adds `{market:"US", listingId}` (P1-08 action)                                               |
| 3   | Sage      | The Ask-Sage CTA on US rows (P2-02); portfolio questions include US (P3-06)                               |
| 4   | Home      | The P1-08 US card links "See holdings" here                                                               |
| 5   | Deep link | `/holdings?group=market&currency=USD` round-trips; not in the sitemap                                     |
| 6   | API       | `/v1/holdings?group=&currency=` + a row                                                                   |
| 7   | Demo      | The mixed fixture                                                                                         |
| 8   | Telemetry | `holdings_mixed_viewed` {flag:"us-holdings", markets}, `currency_toggled` {to, flag:"us-currency-toggle"} |

## Tests

**Pairing (`apps/web/__tests__/pairing/algorithm-currency.test.ts`):**

- a USD and an INR trade of the same symbol/exchange never pair;
- **the INR golden fixture pairs byte-identically before and after** (commit the golden first);
- a USD same-day buy+sell pairs.
- **Mutation:** drop `currency` from the key and watch the cross-currency test fail.

**Pure logic:**

- `packages/services/__tests__/us-lots-logic.test.ts`: the calendar year at 31 Dec / 1 Jan boundaries; a wash-sale note at ±30 and ±31 days; no note on gains.
- `packages/services/__tests__/holdings-market-grouping.test.ts`: `groupHoldingsByMarket`; excluded counts; a stale-FX flag; `pnl.local + pnl.fx === pnl.total`.

**Tax and export (`packages/services/__tests__/tax-logic-us-exclusion.test.ts`):**

- US lots produce no STCG/LTCG;
- the CSV export round-trips `currency` and `fx_at_trade`.

**Schema:** `packages/database/__tests__/schema-money-1639.test.ts` covers the isSet arms on `PairedTradeView.currency` and `fxAtTrade`.

**Route and render:**

- `apps/api/__tests__/routes/holdings-mixed.test.ts`: `currency` on every row; the group param; flag-off shape unchanged.
- `apps/web/__tests__/components/holdings-mixed.test.ts` (`renderToStaticMarkup`):
  - **a USD row renders no ₹ except in the dated equivalent**;
  - every US price has `◷ EOD`;
  - no vendor name;
  - with the flag off, it snapshot-equals today.

## Acceptance

- [ ] India-only users see an unchanged holdings page, tradebook and pairing output (goldens).
- [ ] Mixed users: BY MARKET is the default, with dual-currency totals, the rate date, and the local/FX split summing exactly.
- [ ] Values are never converted at RBI and cost is never converted at spot (unit tests).
- [ ] FIFO never pairs across currencies; US lots show "—" term, the calendar year and the wash-sale disclosure.
- [ ] 375/1280 × light/dark for U1, U2 and U5.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Out of scope / hand-offs

- US tax computation and the Schedule FA generator. This ticket stores and derives what the generator will need, via MONEY-915.
- The LRS tracker is P3-05.
- Roast, Sage portfolio and the dashboard card are P3-06.
- Live US quotes (Decisions #01).
