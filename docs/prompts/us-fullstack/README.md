# US full-stack — build prompts (Plan 4)

Each prompt runs as one Claude Code session and produces one branch and one PR. Every prompt can be run from **cloud Claude Code**, because everything it needs is in this repo. Written 2026-09-24 against `main` @ `f109647`.

Linear project: **US Launch — NRI & LRS Portfolio Intelligence**. Lane epics:

- L = MONEY-1549, licence & gates
- U = 1550, universe
- F = 1551, funds
- X = 1553, currency
- H = 1554, history (warehouse project)
- R = 1555, StockSage
- V = 1557, surfaces
- B = 1621, brokers

## How to trigger one

Open a cloud Claude Code session on this repo and paste:

```
Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md, then execute docs/prompts/us-fullstack/<phase>/<file>.md end to end. Do not merge.
```

The session branches `{type}/MONEY-{n}` from `origin/main`, builds the change, runs `VERIFY_SERIAL=1 yarn verify:push` and `/code-review`, pushes and opens the PR. You merge. Then you turn the prompt's flag on **for yourself only** in PostHog, check it on a phone, and widen it.

**Depends on** is the union of this table and each prompt's own header line; the two agree. **Parallel-safe** means two sessions can run at the same time without touching the same files, and neither depends on the other, directly or transitively. Run parallel prompts in separate cloud sessions.

## Local or cloud: the same line works in both

Everything a prompt reads is committed:

- the design-v2 prompts (30, built from Claude Design);
- this pack;
- the SnapTrade pack and its references;
- the design bundle at `docs/design/v2-bundle/`;
- the gstack reviews.

Nothing points at `~/Developer/UseMoneyAI/archive-docs`. A local session (`claude` at the repo root) and a cloud session take the same paste line and behave the same way.

**Refreshing the design bundle is LOCAL ONLY.** The Claude Design MCP needs `/design-login`, which a cloud session cannot do. The bundle was last synced 2026-09-22 (#456) from project `68d59c1e-f5a8-4f1a-b97c-f390a6ff3fee`, and all 25 files the design-v2 prompts read are present. If the design has changed since then, run this in a LOCAL session:

```
Use the claude_design MCP (https://api.anthropic.com/v1/design/mcp, auth via /design-login) to import
https://claude.ai/design/p/68d59c1e-f5a8-4f1a-b97c-f390a6ff3fee into docs/design/v2-bundle/ (overwrite in place,
keep the folder layout). Then commit it on a docs/MONEY-<n> branch and open a PR. Do not implement anything.
```

Then merge that PR before starting the next cloud prompt that reads the changed files.

## Monitoring, from anywhere

| What                | Where                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket state        | Linear project "US Launch — NRI & LRS Portfolio Intelligence"                                                                                                                                                         |
| Open PRs per ticket | `gh pr list --search "MONEY-16"` (or the GitHub UI)                                                                                                                                                                   |
| Plan and ticks      | the "US Launch Build Plan" artifact, https://claude.ai/artifact/N3otBcTN66j2uM1E2KVFU2 (private to you until shared); a snapshot is committed as `plan.html`. Tick a row when its PR merges; ticks save for everyone. |
| Flags live          | PostHog → Feature flags → filter `us-`                                                                                                                                                                                |
| The data under it   | the "Data Platform Flight Plan" artifact                                                                                                                                                                              |

## Architecture law (founder, 2026-09-24)

- Mobile apps come later.
- The APIs are built now so those apps can use them.
- Server actions and `/v1` routes both call **one shared function** in `packages/services`.
- The Next.js app calls the server actions.

MONEY-1632 (P0-01) builds that contract and the test that enforces it, so it runs FIRST. Details are in `00-shared-context.md` §2.

## Phase 0 — India/US split and onboarding (≈ 60 pts)

| Prompt                                        | Tickets                            | Flag(s)              | Screens          | Depends on                 | Parallel-safe with |
| --------------------------------------------- | ---------------------------------- | -------------------- | ---------------- | -------------------------- | ------------------ |
| `phase-0/P0-01-service-contract.md`           | **MONEY-1632** (4)                 | —                    | —                | —                          | P0-02              |
| `phase-0/P0-02-flag-registry.md`              | **MONEY-1622** (4)                 | declares all 20 + 4  | debug page       | —                          | P0-01              |
| `phase-0/P0-03-us-layer-and-gate-audit.md`    | MONEY-1562 (4), 1561 (2)           | —                    | —                | P0-01, P0-02               | P0-08, P0-09       |
| `phase-0/P0-04-us-entitlement-and-upgrade.md` | MONEY-1624 (8), 917                | `us-upgrade`         | S0.4, S0.5       | P0-03                      | P0-05              |
| `phase-0/P0-05-onboarding-start-and-fork.md`  | MONEY-1623 (8), 1584 (8)           | `us-onboarding`      | S0.1, S0.2, S0.3 | P0-01, P0-02               | P0-04              |
| `phase-0/P0-06-market-switch.md`              | MONEY-1625 (4)                     | `us-market-switch`   | S0.6             | P0-03, P0-05 (User.market) | P0-08              |
| `phase-0/P0-07-existing-users-and-demo.md`    | MONEY-1626 (4), 919                | `us-onboarding`      | S0.7, demo       | P0-05                      | P0-06              |
| `phase-0/P0-08-fx-and-denomination.md`        | MONEY-1575 (4), 1576 (4), 1578 (2) | `us-currency-toggle` | toggle           | P0-01                      | P0-03, P0-06       |
| `phase-0/P0-09-market-aware-foundations.md`   | MONEY-899, 901, 903                | —                    | —                | —                          | all of Phase 0     |

Founder-only, with no prompt:

- **MONEY-1563**, the licence decision plus the allowlist widening, as one reviewed diff.
- **MONEY-923**, the legal memo.

## Phase 1 — screener and market (≈ 110 pts)

| Prompt                                               | Tickets                               | Flag(s)                                                        | Screens                 | Depends on                        | Parallel-safe with |
| ---------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------- | ----------------------- | --------------------------------- | ------------------ |
| `phase-1/P1-01-us-screener-projection.md`            | MONEY-1566 (2), 1568 (8)              | — (a job)                                                      | —                       | P0-01                             | P1-05              |
| `phase-1/P1-02-screener-contract-and-search-rung.md` | MONEY-1569 (4), 1570 (2), 1574 (4)    | —                                                              | —                       | P1-01                             | P1-04              |
| `phase-1/P1-03-us-in-every-picker.md`                | **MONEY-1627** (4)                    | `us-stocks-search`                                             | S1.1                    | P0-03, P1-02                      | P1-05              |
| `phase-1/P1-04-us-stock-page.md`                     | MONEY-1586 (16), H lane 1554          | `us-stocks-listing`, `us-stock-chart`, `us-stock-fundamentals` | S1.3                    | P0-03, P0-08, P0-09, P1-01        | P1-02              |
| `phase-1/P1-05-us-news-and-events.md`                | **MONEY-1629** (4)                    | `us-news`                                                      | S1.3 tab, S1.2 feed     | P0-01, P0-03                      | P1-01, P1-03       |
| `phase-1/P1-06-screener-us-pill.md`                  | MONEY-1587 (16), 983 (4)              | `us-screener`                                                  | S1.4                    | P0-06, P0-08, P1-01, P1-02, P1-04 | P1-07              |
| `phase-1/P1-07-us-markets-page.md`                   | **MONEY-1628** (8)                    | `us-market-overview`                                           | S1.2                    | P1-01, P1-04, P1-05               | P1-06              |
| `phase-1/P1-08-watchlist-and-wiring.md`              | MONEY-1589 (4), **1631** (4), 912 (4) | `us-watchlist`, `us-dashboard`                                 | S1.5, S1.6              | P0-08, P1-01, P1-03, P1-04        | P1-09              |
| `phase-1/P1-09-us-funds.md`                          | MONEY-1571 (1), 1572 (4), 1573 (1)    | `us-funds`                                                     | fund page, MF/ETF modes | P1-02, P1-04, P1-06               | P1-08              |
| `phase-1/P1-10-api-parity-sweep.md`                  | **MONEY-1630** (8)                    | —                                                              | —                       | P1-01 … P1-09                     | — (runs last)      |

## Phase 2 — StockSage (≈ 40 pts)

| Prompt                                            | Tickets                      | Flag(s)               | Screens     | Depends on                                       | Parallel-safe with |
| ------------------------------------------------- | ---------------------------- | --------------------- | ----------- | ------------------------------------------------ | ------------------ |
| `phase-2/P2-01-stocksage-us-arm.md`               | MONEY-1583 (16), 1585 (2)    | `us-stock-research`   | —           | P0-01, P0-02, P0-03, P0-08, P1-01 (Phase 1 data) | P2-03              |
| `phase-2/P2-02-sage-us-deltas-and-entrypoints.md` | MONEY-1588 (8), **1634** (4) | `us-sage-entrypoints` | S2.1, S2.3  | P1-08, P2-01, P2-03                              | P2-05              |
| `phase-2/P2-03-currency-aware-renderers.md`       | **MONEY-1633** (4)           | `us-stock-research`   | S2.2        | P0-08, P0-09                                     | P2-01              |
| `phase-2/P2-04-us-person-guardrail.md`            | MONEY-913                    | —                     | disclaimers | P0-05, P2-01                                     | P2-03              |
| `phase-2/P2-05-us-research-evals.md`              | **MONEY-1635** (4)           | gates widening        | —           | P2-01, P2-04                                     | P2-02              |

## Phase 3 — broker integration (≈ 50 pts)

| Prompt                                              | Tickets                            | Flag(s)                                 | Screens    | Depends on                 | Parallel-safe with |
| --------------------------------------------------- | ---------------------------------- | --------------------------------------- | ---------- | -------------------------- | ------------------ |
| `phase-3/P3-01-currency-on-holdings.md`             | **MONEY-1636** (4)                 | —                                       | —          | P0-08                      | — (lands first)    |
| `phase-3/P3-02-snaptrade-rail.md`                   | **MONEY-1637** (8) = SnapTrade P18 | —                                       | —          | P0-01, P0-02, P0-08, P3-01 | —                  |
| `phase-3/P3-03-us-broker-connect.md`                | **MONEY-1638** (4), 914            | `us-broker-connect`                     | S3.1       | P0-04, P0-05, P3-02        | P3-05              |
| `phase-3/P3-04-mixed-holdings.md`                   | **MONEY-1639** (8), 916            | `us-holdings`, `us-currency-toggle`     | S3.2       | P0-08, P1-04, P3-01, P3-03 | —                  |
| `phase-3/P3-05-lrs-tracker-and-statement-import.md` | MONEY-915                          | `us-lrs-tracker`, `us-statement-import` | S3.3, S3.4 | P0-05, P0-08, P3-01        | P3-03              |
| `phase-3/P3-06-portfolio-wiring.md`                 | **MONEY-1640** (4)                 | —                                       | —          | P1-08, P2-02, P2-04, P3-04 | — (runs last)      |

Founder-only: **MONEY-921**, the closed beta (20–50 LRS investors).

**How the SnapTrade pack fits in** (`snaptrade-prompts-P18-P33.md`, v1 of 12-Sep; the design-v2 README "US track" has the full reconciliation):

- **P3-02 runs its P18, with four overrides:**
  - P18 §1e (currency on Holding/Trade/…) ships first, as P3-01 / MONEY-1636, with P18's field names.
  - P18 §7a's FX is replaced by `convertUsd` (Decisions #02: spot for values, RBI reference for cost).
  - Broker routes stay at `/v1/brokers/snaptrade/*`, because the rail also serves Zerodha and Upstox. They are still thin callers of one `snaptrade-connect.service.ts`, and still registered for the parity test, each row carrying `familyException`.
  - A US broker card renders only when **all** of these pass: US access, `us-broker-connect`, `snaptrade-brokers` (declared with the other three `snaptrade-*` flags in P0-02's `BROKER_FLAGS`) with the slug in its payload, and the broker's `alsoRequires` flags. Indian alternates (P28 `snaptrade-zerodha`, P29 `snaptrade-upstox`) do not require `us-broker-connect`.
- **P19–P27 (US brokers) are follow-ons after P3-03.** Run them one broker per session, straight from the pack.
- **P28/P29 (Zerodha and Upstox via SnapTrade) are India work, outside this program.** Run them from the pack when wanted.
- **P30–P33 (crypto) are out of scope for this program.** Their licence precondition is in `docs/reference/crypto-venues-live-data-and-multi-asset-sep2026.md`.

Parked, with no native app in this program: **MONEY-1590–1593** (M20 mobile US layer). The `/v1/us/*` routes built here are exactly what M20 will consume.

## Screen catalog (mobile-first; the IDs are used in every prompt)

| ID   | Screen                                         | Route                            | Flag                                              |
| ---- | ---------------------------------------------- | -------------------------------- | ------------------------------------------------- |
| S0.1 | First run: three doors                         | `/start`                         | `us-onboarding`                                   |
| S0.2 | Market fork (India · US · Both) plus residency | `/start/market`                  | `us-onboarding`                                   |
| S0.3 | Settings → Market preferences                  | `/settings/market`               | `us-onboarding`                                   |
| S0.4 | Upgrade for US                                 | `/upgrade?market=US`             | `us-upgrade`                                      |
| S0.5 | GateInline card (inline, never a modal)        | any US surface                   | `us-upgrade`                                      |
| S0.6 | Market pill (India · US · Both)                | header, tab bar                  | `us-market-switch`                                |
| S0.7 | "Add US" card for existing users               | Home                             | `us-onboarding`                                   |
| S1.1 | Search plus command palette, US section        | overlay                          | `us-stocks-search`                                |
| S1.2 | US Markets                                     | `/markets/us`                    | `us-market-overview`                              |
| S1.3 | US stock page                                  | `/us/stock/[symbol]`             | `us-stocks-listing` (+ chart, fundamentals, news) |
| S1.4 | Screener, US pill                              | `/discover/screener?market=US`   | `us-screener`, `us-funds`                         |
| S1.5 | Mixed watchlist                                | `/watchlist`                     | `us-watchlist`                                    |
| S1.6 | Home US cards                                  | `/dashboard`                     | `us-dashboard`                                    |
| S2.1 | Sage market pill                               | `/sage`                          | `us-sage-entrypoints`                             |
| S2.2 | US research report                             | `/sage/research/[id]`            | `us-stock-research`                               |
| S2.3 | Ask-Sage sheet                                 | bottom sheet from any US surface | `us-sage-entrypoints`                             |
| S3.1 | Connect a US broker                            | `/brokers?market=US`             | `us-broker-connect`                               |
| S3.2 | Mixed holdings                                 | `/holdings`                      | `us-holdings`                                     |
| S3.3 | LRS/TCS tracker                                | `/tax/lrs`                       | `us-lrs-tracker`                                  |
| S3.4 | Statement import                               | `/brokers/import`                | `us-statement-import`                             |

Each route here is the prompt's proposal. The session verifies it against the app router before building. Where a route already exists (e.g. `/stock/[symbol]` serving US today), the prompt says whether to keep it or redirect.

## Sources in this folder

- `00-shared-context.md`: the rules every prompt inherits (read with `design-v2/00-shared-context.md`).
- `PLAN-sep2026.md`: the Plan 4 document, covering lanes, measured prod state and dependency order. It is a copy of `archive-docs/reports/us-fullstack-plan-sep2026.md`.
- `snaptrade-prompts-P18-P33.md`: the SnapTrade pack. P3-02 executes its P18. The pack references `docs/reference/snaptrade-multi-broker-plan-sep2026.md`, which is committed alongside.
