# P3-03 · Connect a US broker (S3.1): SnapTrade link, sync, done, re-auth, connection card (+ IBKR path)

Ticket: MONEY-1638 (4) + MONEY-914 · Branch: `feat/MONEY-1638` · Screens: S3.1 · Depends on: P3-02 (MONEY-1637), P0-04 (GateInline), P0-05 (`User.market`/`residency` for persona order) · Parallel-safe with: P3-05

**Flags.** A US broker card renders only when ALL of these pass:

1. US access (`resolveUsLayer()`);
2. **`us-broker-connect`** (the US SECTION of the picker);
3. **`snaptrade-brokers`**, with the broker's slug in its payload `{ slugs }`;
4. any **`alsoRequires`** flags on the broker's config (IBKR via SnapTrade: `us-broker-ib`).

`isBrokerOfferable` from P3-02 is the one place this is decided.

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Broker tokens: `/code-review ultra`.**

## Goal

Build the connect half of `docs/prompts/design-v2/web/W08-us-connect-and-import.md` (Build §1, §2, §4, §5) on `/brokers`, mobile-first. It covers:

- a US tab/section with a brokerage grid that shows ONLY brokers P3-02's catalogue and flags make offerable;
- a consent sheet, then a full-page redirect to the SnapTrade portal, then a return deep link;
- sync progress, then a done card;
- a connection card with last sync, resync (budget-aware) and disconnect;
- a re-auth state.

The statement-import half of W08 is P3-05.

## Why / measured state today (verified)

- `apps/web/app/brokers/{page,client}.tsx` exist; `client.tsx` is 53 KB and India-only. `/brokers?market=US` is a query on the existing route. The README's route proposal is kept, and there is no new page.
- The patterns to mirror are `apps/web/components/brokers/BrokerConsentModal.tsx` and `apps/web/components/BrokerReauthBanner.tsx`.
- `apps/web/components/ui/drawer.tsx` (vaul) and `sheet.tsx` exist.
- **MONEY-914 (IBKR Flex token import, direct) vs Decisions #04 ("SnapTrade for US retail brokers, IBKR direct not a product path").**
  - The direct adapter `packages/core/src/brokers/adapters/interactive-brokers.ts` is OAuth, not Flex, and it stays unsurfaced.
  - The zero-approval Flex path exists **through SnapTrade**: P26, `INTERACTIVE_BROKERS_SNAPTRADE`, slug `INTERACTIVE-BROKERS-FLEX`, "API Key connection (Flex Query token)".
  - This ticket therefore satisfies 914 as follows. The IBKR tile appears only when P26 has run AND `us-broker-ib` is on. Otherwise the IBKR tile reads "IBKR · import a statement" and routes to P3-05's import. No direct Flex client is built.
- **MONEY-1638 says "the portal opens in a sheet on mobile".** The plan (§4.3) and SnapTrade's portal guidance require a full browser context for OAuth and passkeys.
  - The SHEET here is **our consent sheet**. Its CTA does a full-page redirect to `redirectURI`, which is valid for 5 minutes.
  - **Never iframe the portal.**
- The design sources are `docs/design/v2-bundle/v2 US Launch.dc.html` ("Bring your US accounts in", "Connect Robinhood · VIA SNAPTRADE", "Syncing your US accounts", "4 ACCOUNTS CONNECTED", "Fidelity needs re-authorising"), the DS-RESP1 desktop rule ("US connect: 2-col (choices | trust/consent)") and the DS-ST3 row "US connect (SnapTrade)".

## Read first (verified paths)

- W08 (above), connect sections only
- `apps/web/app/brokers/{page,client}.tsx`, `apps/web/components/brokers/*`, `apps/web/components/BrokerReauthBanner.tsx`
- `apps/web/lib/actions/{broker-connection,broker-status}.ts` + `-logic.ts`
- P3-02's `snaptrade-connect.service.ts`, `snaptrade-connection.ts` action, `isBrokerOfferable`, `snaptrade-budget-logic.ts`, and the catalogue route
- `docs/gstack/ceo-review-2026-09-23-product-roadmap/product-plan-and-roadmap.md` (DS-ST3 table :841+, DS-RESP1 :834, DS-UNRES1 :835)

## Build, in this order

### 1. Service

**`packages/services/src/snaptrade-connections.service.ts`:**

- **`listSnapTradeConnections(userId, { market: "US" })`** returns plain JSON per authorization:

```
{ authorizationId, broker, displayName, accounts: [{ id, name, category }],
  status: CONNECTED | NEEDS_REAUTH | SYNCING,
  lastSyncAt, disabledAt, deleteAfter,
  positions, lots, transactions,          // counts
  historyLine }                           // from historyPolicy:
                                          // "History from account opening" |
                                          // "Last 2 years" | …
```

- **`resyncSnapTradeAuthorization(userId, authorizationId)`**:
  - calls P3-02's `decideHoldingsPull({ trigger: "manual" })`;
  - a refusal returns `{ refused: true, reason, lastUpdatedAt }`, never an error;
  - IDOR: the authorization must belong to the user.
- **Disconnect** reuses P3-02's `disconnectSnapTradeAuthorization`. It returns `siblingCount` for the "this will unlink N accounts" confirm.

Put the pure pieces (status and history line) in `snaptrade-connections-logic.ts`.

### 2. Server action

`apps/web/lib/actions/snaptrade-connection.ts`, extending P3-02's file:

- `listUsBrokerConnectionsAction`
- `resyncUsBrokerAction`
- `disconnectUsBrokerAction`

Each is thin and checks all four flag conditions in the header.

### 3. `/v1` route + registry row

Per the P3-02 ruling, broker routes stay under `/v1/brokers/snaptrade/*`:

- `GET /v1/brokers/snaptrade/connections?market=US`
- `POST /v1/brokers/snaptrade/:authorizationId/resync`

Both are registered before `/:id`. Add two `BROKER_SURFACES` rows (P0-01 field names; both `flag:"us-broker-connect"`, `usAccess:"required"`, `serviceFile:"packages/services/src/snaptrade-connections.service.ts"`, `actionFile:"apps/web/lib/actions/snaptrade-connection.ts"`, `routeFile` = the file P3-02 mounts the SnapTrade routes from, `familyException:"broker rail stays in /v1/brokers (P3-02 delta 4)"`):

- `{surface:"snaptrade-connections", serviceExport:"listSnapTradeConnections", routePath:"/v1/brokers/snaptrade/connections"}`
- `{surface:"snaptrade-resync", serviceExport:"resyncSnapTradeAuthorization", routePath:"/v1/brokers/snaptrade/:authorizationId/resync"}`

Add `"./snaptrade-connections.service"` to `packages/services/package.json` `exports` if missing (P0-01 rule 3).

(MONEY-1638's `/v1/brokers/us` is superseded by this ruling.)

### 4. UI (mobile-first; 375 first, then 768 and 1280)

**US section of `/brokers`.** It renders only when `us-broker-connect` && US access pass.

- Copy: "Bring your US accounts in. Read-only, as always."
- Order by persona (P0-05 `residency`): NRI puts the Link card first; LRS puts Import first.
- The brokerage grid uses **P3-02's catalogue filtered by `isBrokerOfferable`**. No hardcoded list, and no broker the catalogue does not return. The first P3-02 build offers only `SANDBOX`, and P19+ add real brokers.
- A "More brokers" tile appears only when more than 6 are offerable.
- Read-only line: "✦ Read-only. We can't place orders — not here, not anywhere. Revoke in one tap."

**Consent sheet.** A vaul Drawer below 768px. At 1024px and above it is a 2-column page section: choices | trust/consent (DS-RESP1).

- Scopes: ✓ positions · balances, ✓ activities, ✕ trading.
- "via SnapTrade" is the ONE place the aggregator is named. The price vendor is never named.
- The CTA "Continue to {Broker} →" calls `startSnapTradeConnectAction` and then sets `window.location.assign(redirectURI)`. It never renders the URL, never logs it, and never iframes it.

**Return.** The callback redirects to `/brokers?market=US&connected={authId}`. The page shows sync progress from `listUsBrokerConnectionsAction`, polled every 5 s for at most 3 minutes, then it stops and shows "We'll finish in the background".

- Progress copy: "positions N · lots N · transactions N".
- "You can leave — we finish in the background."

**Done card.** "{N} ACCOUNTS CONNECTED · {positions} positions, in." plus a `DualCurrency` total from P3-01's `totals` (VALUE at spot, with date), tags "◷ EOD · SPOT · READ-ONLY", and "See mixed holdings →" (only when `us-holdings` is on).

**Connection card.** Shows the history line, "Last synced 14:05", a Resync button (a refused pull shows "Updated 14:05 · next refresh available later", never an error), and Disconnect (a confirm with the sibling count).

**Re-auth.** `NEEDS_REAUTH` shows: "{Broker} needs re-authorising — the broker session expired on {date}. Your other accounts synced fine." with "Re-authorise →" (P3-02 `reconnect`) and "Remind me tomorrow".

- An app-wide `BrokerReauthBanner` variant appears under "Brokers · N connected" on the Portfolio tab (OV-10).

**FREE plan (U5).** `GateInline` sits in place of the grid: "US brokers are part of PRO · $X/mo" → `/upgrade?market=US` (DS-UNRES1). Never a modal.

## Screens

### S3.1 · `/brokers?market=US` (375px)

```
┌──────────────────────────────────────┐
│ ‹ Brokers          India │[US]       │
├──────────────────────────────────────┤
│ Bring your US accounts in.           │
│ Read-only, as always.                │
│                                      │
│ LINK AN ACCOUNT                      │
│ ┌────────┐ ┌────────┐ ┌────────┐     │
│ │   RH   │ │   SW   │ │   WB   │     │
│ │Robinhd │ │ Schwab │ │ Webull │     │
│ └────────┘ └────────┘ └────────┘     │
│ ┌────────┐ ┌────────┐ ┌────────┐     │
│ │  IBKR  │ │  E*T   │ │ More › │     │
│ │ import │ │E*TRADE │ │        │     │
│ └────────┘ └────────┘ └────────┘     │
│ ✦ Read-only. We can't place orders   │
│   — not here, not anywhere.          │
│                                      │
│ NO API? YOUR STATEMENT WILL DO       │
│ Vested · INDmoney · IBKR CSV     ›   │
├──────────────────────────────────────┤
│ Home  Portfolio  Sage  Discover  You │
└──────────────────────────────────────┘
```

At 1280px it is two columns (max-w 1040). The left has the grid (4 per row) and the import card. The right has the trust panel: read-only scopes, "Revoke any time", "Your data stays yours". Connected accounts list above the grid.

### Consent sheet (375px, bottom sheet)

```
┌──────────────────────────────────────┐
│ ──────────────── ▬ ───────────────── │
│ Connect Robinhood                    │
│ via SnapTrade · read-only            │
│                                      │
│ WHAT WE CAN SEE                      │
│ ✓ Positions and balances             │
│ ✓ Activities (trades, dividends)     │
│ ✕ Trading — never                    │
│                                      │
│ WHAT HAPPENS NEXT                    │
│ 1 Sign in on Robinhood's page        │
│ 2 Pick the accounts to share         │
│ 3 We sync in the background          │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ Continue to Robinhood →          │ │
│ └──────────────────────────────────┘ │
│ Revoke any time · Settings › Market  │
└──────────────────────────────────────┘
```

### Connection card, synced and needing re-auth (375px)

```
┌──────────────────────────────────────┐
│ Robinhood · 2 accounts   ● Synced    │
│ History from account opening         │
│ 14 positions · $58,640               │
│ ≈ ₹51,67,357 · spot ₹88.12 · 23 Sep  │
│ Last synced 14:05                    │
│ [ Resync ]            [ Disconnect ] │
├──────────────────────────────────────┤
│ E*TRADE · 1 account  ▲ Re-authorise  │
│ The broker session expired 21 Sep.   │
│ Your other accounts synced fine.     │
│ [ Re-authorise → ]   Remind me later │
└──────────────────────────────────────┘
```

### States (DS-ST3 "US connect (SnapTrade)")

| State    | Behaviour                                                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loading  | Grid skeleton at final tile size; connected-list skeleton rows                                                                                            |
| empty    | No offerable brokers (catalogue empty or payload empty): only the import card, with the line "Linking is opening broker by broker." No "coming soon" list |
| error    | Portal `ERROR`: "Couldn't connect Robinhood · nothing was shared." [Try again] [Import a statement]. Catalogue error: "Couldn't load brokers · retry"     |
| partial  | "You can leave — we finish in the background"; one account `NEEDS_REAUTH` while the others sync                                                           |
| DataGap  | Spot missing: the done-card ₹ line reads "₹ view unavailable · no rate for 23 Sep"; the USD total still shows                                             |
| gated    | FREE: GateInline in place of the grid; the import card stays (import is all tiers)                                                                        |
| flag-off | `us-broker-connect` off: no US pill or section; `/brokers` is today's page; the routes answer not-found                                                   |
| demo     | A demo fixture of one connected Robinhood card (read-only, actions disabled "Sign up to connect")                                                         |

### Users

| User   | S3.1                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| U1     | Absent                                                                                        |
| U2 NRI | Link card first                                                                               |
| U2 LRS | Import card first                                                                             |
| U3     | Absent until US is added (S0.7)                                                               |
| U4     | Demo card, actions disabled                                                                   |
| U5     | GateInline on Link; Import available                                                          |
| U6     | Full; cap of 5 authorizations (P3-02) shows "You've linked 5 — disconnect one to add another" |
| U7     | Full, and the founder allowlist bypasses the plan                                             |

## Cross-surface access (§6)

| #   | Line      | Answer                                                                                                                                      |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Search    | n/a: account management isn't searchable. The command palette gets a "Connect a US broker" command under `us-broker-connect`                |
| 2   | Watchlist | n/a: accounts are not instruments. Holdings → watchlist suggestions are P3-06                                                               |
| 3   | Sage      | n/a here. The Sage Brokers tab listing US accounts is P3-06                                                                                 |
| 4   | Home      | The P1-08 US card shows "Connect a US broker" when there are 0 connections, under `us-dashboard`                                            |
| 5   | Deep link | `/brokers?market=US` round-trips; `?connected=` is one-shot; not in the sitemap                                                             |
| 6   | API       | `/v1/brokers/snaptrade/{connect,complete,catalogue,connections,:id/resync}` + `BROKER_SURFACES` rows                                        |
| 7   | Demo      | The connected-card fixture                                                                                                                  |
| 8   | Telemetry | `us_broker_grid_viewed` {offerableCount, flag:"us-broker-connect"}, `us_broker_connect_clicked` {slug}, `us_broker_resync_refused` {reason} |

## Tests

- `packages/services/__tests__/snaptrade-connections-logic.test.ts`: history line per `historyPolicy`; the status derivation.
- `packages/services/__tests__/snaptrade-connections-service.test.ts`: IDOR on resync with a foreign id; a refused budget pull returns `refused`, not an error.
- `apps/api/__tests__/routes/snaptrade-connections.test.ts`: flag-off returns not-found; route order vs `/:id`; the shape.
- `apps/web/__tests__/components/us-broker-grid.test.ts` (`renderToStaticMarkup`):
  - only offerable brokers render;
  - with `us-broker-connect` off, nothing renders;
  - with the IBKR tile and `us-broker-ib` off, the tile reads "import";
  - no iframe element in the consent sheet;
  - no "Tiingo" string;
  - **USD-renders-no-bare-₹**: in the done/connection card, ₹ appears only in the dated spot line.
- `apps/web/__tests__/actions/us-broker-connect-gates.test.ts`: every one of the four flag conditions is fail-closed.
  - **Mutation:** drop `us-broker-connect` from `isBrokerOfferable`'s US branch and watch the test fail.

## Acceptance

- [ ] The P18 acceptance scenario is now runnable: the founder connects SANDBOX on QA through this UI and sees accounts, positions (native + converted), the re-auth flow via the forced-disable endpoint, and reconnect.
- [ ] Only catalogue-offerable brokers ever render. No broker name is hardcoded in the UI.
- [ ] The portal is only ever a full-page redirect.
- [ ] 375/1280 × light/dark screenshots for U1, U2 (NRI and LRS order) and U5.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Out of scope / hand-offs

- Statement import (the W08 import half) is P3-05.
- The mixed holdings view is P3-04.
- The per-broker P19–P29 prompts run next, one PR each, from the pack.
- Crypto (P30–P33) is a follow-on.
- A direct IBKR Flex client is not built (Decisions #04).
