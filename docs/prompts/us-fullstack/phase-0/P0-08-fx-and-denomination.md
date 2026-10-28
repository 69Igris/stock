# P0-08 · FX: two rates per date, one `convertUsd`, a toggle that says why it is off

Ticket: MONEY-1575 (+ MONEY-1576, MONEY-1578) · Branch: `feat/MONEY-1575` (one PR closes all three) · Flag(s): `us-currency-toggle` · Screens: `$ ↔ ₹` toggle on the US stock page · Depends on: P0-01 · Parallel-safe with: P0-03, P0-06

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt. Decision 02 binds everything here: **spot for VALUES, the RBI reference rate of the trade date for COST basis / LRS, never mixed.**

## Goal

`fx_rates` can hold a spot and an RBI rate for the same date, and holds a daily USDINR spot series back to January 2016. Every USD→INR conversion in the product goes through one function, `convertUsd({amount, kind, date})`, that returns a flagged absence instead of a zero, a blank or `NaN` when it has no rate. On the US stock page, the `$ ↔ ₹` toggle is disabled with a reason ("No USD→INR rate for 18 Apr 2016") rather than producing an empty cell.

## Why / measured state today (verified 2026-09-24)

- `FxRate` (`packages/database/prisma/schema.prisma:7233`): `pair`, `date`, `rate`, `source String // YAHOO | RBI`, `asOf`; **`@@unique([pair, date])` at `:7244`** — `source` is not in the key, so the first RBI write for a date would overwrite the YAHOO row (the MONEY-1050/1234/1235 class).
- The only writer: `us-eod-sync` leg (d), `workers/src/processors/us-eod-sync.ts:2078-2082` — `upsert where: { pair_date: { pair: FX_PAIR, date } }` with `FX_PAIR = "USDINR"` (`:279`) and `FX_SOURCE = "YAHOO"` (`:333`). (The ticket cites `:1988`; the code has moved.) Rows: 17 on prod, 2026-08-28 → 2026-09-21 (ticket, measured 2026-09-22 — re-measure before the push).
- No reader of `fx_rates` exists in `apps/` or `packages/services` (grep `prisma.fxRate` → only the writer).
- Spot today: `getExchangeRate(from, to)` (`packages/core/src/currency/exchange-rates.ts:64`), Yahoo, in-memory 1 h cache, returns `null` when no finite positive rate.
- RBI reference: `getRbiReferenceRate({currency, invoiceDate})` (`packages/services/src/gst/rbi-fx.ts:87`) — env override `GST_FX_RATE_<CCY>_<YYYY-MM-DD>` else `fetchFromRbi` which **returns `null` always** (`:73-79`, `TODO(MONEY-217)`) → throws `RbiRateUnavailableError`. **The COST arm has no production source until MONEY-217.** Say that in the PR and in the code, not in a stack trace.
- Historical Yahoo series: `fetchChart` (`packages/core/src/market-data/yahoo-api.ts:528`).
- `fx_rates` is a prod→QA REFERENCE collection (`scripts/ops/sync-prod-to-qa.sh:965`): QA receives rows; the backfill runs on prod only.
- No `DualCurrency` component exists (W00 not built); W00 specifies it at `apps/web/components/design-v2/DualCurrency.tsx` with `{ inr, usd, primary, fxRate, fxAsOf, fxKind: "SPOT"|"RBI_REF" }` (`docs/prompts/design-v2/web/W00-design-primitives-and-shell.md:30`). No `DataGapBanner` either (`:23`).
- The US stock page renders USD through a local `formatUsd` (`apps/web/app/stock/[symbol]/us-client.tsx:58`); there is no toggle.

## Read first (verified paths)

- `packages/database/prisma/schema.prisma:7225-7247`, `workers/src/processors/us-eod-sync.ts:2039-2095`, `workers/src/processors/us-eod-sync-logic.ts:369-395`
- `packages/core/src/currency/exchange-rates.ts`, `packages/core/__tests__/exchange-rates.test.ts`
- `packages/services/src/gst/rbi-fx.ts`
- `packages/core/src/market-data/yahoo-api.ts` (`fetchChart`), `scripts/jobs/tiingo-us-backfill.ts` (a Cloud Run job script to copy the shape of), `scripts/ops/setup-infra.sh`
- `apps/web/app/stock/[symbol]/{page,us-client}.tsx`
- `docs/design/v2-bundle/Decisions - US Launch.dc.html` (Decision 02, the `rows` array)

## Build — in this order

### 0. Schema + writer (MONEY-1575)

1. Before touching the schema, measure on QA (a prod copy: `fx_rates` is a REFERENCE collection): `db.fx_rates.countDocuments({source: {$exists: false}})` and `…({source: null})` — both must be 0 (a unique index on Mongo is not sparse; a row without `source` would collide). Paste both counts in the PR, labelled QA. The same count on prod is the founder's pre-push check ("Founder, after merge").
2. `@@unique([pair, date, source])`. Prisma renames the compound key → `pair_date_source`; update `us-eod-sync.ts:2079` to `where: { pair_date_source: { pair: FX_PAIR, date, source: FX_SOURCE } }` and drop `source` from `update` (it is part of the key now).
3. Run `prisma generate`. Pushing the index (`scripts/ops/setup-infra.sh {qa|prod} --only db`) is a founder step after merge. Read `setup-infra.sh` and write in the PR's "Founder, after merge" list whether the old `pair_date` unique index must be dropped explicitly (a surviving old unique still blocks the RBI row), with the exact drop command if so.

### 1. Backfill (MONEY-1575) — `scripts/jobs/fx-backfill-usdinr.ts` (+ `-logic.ts`)

- One `fetchChart("USDINR=X", {interval: "1d", period1: 2016-01-01})`, rows → `{pair:"USDINR", date: UTC midnight of the session, rate: close, source:"YAHOO", asOf: now}`. Drop non-finite / ≤ 0 closes and COUNT them.
- Upsert on `pair_date_source`; never overwrite an existing row (`update: {}`) — the nightly leg owns recent rows.
- Dry run by default; `--apply` writes. Reconcile in the output: rows written vs distinct `candles.ts` for `timeframe: "D1"` and `exchange` in `US_EXCHANGES` (`packages/core/src/market-data/instruments/types.ts`; `Candle` has no `market` field) from 2016-01-01 — use a raw `distinct` over one liquid listing (e.g. SPY) if the full distinct is too heavy, and say which — print both and the list of US sessions with no FX row (a Yahoo holiday mismatch is expected on a few dates; list them, do not hide them).
- Write the provisioning script for a Cloud Run job like `tiingo-us-backfill` (read how that job is set up in `scripts/ops/` and follow it; job env pinned at setup — re-run setup after deploy). Prod only. The session runs the backfill only as a dry run against QA or fixtures; provisioning and running it on prod are founder steps.

### 2. Service (MONEY-1576) — `packages/services/src/currency/`

`us-denomination-logic.ts` (pure, no I/O — the ticket names this file):

```ts
export type FxKind = "VALUE" | "COST";
export type Converted =
  | {
      ok: true;
      inr: number;
      rate: number;
      rateDate: string;
      kind: FxKind;
      source: "SPOT" | "YAHOO_DAILY" | "RBI" | "OPS_OVERRIDE";
      stale: boolean;
    }
  | {
      ok: false;
      kind: FxKind;
      date: string;
      reason: "no-spot-rate" | "no-rbi-rate" | "bad-amount";
    };

export const STALE_SPOT_MS = 24 * 3600_000;
export function convertWithRate(a: {
  amount: number;
  kind: FxKind;
  date: string;
  rate: FxRateHit | null;
  now: Date;
}): Converted;
/** Totals: rows without a rate are EXCLUDED and COUNTED, never zero-filled. */
export function sumConverted(rows: Converted[]): {
  inr: number;
  excluded: number;
  stale: boolean;
};
```

- Guard `amount` and `rate` with `Number.isFinite` and return ABSENCE. Do NOT use the repo's `finite()` helpers (`packages/services/src/fire-logic.ts:46` and siblings) — they collapse non-finite to `0`, which is exactly the failure this function exists to prevent. `rate <= 0` → absence. VALUE and COST never read each other's source.

`us-denomination.service.ts`:

```ts
export async function convertUsd(
  a: { amount: number; kind: FxKind; date: string /* YYYY-MM-DD */ },
  deps?,
): Promise<Converted>;
export async function getFxAvailability(
  userId: string,
  input: FxAvailabilityInput,
): Promise<ServiceResult<FxAvailability>>;
// FxAvailabilityInput = z.object({ kind: z.enum(["VALUE","COST"]), dates: z.array(isoDate).min(1).max(366) }).strict()
// FxAvailability = { kind, rates: Array<{ date, rate: number | null, source, asOf: string | null, reason: string | null }> }
```

Rate resolution:

- **VALUE**, `date` = today (IST) → `getExchangeRate("USD","INR")` (live spot, 1 h cache); if null → latest `fx_rates` YAHOO row with `stale = now - asOf > 24h`.
- **VALUE**, past date → `fx_rates` YAHOO row for that date, else the nearest PRIOR row within 4 days (weekend/holiday), else `no-spot-rate`.
- **COST** → `fx_rates` RBI row for that date; else `getRbiReferenceRate` (env override only today); `RbiRateUnavailableError` → `no-rbi-rate`. No fallback to spot, ever.

Add services subpath `"./currency/*": "./src/currency/*.ts"`. This is the one conversion function; the SnapTrade pack's own conversion (cross-pack reconciliation C3) must call it.

### 3. Server action — `apps/web/lib/actions/us-fx.ts`

`getFxAvailabilityAction(input: unknown)` → `getAuthenticatedUser` (demo/signed-out allowed: FX is not licensed data, pass `userId` null-safe) → `FxAvailabilityInput.safeParse` → service.

### 4. `/v1/us/fx` + `US_SURFACES`

`GET /v1/us/fx?kind=VALUE&dates=2016-04-18,2026-09-23` → same JSON. Row `{ surface: "fx", flag: "us-currency-toggle", usAccess: "none", serviceExport: "getFxAvailability", serviceFile: "packages/services/src/currency/us-denomination.service.ts", actionFile: "apps/web/lib/actions/us-fx.ts", routeFile: "apps/api/src/routes/v1/us/fx.ts", routePath: "/v1/us/fx" }`. (P0-01 rule 3 derives the specifier from `serviceFile` for any path under `packages/services/src/`, so this resolves `@usemoney/services/currency/us-denomination.service`; add that subpath to `packages/services/package.json` `exports` if missing.)

### 5. UI (MONEY-1578)

- `apps/web/components/design-v2/DualCurrency.tsx` + `dual-currency-logic.ts` (W00 props): primary large, secondary muted, stamp `SPOT ₹83.12/$ · 1H` or `RBI REF · TRADE DATE`. Formats with `Intl.NumberFormat` en-US for `$`, en-IN for `₹` inside the logic file (P0-09's `formatMoney` replaces it when it lands; do not wait for it).
- `apps/web/components/design-v2/CurrencyToggle.tsx`: `[ $ | ₹ ]`, 44 px segments. Disabled when the availability row for the rendered date has `rate: null`, with the reason as visible text under the toggle (not only a tooltip): VALUE → "No USD→INR rate for 18 Apr 2016"; COST → "No RBI reference rate for 18 Apr 2016".
- `apps/web/components/design-v2/DataGapBanner.tsx` (W00 props `{ text, lastGood? }`): shown above totals when `sumConverted().stale` ("FX rate from {date} · values approximate") or `excluded > 0` ("{n} rows have no rate for their date and are not in this total").
- Mount on the US stock page (`us-client.tsx`) when `us-currency-toggle` is on (`licensed:false` flag, read via `useUsFeatureFlags`; the page itself is already behind the US layer). Toggle state is per-viewer UI state (sessionStorage via try/catch); the default comes from `primaryCurrency` once P0-05 lands (until then `$`). The converted price uses VALUE at the quote's session date.

## Screens

### Toggle on the US stock page — 375px

```
┌──────────────────────────────────────┐
│ ← AAPL · NASDAQ              [$|₹]   │
│ Apple Inc.                           │
│ ₹19,142.30                           │
│ $228.02 · SPOT ₹83.95/$ · 1H         │
│ ◷ End-of-day · 23 Sep                │
├──────────────────────────────────────┤
│ Viewing 18 Apr 2016        [$|₹]░░   │
│ $26.84                               │
│ ₹ unavailable: No USD→INR rate for   │
│ 18 Apr 2016                          │
└──────────────────────────────────────┘
```

1280px: toggle in the price header's right cluster; reason text inline to its left.

### States

| State                           | Toggle / DualCurrency                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| loading                         | toggle disabled, no reason text, secondary line skeleton                                |
| empty                           | n/a                                                                                     |
| error                           | availability read fails → toggle disabled, "Currency conversion unavailable right now"  |
| DataGap                         | stale spot > 24 h → `DataGapBanner` + values still render in $                          |
| gated                           | n/a — the page is behind the US layer; FX itself is not gated                           |
| flag-off (`us-currency-toggle`) | no toggle; `$` only (today)                                                             |
| demo                            | demo has no US page in Phase 0; P0-07's demo card uses the fixture FX, not this service |

### U1–U7

| User    | Behaviour                                                  |
| ------- | ---------------------------------------------------------- |
| U1      | never on a US page → nothing                               |
| U2 NRI  | default `$` primary                                        |
| U2 LRS  | default `₹` primary (from `primaryCurrency`)               |
| U3      | as U1 unless they add US                                   |
| U4      | n/a (see demo)                                             |
| U5 FREE | sees GateInline instead of prices (P0-04) → no toggle      |
| U6 / U7 | toggle works; disabled with reason on dates without a rate |

## Cross-surface access (§6)

1. Search — n/a: a control. 2. Watchlist — n/a here; P1-08's mixed watchlist uses `convertUsd` for its ₹ column. 3. Sage — n/a; P2-03's renderers call `convertUsd`. 4. Home — n/a; P1-08 dashboard cards. 5. Deep link — n/a (per-viewer state). 6. API — `GET /v1/us/fx`, row `fx`. 7. Demo — n/a (see states). 8. Telemetry — `currency_toggled {to, kind, flag:"us-currency-toggle"}`; `currency_toggle_disabled_viewed {reason}` once per page.

## Tests

- `packages/services/__tests__/currency/us-denomination-logic.test.ts` — every branch: finite/NaN/Infinity/negative amount; rate null → absence (never 0); stale > 24 h → `stale:true`; COST never uses a spot row (feed a YAHOO row to COST → absence); `sumConverted` excludes + counts; empty list → `{inr:0, excluded:0}` is the ONLY zero.
- `packages/services/__tests__/currency/us-denomination-service.test.ts` — `deps.prisma` + fake spot/RBI: today → live spot; past date → YAHOO row; weekend → prior row ≤ 4 days; 5-day gap → absence; `RbiRateUnavailableError` → `no-rbi-rate`.
- `workers/__tests__/…/us-eod-sync` existing FX-leg tests — updated to `pair_date_source` (find them with `grep -rln "pair_date" workers/__tests__`).
- Schema test: `FxRate` declares `@@unique([pair, date, source])` and no `@@unique([pair, date])`. The live coexistence check (a YAHOO and an RBI row for the same date on QA, the ticket's acceptance) runs after the founder's index push and is listed under "Founder, after merge".
- `packages/core/__tests__/ops/fx-backfill-usdinr.test.ts` — logic: row mapping, non-finite drop count, reconcile report lists missing sessions.
- `apps/web/__tests__/design-v2/currency-toggle.test.tsx` — **render test on 2016-04-18 with no rate: disabled + the exact copy** (the ticket's acceptance); with a rate: enabled.
- `apps/web/__tests__/design-v2/dual-currency-logic.test.ts` — en-IN grouping (₹19,142.30 / lakh grouping for ≥ 1,00,000), en-US grouping; `SPOT` vs `RBI_REF` stamp.
- `apps/api/__tests__/routes/us-fx-contract.test.ts` — envelope; >366 dates → 400.
- **Mutation check:** make `convertWithRate` return `{ok:true, inr:0}` on a missing rate → the logic test goes red; remove `source` from the unique key → the schema test fails.

## Acceptance

- [ ] Pre-push counts of `source`-less rows are 0 on QA (pasted, labelled QA).
- [ ] The backfill's dry run (QA or fixtures) prints the reconcile report and the list of missing sessions; its logic test is green.
- [ ] US stock page with the flag on: toggle works for a current quote; a 2016 date without a rate shows the disabled reason.
- [ ] PR says out loud: "COST conversions have no production source until MONEY-217 (RBI fetcher); env overrides serve QA only."
- [ ] `verify:push`; `/code-review` (money display path).

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- On prod, re-run the two `source`-less counts; both must be 0 before the push.
- Push the index: `setup-infra.sh qa --only db`, then `setup-infra.sh prod --only db`; drop the old `pair_date` unique if the PR says it survives, and confirm with `listIndexes`.
- On QA, write a YAHOO and an RBI row for one date and confirm they coexist (the ticket's acceptance); check that the next nightly `us-eod-sync` FX leg still writes (job log).
- Provision `fx-backfill-usdinr` on prod, run it with `--apply`, and confirm `fx_rates` YAHOO rows cover 2016-01 → today against the reconcile report.

## Out of scope / hand-offs

- The RBI live fetcher → MONEY-217 (not in this program's table).
- Toggle on the screener → **P1-06**; on holdings → **P3-04**; currency column on Holding/Trade/Position → **P3-01**.
- Replacing `dual-currency-logic`'s `Intl` calls with `formatMoney` → **P0-09**'s ratchet will count them.
