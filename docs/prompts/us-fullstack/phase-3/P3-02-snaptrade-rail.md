# P3-02 · SnapTrade rail: execute P18 end to end, with the US-program deltas

Ticket: MONEY-1637 (8) = SnapTrade P18 · Branch: `feat/MONEY-1637` · Flag(s): P18's own flags, `snaptrade-brokers` (master, PostHog payload `{ slugs: string[] }`), `snaptrade-zerodha`, `snaptrade-upstox`, `snaptrade-crypto`, all default OFF and ALREADY declared by P0-02 in `BROKER_FLAGS` (`@usemoney/core/flags/us-flags`, the MONEY-1622 registry); this prompt reads them and declares nothing · Screens: none (the picker UI is P3-03) · Depends on: P0-01 (MONEY-1632 contract), P0-02 (MONEY-1622 flag registry), P0-08 (MONEY-1576 `convertUsd`), **P3-01 (MONEY-1636) merged** · Parallel-safe with: — (P3-03 and P3-04 depend on it, P3-01 is its dependency, and P3-05 also edits `schema.prisma`)

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Broker tokens + money: `/code-review ultra`.**

## Goal

**Execute `docs/prompts/us-fullstack/snaptrade-prompts-P18-P33.md` §P18 (lines 34-97) end to end**, including:

- the run protocol and house rules (`:5-30`);
- the spec in `docs/reference/snaptrade-multi-broker-plan-sep2026.md` (§2.4 endpoints, §2.5 polling, §4 architecture).

Apply the deltas below. Where this prompt and P18 differ, **this prompt wins**. Every delta is listed, so nothing is resolved silently.

The ticket text describes "ONE adapter behind the existing `adapters/` interface". P18's design is a `SnapTradeAdapter` implementing a separate `ReadPort`, which the factory dispatches on `BROKER_CONFIGS[broker].rail` (P18 §2e, plan §4.1). That design is the implementation of the ticket. Follow P18.

## Why / measured state today (verified)

- No SnapTrade code exists: `grep -ri snaptrade` over `packages`, `apps` and `workers` source returns nothing.
- `docs/reference/snaptrade-multi-broker-plan-sep2026.md` is in the repo. `docs/reference/snaptrade-rail.md` does not exist yet; P18 §0 creates it.
- `SYNC_ENABLED_BROKERS = ["ZERODHA","ZERODHA_CONNECT"]` (`packages/services/src/broker-sync.service.ts:149`). It is pinned BY VALUE in `packages/services/__tests__/broker-sync.test.ts:175-185`, following the founder decision of 2026-09-11 (MONEY-1379).
- The broker core is `packages/core/src/brokers/{base-adapter,factory,config}.ts`, plus `adapters/*`. The IBKR direct adapter (`adapters/interactive-brokers.ts`) is a working OAuth adapter and is not surfaced. MONEY-1637 calls it "a stub"; it is not.
- `BrokerType` (`schema.prisma:3330`) has 11 values, none of them SnapTrade.
- Helpers P18 names, all verified:
  - `packages/core/src/brokers/oauth-state.ts` (`generateOAuthState` :86, `verifyOAuthState` :144, 10-min TTL :58);
  - `apps/web/lib/brokers/{connect-gate,failure-log}.ts`;
  - `packages/core/src/market-data/tiingo/tiingo-pacer.ts`;
  - `workers/src/lib/pubsub-dedupe.ts`;
  - `workers/scripts/setup-pubsub.sh`;
  - `packages/services/src/account-deletion.service.ts`.
- **Path correction:** P18 says `workers/scripts/setup-scheduler.sh`. The real file is **`scripts/ops/setup-scheduler.sh`**.
- **Entitlement:** `requireFeature` lives in `apps/web/lib/actions/premium-gate.ts:66`, with a second copy at `apps/api/src/lib/premium-gate.ts`. A shared service cannot import `apps/web`. The paid-plan check inside the shared connect service must therefore use `packages/services` entitlements (subscription/plan helpers), injected as a dependency.
- `apps/api/src/routes/v1/brokers.ts` has `GET /:id` (`:147`), `PATCH /:id`, `DELETE /:id` and more. **Register `/snaptrade/*` BEFORE `/:id`**, or `GET /snaptrade/catalogue` is captured as `id = "snaptrade"`.

## Deltas to P18 (binding)

1. **Skip P18 §1e: MONEY-1636 (P3-01) shipped it.**
   - `currency`, `rail`, `externalInstrumentId`, `figi`, `brokerPrice`, `brokerValue` and `priceAsOf` already exist on the five models, and so do `Trade.provisional` and `Trade.activityId`.
   - `BrokerRail` also exists already.
   - Do not re-add any of them. Do not rewrite `backfill-broker-currency.ts`.
   - Reuse `effectiveCurrency` and `assertMoneyRowShape` from P3-01.

2. **FX (P18 §7a) is SUPERSEDED.**
   - P18's "convert at read via `FxRate` for the display date, latest-earlier fallback labelled" is replaced by Decisions #02 + MONEY-1576: `convertUsd({ amount, kind: "VALUE" | "COST", date })`.
     - VALUE uses spot.
     - COST uses the RBI reference of the trade date.
     - A missing rate is a flagged absence, never a fallback number.
   - `BrokerActivity.fxRate` (P18 §1f) is **informational**, the broker's own rate. It is never used as cost basis.
   - Derived trades take `Trade.fxAtTrade` from `convertUsd`'s COST arm (P3-01's decision), or leave it null and flagged.
   - P18 §7a's "add GBPINR/EURINR/… pairs when an account reports them" still applies, and still means measure before adding.

3. **Service contract.** P18 §3c's `packages/services/src/snaptrade-connect.service.ts` is the ONE implementation called by both the web action (`apps/web/lib/actions/snaptrade-connection.ts`) and `/v1/brokers/snaptrade/*`. That satisfies MONEY-1632.
   - The gate order P18 §3a puts in the ACTION moves into the service: flag → paid plan / allowlist → cap of 5 → `ensureSnapTradeUser` → state → login.
   - The action and route stay thin: auth → DB user → schema → service. The zod schemas live in `snaptrade-connect-logic.ts`, and both callers import them.
   - The callback route `apps/web/app/api/brokers/snaptrade/callback/route.ts` and `POST /v1/brokers/snaptrade/complete` call the same `completeSnapTradeConnection(userId, { connectionId, state? })`.

4. **Route family exception.** The broker routes stay at P18's `/v1/brokers/snaptrade/*`, not `/v1/us/*`, because the rail is not US-only (P28 Zerodha and P29 Upstox run through it). `/v1/brokers` already exists, so the `V1_ENDPOINTS` pin stays at 39 (no new family).
   - **Registry choice:** add a sibling `BROKER_SURFACES` in `packages/services/src/brokers/registry.ts`, with EXACTLY P0-01's row shape and field names (`UsSurface`, with `flag` typed as `BrokerFlagKey | UsFlagKey`, because P3-03's US rows use `us-broker-connect`). It is sibling rather than shared because its flags are `snaptrade-*`, not `us-*`. Every row carries `familyException`, which P0-01 rule 1 already accepts for `/v1/brokers/snaptrade/*`.
   - Extend MONEY-1632's `us-surface-parity.test.ts` to iterate BOTH registries with the SAME assertions (P0-01 rules 1–8), not a subset.
   - Rows. All four share `serviceFile:"packages/services/src/snaptrade-connect.service.ts"`, `actionFile:"apps/web/lib/actions/snaptrade-connection.ts"`, `routeFile:"apps/api/src/routes/v1/brokers.ts"` (or a `brokers/snaptrade.ts` it mounts), `familyException:"the rail also serves Indian brokers (P28/P29); /v1/brokers is the existing family"`, and `usAccess:"none"` (US access is enforced per broker inside `isBrokerOfferable`, delta 5):

     | `surface`              | `flag`              | `serviceExport`                    | `routePath`                       |
     | ---------------------- | ------------------- | ---------------------------------- | --------------------------------- |
     | `snaptrade-connect`    | `snaptrade-brokers` | `startSnapTradeConnect`            | `/v1/brokers/snaptrade/connect`   |
     | `snaptrade-complete`   | `snaptrade-brokers` | `completeSnapTradeConnection`      | `/v1/brokers/snaptrade/complete`  |
     | `snaptrade-catalogue`  | `snaptrade-brokers` | `listSnapTradeCatalogue`           | `/v1/brokers/snaptrade/catalogue` |
     | `snaptrade-disconnect` | `snaptrade-brokers` | `disconnectSnapTradeAuthorization` | `/v1/brokers/:id`                 |

     Add `"./snaptrade-connect.service"` (and `-logic`) to `packages/services/package.json` `exports`: P0-01 rule 3 derives the specifier from `serviceFile`.

5. **Flags.**
   - `snaptrade-brokers`, `snaptrade-zerodha`, `snaptrade-upstox` and `snaptrade-crypto` are ALREADY declared by P0-02 in `BROKER_FLAGS`, beside `US_FLAGS` in the same registry (`@usemoney/core/flags/us-flags`). Read them from there through `BROKER_FLAG_DEFAULTS` and the registry's evaluator. Do not re-declare them, and do NOT add them to `APP_FEATURE_FLAG_KEYS` as P18 §6a says; the shared context §3 forbids a fifth copy. If `BROKER_FLAGS` is missing on `origin/main`, STOP and report: P0-02 is not merged as written.
   - The `snaptrade-brokers` payload `{ slugs }` is read through the registry's payload API. If P0-02 did not build one, add it there (next to `BROKER_FLAGS`), not in `feature-flags.ts`.
   - `isBrokerOfferable({ broker, flags, payload, catalogue, region })` (P18 §6a) gains:
     - a per-config `alsoRequires: string[]` (P26 uses `us-broker-ib`);
     - a rule that **US-region brokers also require `us-broker-connect` and US access**.
     - Indian SnapTrade alternates (P28/P29) do NOT require `us-broker-connect`.
   - Test every gate, including "master on, slug missing ⇒ false".

6. **Refusal shape.** P18's route tests expect "403 flag off". Under the shared context §2.6/§3 a flag-off route **refuses as absence**, i.e. the same 404 the route gives an unknown path. The paid-plan refusal stays `403 { code: "PLAN_REQUIRED", plan }`, because the upgrade needs the plan line; P3-03 renders it as GateInline. It is reachable only when the flag and access are on, so it confirms nothing to an outsider. Test both.

7. **`SYNC_ENABLED_BROKERS` — an explicit decision, surfaced to the founder.**
   - Recommended: widen by exactly `"SNAPTRADE_SANDBOX"` (P18 §4a). Edit the by-value pin in `broker-sync.test.ts` in the same commit, with a comment citing MONEY-1637.
   - This **amends the MONEY-1379 founder decision (Zerodha-only)**. The PR body must state it under a "Founder decision required" heading.
   - The sandbox broker is offerable only to the `snaptrade-brokers` cohort with slug `SANDBOX`, so the scheduled fan-out gains rows only for them.
   - Each P19+ broker prompt appends its own value.
   - If the founder declines, ship with the list unchanged and SnapTrade syncing only through webhooks and foreground pulls. Say so in the PR.

8. **UI split.**
   - P18 §6b (picker cards in `apps/web/app/brokers/client.tsx`) moves to **P3-03**, whose mobile-first S3.1 supersedes it.
   - P18 §7b (holdings table native/converted) moves to **P3-04**.
   - This PR ships the actions, routes and catalogue only. P18's acceptance (the founder connects SANDBOX on QA) is performed after P3-03 merges.
   - Until then, prove the flow with the route tests and one scripted run of `startSnapTradeConnect` → the portal URL on QA.

9. **Founder-only step 0a.**
   - Creating the SnapTrade commercial account, 2FA and the TEST keys is a founder action. A cloud session cannot do it.
   - If `SNAPTRADE_CLIENT_ID` / `SNAPTRADE_CONSUMER_KEY` are not in the session env, do §0b (pin the SDK with `npm view snaptrade-typescript-sdk version`) and build the client against the SDK's types.
   - Hand-build the §0c fixtures from SnapTrade's reference schemas, with a `README` stating `source: synthetic-from-docs, <date>`, and list "replace with a real sandbox capture" under **Engine-gated** in the PR.
   - Do not fake a sandbox run.

10. **Crypto (P30–P33) and the per-broker prompts (P19–P27) are OUT of this ticket.**
    - Run P19–P27 later, one per broker, straight from the pack, after P3-03 merges.
    - Crypto is a follow-on; `docs/reference/crypto-venues-live-data-and-multi-asset-sep2026.md` is in the repo for it.

## Read first (verified paths)

- `docs/prompts/us-fullstack/snaptrade-prompts-P18-P33.md` (the run protocol `:5-30`, P18 `:34-97`)
- `docs/reference/snaptrade-multi-broker-plan-sep2026.md` (§2.4, §2.5, §4.1–4.9)
- Everything under "Why" above
- P3-01's `effectiveCurrency`, `assertMoneyRowShape` and `portfolio-fx-logic.ts`; P0-08's `convertUsd`; MONEY-1632's registry + parity test; MONEY-1622's flag registry

## Build, in this order

Follow P18's numbered steps with the deltas applied:

- §0: docs commit (the `snaptrade-rail.md` skeleton with every founder-only field marked TODO(founder)) + SDK pin + fixtures, per delta 9.
- §1 a–d, f–h, skipping e (delta 1). Write the isSet arm tests first.
- §2: rail core.
- §3: connect, following deltas 3 and 6.
- §4: sync, following delta 7 and the scheduler-path correction.
- §5: webhooks.
- §6 a, c, d, following delta 5; §6b goes to P3-03.
- §7 a and c, following delta 2; §7b goes to P3-04.
- §8: tests.

### Contract summary (the headings every prompt carries)

**1. Service**

- `packages/services/src/snaptrade-connect.service.ts`: `startSnapTradeConnect`, `completeSnapTradeConnection`, `listSnapTradeCatalogue`, `disconnectSnapTradeAuthorization`.
- `snaptrade-user.service.ts`, `snaptrade-catalogue.service.ts`.
- The sync branch lives in `broker-sync.service.ts`.

**2. Server action:** `apps/web/lib/actions/snaptrade-connection.ts`, thin.

**3. `/v1` + registry:**

- `POST /v1/brokers/snaptrade/connect`, `POST /v1/brokers/snaptrade/complete` and `GET /v1/brokers/snaptrade/catalogue`, all registered before `/:id`;
- `DELETE /v1/brokers/:id` extended for SnapTrade (P18 §3d);
- the `BROKER_SURFACES` rows (delta 4).

**4. UI:** none (delta 8).

## Cross-surface access (§6)

| #   | Line      | Answer                                                                                                                                |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Search    | n/a: a rail                                                                                                                           |
| 2   | Watchlist | n/a: a rail                                                                                                                           |
| 3   | Sage      | n/a here; P3-06 feeds synced holdings to Sage                                                                                         |
| 4   | Home      | n/a here; P3-06                                                                                                                       |
| 5   | Deep link | The callback returns to `/brokers?connected=…` (P3-03 renders it)                                                                     |
| 6   | API       | The `/v1/brokers/snaptrade/*` routes + `BROKER_SURFACES` rows, iterated by the parity test                                            |
| 7   | Demo      | n/a: no demo connects a broker. The demo broker list is untouched (see DS "demo contradicts itself"; do not add a fake SnapTrade row) |
| 8   | Telemetry | `snaptrade_connect_started` {slug, flag:"snaptrade-brokers"}, `snaptrade_connect_completed` {status}                                  |

## Tests

These are P18 §8's list, all of it: isSet arms, mapper goldens, budget-logic tables, contentHash id-change, provisional↔authoritative swap, webhook HMAC valid/invalid/missing-env + dedupe + idempotency, connect gates fail-closed, callback SUCCESS/ERROR/ABANDONED + IDOR, disconnect atomicity, cleanup, and api mirrors. Plus the deltas:

- `packages/services/__tests__/snaptrade-offerable.test.ts`: `us-broker-connect` is required for US-region brokers only, and `alsoRequires` is honoured.
- `packages/services/__tests__/snaptrade-fx.test.ts`: a derived trade takes `fxAtTrade` from `convertUsd` COST, never from `BrokerActivity.fxRate`. A missing RBI rate gives null plus a flag.
  - **Mutation:** feed `activity.fxRate` into `fxAtTrade` and watch the test fail.
- `apps/api/__tests__/routes/snaptrade-routes.test.ts`:
  - flag-off → 404 identical to an unknown path;
  - free plan → 403 `PLAN_REQUIRED`;
  - `GET /snaptrade/catalogue` is not captured by `/:id`;
  - IDOR on `complete` with a foreign `connection_id`.
- The parity test iterates `BROKER_SURFACES`.
- `broker-sync.test.ts`: the pinned list is edited deliberately (delta 7).
- A source scan: no import of `Candle` / quote-cache writers under `packages/core/src/brokers/snaptrade/` (P18 §7c).

## Acceptance

- [ ] P18's ACCEPTANCE (`snaptrade-prompts-P18-P33.md:96`), except the steps that need the P3-03 UI or the founder's keys. Those are listed under "Engine-gated / founder steps" in the PR.
- [ ] No duplicate of P3-01's fields or backfill.
- [ ] One conversion rule (`convertUsd`), and no `FxRate` display-date conversion anywhere in the rail.
- [ ] `BROKER_SURFACES` is covered by the parity test.
- [ ] The `SYNC_ENABLED_BROKERS` decision is stated for the founder.
- [ ] PR lists the new collections as user data (not in `REFERENCE_COLLECTIONS`), states "no market data stored from SnapTrade", and maps the launch-review checklist to code.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8). The session edits scripts, schema and specs, runs `prisma generate`, and runs nothing against prod.

- Push the new models (`SnapTradeUser`, `SnapTradeAuthorization`, `BrokerActivity`, …): `setup-infra.sh qa --only db`, then `setup-infra.sh prod --only db`.
- Provision the new topic and the SnapTrade scheduler lanes: `workers/scripts/setup-pubsub.sh qa|prod`, `scripts/ops/setup-scheduler.sh qa|prod`.
- Store `SNAPTRADE_CLIENT_ID` / `SNAPTRADE_CONSUMER_KEY` in Secret Manager (P18 §0a) and register the webhook URL in the SnapTrade dashboard.
- Decide the `SYNC_ENABLED_BROKERS` widening (delta 7).
- After P3-03 merges: P18's ACCEPTANCE on QA with the test key.

## Out of scope / hand-offs

- The picker UI (P18 §6b) is P3-03.
- The holdings rendering (P18 §7b) is P3-04.
- The per-broker P19–P29 prompts run after P3-03, one PR each.
- Crypto P30–P33 is a follow-on.
- Trading (Appendix C) is reserved and not built.
