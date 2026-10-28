# P0-09 · Market-aware foundations — no `.NS` default, money in the right currency, per-exchange hours

Ticket: MONEY-899 (+ MONEY-901, MONEY-903) · Branch: `fix/MONEY-899` (one PR closes all three) · Flag(s): none (no UI surface changes behaviour for India users) · Screens: none · Depends on: nothing · Parallel-safe with: all of Phase 0 (P1-04 and P2-03 depend on it) — see the file-exclusion list below, which is what keeps it so

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Three India-only assumptions stop being defaults. A US ticker never becomes `AAPL.NS`. Money is formatted by currency — `₹` with en-IN lakh/crore grouping, `$` with en-US grouping — through one function, and a ratchet stops new hardcoded `₹` from appearing. Market status is asked per exchange, so a US surface never reports NSE's 09:15–15:30 IST session.

## Why / measured state today (verified 2026-09-24 — measured, not copied from the tickets)

### MONEY-899 — the `.NS` default

The rule that is correct already exists twice: `yahooSymbolFor(market, …)` (`packages/core/src/market-data/instruments/resolve-instrument-logic.ts:320`, market-guarded) and the `US_EXCHANGES` membership guard in `zerodha-instruments.ts:285-291`, both built on `US_EXCHANGES` + `YAHOO_SUFFIX_MAP` (`packages/core/src/market-data/instruments/types.ts`, whose comment records four prior absent-vs-empty incidents). Sites that still default to `.NS` with no US guard:

| Site                                                                         | Shape                                                                                                                                           |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/lib/market/symbol-mapper.ts:194`, `:231`                           | `exchange === "BSE" ? ".BO" : ".NS"` (`toYahooSymbol`, `toYahooSymbolAsync`; `Exchange = "NSE" \| "BSE"` at `:31`; 25 call sites in `apps/web`) |
| `packages/core/src/market-data/instruments/zerodha-instruments-logic.ts:439` | `YAHOO_SUFFIX_MAP[exchange] ?? ".NS"`                                                                                                           |
| `packages/core/src/market-data/sparkline.ts:56`                              | `exchange === "BSE" ? … : \`${symbol}.NS\``                                                                                                     |
| `packages/core/src/screener/engine.ts:808`                                   | inline `` `${stock.symbol}.${… "BO" : "NS"}` ``                                                                                                 |
| `apps/web/app/api/market/search/search-logic.ts:424`                         | inline                                                                                                                                          |
| `apps/web/lib/actions/stock-sector-logic.ts:20`                              | inline                                                                                                                                          |
| `apps/api/src/routes/v1/market.ts:194`                                       | inline (`?exchange=` default NSE)                                                                                                               |
| `apps/web/app/api/backtest/route-logic.ts:125`                               | "append `.NS` when no suffix"                                                                                                                   |
| `apps/web/app/api/chat/route.ts:1119`                                        | `resolved.yahooSymbol \|\| \`${resolved.symbol}.NS\``                                                                                           |
| `apps/web/components/chat/blocks/ActionBlockRenderer.tsx:203`, `:219`        | bare symbol + `.NS`                                                                                                                             |
| `packages/research/src/data-sources/symbol-resolver.ts:71`                   | `?? ".NS"`                                                                                                                                      |
| `packages/research/src/skills/portfolio-analysis.ts:38`                      | bare symbol + `.NS`                                                                                                                             |
| `packages/research/src/data-sources/db-store.ts:775`                         | `` `${clean}.NS` ``                                                                                                                             |
| `workers/src/processors/events-sync.ts:249`                                  | `` `${symbol}.NS` ``                                                                                                                            |

India-only by construction (leave, but allow-list with the reason): `workers/src/processors/bhavcopy-sync.ts:521` (NSE bhavcopy rows). The ticket lists four sites; there are sixteen.

### MONEY-901 — `₹` everywhere

- `formatCurrency(value)` (`packages/utils/src/format.ts:4`) is INR-only (`en-IN`, `currency:"INR"`); `formatPnL` builds on it; `formatCompactNumber` (`:62`) is lakh/crore-only. 20 call sites use `formatCurrency(`. `packages/utils` has no `./format` subpath export.
- **29 files define their own money formatter** (`formatInr`, `formatINR`, `fmtINR`, `formatMoney`, `fmtCurrency`, a local `formatCurrency`, …) — find them with:
  `grep -rnE "(function|const) (format(INR|Inr|Rupees?|Currency|Money|Amount)|fmt(INR|Inr|Rupee|Money|Currency)|inr)\b" apps packages --include=*.ts --include=*.tsx | grep -v __tests__ | grep -v /dist/`
  plus `formatUsd` in `apps/web/app/stock/[symbol]/us-client.tsx:58`.
- Hardcoded `₹` in `apps/web`: **102 `.tsx` files (412 lines) + 46 `.ts` files**; `en-IN` in 116 `apps/web` files; `currency: "INR"` literal in 12 `apps/web` files + 4 in `packages/`. (Ticket said ~90 / 118 / 22.)

### MONEY-903 — 09:15–15:30 IST

- US hours, holidays, early closes and DST ALREADY exist: `packages/core/src/market-data/us-market-hours.ts` (`usMarketSession` `:701`, `isUsMarketOpen` `:718`, `US_MARKET_HOLIDAYS` `:144`, `nextUsSessionBoundary` `:739`). The ticket predates it.
- What is missing is a per-exchange entry point. India: `getNseMarketStatus` (`packages/core/src/market-data/market-hours.ts:121`, `MarketStatus` `:35`). Duplicates of the India session outside it:
  - `apps/web/lib/market/market-hours.ts:11-12` (`getMarketSnapshot`, a second NSE clock with no holidays; one caller, `apps/web/app/paper-trading/PaperTradingLayoutClient.tsx:8`)
  - `apps/web/app/api/market/indices/indices-logic.ts:144-146`
  - `apps/market-data/src/routes/history.ts:120` (`inIndiaSession`, deliberately coarse — documented; leave, allow-list)
  - copy: `apps/web/app/discover/markets/client.tsx:339` "LIVE · 09:15–15:30 IST", `PaperTradingLayoutClient.tsx:142`

## Read first (verified paths)

- `packages/core/src/market-data/instruments/{types,resolve-instrument-logic,zerodha-instruments,zerodha-instruments-logic}.ts`, `apps/web/lib/market/symbol-mapper.ts`, `apps/web/lib/market/quote-exchange.ts` (explains the DOW.NS collision)
- `packages/utils/src/{format,index}.ts`, `packages/utils/package.json`
- `packages/core/src/market-data/{market-hours,us-market-hours}.ts`, `apps/web/hooks/useMarketStatus.ts`, `apps/web/lib/market/market-hours.ts`

## Build — in this order

### Do NOT edit these files (other Phase-0 prompts own them; the ratchet counts them instead)

`apps/web/app/stock/[symbol]/us-client.tsx` (P0-08), `apps/web/components/TopBar.tsx` + `apps/web/components/Sidebar.tsx` (P0-06), `apps/web/components/dashboard/DashboardOverview.tsx` + `apps/web/lib/demo/data.ts` (P0-07), `apps/web/app/welcome/client.tsx` + `apps/web/components/TermsGate.tsx` (P0-05), `apps/web/app/stock/[symbol]/page.tsx` + `apps/web/app/api/market/{quote,stream,search}/route.ts` (P0-03), `apps/web/lib/actions/subscription.ts` (P0-04). If a site in the tables above lives in one of these, leave it and list it in the PR as a hand-off to that prompt.

### 1. MONEY-899 — one Yahoo-symbol rule

`packages/core/src/market-data/instruments/types.ts` (next to `US_EXCHANGES`):

```ts
/** THE Yahoo symbol rule. US venue → bare ticker; NSE/BSE → suffix; anything else → null (never ".NS"). Already-suffixed / "^" index symbols pass through. */
export function yahooSymbolForExchange(
  symbol: string,
  exchange: string,
): string | null;
```

- `yahooSymbolFor` (`resolve-instrument-logic.ts:320`) and `zerodha-instruments.ts:285-291` delegate to it.
- Every site in the 899 table calls it. Where a site has NO exchange (chat `:1119`, `ActionBlockRenderer`, `portfolio-analysis`, `db-store`, `events-sync`), either resolve the instrument first (`resolveInstrument`, `packages/core/src/market-data/instruments/resolve-instrument.ts`) or — only where the input is India-scoped by construction — pass `"NSE"` explicitly with a one-line comment saying why. A `null` result means "no Yahoo symbol": the caller skips the fetch (absence), never guesses.
- `toYahooSymbol(symbol, exchange: string = "NSE")` in `symbol-mapper.ts` widens its parameter to `string` and delegates; its 25 callers keep compiling. Its `null` becomes `""` only if a caller cannot take null — prefer changing the caller.
- `apps/api/src/routes/v1/market.ts:194` keeps its `?exchange=` default of NSE (that is an API contract) but computes through the function.

### 2. MONEY-901 — one money formatter

`packages/utils/src/format.ts`:

```ts
export type Money = "INR" | "USD";
export function formatMoney(
  value: number | null | undefined,
  currency: Money,
  opts?: { compact?: boolean; signed?: boolean; decimals?: 0 | 2 },
): string;
// non-finite / null → "—" (never "₹NaN", never "$0.00" for missing)
// INR: en-IN grouping (₹12,34,567.00); compact → ₹12.35L / ₹1.23Cr
// USD: en-US grouping ($1,234,567.00); compact → $1.23M / $4.56B / $12.3K
export function formatCurrency(value: number): string; // kept: formatMoney(value, "INR") — 20 callers unchanged
```

- `formatPnL` gains an optional `currency` (default `"INR"`). Add `"./format": "./src/format.ts"` to `packages/utils/package.json` exports; new imports use `@usemoney/utils/format` (subpaths, not the barrel).
- Replace the 29 local formatter DEFINITIONS with `formatMoney` imports (skipping the do-not-edit files). Keep call sites' behaviour byte-identical for INR (snapshot a few before/after strings in tests — `₹1,23,456` must stay `₹1,23,456`).
- Do NOT rewrite the 412 `₹` lines. Most are India-only copy and correct. Instead:
- **Ratchet** — `packages/utils/__tests__/money-ratchet.test.ts` + `scripts/money-ratchet-baseline.json` (generated by the test's `--update` mode, committed): counts per file of `₹` literals, `currency: "INR"` literals and `en-IN` in `apps/web` (non-test). The test fails when any file's count goes UP or a new file appears; going down rewrites nothing (the founder re-baselines deliberately). Plus a hard rule with no baseline: zero `₹`, `"INR"` and `en-IN` in `apps/web/components/design-v2/**`, `apps/web/app/us/**`, and any file whose name contains `us-` under `apps/web/app` or `apps/web/components` (US surfaces must use `formatMoney`). **Mutation check:** add a `₹` to `apps/web/components/design-v2/MarketPill.tsx` (or any file under that folder — create a throwaway if none exists yet) → red.

### 3. MONEY-903 — per-exchange status

`packages/core/src/market-data/market-hours.ts`:

```ts
/** THE entry point. NSE/BSE → getNseMarketStatus; US venues → built from usMarketSession/nextUsSessionBoundary (holidays + DST already there); unknown → null. */
export function getExchangeMarketStatus(
  exchange: string,
  at?: Date,
): MarketStatus | null;
```

- US mapping: `pre` → `PRE_OPEN`, `rth` → `OPEN`, `post` → `POST_CLOSE`, `closed` on a holiday → `HOLIDAY` with the holiday name, weekend → `WEEKEND`. `closesAt` / `nextOpenAt` from `nextUsSessionBoundary`. `formatClosedReason` (`:195`) takes the exchange so it can print "Opens 09:30 ET" for US (US times shown in IST for India-resident users is a UI concern — the function returns instants, not strings, except `formatClosedReason`, which gains a `tz: "IST" | "ET"` param, default IST).
- Delete `apps/web/lib/market/market-hours.ts`; `PaperTradingLayoutClient.tsx` uses `getNseMarketStatus` (paper trading is India-only) — its "CLOSED · 09:15 IST" copy comes from `formatClosedReason`.
- `indices-logic.ts:144-146` → `getNseMarketStatus` (indices here are Indian).
- `discover/markets/client.tsx:339` copy → from `getNseMarketStatus` (this page is India-only until P1-07).
- `apps/market-data/src/routes/history.ts:120` stays (documented coarse CDN heuristic); allow-list it in the scan with that reason.
- Scan: no `9 * 60 + 15`, `15 * 60 + 30` or `09:15`/`15:30` string outside `packages/core/src/market-data/market-hours.ts` and the allow-list (help FAQ copy `apps/web/app/help/lib/faq-data.ts:218` and `SectorsHeatmap.tsx:418` are prose about NSE — allow-list with reason).

### 4. No service / action / route

These are libraries under every surface. No `US_SURFACES` row, no `/v1` change, no flag. The India UI must be pixel-identical.

## Cross-surface access (§6)

1–5 n/a: no surface. 6. API — `/v1/market/*` now computes Yahoo symbols through the one rule; contract unchanged. 7. Demo — unchanged (demo numbers still format identically for INR — asserted by the INR snapshot tests). 8. Telemetry — n/a.

## Tests

- `packages/core/__tests__/market-data/yahoo-symbol-for-exchange.test.ts` — AAPL/NASDAQ → `AAPL`; INFY/NYSE → `INFY` (the ADR, never `INFY.NS`); DOW/NYSE → `DOW`; RELIANCE/NSE → `RELIANCE.NS`; RELIANCE/BSE → `RELIANCE.BO`; `RELIANCE.NS` passes through; `^NSEI` passes through; `X`/`LSE` → `null`; `""` → `null`.
- `packages/core/__tests__/market-data/no-ns-default-scan.test.ts` — source scan over `apps/`, `packages/*/src`, `workers/src`: no `?? ".NS"`, `: ".NS"`, `` `${…}.NS` ``, `+ ".NS"` outside `types.ts`, except the allow-list (each entry has a reason; `bhavcopy-sync.ts:521` is one). PREMISE: scanned files > 0. **Mutation check:** re-add `?? ".NS"` to `zerodha-instruments-logic.ts` → red.
- `packages/utils/__tests__/format-money.test.ts` — INR/USD grouping, compact both, signed, `NaN`/`Infinity`/`null` → `—`, `-0` → no "-₹0"; `formatCurrency` output unchanged for five fixed inputs (byte-equal to today).
- `packages/utils/__tests__/money-ratchet.test.ts` — above.
- `packages/core/__tests__/market-hours.test.ts` (extend) — `getExchangeMarketStatus` for NSE on a Muhurat/holiday date, NASDAQ on Thanksgiving, on a US early close, across both DST switches, a Saturday; unknown exchange → null.
- `packages/core/__tests__/market-data/session-hardcode-scan.test.ts` — the 09:15/15:30 scan.
- Existing suites that touch these paths stay green (`symbol-mapper`, `sparkline`, `screener/engine`, `search-logic`, `indices-logic`, `useMarketStatus`, `us-market-hours`).
- `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] `grep -rnE '\?\? "\.NS"|: "\.NS"' apps packages workers --include=*.ts --include=*.tsx | grep -v __tests__` returns only `types.ts` and allow-listed lines.
- [ ] A US holding/quote path that previously produced `DOW.NS` now produces `DOW` or absence (show one before/after in the PR).
- [ ] Every INR string the app rendered before renders identically (snapshot tests + a 375px screenshot of Holdings and Dashboard, before/after, light).
- [ ] Ratchet baseline committed; mutation checks red then green.
- [ ] Paper-trading header and discover markets copy unchanged for India.
- [ ] `verify:push`; `/code-review`.

## Out of scope / hand-offs

- Converting the remaining `₹` lines on India-only pages — done opportunistically when a page is touched; the ratchet only lets the count fall.
- `formatUsd` in `us-client.tsx` → **P0-08** (it owns that file). US copy of the NSE banner on `/discover/markets` → **P1-07**.
- US hours shown in ET vs IST per residency → the consumers (`usHoursIn` from P0-05's profile).
