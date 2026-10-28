# P1-09 · US funds — MF + ETF screener modes, fund NAV chart path, fund view, reference-data decision note

Ticket: MONEY-1571 (+ MONEY-1572, MONEY-1573) · Branch: `feat/MONEY-1571` · Flag(s): `us-funds` · Screens: S1.4 (US MF / US ETF modes), S1.3 fund variant · Depends on: P1-06 (US pill + `screenUs`), P1-04 (US page), P1-02 (registry + NAV-depth measurement) · Parallel-safe with: P1-08

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

US mutual funds and ETFs are in scope. This is a deliberate override of the design (MONEY-1571). Ship:

1. The US pill in the screener's MUTUAL FUNDS and ETFS modes, driven by the P1-02 registry. Price/NAV-derived filters only.
2. A US mutual-fund NAV series served by `apps/market-data` `/udf/history`, so the shared chart works for a fund (1572).
3. A fund variant of `/us/stock/[symbol]` for `assetType === "Mutual Fund"`. ETFs already render as P1-04's stock page, minus the fundamentals tabs.
4. The prompt edits (1571) and a reference-data decision note with quoted prices, prepared for the founder to decide (1573).

## Why / measured state today (verified)

- `docs/prompts/design-v2/web/W02-screener-unified.md:19` ends "US + MF/ETF modes → 'US FUNDS & ETFS — LATER · Same switcher, next stop.' panel", and `:38` lists "US MF/ETF modes" as a Non-goal. That is exactly what 1571 deletes. `docs/prompts/design-v2/mobile/M21-module-web-v2-parity.md` has no US-fund line today (grep `fund|etf|later` gives only `:9`). Add one sentence there saying US MF/ETF modes exist and are mirrored by `POST /v1/us/screener` with `mode`.
- `apps/market-data/src/routes/history.ts`:
  - `:96-97` resolves `MF:{schemeCode}` to an AMFI fund;
  - `:102-103` treats ANY 3-part symbol as a US tile.

  A US mutual fund's listingId is 3-part with exchange `NMFQS` (`schema.prisma:6876`), so it is routed to a tile that does not exist. Meanwhile `apps/market-data/src/routes/symbols.ts:91-94` `usTvType` already answers `"fund"` for it. `/udf/symbols` and `/udf/history` DISAGREE today: the MONEY-1476 defect class.

- The AMFI fund branch (`history.ts:190-215`) runs BEFORE the US licence gate (`:219`), because AMFI NAV is not licence-bound. **A US fund NAV is a US price, so the new branch must sit AFTER the US licence gate** and must never reuse the AMFI branch's position.
- `serveFundNav` (`history.ts:440`) → `getMfNavHistory` → `navPointsToBars` (`packages/core/src/market-data/udf/fund-bars.ts:33`). Build a sibling reader over `UsFundNav` (`schema.prisma:6977`, keyed `permaTicker,date`).
- Delisted US funds have no permaTicker and so no NAV rows, ever. That is a documented floor, and the answer must be "no history on file", not an error.
- Fund reference data (expense ratio, AUM, category, issuer, holdings) does not exist anywhere in the platform (PLAN §3 C-2). The registry (P1-02) therefore declares no such filter.
- Use the NAV-depth numbers P1-02 pasted (p10/p50/p90 history per permaTicker). If median < 1Y, the MF mode offers 1M/3M/6M only, and the screen says so.

## Read first (verified paths)

`apps/market-data/src/routes/{history,symbols,udf}.ts`; `packages/core/src/market-data/udf/fund-bars.ts`; `packages/core/src/market-data/prices/mf-nav-service.ts`; `apps/web/app/discover/screener/{client,mf-mode,etf-mode}.tsx` + P1-06's US mode file; `packages/core/src/market-data/us-screener/filter-registry.ts`; `packages/services/src/us/{screener,stock}.service.ts`; `apps/web/app/us/stock/[symbol]/*`; W02 and M21 prompts.

## Build — in this order

### 1. Service

- `packages/core/src/market-data/prices/us-fund-nav-service.ts`: `getUsFundNavHistory(permaTicker, from, to): NavPoint[]` over `UsFundNav`. It returns `[]` for an unknown permaTicker; the caller distinguishes the named reasons.
- `packages/services/src/us/funds.service.ts`: `getUsFund(userId, {listingId})` returns `{identity, navOrClose, lastCloseDate, ret1M…ret5Y, navHistoryFrom, fundFill, referenceData: null, referenceNote}` from `usScreenerRow` + `UsInstrument`. `referenceData` is always `null` until 1573 is decided, and the UI prints `referenceNote`.
- `screenUs` (P1-06) already takes `mode`. Confirm `mode:"MF"` and `mode:"ETF"` select `assetType` `"Mutual Fund"` / `"ETF"` verbatim (never upper-cased).

### 2. Server actions

`apps/web/lib/actions/us-funds.ts` `getUsFundAction`. The screener modes reuse `screenUsAction`, which now checks `us-funds` when `mode !== "STOCK"`.

### 3. `/v1` + `US_SURFACES` + market-data

- `GET /v1/us/funds/:listingId` → `getUsFund`; row `{surface:"fund", flag:"us-funds", usAccess:"required", serviceExport:"getUsFund", serviceFile:"packages/services/src/us/funds.service.ts", actionFile:"apps/web/lib/actions/us-funds.ts", routeFile:"apps/api/src/routes/v1/us/funds.ts", routePath:"/v1/us/funds/:listingId"}`, mounted with `usRoutes.route("/funds", …)`. The `screener` row (P1-06) keeps `flag:"us-screener"`; add a comment on it that `us-funds` also gates the MF/ETF modes.
- `apps/market-data/src/routes/history.ts`:
  - inside the 3-part branch, `exchange === "NMFQS"` gives `{kind:"usFund", listingId}`;
  - after the US licence gate, a non-daily resolution gets the same named refusal an equity gets;
  - daily resolves the `UsInstrument` row, then `permaTicker`. None gives `s:"no_data"` with `nextTime` absent (the "no history on file" answer), else `navPointsToBars(getUsFundNavHistory(…))`;
  - US never shared-cached (keep the `:371-384` rule).
- `symbols.ts` stays consistent. Add a test that every symbol `/udf/symbols` types as `"fund"` resolves in `/udf/history`.

### 4. UI + docs

- Screener: generalise P1-06's US mode component to take `mode`. MF and ETF get the pill only under `usLayer.on && flags["us-screener"] && flags["us-funds"]`.
  - ETF filters: price/return/volume/52W.
  - MF filters: `ret*` per the measured depth.
  - Columns: ETF gets SYMBOL · NAME · PRICE · 1M · 1Y · $VOL; MF gets SYMBOL · NAME · NAV · 1M · 3M · 6M (+1Y only if measured).
  - One honest line above the results: "Expense ratio, AUM and category aren't available for US funds on UseMoney." No disabled placeholders, no "coming soon" (MONEY-1573 risk).
  - `ExclusionRow` shows NAV-history exclusions ("4,210 funds not screened on 1Y · less than a year of NAV on file").
- `/us/stock/[symbol]`: when `assetType === "Mutual Fund"`, render `UsFundView` (NAV header `$` + `◷ NAV · SEP 23`, returns strip, chart via the new branch, no fundamentals tabs, `referenceNote`, disclaimer + listing id). ETFs keep the stock view but hide the fundamentals tabs (`fundamentalFill: NOT_APPLICABLE`).
- Docs (1571): edit W02 §1 (delete the LATER panel sentence and replace it with "US MF/ETF modes are built per MONEY-1571/1574, price-derived filters only") and its Non-goals; add the M21 sentence.
- Docs (1573): `docs/reference/us-fund-reference-data-decision-sep2026.md`. It covers 3–4 options (data vendors that sell US fund expense ratio/AUM/category; issuer-site scrape; out of scope), each with a **quoted price and its source URL and date**, or "quote on request" stated as such. It includes coverage over 27,121 active MF + 5,822 active ETF (PLAN §1), licence/redistribution terms, and a `Decision: ___ (founder)` line left blank. **Do not decide it.**

## Screens

### S1.4 — US ETFs, 375px

```
┌──────────────────────────────────────┐
│ [Stocks] [Funds] ETFs  (IN)[US]      │
│ US ◷ EOD · SEP 23 CLOSE              │
│ Expense ratio, AUM and category      │
│ aren't available for US funds.       │
│ 5,822 US ETFs · 318 match            │
├──────────────────────────────────────┤
│ SPY   SPDR S&P 500 ETF    $571.30    │
│ 1M +2.1% · 1Y +31.4% · $vol 30.2B    │
├──────────────────────────────────────┤
│ QQQ   Invesco QQQ         $489.20    │
│ 1M +3.0% · 1Y +34.9% · $vol 18.7B    │
└──────────────────────────────────────┘
```

### S1.3 — fund variant, 375px

```
┌──────────────────────────────────────┐
│ ‹  VFIAX                     ☆       │
│ Vanguard 500 Index Admiral           │
│ US · MUTUAL FUND                     │
│ NAV $528.14         ◷ NAV · SEP 23   │
│ 1M +2.0%  3M +5.1%  6M +9.8%         │
│ [1M] 6M 1Y 5Y   NAV, daily           │
│ ╱╲╱╲___╱╲╱                           │
│ NAV history on file from 2021-03     │
│ Expense ratio, AUM and category      │
│ aren't available for US funds.       │
└──────────────────────────────────────┘
```

1280px: the same table shells as P1-06; the fund view is two columns (chart + returns left, identity + notes right).

| State      | Render                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loading    | skeleton table / NAV header + chart box                                                                                                                       |
| empty      | "No US funds match" + loosen; delisted fund page → "No NAV history on file for this fund"                                                                     |
| error      | `DataGapBanner` in results / chart                                                                                                                            |
| DataGap    | `fundFill: NO_PERMATICKER/NO_NAV` → NAV `—` + named reason; returns longer than history → `—` + an exclusion count                                            |
| gated (U5) | GateInline in results / page                                                                                                                                  |
| flag-off   | `us-funds` off → no US pill in Funds/ETFs modes; fund page → 404; `/v1/us/funds` empty; market-data branch still licence-gated (flag is product, not licence) |
| demo       | SPY/QQQ/VFIAX fixtures                                                                                                                                        |

| User | Behaviour              |
| ---- | ---------------------- |
| U1   | absent                 |
| U2   | full                   |
| U3   | absent until US access |
| U4   | demo                   |
| U5   | GateInline             |
| U6   | full                   |
| U7   | full                   |

## Cross-surface access (§6)

1. Search: US search already returns ETFs/MFs (assetType chip, P1-03). 2. Watchlist: ☆ on the fund page and rows (`UsWatchStar`, P1-08). 3. Sage: `AskSageUs` on the fund page, under both flags. 4. Home: n/a (the US card shows proxies). 5. Deep link: `/us/stock/VFIAX` and `?mode=etf&market=US`. 6. API: `/v1/us/funds/:listingId` + screener modes. 7. Demo: fixtures. 8. Telemetry: `us_funds_mode_viewed {flag:"us-funds", mode}`, `us_fund_viewed {listingId}`.

## Tests

- `apps/market-data/__tests__/us-fund-history.test.ts`:
  - an NMFQS listing with daily resolution gives bars;
  - `resolution=5` gives the named refusal;
  - a non-allowlisted token gives the licence refusal BEFORE any NAV read;
  - a delisted fund with no permaTicker gives `no_data`, not an error.
- `…/udf-symbols-history-agreement.test.ts`: every `"fund"`-typed US symbol resolves in history.
- `packages/core/__tests__/market-data/us-filter-registry.test.ts` (extend): the MF mode's `ret*` set equals the depth decision constant.
- `apps/web/__tests__/app/us-funds-modes.test.tsx`:
  - the pill is absent without `us-funds`;
  - no "coming soon"/"not derivable yet" copy;
  - **no `₹` glyph** in the NAV/price cells.
- `packages/services/__tests__/us-funds-service.test.ts`: `referenceData === null`; **DOW-style recycled ticker:** the fund resolves by `listingId`, never by symbol.
- `TEST-COVERAGE.md`.

## Acceptance

- [ ] Locally against QA (`us_screener_rows` and `us_fund_nav` are prod copies once P1-01's founder steps have run; otherwise fixtures, and say so): US ETF mode returns SPY/QQQ, US MF mode returns funds with the measured return set, and the VFIAX page draws a NAV chart through a local `/udf/history`.
- [ ] W02/M21 prompt edits are in the diff; the 1573 note carries quoted prices with sources and a blank founder decision line.
- [ ] U1/U2/U5 screenshots; `verify:push`; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- As the founder on prod with `us-screener` and `us-funds` on: US ETF mode returns SPY/QQQ, US MF mode returns funds with the measured return set, and the VFIAX page draws a NAV chart through prod `/udf/history`.

## Out of scope / hand-offs

Buying or scraping fund reference data (the founder decides; that is 1573's outcome). Fund holdings. Mobile fund screens (M20, parked).
