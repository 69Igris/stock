# P1-02 · US screener contract (named absence + filter registry) and the search rung

Ticket: MONEY-1569 (+ MONEY-1570, MONEY-1574) · Branch: `feat/MONEY-1569` · Flag(s): none (contracts only; P1-06 mounts them) · Screens: none · Depends on: P1-01 · Parallel-safe with: P1-04

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt.

## Goal

Three contracts that P1-03, P1-06 and P1-09 build on:

1. **The filter registry.** Every US filter declares `appliesTo` and `requires`. Modes, disabled states and exclusion accounting all derive from it (1574).
2. **The named-absence envelope.** Every US screener response is `{rows, matched, universe, excluded:{filterId → {count, reason}}, nextCursor}`, plus the `ExclusionRow` component that renders it (1569).
3. **The search rung.** US instrument search reports which rung answered (`atlas | prisma-fallback | refused`) and counts it. The module moves into `packages/services` so `apps/api` can call it (1570).

## Why / measured state today (verified)

- `apps/web/lib/market/us-instrument-search.ts` (696 lines) imports `prisma` (`:54`) and lives in apps/web. `apps/api` may never import apps/web, so `/v1/us/search` cannot reach it. It must move.
- It never throws. `reportUsSearchFailure(stage, error)` (`:403`) has `UsSearchStage = "atlas" | "fallback"` (`:381`) and logs failures, but a SUCCESSFUL answer never says which rung produced it. A mis-filtered Atlas index therefore falls through to `startsWith`/`contains` and looks healthy (the MONEY-1500 shape). QA has no Atlas Search (root CLAUDE.md, MONEY-1503), so QA only ever exercises the fallback.
- Token-field trap, already documented in the file (`:20`, `:203`): `exchange`/`assetType`/`listingStatus` are token fields, and `assetType` is verbatim (`"Mutual Fund"`), never upper-cased.
- Importers to repoint: `apps/web/app/api/market/search/route.ts:52`, `…/search/search-logic.ts`, and the tests `apps/web/__tests__/market/us-instrument-search.test.ts`, `…/api/market-search.test.ts` and `…/market/atlas-filter-operators.test.ts`.
- India's screener is scoped by EXCHANGE, not `market`, because `{market:"IN"}` matches zero on pre-existing rows (`packages/services/src/screener.service.ts:443-444`, `apps/web/lib/screener/match-score.ts:510-512`). The US path never touches those collections, and the envelope carries `market` as a request field, never a stored-column filter.
- Measure before scoping the MF mode (C-2): `us_fund_nav` distinct `permaTicker` and the p10/p50/p90 of `max(date)−min(date)` per permaTicker. Run it on QA, whose `us_fund_nav` is a nightly copy of prod's (`REFERENCE_COLLECTIONS`), and paste the numbers in the PR labelled as the QA copy; the session never queries prod (00-shared-context §8). They decide which `ret*` filters the registry marks `appliesTo: ["MF"]`.

## Read first (verified paths)

- `packages/types/src/us-screener.ts` (created by P1-01) · `packages/core/src/market-data/us-screener/projection-logic.ts` (P1-01).
- `apps/web/lib/market/us-instrument-search.ts` (whole file) · `apps/web/app/api/market/search/route.ts:100-130`.
- `packages/services/src/types.ts:9` `ServiceResult` · `packages/api-utils/src/pagination/index.ts:24` `encodeCursor`/`decodeCursor`/`paginatedCursor`.
- `packages/services/src/scans.service.ts:369` `mapFiltersToScreenFilters` (India bands; the US band table comes later, in P1-06).
- `packages/services/src/us/registry.ts` (`US_SURFACES`, built by P0-01. If absent, STOP: P0-01 is not merged).

## Build — in this order

### 1. Filter registry (1574)

`packages/core/src/market-data/us-screener/filter-registry.ts`:

```ts
export interface UsFilterDef {
  id: string; // "peTtm", "ret1Y", "chg1M", "sicDivision", …
  label: string; // UI copy, no vendor names
  kind: "range" | "enum";
  appliesTo: ReadonlyArray<"STOCK" | "ETF" | "MF">;
  requires: ReadonlyArray<keyof UsScreenerRow>; // fields P1-01 writes
  absentReason: string; // "No SEC filings on file", "No NAV history ≥ 1Y"
  unit: "usd" | "pct" | "x" | "none";
}
export const US_FILTERS: readonly UsFilterDef[];
export function filtersForMode(mode): readonly UsFilterDef[];
```

Only declare filters the row can answer. Fund reference data (expense ratio, AUM, category, issuer) is NOT declared: it does not exist (F4 / MONEY-1573). Absence of a declaration is the honest state; do not add disabled placeholders here (P1-06 decides copy).

### 2. Envelope + pure query builder (1569)

- In `packages/types/src/us-screener.ts` add `UsScreenRequest {mode, filters: Record<id, {min?,max?}|{in: string[]}>, sort?, cursor?, limit≤100}` and `UsScreenResponse {rows, matched, universe, excluded: Record<filterId,{count:number; reason:string}>, nextCursor, asOf}`.
- `packages/services/src/us/screener-logic.ts` (pure): `buildUsScreenWhere(req)` builds a Prisma where over `UsScreenerRow` ONLY. `accountExclusions(universeCounts, req)` returns `excluded` from the registry's `requires`: rows where a required field is null are counted per filter, never silently dropped. Zod `UsScreenRequestSchema` lives here, single-sourced for P1-06's action and route.
- Rule: `excluded[f].count` is the number of rows in the mode's universe whose `requires` fields are null. It is computed with ONE `count` per active filter over `{[field]: null}` on a field P1-01 writes on EVERY row (null written explicitly, so the predicate is safe; assert this in the test).

### 3. `ExclusionRow` component (1569)

`apps/web/components/screener/us/ExclusionRow.tsx` takes `{excluded, universe}` and renders, under the results, e.g. "3,121 stocks not screened on P/E · No SEC filings on file". It shows one line per filter with a non-zero count, then `.pf-*` tokens, 14px min, and no tooltip. It renders nothing when all counts are 0.

### 4. Search module move + rung (1570)

- `git mv` `apps/web/lib/market/us-instrument-search.ts` to `packages/services/src/us/search.service.ts`. Export the subpath `"./us/search"` in `packages/services/package.json` (import subpaths, never the root barrel: it costs 3.8s of test budget).
- Change `searchUsInstruments` to return `{rows, rung: "atlas" | "prisma-fallback"}`. The caller maps a licence/flag refusal to `"refused"`.
- Emit `metrics.increment("us_search.answer", 1, {rung})` once per request. Use `metrics` from `@usemoney/datadog/metrics`, the same transport `packages/core/src/search/atlas-gate.ts:61` uses. Failures keep `reportUsSearchFailure`, which imports `reportSearchFailure` from `@usemoney/core/search/atlas-gate` (`:702`).
- Repoint the 5 importers. `/api/market/search` keeps its behaviour byte-for-byte except the new `usRung` field in its JSON.
- No `/v1/us/search` route here. That is P1-03, which consumes this.

### 5. Registry rows

None yet: no surface ships in this PR. The parity test must stay green.

## Tests

- `packages/core/__tests__/market-data/us-filter-registry.test.ts`:
  - every `requires` key is a field P1-01's projection writes (import the projection's output type/field list: the JOIN, not the halves);
  - every filter returned by `filtersForMode(m)` declares `m` in `appliesTo`;
  - no filter id repeats;
  - no label names a vendor (Tiingo, Databento, EDGAR tools), per Decision 06.
- `packages/services/__tests__/us-screener-logic.test.ts`:
  - a fixture of 10 rows, 4 with `peTtm: null`, filter `peTtm ≤ 25`, gives `excluded.peTtm.count === 4` with reason "No SEC filings on file";
  - `buildUsScreenWhere` never references `stockRatios`/`instrumentMapping`/`latestQuote`/`mutualFundMaster`/`indexConstituent`.
- **Mutation check:** a test that stubs `accountExclusions` to return `{}` makes the render test red. State in the PR that you ran it.
- `apps/web/__tests__/components/us-exclusion-row.test.tsx`: shows a non-zero, labelled count; no `₹` glyph; renders null when empty.
- `packages/services/__tests__/us-search-rung.test.ts`:
  - Atlas throws → `rung: "prisma-fallback"`;
  - Atlas returns rows → `"atlas"`;
  - the pipeline keeps `assetType` verbatim (`"Mutual Fund"`, not upper-cased) and the three token fields use `in`, not `text`.
- Existing search tests are moved and still pass. `TEST-COVERAGE.md` updated.

## Acceptance

- [ ] `apps/web` has no file named `us-instrument-search.ts`, and `grep -rn "lib/market/us-instrument-search"` is empty.
- [ ] `/api/market/search?q=AAPL&includeUs=true` (flag on, locally against QA) answers with `usRung: "prisma-fallback"` (QA has no Atlas Search), and a test asserts `metrics.increment("us_search.answer", 1, {rung})` fires once per request.
- [ ] The NAV-depth measurement is pasted, and the registry's MF `ret*` set matches it (per the MONEY-1574 risk: if median < 1Y, MF gets 1M/3M/6M only).
- [ ] `verify:push`; `/code-review`.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- On prod, as the founder with the flag on: `/api/market/search?q=AAPL&includeUs=true` answers `usRung: "atlas"`, and the `us_search.answer` series appears in Datadog within a day.
- A week later: the Atlas rung is non-zero every day (the ticket's ask).

## Out of scope / hand-offs

The `screenUs` service, action, route and UI (P1-06). The picker UI and `/v1/us/search` (P1-03). The MF/ETF mode UI (P1-09).
