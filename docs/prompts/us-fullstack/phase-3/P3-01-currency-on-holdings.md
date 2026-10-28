# P3-01 · Currency on Holding / Trade / Position / Order / MutualFund (SnapTrade P18 §1e, brought forward)

Ticket: MONEY-1636 (4) · Branch: `feat/MONEY-1636` · Flag(s): none (a schema and read path; nothing renders USD until P3-04) · Screens: none · Depends on: P0-08 (MONEY-1575/1576: `FxRate` source-in-key, `convertUsd`) · Parallel-safe with: — (lands first). **This PR lands first**: P3-02, P3-04 and P3-05 depend on it, and P3-02 skips P18 §1e because this ticket ships it.

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Money path: `/code-review ultra`.**

## Goal

1. Every holding, trade, position, order and MF row states its currency as a named value.
2. USD is stored as native USD.
3. Trades carry the RBI-reference FX of their trade date for cost basis.
4. Portfolio totals convert at READ time, with the rate date shown:
   - values use spot (`convertUsd` VALUE);
   - cost uses the RBI reference (`convertUsd` COST).
5. The P&L splits exactly into local return + FX return.
6. Nothing US is ever summed as rupees.

This is exactly P18 §1e (`docs/prompts/us-fullstack/snaptrade-prompts-P18-P33.md:49`), with P18's field names kept verbatim, plus the ticket's `fxAtTrade`.

## Why / measured state today (verified)

**The five models carry no currency or rail:** `Trade` (`schema.prisma:496-588`), `Holding` (`:591-658`), `Position` (`:661-739`), `Order` (`:742-798`), `MutualFund` (`:801-864`).

**None of the five has a `@@map`.** Their Mongo collection names are therefore the model names, `Trade`, `Holding`, `Position`, `Order` and `MutualFund`. Verify with `db.getCollectionNames()` before any `$runCommandRaw`.

**Two dangerous defaults** would silently mislabel a USD row written without explicit values:

- `Trade.exchange @default("NSE")` and `Holding.exchange @default("NSE")`;
- `Trade.brokerage @default(20)`, i.e. a ₹20 brokerage.

**`FxRate` is `@@unique([pair, date])`** (`:7233`) until P0-08 adds `source` to the key. Stop if P0-08 is not merged.

**Every writer today, from a grep of `.holding|.trade|.position .create|createMany|upsert`, excluding tests:**

- `packages/services/src/{broker-sync,trades,trade-import,trade-import-logic,positions}.service.ts|-logic.ts`
- `workers/src/processors/{sync-logic,import}.ts`
- `apps/web/lib/actions/{holdings,trade-import,positions}.ts`
- `apps/web/lib/jobs/import-processor.ts`
- `apps/web/app/api/[[...path]]/route.ts`
- `packages/core/src/brokers/{clients,adapters}/groww.ts`

**Contract violation.** `apps/web/lib/actions/holdings.ts:160` `addManualHoldingAction` writes `prisma.holding` and `prisma.trade` directly (`:231-266`), which breaks the contract. Its currency write moves into a service in this PR.

**Readers already on the shared path.** `getHoldings` (`packages/services/src/holdings.service.ts:111`) and `getDashboardStats` (`dashboard.service.ts:87`) are what both `apps/web/lib/actions/{holdings,dashboard}.ts` and `apps/api/src/routes/v1/{holdings,dashboard}.ts` call. That is where the read-time conversion goes.

**The IBKR direct adapter** (`packages/core/src/brokers/adapters/interactive-brokers.ts`, 640 lines) is a real OAuth adapter, not a stub. Its header documents the SMART-router exchange sentinel. It reads position `currency` for venue resolution but does not write it through (P18 §1e).

**MONEY-217.** `fetchFromRbi` returns `null` (`packages/services/src/gst/rbi-fx.ts:73-79`). Only `GST_FX_RATE_<CCY>_<YYYY-MM-DD>` env overrides work. **In production, every `fxAtTrade` and every COST conversion is ABSENT until MONEY-217 ships.** Build for that: absence is flagged and counted, never filled with spot.

## The absent-field trap (read before touching Prisma)

A Mongo `db push` creates indexes and never fields. So on every existing row:

- `currency` is ABSENT;
- `{ currency: null }` matches NOTHING;
- `{ currency: { not: null } }` matches nothing either;
- no Prisma predicate matches an absent field.

This is MONEY-1050/1205/1234/1236 again. Therefore:

1. **Write the `{ isSet: false }` arm test FIRST** for each new field, in `packages/database/__tests__/schema-money-1636.test.ts`. Follow `schema-money-1220.test.ts`.
2. **Every writer writes a named value.** Writers never leave `currency` absent: `"INR"` for Indian rails, and the ISO code from the source for foreign ones. `currency` is `String?` in Prisma only so that the push does not fail; the INVARIANT is "set on every row".
3. **Absent-field queries use `$runCommandRaw`.**
   - Measure: `{ count: "Holding", query: { currency: { $exists: false } } }`.
   - Backfill: `{ update: "Holding", updates: [{ q: { currency: { $exists: false }, broker: { $ne: "INTERACTIVE_BROKERS" } }, u: { $set: { currency: "INR", rail: "DIRECT" } }, multi: true }] }`.
   - Run it in batches by `_id` range.
4. **Transitional reader.** Until the backfill has run, readers use ONE pure helper, `effectiveCurrency(row)`, and never scatter `?? "INR"`:
   - if `row.currency` is set, return it;
   - if `broker === "INTERACTIVE_BROKERS"`, return `null`. The row is **excluded from totals with a visible count**, never assumed INR.
   - otherwise return `"INR"`.
   - This refines P18's "treat isSet:false as INR": an IBKR row may be USD.

## Read first (verified paths)

- `packages/database/prisma/schema.prisma` (the five models, `FxRate` :7233, `BrokerType` :3330)
- `packages/database/__tests__/schema-money-1220.test.ts` (the pattern for isSet arms)
- `docs/prompts/us-fullstack/snaptrade-prompts-P18-P33.md` §P18 step 1e and the house rules at `:15`
- `packages/services/src/{holdings,dashboard}.service.ts`, `dashboard-logic.ts` (`finite` :40), `holdings-logic.ts`
- `packages/types/src/broker/index.ts` (`NormalizedHolding` :260, `NormalizedTrade` :335)
- `packages/core/src/brokers/adapters/interactive-brokers.ts` (header + mapper)
- `scripts/data/resector-real-estate.ts` (the TTY-gated `--apply` pattern), `scripts/README.md`
- P0-08's `convertUsd` module

## Build, in this order

### 1. Schema (P18 §1e names, verbatim) + `fxAtTrade`

The session edits `schema.prisma` and runs `prisma generate`. The QA/prod `db push` is a founder step ("Founder, after merge").

- Add `enum BrokerRail { DIRECT SNAPTRADE }`. It is P18 §1a's enum, needed here for `rail`, and P3-02 then reuses it.
- `Holding`, `Trade`, `Position`, `Order`, `MutualFund` each gain:
  - `currency String?` (ISO-4217);
  - `rail BrokerRail?`;
  - `externalInstrumentId String?`;
  - `figi String?`;
  - `brokerPrice Float?`;
  - `brokerValue Float?`;
  - `priceAsOf DateTime?`.
- `Trade` also gains:
  - `provisional Boolean?` and `activityId String?`, both from P18;
  - `fxAtTrade Float?`, this ticket's addition.

**The FX decision, which is binding for P3-02, P3-04 and P3-05:**

- `Trade.fxAtTrade` is the **RBI reference rate for the trade date**, and nothing else. It is the COST-basis rate (Decisions #02).
- It is written only from `convertUsd`'s COST arm or an env override.
- When the RBI rate is unavailable it is left null, and the lot is flagged "needs FX".
- A broker-reported FX rate (SnapTrade `BrokerActivity.fxRate`, P18 §1f, or an import file's `fx_rate` column) is **informational only**. It is kept where it arrived (the BrokerActivity row, or the import's retained extra columns) and is never used as cost basis.
- The name `fxRateOnTrade` used in W08/W10 is superseded by `fxAtTrade`.

Do not add `currency` to any `@@unique`. That would split one position into two rows, the same trap as `stock_financials.basis`.

### 2. Writers set the named value

- Every writer listed above sets `currency` and `rail`: `"INR"` + `DIRECT` for the Indian adapters, the manual path and the Indian CSV import.
- The IBKR direct mapper writes the position's own `currency` into `NormalizedHolding` / `NormalizedTrade`. Add `currency?: string` to both types.
- **A writer guard, `assertMoneyRowShape(row)`**, pure, in `packages/services/src/holdings-logic.ts`. For a non-INR row it requires:
  - `exchange` explicitly set, never the `"NSE"` default;
  - `brokerage` explicitly set, never the `20` default.
- It throws a named error. Call it in the shared persist helpers (`broker-sync.service.ts` persistHoldings and the trade upserts).
- Move `addManualHoldingAction`'s body into `packages/services/src/holdings.service.ts` as `addManualHolding(userId, input)`. The action becomes thin. It is INR-only today; take `currency` from the input with a default of `"INR"` in the zod schema.

### 3. Backfill script: `scripts/data/backfill-broker-currency.ts`

- The name is P18's.
- It is idempotent, `--dry-run` by default, and `--apply` is refused without a TTY (like `resector-real-estate.ts`).
- It uses `$runCommandRaw` count + update per collection, in batches.
- It prints per collection: `absent before`, `stamped`, `skipped IBKR` and `absent after`.
- **IBKR rows:** stamp from `exchange` when it names one market (NASDAQ/NYSE/AMEX/ARCA → USD, NSE/BSE → INR). Leave `SMART`/`UNKNOWN` absent and report the count. `effectiveCurrency` excludes those rows.
- Measure on QA with `--dry-run` and put those counts in the PR, labelled QA. QA's holdings are QA users' own rows, so the prod counts will differ; the prod dry-run is a founder step ("Founder, after merge").
- Add it to `scripts/README.md`.

### 4. Read path (the one function behind the action and `/v1`)

Create `packages/services/src/portfolio-fx-logic.ts` (pure).

**`totalsByCurrency(rows)`** returns `{ native: { INR: {value, cost}, USD: {value, cost} }, excluded: { count, reasons[] } }`:

- It uses `effectiveCurrency` and `finite()` on every number.

**`convertTotals(native, fx)`** returns the INR and USD totals:

- VALUE at spot, COST lot-by-lot at `fxAtTrade`;
- a lot with a null `fxAtTrade` is excluded from the converted COST and counted, never converted at spot.

**`pnlSplit({ qty, p0, p1, s0, s1 })`** returns:

```
local = qty × (p1 − p0) × s0        // local-currency return, at cost FX
fx    = qty × p1 × (s1 − s0)        // FX return on current value
total = qty × (p1·s1 − p0·s0)       // = local + fx, exactly
```

- `s0` is `fxAtTrade` (RBI ref) and `s1` is spot (Decision 02: cost at RBI, value at spot, never mixed within one leg).
- A missing `s0` or `s1` returns `{ unavailable: reason }`. It never returns `NaN` or `0`.

**Service changes:**

- `getHoldings` and `getDashboardStats` return, additively and without breaking the existing shape:
  - `currency` on every row;
  - `totals: { inr, usd, spotRate, spotAsOf, spotStale, excluded }`.
- `spotStale` means more than 24 hours old. P3-04 renders the `DataGapBanner` from it.
- The India-only response values stay numerically identical. The contract test compares against a golden.

### 5. `/v1` route + `US_SURFACES` row

- No new route. `/v1/holdings` and `/v1/dashboard` gain the fields through the SAME service functions.
- Update their contract tests.
- There is no `US_SURFACES` row: these are India surfaces gaining a field. Name that in the PR.

### 6. UI

None. Nothing renders USD until P3-04. Existing screens show the unchanged INR numbers.

## Cross-surface access (§6)

Lines 1–8 are all n/a: this is schema and read-path only. The fields feed Holdings (P3-04), Sage portfolio context (P3-06) and `/v1/holdings` (line 6: the fields are added and contract-tested).

## Tests

- `packages/database/__tests__/schema-money-1636.test.ts`: an `isSet:false` arm per new field. Written FIRST.
- `packages/services/__tests__/portfolio-fx-logic.test.ts`:
  - `effectiveCurrency` truth table, including IBKR absent → `null`;
  - `pnlSplit`: local + fx === total to 1e-9 on 20 random finite cases, a negative-FX case, and a missing s0/s1 → `unavailable`;
  - `convertTotals`: a null `fxAtTrade` lot is excluded and counted, never spot-converted.
  - **Mutation:** swap spot/RBI in `convertTotals` and watch the Decision-02 test fail.
- `packages/services/__tests__/holdings-logic-money-row-shape.test.ts`: a USD row with the default exchange or brokerage throws.
- `packages/services/__tests__/holdings-service-currency.test.ts`: a mixed fixture returns currency on every row plus totals; an India-only fixture's numbers are equal to the golden.
- `scripts/__tests__/` or `packages/core/__tests__/ops/`: the backfill planner is pure (it builds the `$runCommandRaw` payloads), IBKR rows are skipped and the report is correct.
- `apps/api/__tests__/routes/holdings-currency.test.ts` and `dashboard-currency.test.ts`: contract.
- `apps/web/__tests__/actions/add-manual-holding.test.ts`: the action is thin, and the service writes `currency:"INR"`, `rail:"DIRECT"`.
- Update `TEST-COVERAGE.md`.

## Acceptance

- [ ] Every new field has an isSet arm test.
- [ ] Every writer in the list above sets `currency` + `rail`, with a functional test per writer family.
- [ ] Backfill dry-run counts from QA are in the PR, labelled QA; the prod dry-run and `--apply` are listed under "Founder, after merge".
- [ ] Totals convert at read time with the rate date, and `fxAtTrade` null is counted, never spot-filled.
- [ ] India outputs are unchanged (goldens).
- [ ] MONEY-217's production consequence is stated in the PR body.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- Push the schema: `setup-infra.sh qa --only db`, then `setup-infra.sh prod --only db`.
- Run `scripts/data/backfill-broker-currency.ts --dry-run` against prod and compare with the QA counts in the PR.
- Run it with `--apply` (TTY) on QA, then on prod, and confirm `absent after` is only the reported IBKR `SMART`/`UNKNOWN` rows.

## Out of scope / hand-offs

- `BrokerActivity`, `BrokerCashBalance`, `BrokerRawPosition`, `SnapTradeUser` and `SnapTradeAuthorization` belong to P3-02 (P18 §1b–1h).
- USD rendering is P3-04.
- FIFO keyed on currency is P3-04.
- The MONEY-217 RBI fetcher is not in this program.
