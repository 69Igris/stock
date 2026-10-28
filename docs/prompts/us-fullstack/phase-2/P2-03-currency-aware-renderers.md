# P2-03 · Currency-aware research and chat renderers: USD renders $ (with a dated ₹-equivalent), never a hardcoded ₹

Ticket: MONEY-1633 (4) · Branch: `feat/MONEY-1633` · Flag(s): `us-stock-research` (the ₹-equivalent chip and US report blocks) · Screens: S2.2 (US research report) · Depends on: P0-08 (MONEY-1576 `convertUsd`, MONEY-1578 disabled-with-reason), P0-09 (MONEY-901 currency helper, if it landed one) · Parallel-safe with: P2-01

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Money rendering: `/code-review ultra`.**

## Goal

1. Every typed chat block and research report card formats money through ONE `formatMoney(amount, currency, opts)`, and `currency` travels on the block payload.
2. A USD block renders `$` in en-US grouping.
3. An optional ₹-equivalent chip shows the `convertUsd` VALUE (spot) with its date.
4. India blocks render byte-for-byte as today.

## Why / measured state today (verified, counted with `grep -o "₹"`)

**The only money formatter** is `packages/utils/src/format.ts:4`, `formatCurrency(value)`, which is hardcoded `en-IN`/`INR`. `formatPnL` (`:16`) is built on top of it.

**Block renderers** (`apps/web/components/chat/blocks/`):

- `ChatBlock.tsx`: **6** ₹.
  - `:750` `export const inr = (n) => "₹" + …toLocaleString("en-IN")`
  - `:752-756` is the compact ₹Cr/₹L/₹k helper.
  - `:758` is `signedInr`.
  - These helpers are what `TypedFinancialBlocks.tsx` imports.
- `TypedFinancialBlocks.tsx`: **11** ₹ glyphs.
  - Glyphs at `:685` (NAV), `:720` (AUM), `:822/839/856/865` (FIRE corpus ₹Cr), `:1143/1152` (support/resistance).
  - `inr()` calls at `:120, :383, :395, :425, :810, :1681`.
  - `:361` is a comment.
- `ChartBlockInner.tsx`: **4** ₹, at `:78-81` (axis tick formatter).

**Chat UI** (`apps/web/components/chat/`):

- `ActionConfirmationDialog.tsx:297`: 1, a money value.
- `sidebar/AlertsTabBody.tsx:103`: 1, the alert threshold.
- `CitationsRail.tsx:391`: 1, an icon glyph.
- `StockSageIcon.tsx`: 3, the brand mark. **Leave it.**
- `options/PromptOptionsPopover.tsx`: 10.
  - `:3758` prints a stock price and is fixed in P2-02.
  - `:282-336` and `:484` are hardcoded "38 holdings · ₹12.4L" copy, which is placeholder data. See "Out of scope".

**Research components.** `apps/web/components/stocksage/*` and `apps/web/app/stocksage/*` contain **0** ₹. Research money reaches the screen through the chat blocks above.

**Payload types.** In `packages/types/src/chat.ts`, `ContentBlock` (`:576`) and the `format?: "currency" | …` fields (`:33, :54, :78, :192`) carry no currency code.

**PDF export: there is none for research.** Nothing in `apps/web` or `packages` renders a research PDF. `packages/services/src/documents.service.ts:218` `generateReport` only creates a `UserDocument` row for tax/risk/portfolio_statement. The ticket's PDF bullet therefore has nothing to change. Record "n/a (measured)" in the PR and **do not build an exporter.**

## Read first (verified paths)

- `packages/utils/src/format.ts`, `packages/utils/src/index.ts`
- `apps/web/components/chat/blocks/{ChatBlock,TypedFinancialBlocks,ChartBlockInner,TableBlockRenderer,CardBlockRenderer,ComparisonBlockRenderer,StockListBlockRenderer}.tsx`
- `packages/types/src/chat.ts` (`ContentBlock`, block interfaces with `format`)
- `apps/web/components/chat/{ActionConfirmationDialog,CitationsRail}.tsx`, `sidebar/AlertsTabBody.tsx`
- `packages/research/src/tools/synthesize-report.ts` and the places the worker builds blocks. Find where `StructuredReportBlock` / typed blocks are assembled by grepping `type: "table"` in `packages/research/src` and `apps/web/lib/chat-tools`.
- P0-08's `convertUsd` and its MONEY-1578 "disabled with reason" copy.

**Stop** if `convertUsd` is not on `origin/main`.

## Build, in this order

### 1. Shared helper (the "service" of this ticket)

Check first: if P0-09 (MONEY-901) already added a currency-parameterised helper to `@usemoney/utils`, use it and extend it. Otherwise add ONE to `packages/utils/src/format.ts`:

```ts
export type MoneyCurrency = "INR" | "USD";
export function formatMoney(
  amount: number | null | undefined,
  currency: MoneyCurrency,
  opts?: { compact?: boolean; signed?: boolean; decimals?: number },
): string;
```

- INR: `en-IN`; compact is ₹Cr / ₹L / ₹k exactly as `ChatBlock.tsx:752-756` does today (copy those thresholds, then delete the local helper).
- USD: `en-US`; compact is $B / $M / $K.
- A non-finite or null amount returns `"—"`. It never returns `NaN`, `$0` or `₹0`.
- `formatCurrency` stays as a deprecated wrapper `= formatMoney(v, "INR")`. Do not touch its other callers.

**The ₹-equivalent:** `packages/services/src/currency/inr-equivalent-logic.ts` (pure), or next to `convertUsd` if P0-08 put it elsewhere. Do not create a second module:

- `inrEquivalent({ usd, date, rate })` returns `{ text: "≈ ₹20,104", rateText: "spot ₹88.12 · 23 Sep" } | { unavailable: "no rate for 23 Sep" }`.
- It uses VALUE (spot) only. It never uses the RBI rate (Decision 02).

### 2. Payload

- Add `currency?: MoneyCurrency` to every money-bearing block interface in `packages/types/src/chat.ts`.
- An absent `currency` means INR, because every stored historical block is INR. Write that ONCE, as `blockCurrency(block)`, and never as scattered `?? "INR"`.
- Add `fx?: { rate: number; date: string; source: "SPOT" }` to blocks that show a ₹-equivalent.
- **Producers.** The research worker (when the plan's market is US, from P2-01) and the chat tool mappers stamp `currency: "USD"` on blocks built from `fetch_us_*` tools. Find each producer with the grep in "Read first".

### 3. `/v1` route + `US_SURFACES` row

- There is no new route: blocks travel inside `/v1/research/:id/result` and `/v1/chat-history`, which already exist.
- Add a contract assertion in `apps/api/__tests__/routes/` that a US result's blocks carry `currency:"USD"`.
- No `US_SURFACES` row: this is a renderer, not a surface. Say so in the PR.

### 4. UI

- Replace every money ₹ listed above, except `StockSageIcon` (brand) and the `CitationsRail` icon, with `formatMoney(x, blockCurrency(block), …)`.
- `ChartBlockInner` axis ticks take the series currency.
- FIRE, tax (STCG/LTCG) and MF NAV/AUM blocks are India-only. Keep them INR explicitly (`"INR"`) and do not route them.
- **₹-equivalent chip** (`apps/web/components/chat/blocks/InrEquivalentChip.tsx`):
  - It renders under USD figures only when `us-stock-research` is on and the user's display currency (MONEY-1575/P0-08) wants ₹.
  - Copy: "≈ ₹20,104 · spot ₹88.12 · 23 Sep".
  - If the rate is missing: "₹ view unavailable · no rate for 23 Sep".

## Screens

### S2.2 · US research report, valuation card (375px)

```
┌──────────────────────────────────────┐
│ ‹ Research · AAPL · NASDAQ           │
│ US ◷ EOD · 23 SEP CLOSE              │
├──────────────────────────────────────┤
│ VALUATION                   EDGAR ▸  │
│ Price            $228.14             │
│                  ≈ ₹20,104           │
│ Revenue (FY25)   $416.2B             │
│   10-K · filed 31 Oct 2025           │
│ Net income       $112.0B             │
│ P/E (TTM)        30.8×               │
│ 5y median P/E    27.4×               │
│ ─────────────────────────────────    │
│ ₹ at spot ₹88.12 · 23 Sep            │
│ Analysis and education only — not    │
│ investment advice.                   │
└──────────────────────────────────────┘
```

At 1280px, it is the existing report layout: the table spans the content column, and the ₹-equivalent sits in a right-aligned secondary column, not a second line.

### States

| State    | Behaviour                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------- |
| loading  | The existing report skeleton; money cells are `—` placeholders at final width                       |
| empty    | A block with no money rows renders as today                                                         |
| error    | Existing ErrorBlock; no ₹/$ glyph in error text                                                     |
| DataGap  | Spot missing: the chip reads "₹ view unavailable · no rate for 23 Sep"; the USD values still render |
| gated    | Not applicable here (the report exists only after P2-01's gate)                                     |
| flag-off | `us-stock-research` off: US blocks are never produced, so no chip; INR blocks are unchanged         |
| demo     | The demo US report fixture (MONEY-919) renders `$` + chip with the fixture rate                     |

### Users

| User         | Behaviour                                                 |
| ------------ | --------------------------------------------------------- |
| U1           | INR blocks only, byte-identical                           |
| U2 / U6 / U7 | USD blocks with `$`, chip per display currency            |
| U3           | As U1 until US is added                                   |
| U4           | Demo fixture                                              |
| U5           | Never reaches a US report (gated upstream); INR unchanged |

## Cross-surface access (§6)

| #   | Line      | Answer                                                               |
| --- | --------- | -------------------------------------------------------------------- |
| 1   | Search    | n/a: a renderer                                                      |
| 2   | Watchlist | n/a: a renderer                                                      |
| 3   | Sage      | Every Sage answer now renders in the right currency                  |
| 4   | Home      | n/a: a renderer                                                      |
| 5   | Deep link | n/a: a renderer                                                      |
| 6   | API       | Blocks carry `currency` in `/v1/research/:id/result` (contract test) |
| 7   | Demo      | The US report fixture                                                |
| 8   | Telemetry | n/a: no new action; renderers emit nothing                           |

## Tests

- `packages/utils/__tests__/format-money.test.ts`:
  - INR compact thresholds equal the old helper's outputs, verified on a table of 12 values;
  - USD grouping;
  - `null`/`NaN`/`Infinity` → `"—"`.
  - **Mutation note:** swap the locales and watch the table fail.
- `packages/services/__tests__/currency/inr-equivalent-logic.test.ts`: only spot is accepted; a missing rate yields `unavailable` and never `0`.
- `apps/web/__tests__/components/chat-blocks-currency.test.ts` (`renderToStaticMarkup`):
  - **USD-renders-no-₹:** render every money-bearing block type with `currency:"USD"` and fx absent, and assert `!html.includes("₹")`;
  - with fx present, the only ₹ is inside the dated chip;
  - INR snapshots are unchanged against the golden output captured before the change (commit the goldens first).
- `apps/web/__tests__/components/chart-block-axis-currency.test.ts`: axis ticks `$1.2K` for USD.
- `apps/api/__tests__/routes/research-result-currency.test.ts`: contract.
- Update `TEST-COVERAGE.md`.

## Acceptance

- [ ] `grep -o "₹"` over `components/chat/blocks` returns only occurrences inside `formatMoney`'s INR branch or explicit India-only blocks. List the survivors in the PR.
- [ ] A USD block renders no ₹ except the dated chip (test).
- [ ] INR goldens are unchanged.
- [ ] The PDF bullet is recorded as "n/a (measured): no research PDF exporter exists".
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Out of scope / hand-offs

- The `PromptOptionsPopover.tsx:282-336, :484` hardcoded "₹12.4L / 38 holdings" strings are placeholder numbers, which break "numbers are computed or absent". File a ticket from the session, read its id back, and do not fix them here.
- The `:3758` price row is fixed by P2-02.
- The roast prompt's ₹ (`packages/roast/src/prompts.ts:53-150`) goes to P3-06.
- The skill-map allow-listing of the `fetch_us_*` tools inside India skills stays out. P2-01 gives US its own tool set.
