# MONEY-499 (ZA-1) — Zerodha OAuth flow end-to-end audit

**Date:** 2026-05-30 · **Branch:** `feat/MONEY-499` · **Scope:** the Zerodha
Kite Connect OAuth happy path + the four required failure paths.

## Code path

| Stage                    | Location                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Init (login URL)         | `ZerodhaClient.getLoginUrl` → `getOAuthUrlAction` (`broker-connection.ts`)                                                                        |
| Redirect target          | `GET apps/web/app/api/brokers/zerodha/callback/route.ts`                                                                                          |
| Token exchange + persist | `handleOAuthCallbackAction("ZERODHA", requestToken, state)` (`broker-connection.ts:~304-628`) → `ZerodhaClient.exchangeToken` (`zerodha.ts:~355`) |
| CSRF state               | round-tripped via `?state=` (callback `route.ts:14,24`) → `verifyOAuthState` (`lib/brokers/oauth-state.ts`, MONEY-287)                            |
| Transport / errors       | `base-client.ts makeRequest` (`:62-84`)                                                                                                           |
| Failure logging          | `lib/brokers/failure-log.ts` (**new, MONEY-502** — now records the paths below)                                                                   |

## Happy path ✅

`status` ok + `request_token` present (`route.ts:10-11`) → `handleOAuthCallback
Action` verifies state, exchanges + encrypts + persists the token, auto-syncs,
redirects `?success=connected&broker=zerodha` (`route.ts:27-30`). Works.

## Failure paths

### (a) User cancels mid-flow — ✅ handled

`route.ts:17-19`: `status === "cancelled" || !requestToken` → redirect
`/brokers?error=auth_cancelled` before any action call. A failed exchange returns
a generic `?error=auth_failed` (`route.ts:31-35`); the full error stays in the
server log (`handleOAuthCallbackAction`'s structured warn/error + `mapKnownBroker
Error`). **No gap.** Now also captured by MONEY-502 at the `oauth_callback` site
when the exchange throws.

### (b) Token expires during session — ⚠️ gap → MONEY-582

A runtime concern, not a callback one. Per the sync audit, `isTokenValid` is
**defined but unused** in `base-client.ts` — an expired token is never
transitioned to `EXPIRED`/`NEEDS_REAUTH`; the user silently gets stale/empty
data. `getBrokerCredentials` returns `null` for non-active connections (so reads
fall back to Yahoo, compliant), but the connection status isn't updated to prompt
a reconnect.

- **Now:** classified `AUTH_EXPIRED` + recorded by MONEY-502
  (`recoveryAction: "reauth"`), so it's queryable.
- **Fix (ticketed → MONEY-582):** detect expiry before the delete in sync, set
  `NEEDS_REAUTH`, surface the reconnect banner.

### (c) Callback CSRF / state — ✅ enforced; ⚠️ narrow Redis-down gap → MONEY-582

The CSRF state **IS** round-tripped (`route.ts:14` reads `?state=`, `:24` passes
it to the action) and verify-and-consumed by `verifyOAuthState` (MONEY-287) — so
the happy path is protected. The remaining gap is that `verifyOAuthState`
**soft-passes when Redis is unavailable unless `OAUTH_STATE_STRICT=1`** (per the
sync audit), i.e. a Redis outage fails _open_.

- **Fix (ticketed → MONEY-582 / security):** set `OAUTH_STATE_STRICT=1` in prod
  so a Redis outage fails closed.

### (d) Rate-limit (429) during the initial holdings fetch — ⚠️ gap → MONEY-582

`base-client.ts makeRequest` has **no timeout, retry, or backoff** (per the sync
audit); a 429 during the post-connect auto-sync throws and that data type is
skipped for the run.

- **Now:** classified `RATE_LIMIT` + recorded by MONEY-502
  (`recoveryAction: "retry"`); the holdings-fetch latency is also instrumented by
  MONEY-500 (`broker_holdings_fetch`).
- **Fix (ticketed → MONEY-582):** add a timeout + bounded exponential backoff on
  429/5xx; silent Yahoo fallback for quotes.

## Summary

| Path             | Status                               | Disposition                                |
| ---------------- | ------------------------------------ | ------------------------------------------ |
| Happy            | ✅ works                             | —                                          |
| (a) cancel       | ✅ handled (`route.ts:17-19`)        | none                                       |
| (b) token expiry | ⚠️ gap                               | logged (502); fix → **MONEY-582**          |
| (c) CSRF/state   | ✅ enforced; ⚠️ Redis-down soft-pass | set `OAUTH_STATE_STRICT=1` → **MONEY-582** |
| (d) rate-limit   | ⚠️ gap                               | logged (502); fix → **MONEY-582**          |

**Shipped this branch:** every failure path is now structured-logged
(MONEY-502 `oauth_callback` + classifier) and the holdings fetch is instrumented
(MONEY-500) — so the Jun-20 failure log will carry real, grouped OAuth/sync
failures. The behavioural fixes for (b)/(d) and the (c) Redis-down hardening are
data-correctness / security work on the live broker-sync write path, tracked in
**MONEY-582** (which already lists token-expiry → NEEDS_REAUTH, the
`OAUTH_STATE_STRICT` soft-pass, and the missing timeout/retry/rate-limit as HIGH
items) — deliberately kept off this read/audit branch.
