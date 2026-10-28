# P3-05 · LRS/TCS tracker (S3.3) + US statement import with per-buy lots (S3.4)

Ticket: MONEY-915 · Branch: `feat/MONEY-915` · Flag(s): `us-lrs-tracker` (S3.3), `us-statement-import` (S3.4) · Screens: S3.3, S3.4 · Depends on: P3-01 (MONEY-1636 `currency`, `fxAtTrade`), P0-05 (`User.residency`), P0-08 (`convertUsd`) · Parallel-safe with: P3-03

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Money + tax figures: `/code-review ultra`.**

## Goal

1. **Persona A.** A resident investing under LRS imports a Vested / INDmoney / IBKR / generic US statement. Every BUY is kept as its **own lot**, and a lot is never aggregated per security. This is MONEY-915's moat note: Vested's own Schedule FA has a publicly documented bug that aggregates per security. Each lot stores its acquisition date and calendar-year attribution, with cost basis frozen at the RBI reference of the trade date.
2. **The LRS/TCS tracker.** It shows remitted this FY against the $250,000 limit, the headroom, the TCS bands as EDITABLE assumptions, the TCS claimable total, and "Export for my CA".
3. **Scope.** This is the import half of `docs/prompts/design-v2/web/W08-us-connect-and-import.md` (Build §3, §4) plus `docs/prompts/design-v2/web/W11-lrs-tcs-tracker.md` entire. The flag names and route families below supersede W08/W11's `us-stocks-listing` and `/v1/tax/lrs` (shared context §2/§3).

## Why / measured state today (verified)

**Import**

- **Formats.** `BrokerFormat` (`packages/core/src/import/types.ts:6`) = zerodha, upstox, groww, angel, angelone, dhan, fyers, generic. It has no US format, and `format-detector.ts:80` `detectBrokerFormat` knows none. Money parsing in `normalizers.ts:117` assumes ₹.
- **Pipeline.**
  - `packages/services/src/trade-import.service.ts:549` `startTradeImport`, run by `workers/src/processors/import.ts`;
  - dedupe in `packages/core/src/import/hash.ts`;
  - `/v1/imports` at `apps/api/src/routes/v1/imports.ts:84`.
- **Anti-example.** The web action `apps/web/lib/actions/trade-import.ts` is 1,250+ lines with 19 direct `prisma.` calls. **Do not extend it.** The US path is a new thin action over a service.
- **Upload size.** `next.config.js:13` sets `bodySizeLimit: "16mb"`. W08's "up to 20 MB" cannot ride a server action, and no signed-URL upload (D3) exists. CSV statements are kilobytes, so **the cap is 10 MB** and PDF statements are out of scope (see below).
- **Routes.**
  - `/tradebook/import` exists (`apps/web/app/tradebook/import/{page,client}.tsx`) and has the wizard shell.
  - README S3.4's `/brokers/import` does not exist. **Build S3.4 at `/tradebook/import?market=US`**, reusing the shell. The P3-03 import card links there. Do not add `/brokers/import`.
  - README S3.3 is `/tax/lrs`, and `apps/web/app/tax/{page,client}.tsx` + `sections/*` exist. **Build `/tax/lrs` as its own route** so that it is mobile full-screen, and add one link row in `/tax`.

**LRS**

- There is no LRS or TCS concept anywhere.
- `NotificationType` (`schema.prisma:4224`) has no `LRS_HEADROOM`.
- The RBI reference comes from `packages/services/src/gst/rbi-fx.ts`, whose **`fetchFromRbi` returns null (MONEY-217)**; only `GST_FX_RATE_USD_<date>` env overrides work. **On prod today every lot's `fxAtTrade`, and so every ₹ LRS figure, is absent.** The tracker must show USD figures with the "needs FX" count, never spot-filled rupees. Say so in the PR.

## Read first (verified paths)

- W08 §3–4 and W11 (above); `docs/design/v2-bundle/v2 US Launch.dc.html` ("No API? Your statement will do." and "Your $250,000, accounted for."); DS-ST3 row "CSV / statement import (D22)" (`product-plan-and-roadmap.md:854`)
- `packages/core/src/import/{types,format-detector,column-mappings,row-parser,normalizers,hash,csv-parser,xlsx-parser}.ts`
- `packages/services/src/trade-import{,-logic}.service.ts|.ts`, `workers/src/processors/{import,import-logic}.ts`, `apps/api/src/routes/v1/imports.ts`
- `apps/web/app/tradebook/import/*`, `apps/web/app/tax/*`, `packages/services/src/{tax,tax-logic}.service.ts|.ts`, `packages/services/src/notifications.service.ts`
- P3-01's `fxAtTrade` decision, `effectiveCurrency` and `assertMoneyRowShape`

## Build, in this order

### 1. Services

**Schema** (write the isSet arms first, in `packages/database/__tests__/schema-money-915.test.ts`):

```
LrsRemittance { userId, fy String ("2026-27"), date, amountUsd Float,
  rbiRef Float?, inrValue Float?, tcsPaid Float?, purpose String,
  source "IMPORT"|"MANUAL"|"SNAPTRADE_ACTIVITY", importBatchId String?,
  tradeId String? @db.ObjectId, createdAt, updatedAt }
  @@unique([userId, tradeId])        // one remittance per lot
  @@index([userId, fy])
  @@map("lrs_remittances")

LrsAssumptions { userId @unique, fyLimitUsd Float @default(250000),
  tcsThresholdInr Float @default(1000000), tcsRatePct Float @default(20),
  updatedAt }
  @@map("lrs_assumptions")

enum NotificationType += LRS_HEADROOM
```

The `@@unique([userId, tradeId])` is on a nullable `tradeId`, and **Mongo unique indexes are not sparse.** Either make MANUAL rows carry a synthetic `tradeId`, or use a partial index created via `setup-infra`. Pick one and test it with two MANUAL rows. The session edits `schema.prisma` (and, for the partial index, the `setup-infra` definition) and runs `prisma generate`; applying either to QA or prod is a founder step ("Founder, after merge").

**`packages/services/src/us/statement-import-logic.ts` (pure):**

- **Detection.** `detectUsFormat(headers)` recognises `VESTED`, `INDMONEY`, `IBKR_ACTIVITY_CSV` and `GENERIC_US`.
  - Required fields: `trade_date, symbol, trade_type, quantity, trade_price, currency`.
  - Optional: `fx_rate`.
  - Extend `BrokerFormat` and `column-mappings.ts` with these.
- **Mapping.** `mapColumns(headers, format)` returns `[{ column, sample, readAs, confidence }]`. An un-mapped column gets an explicit "column skipped" status and is never guessed. Extra columns are kept in the row's raw payload.
- **Row issues.** `rowIssues(rows, lookups)` returns:
  - `MISSING_FX`, offering the RBI ref for that date or "Enter it";
  - `UNKNOWN_SYMBOL`, with suggestions from US instrument search, e.g. `"BRK.B "` → `BRK-B` (trim, and a dot becomes a dash);
  - `DUPLICATE`.
  - Flagged rows never block the import.
- **Lots.** `toLots(rows)` produces **one lot per BUY row**, with no aggregation, carrying `currency: "USD"`, the exchange from the resolved listing (never the `"NSE"` default), `brokerage` set explicitly (0 when absent), and `fxAtTrade` = the RBI ref or null.
  - **The file's `fx_rate` is NOT cost basis** (P3-01 decision). It is kept in the raw payload only.
- **Dedupe.** The hash includes `currency` and the listing, so re-importing the same file yields all duplicates.
- **Calendar year.** `calendarYearOf(tradeDate)` is shared with P3-04's `us-lots-logic.ts`; import it and do not re-implement it.

**`packages/services/src/us/statement-import.service.ts`:**

- `previewUsStatement(userId, { fileName, bytes })` parses, detects, maps and flags issues, and returns plain JSON: counts, mapping, issues, a sample of new lots, and the duplicate count.
- `commitUsStatement(userId, { previewId, resolutions })` creates the import batch through the EXISTING `trade-import` pipeline (`createImportRecord` → worker), with `market: "US"`. The worker writes Trades via `assertMoneyRowShape` and then calls `seedRemittances(batchId)`.

**`packages/services/src/us/lrs-logic.ts` (pure):**

- `fyOf(date)` covers April to March.
- `headroom(remittances, assumptions)` returns `{ remittedUsd, limitUsd, headroomUsd, pctUsed }`.
- `tcsBands(remittances, assumptions)`:
  - works on INR values only;
  - rows with a null `rbiRef` are **excluded and counted**;
  - applies the threshold and the rate above it.
- `claimableTcs`.
- `crosses80(prev, next)` fires exactly once per FY.

**`packages/services/src/us/lrs.service.ts`:**

- `getLrsSummary(userId, fy)`
- `addLrsRemittance(userId, input)`
- `updateLrsAssumptions(userId, input)`
- `exportLrsLedger(userId, fy)`, CSV
- `seedRemittances(batchId)`, which dedupes by `tradeId`

**Visibility selector.** One pure selector in `lrs-logic.ts`, `shouldShowLrs({ residency, flags, usAccess })`, returns `false` for NRI residency. Every entry point uses it: dashboard card, tax row, settings row, route.

### 2. Server actions

- `apps/web/lib/actions/us-statement-import.ts`: `previewUsStatementAction(formData)` (cap 10 MB, `.csv`/`.xlsx` only) and `commitUsStatementAction`.
- `apps/web/lib/actions/us-lrs.ts`: `getLrsSummaryAction(fy)`, `addLrsRemittanceAction`, `updateLrsAssumptionsAction` and `exportLrsLedgerAction`.

All of them are thin, and every flag and selector check happens before the service is called.

### 3. `/v1` routes + `US_SURFACES` rows

- `apps/api/src/routes/v1/us/statement-import.ts`: `POST /v1/us/statement-import/preview` (multipart, 10 MB) and `POST /v1/us/statement-import/commit`.
- `apps/api/src/routes/v1/us/lrs.ts`: `GET /v1/us/lrs?fy=`, `POST /v1/us/lrs/remittances`, `PATCH /v1/us/lrs/assumptions` and `GET /v1/us/lrs/export?fy=`.
- Schemas are imported from the `-logic.ts` files.
- Rows, one per service export, all `usAccess:"none"` (both flags are `licensed:false`: the user's own statements and remittances, never US market data), mounted with `usRoutes.route("/statement-import", …)` and `usRoutes.route("/lrs", …)`:

| `surface`                  | `flag`                | `serviceExport`        | `serviceFile` (under `packages/services/src/us/`) | `actionFile` (under `apps/web/lib/actions/`) | `routeFile` (under `apps/api/src/routes/v1/us/`) | `routePath`                       |
| -------------------------- | --------------------- | ---------------------- | ------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| `statement-import-preview` | `us-statement-import` | `previewUsStatement`   | `statement-import.service.ts`                     | `us-statement-import.ts`                     | `statement-import.ts`                            | `/v1/us/statement-import/preview` |
| `statement-import-commit`  | `us-statement-import` | `commitUsStatement`    | `statement-import.service.ts`                     | `us-statement-import.ts`                     | `statement-import.ts`                            | `/v1/us/statement-import/commit`  |
| `lrs-summary`              | `us-lrs-tracker`      | `getLrsSummary`        | `lrs.service.ts`                                  | `us-lrs.ts`                                  | `lrs.ts`                                         | `/v1/us/lrs`                      |
| `lrs-remittance`           | `us-lrs-tracker`      | `addLrsRemittance`     | `lrs.service.ts`                                  | `us-lrs.ts`                                  | `lrs.ts`                                         | `/v1/us/lrs/remittances`          |
| `lrs-assumptions`          | `us-lrs-tracker`      | `updateLrsAssumptions` | `lrs.service.ts`                                  | `us-lrs.ts`                                  | `lrs.ts`                                         | `/v1/us/lrs/assumptions`          |
| `lrs-export`               | `us-lrs-tracker`      | `exportLrsLedger`      | `lrs.service.ts`                                  | `us-lrs.ts`                                  | `lrs.ts`                                         | `/v1/us/lrs/export`               |

The registry stores the full repo-relative paths; the table shortens them only for width.

- An NRI user gets absence from the LRS routes, exactly like an unknown path.

### 4. UI (375 first)

**S3.4 · `/tradebook/import?market=US`.** A 3-step wizard in the existing shell.

- **Step 1, upload.** Format hints: Vested · INDmoney · IBKR CSV · Generic. The parsed card reads "vested_apr26.csv · 184 KB · 42 ROWS · READ OK".
- **Step 2, mapping.** A card list below 768px. Mapped columns show a confidence percentage, and un-mapped columns show "column skipped".
  - The "N ROWS NEED YOU" panel offers: missing FX → "Use RBI rate · ₹83.28" / "Enter it"; unknown symbol "BRK.B " → "Yes, BRK-B" / "Skip this row".
  - Copy: "Flagged rows never block the import."
- **Step 3, review and commit.** "38 NEW LOTS · 4 DUPLICATES SKIPPED".
  - Lot rows: DATE · SYMBOL · QTY · PRICE · RBI REF · COST.
  - Copy: "COST BASIS FROZEN AT RBI REFERENCE RATE OF TRADE DATE" and the button "Commit 38 lots →".
  - For LRS personas: "ALSO UPDATED — your LRS headroom".
  - Re-import copy: "Imported before? We de-duplicate against your existing lots."

**S3.3 · `/tax/lrs`.**

- The headroom band.
- The legend: "■ below ₹10L · no TCS ■ above ₹10L · TCS applies · NOT TAX ADVICE · ASSUMPTIONS EDITABLE".
- The ledger, as cards below 768px and a table at 1280px.
- TCS PAID · CLAIMABLE with the Form 26AS copy.
- "Export for my CA".
- The Assumptions card with an Edit sheet (vaul Drawer). Every figure recalculates live.
- "+ Add remittance".
- A dashboard card "LRS HEADROOM · FY 26-27" goes in the P1-08 US card slot under `us-dashboard`.
- Copy guard on every LRS surface: "Not tax advice. We track what you tell us and what your statements say; limits, bands and eligibility are yours to verify with your CA."

## Screens

### S3.3 · `/tax/lrs` (375px)

```
┌──────────────────────────────────────┐
│ ‹ Tax · LRS & TCS          FY 26-27  │
├──────────────────────────────────────┤
│ REMITTED THIS FY                     │
│ $48,200 of $250,000                  │
│ ₹40,23,708 at RBI ref, trade dates   │
│ [██████░░░░░░░░░░░░░░░░░░] 19.3%     │
│ Headroom $201,800 · resets 1 Apr     │
│ 2 rows need FX · excluded from ₹     │
├──────────────────────────────────────┤
│ LEDGER                               │
│ 18 Apr 26 · $12,400 · ₹83.10         │
│   ₹10,30,440 · TCS ₹6,088 · Vested   │
│ 02 Jun 26 · $9,800 · needs FX        │
│   — · — · INDmoney import            │
├──────────────────────────────────────┤
│ TCS PAID · CLAIMABLE    ₹6,04,742    │
│ TCS isn't a cost — claim it when you │
│ file. It shows up in Form 26AS.      │
│ [ Export for my CA ]  [ + Remittance]│
│ Not tax advice. Verify with your CA. │
└──────────────────────────────────────┘
```

At 1280px, the band and the TCS card sit side by side (8/4 columns), the ledger is a table (DATE · AMOUNT · RBI REF · ₹ VALUE · TCS · SOURCE, with a TOTAL row), and the Assumptions card is pinned right.

### S3.4 · `/tradebook/import?market=US`, step 2 (375px)

```
┌──────────────────────────────────────┐
│ ‹ Import US statement      Step 2/3  │
├──────────────────────────────────────┤
│ vested_apr26.csv · Vested · 42 rows  │
│                                      │
│ trade_date  → Trade date     99%     │
│ symbol      → Symbol         99%     │
│ quantity    → Quantity       98%     │
│ price_usd   → Price ($)      95%     │
│ fx_rate     → kept, not cost 90%     │
│ notes       → column skipped         │
├──────────────────────────────────────┤
│ 2 ROWS NEED YOU                      │
│ Row 14 · no RBI rate for 02 Jun 26   │
│ [ Use RBI rate ₹83.28 ] [ Enter it ] │
│ Row 31 · "BRK.B " not found          │
│ [ Yes, BRK-B ]       [ Skip row ]    │
│ Flagged rows never block the import. │
│                                      │
│ [ Review 38 lots → ]                 │
└──────────────────────────────────────┘
```

At 1280px it is the existing tradebook-import shell: a step rail on the left, the mapping table in the centre, and the issues panel on the right.

### States (DS-ST3 "CSV / statement import (D22)" + W11)

| State    | S3.4 import                                                                                | S3.3 LRS                                             |
| -------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| loading  | Progress + filename                                                                        | Skeleton band + 4 ledger rows                        |
| empty    | "We didn't find trades in this file · try another statement"                               | "No remittances yet · import a statement or add one" |
| error    | Format not recognised: "We don't read {broker} files yet · send it to us" + supported list | "Couldn't load · retry"                              |
| partial  | "36 of 42 rows imported · 6 skipped [see why]"; "4 already in your portfolio"              | n/a                                                  |
| DataGap  | Missing RBI ref: the row is flagged "needs FX"; never spot                                 | ₹ totals exclude needs-FX rows with a visible count  |
| gated    | Import is allowed on all tiers behind the flag (W08); no plan gate                         | No plan gate; NRI → absent (selector)                |
| flag-off | `us-statement-import` off: no US mode, `?market=US` ignored, route not-found               | `us-lrs-tracker` off: no route, card or tax row      |
| demo     | A demo preview with the Vested fixture; commit disabled                                    | A demo ledger (MONEY-919)                            |

### Users

| User    | S3.4                                       | S3.3                                                         |
| ------- | ------------------------------------------ | ------------------------------------------------------------ |
| U1      | Absent                                     | Absent                                                       |
| U2 LRS  | Available; import card first on `/brokers` | Visible                                                      |
| U2 NRI  | Available                                  | **Absent everywhere** (no card, no Tax row, no Settings row) |
| U3      | Absent until US is added                   | Absent until US is added + LRS residency                     |
| U4      | Demo                                       | Demo                                                         |
| U5      | Available (all tiers)                      | Visible if LRS                                               |
| U6 / U7 | Available                                  | Visible if LRS                                               |

## Cross-surface access (§6)

| #   | Line      | Answer                                                                                                                                                                              |
| --- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Search    | Command palette: "Import a US statement" and "LRS headroom" (LRS only)                                                                                                              |
| 2   | Watchlist | n/a: imported lots are holdings, not watch items. Holdings → watchlist suggestions are P3-06                                                                                        |
| 3   | Sage      | n/a here; P3-06 includes imported lots in portfolio context                                                                                                                         |
| 4   | Home      | The LRS headroom card (LRS only) in the P1-08 US slot                                                                                                                               |
| 5   | Deep link | `/tax/lrs?fy=2026-27` and `/tradebook/import?market=US` round-trip; not in the sitemap                                                                                              |
| 6   | API       | `/v1/us/statement-import/*` and `/v1/us/lrs*` + rows                                                                                                                                |
| 7   | Demo      | The Vested fixture preview and the demo ledger                                                                                                                                      |
| 8   | Telemetry | `us_statement_previewed` {format, rows, issues, flag:"us-statement-import"}, `us_statement_committed` {lots, dupes}, `lrs_viewed` {flag:"us-lrs-tracker"}, `lrs_assumptions_edited` |

## Tests

**Fixtures.** `packages/core/__tests__/fixtures/us-statements/{vested,indmoney,ibkr-activity,generic}.csv` are hand-built from each broker's public export format. The README must mark them synthetic. They must include the `"BRK.B "` trailing-space row and a missing-FX row.

**Import logic (`packages/services/__tests__/us/statement-import-logic.test.ts`):**

- detection per format;
- an un-mapped column gives "column skipped";
- **one lot per BUY, never aggregated** (two AAPL buys give two lots);
- `fx_rate` from the file never becomes `fxAtTrade`;
- a re-import dedupes 100 %.
- **Mutation:** aggregate by symbol and watch the per-lot test fail.

**LRS logic (`packages/services/__tests__/us/lrs-logic.test.ts`):**

- FY boundaries (31 Mar / 1 Apr);
- headroom;
- TCS bands at the threshold ±₹1;
- a needs-FX row excluded and counted;
- the 80 % crossing fires once;
- editing the threshold recomputes.
- **`shouldShowLrs`:** NRI → false.

**Services and schema:**

- `packages/services/__tests__/us/lrs-service.test.ts`: seeding from a committed batch dedupes by `tradeId`, including the unique-index-with-nulls case.
- `packages/database/__tests__/schema-money-915.test.ts`: the isSet arms.

**Routes and render:**

- `apps/api/__tests__/routes/us-lrs.test.ts` and `us-statement-import.test.ts`: flag-off / NRI → absence; a 10 MB cap; schema identity.
- `apps/web/__tests__/components/lrs-tracker.test.ts`: every money figure carries its currency; ₹ values show "RBI ref"; the NRI render is empty; the "Not tax advice" line is present.

## Acceptance

- [ ] Committing the Vested fixture writes N per-buy lots (USD, the listing's exchange, `fxAtTrade` = the env-override RBI ref), creates the matching remittance rows for FY 2026-27, and re-importing it skips every row.
- [ ] An NRI persona sees no LRS UI anywhere (render tests on dashboard, tax and settings).
- [ ] A missing RBI ref gives a flagged row excluded from ₹ totals with a visible count, never a spot-filled value.
- [ ] Export contains every ledger column. The 80 % notification fires once per FY crossing.
- [ ] The MONEY-217 production consequence is in the PR body.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- Push the new models (`LrsRemittance`, `LrsAssumptions`, the `NotificationType` value) and, if chosen, the partial index: `setup-infra.sh qa --only db`, then `setup-infra.sh prod --only db`.

## Out of scope / hand-offs

- PDF statements (Schwab PDF, W08's 20 MB), which need the D3 signed-URL upload and OCR. File a follow-up.
- The Schwab/E\*TRADE RSU formats (MONEY-915 stretch).
- The Schedule FA generator (a later report over these lots).
- SnapTrade deposit activities seeding remittances (`source: SNAPTRADE_ACTIVITY`): wire it when a SnapTrade broker with DEPOSIT activities ships (P19+). Leave the enum value in place.
- Filing / 26AS integration and NRI tax.
