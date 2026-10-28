# P2-01 · StockSage US arm: tools, market-aware resolution, gate before spend

Ticket: MONEY-1583 (16) + MONEY-1585 (2) · Branch: `feat/MONEY-1583` · Flag(s): `us-stock-research` (read, not declared) · Screens: none (backend; the CTA copy is P2-02) · Depends on: P0-01 (MONEY-1632 contract + `US_SURFACES`), P0-02 (MONEY-1622 flag registry), P0-03 (MONEY-1562 `resolveUsLayer()`), P0-08 (MONEY-1576 `convertUsd`), P1-01 (MONEY-1566 `us_screener_row`; the Phase 1 data) · Parallel-safe with: P2-03

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Money path: `/code-review ultra`** (credits and the licence gate).

## Goal

1. A US symbol can be researched end to end: it resolves to ONE `listingId`, the plan is marked `market: "US"`, the planner reaches the US tools, and the report cites EDGAR filings with their filing dates.
2. When the run is not allowed, it is refused BEFORE any credit moves:
   - **Licence gate off** (`resolveUsLayer().access === false`): the refusal is ABSENCE. It returns exactly the same answer as an unknown symbol.
   - **Licence on, `us-stock-research` off**: the refusal is `US_RESEARCH_OFF`. P2-02 renders it as "Research · India only today".
3. The web server action and `POST /v1/research` both run ONE start function.

## Why / measured state today (verified 2026-09-24 on `main` @ f109647)

**The US tools**

- The ticket says there are "no US tools". That is stale. Four EDGAR tools already exist and are registered, from MONEY-979:
  - `fetch_us_financials`, `fetch_us_insider_trades`, `fetch_us_13f_holders`, `fetch_us_filings`;
  - they are registered at `packages/research/src/tools/registry.ts:195-198` and `:391-394`;
  - they read the DB only.
- They are deliberately kept OUT of the skill map (`packages/research/src/skills/skill-tool-map.ts:107-130`), for two reasons: rupee renderers (fixed by P2-03) and the `tools + 2` task floor.
- Of the ticket's six tools, only two are new: **`us-eod-prices`** and **`us-fx-spot`**. Keep the repo's naming, so they are `fetch_us_eod_prices` and `fetch_us_fx_spot`, and map the ticket's names in the PR body.

**Market pinning to India** (all three sites are pinned to IN, each with a comment explaining why):

- `packages/research/src/agent.ts:319`: `resolveInstrument({ symbol, market: "IN" })`. The failure message at `:496` ("not listed on NSE or BSE") fires AFTER planning.
- `apps/web/app/api/chat/route.ts:186`: `resolveStockSymbol` is pinned to IN.
- `packages/research/src/data-sources/symbol-resolver.ts`: sync only, and defaults to `.NS`. Its header forbids a market-less DB resolver and says to use `resolveInstrument` with an explicit market.

**Two implementations of "start research"** (the anti-example in 00-shared-context §2):

- `apps/web/lib/actions/research.ts:156` `startResearchAction`:
  - resolves symbols with its own `prisma.instrumentMapping` queries (`:284`, NSE-only name fallback at `:309`);
  - charges with `consumeCredits` at `:436`;
  - refunds at `:572`.
- `packages/services/src/research.service.ts:613` `startResearchJob` is what `apps/api/src/routes/v1/research.ts:68` calls.
- The web action never calls it.
- Its zod schema is local to the route (`research.ts:34`). There is no shared schema.

**Other facts**

- The worker cannot evaluate PostHog flags (see the `agent.ts:326-331` comment), so the gate has to run on the caller side, inside the shared function.
- `ResearchJobMessage` (`packages/types/src/pubsub.ts:787`) has no `market` field.
- `UsFilingInsight` (`schema.prisma:7802`) is written and has no reader in `packages/research`, `packages/services` or `apps/web/lib`. The 10-Q deltas eval (P2-05) needs it.
- History must be read through `CandleRepository.getCandles` (`packages/core/src/market-data/candles/candle-repository.ts:393/449`), never `prisma.candle`.

## Read first (verified paths)

- `packages/research/src/agent.ts` (lines 280-500), `planner.ts`, `prompts.ts` (`SEBI_COMPLIANCE_RULES` :28), `tools/registry.ts`, `skills/skill-tool-map.ts`, `tools/fetch-us-*.ts`, `data-sources/symbol-resolver.ts`
- `packages/core/src/market-data/instruments/resolve-instrument.ts` (`market`, `exchange`, `UsReadArgs` :103), `packages/core/src/market-data/databento/databento-symbology.ts:346` `latestOccupantOf`
- `packages/core/src/market-data/candles/{candle-repository,index}.ts`, `packages/core/src/us-fundamentals/`
- `packages/services/src/research.service.ts` (:566-700), `apps/web/lib/actions/research.ts`, `apps/api/src/routes/v1/research.ts`, `apps/api/__tests__/routes/parity-p2b-contract.test.ts`
- `apps/web/app/api/research/preview-plan/route.ts` (schema :52, POST :230), `apps/web/hooks/useResearchPlanPreview.ts`
- `packages/core/src/market-data/us-market-access.ts`, `apps/api/src/lib/us-access.ts:83` `mayServeUsMarket`. After P0-03, also `resolveUsLayer()`.
- `packages/types/src/pubsub.ts:787` `ResearchJobMessage`
- `packages/core/src/subscription/plans.ts` (`l2_research_fast: 1`, `l2_research_advanced: 3`)

**Stop and report** if any of these is missing on `origin/main`: `packages/services/src/us/registry.ts` (`US_SURFACES`), `resolveUsLayer`, the MONEY-1622 flag registry, `convertUsd`.

## Build, in this order

### 1. Service

**a. Shared schema.** Move `StartResearchSchema` out of `apps/api/src/routes/v1/research.ts:34` and into `packages/services/src/research-logic.ts`:

- Add `market: z.enum(["IN","US"]).optional()`.
- Add `listingIds: z.array(z.string()).max(20).optional()`.

Both callers import it. Delete the route-local copy.

**b. Market resolution (pure).** Write `resolveResearchMarket(symbols, hint)` in `packages/services/src/research-logic.ts`:

- An explicit `market` wins.
- Otherwise each symbol resolves through `resolveInstrument` with the stated market.
- Mixed IN+US in one run is refused with `MIXED_MARKET_RUN`. That is phase-1 scope; say so in the PR.
- A US symbol resolves to ONE listing via the current occupant, so `DOW` is Dow Inc. and never Dow Chemical.
- A symbol whose only listing is `DELISTED` returns `NOT_FOUND`. It is never researched.

**c. `startResearchJob(userId, input, deps)` gains `deps.usGate: { access: boolean; researchFlag: boolean }`.** The caller supplies it from `resolveUsLayer()` and the flag registry. The order is fixed:

```
resolve market ─► US and !access        ─► return NOT_FOUND  (same shape as an unknown symbol)
               ─► US and !researchFlag  ─► return US_RESEARCH_OFF
               ─► only then consumeCredits ─► session ─► publish(market, listingIds)
```

Rules for the gate:

- A missing `usGate` means CLOSED for US. The gate never fails open.
- `ResearchJobMessage` gains `market?: "IN"|"US"` and `listingIds?: string[]`.

**d. Converge the web action.** `startResearchAction` becomes thin:

- authenticate, then call `startResearchJob`;
- keep its extras (pinned docs, run-parameters, MF routing) by widening `StartResearchInput`. Do not keep a second credit flow.
- If carrying every extra exceeds about 200 moved lines, stop at the gate plus the market fields, file a ticket for the rest, and name that ticket in the PR. This is 00-shared-context §2's rule for anti-example surfaces.

**e. Preview.** Extract the core of `preview-plan/route.ts` into `previewResearchPlan(userId, input)` in `research.service.ts`. It accepts `market`. For US it returns:

```
market, listingId, exchange,
sources: [ EDGAR 10-K/10-Q/8-K/Forms 4/13F,
           "Third-party EOD tape · previous close",
           your lots (RBI ref cost basis) ],
excludedSources: [ screener.in, NSE announcements, XBRL archive ],
estimate
```

- The source list is a pure function, `usResearchSources(plan)`, in `research-logic.ts`.
- The preview applies the same gate and has the same absence rule as the start.

### 2. Research package (worker side)

- **`agent.ts`.** When `message.market === "US"`, resolve with `resolveInstrument({ symbol, market: "US" })` and pin `listingIds` onto the tasks. Otherwise keep the `market: "IN"` path byte-for-byte.
  - Defence in depth: a US symbol arriving WITHOUT `market: "US"` fails with the absence message and no tool runs. Credit was already refunded or never taken upstream; assert this in a test.
- **New `tools/fetch-us-eod-prices.ts`.**
  - Reads only through `CandleRepository.getCandles({ market: "US", timeframe: "D1", ... })`, keyed by listing.
  - Returns USD bars with `currency: "USD"` and an `asOf` (previous close; there are no live prices, per Decision 01).
  - `fetch_us_eod_prices` must never import `@usemoney/database` directly. Pin that with a test that greps for `prisma.candle`.
- **New `tools/fetch-us-fx-spot.ts`.**
  - Returns `convertUsd({ amount: 1, kind: "VALUE", date })`, i.e. spot and never RBI.
  - A missing rate returns the flagged absence. It never returns a number.
- **New `tools/fetch-us-filing-insights.ts`.** Reads `UsFilingInsight` by `cik10`/`symbol`, newest `filedAt` first, and returns `filedAt` + `form` on every row. This is its first reader.
- **`planner.ts` / `skills/skill-tool-map.ts`.**
  - When `market === "US"`, the plan draws from a US tool set: the six tools plus the compute tools that consume `{annual}` (`input-bindings.ts`).
  - The India skills and their task floors are untouched. The skill map note (`:107`) stays true for the India skills. Add a US entry instead of adding US tools to India skills.
- **`prompts.ts`.** Make the planner and analyst prompts market-aware. Today they say "for Indian stock markets (NSE/BSE)" at `:122` and `:159`, so a US plan would be steered back to India tools.
  - A `market` param selects the IN text (unchanged) or the US text: "US-listed securities (NYSE/NASDAQ); data: SEC EDGAR filings, end-of-day prices; currency USD".
  - When the plan's market is US, the synthesizer cites `form + filedAt` for every EDGAR figure.
  - P2-04 owns the compliance and disclaimer blocks (`SEBI_COMPLIANCE_RULES` :28). Here, only pass `market` through.

### 3. `/v1` route + `US_SURFACES` row

- `POST /v1/research` already exists. Keep the family and add the fields through the shared schema.
- Add the sub-path `POST /v1/research/preview-plan` calling `previewResearchPlan`. `V1_ENDPOINTS` stays at 39 (no new family).
- Refusal mapping in BOTH callers:
  - `NOT_FOUND` → the route's existing unknown-symbol answer (the same status and body as an unknown ticker);
  - `US_RESEARCH_OFF` → 409 `{ code: "US_RESEARCH_OFF" }`. This is only reachable when access is true, so it leaks nothing.
- Two `US_SURFACES` rows, both with `familyException`, which P0-01 rule 1 already accepts for `/v1/research/*` (no parity-test change needed):

```
{ surface: "research", flag: "us-stock-research", usAccess: "required",
  serviceExport: "startResearchJob",
  serviceFile: "packages/services/src/research.service.ts",
  actionFile: "apps/web/lib/actions/research.ts",
  routeFile: "apps/api/src/routes/v1/research.ts",
  routePath: "/v1/research",
  familyException: "existing research family; US is a market field on the same job, not a new surface" }

{ surface: "research-preview", flag: "us-stock-research", usAccess: "required",
  serviceExport: "previewResearchPlan",
  serviceFile: "packages/services/src/research.service.ts",
  actionFile: "apps/web/lib/actions/research.ts",
  routeFile: "apps/api/src/routes/v1/research.ts",
  routePath: "/v1/research/preview-plan",
  familyException: "existing research family" }
```

- The registry's `actionFile` must be a `"use server"` file (P0-01 rule 3), so add `previewResearchPlanAction` to `apps/web/lib/actions/research.ts` and point `useResearchPlanPreview.ts` at it. `apps/web/app/api/research/preview-plan/route.ts` may stay as a thin caller of the same `previewResearchPlan` for existing clients; it holds no logic of its own.
- Add `"./research.service"` (and `"./research-logic"`) to `packages/services/package.json` `exports` if missing: P0-01 rule 3 derives `@usemoney/services/research.service` from `serviceFile`.

### 4. UI

None here. P2-02 renders the refusal codes and the preview. `useResearchPlanPreview.ts` must pass `market` through; it is a one-line change.

## Cross-surface access (§6)

| #   | Line      | Answer                                                                                                                  |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Search    | n/a. Backend only; P2-02 wires the @-picker.                                                                            |
| 2   | Watchlist | n/a. No list surface.                                                                                                   |
| 3   | Sage      | This IS the Sage arm; the `{market, listingIds}` contract is the entry P2-02 uses.                                      |
| 4   | Home      | n/a.                                                                                                                    |
| 5   | Deep link | n/a. The session id URL is unchanged.                                                                                   |
| 6   | API       | `/v1/research` + `/v1/research/preview-plan`, both registered as rows.                                                  |
| 7   | Demo      | The demo already refuses research (`research.ts:164`); keep that and add a test that a demo US request moves no credit. |
| 8   | Telemetry | `research_us_refused` {reason, flag:"us-stock-research"} and `research_us_started` {listingId}.                         |

## Tests

**Unit**

- `packages/services/__tests__/research-logic-market.test.ts`:
  - resolution with an explicit market;
  - bare `AAPL` → US;
  - `INFY` → IN;
  - `DOW` → the current occupant's listingId;
  - an ENE-style delisted-only symbol → `NOT_FOUND`;
  - mixed → `MIXED_MARKET_RUN`;
  - `IT` with market IN stays India.

**Functional, money** (`packages/services/__tests__/research-us-gate.test.ts`, injecting fakes through `StartResearchDeps`):

- licence off → `NOT_FOUND`, `consumeCredits` called **0** times, no session, no publish;
- licence on + flag off → `US_RESEARCH_OFF`, the same zero assertions;
- `usGate` absent → closed;
- both on → consume once, publish carries `market:"US"` + `listingIds`;
- publish failure → refund once.
- **Mutation check:** move `consumeCredits` above the gate and confirm the zero-credit tests fail. Record the result in the PR.
- The refusal body for licence-off must be byte-equal to the unknown-symbol body. Assert this with `deepEqual`.

**Route and web action**

- `apps/api/__tests__/routes/research-us.test.ts`: 404-equivalent vs unknown symbol (equal bodies), 409 for flag-off, and the schema imported from the service. Pin the import by comparing object identity.
- `apps/web/__tests__/actions/research-us-gate.test.ts`: the action calls `startResearchJob`, and there is no `prisma.instrumentMapping` left in the action.

**Research package**

- `packages/research/__tests__/fetch-us-eod-prices.test.ts`:
  - uses an injected repository;
  - asserts `currency:"USD"`;
  - a source scan finds no `prisma.candle`.
- `packages/research/__tests__/fetch-us-fx-spot.test.ts`: a missing rate returns an absence, not `0`/`NaN`.
- `packages/research/__tests__/agent-us-market.test.ts`: a US symbol without `market` does not run tools; the India path is unchanged (golden plan snapshot).

**Coverage.** Update `TEST-COVERAGE.md` and `scripts/test-case-floors.json` wherever the floors move.

## Acceptance

- [ ] A US run's preview carries `market:"US"`, the listingId, the US source list and the estimate.
- [ ] A completed QA run on AAPL cites at least one EDGAR row with `form` + `filedAt`.
- [ ] Zero credit movement on both refusals (functional tests, with the mutation check recorded).
- [ ] With the licence off, the refusal is indistinguishable from an unknown symbol.
- [ ] One start implementation. `grep -n "prisma\." apps/web/lib/actions/research.ts` shows no symbol-resolution or credit code.
- [ ] India plans are unchanged: the golden snapshot test passes and the skill-map floors are unchanged.
- [ ] No `prisma.candle` anywhere in `packages/research`.
- [ ] `VERIFY_SERIAL=1 yarn verify:push` passes, then `/code-review ultra`, then the PR (not merged).

## Out of scope / hand-offs

- The CTA copy, gate sheet and @-picker belong to P2-02.
- Currency rendering belongs to P2-03.
- The US disclaimer text belongs to P2-04.
- The eval gate belongs to P2-05.
- Mixed-market research runs are refused in phase 1. File the follow-up ticket from the session and read its id back.
- `fetch_global_fund` (Yahoo) stays as it is. It is not part of the US arm.
