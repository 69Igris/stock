# Feature Flags - UseMoney Web

This document is the canonical inventory of feature flags wired into
`apps/web`. Keep it in sync when adding, retiring, or repurposing
flags. Audit performed as part of [MONEY-394](https://linear.app/dis-digital/issue/MONEY-394) on 2026-05-12.

## Where they live

| Concern                                    | File                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| Server action - page-visibility evaluation | `apps/web/lib/actions/feature-flags.ts` (`getFeatureFlags`)    |
| Server action - US/International           | `apps/web/lib/actions/feature-flags.ts` (`getUsFeatureFlags`)  |
| Server action - App-level (non-route)      | `apps/web/lib/actions/feature-flags.ts` (`getAppFeatureFlags`) |
| Client hook - page visibility              | `apps/web/lib/hooks/useFeatureFlags.ts`                        |
| Client hook - US flags                     | `apps/web/lib/hooks/useUsFeatureFlags.ts`                      |
| Client hook - app-level flags              | `apps/web/lib/hooks/useAppFeatureFlags.ts`                     |
| Type definitions                           | `apps/web/lib/types/feature-flags.ts`                          |
| Server-side cache (Redis-backed)           | `apps/web/lib/redis/cache.ts`                                  |
| Client-side cache (localStorage)           | `apps/web/lib/utils/feature-flag-cache.ts`                     |
| Debug page (manual flag inspection)        | `apps/web/app/debug-posthog/client.tsx`                        |

PostHog dashboard: <https://us.posthog.com/project/272942/feature_flags>

## Flag inventory

### Always-on routes (no PostHog call)

Listed in `ALWAYS_ON_ROUTES` in `lib/types/feature-flags.ts`. The
`PageGuard` short-circuits these without ever touching PostHog, so they
have **no** runtime flag at all. Listed here only so the URL mapping is
visible:

| Route        | Notes                                                             |
| ------------ | ----------------------------------------------------------------- |
| `/tradebook` | Shipped - was `page-visibility-tradebook`, retired                |
| `/positions` | Shipped - was `page-visibility-positions`, retired                |
| `/holdings`  | Shipped - was `page-visibility-holdings`, retired                 |
| `/discover`  | Shipped - was `page-visibility-discover`, retired                 |
| `/analysis`  | Shipped - was `page-visibility-analysis`, retired                 |
| `/watchlist` | Shipped - was `page-visibility-watchlist`, retired                |
| `/roast`     | Shipped - was `page-visibility-roast`, retired                    |
| `/documents` | Shipped - was `page-visibility-documents`, retired in MONEY-394 E |

### Gated routes - `GATED_FLAG_KEYS`

Server-evaluated on every page-load via PostHog Decide. Sidenav entries
for routes in this group are conditionally rendered via the
`NavItem.featureFlag` field (see `apps/web/components/Sidebar.tsx`).

| Flag                            | Route            | Sidenav behaviour                                                                                            | Allowlist target                        |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `page-visibility-paper-trading` | `/paper-trading` | Visible to all; page renders Coming Soon for non-allowlisted                                                 | 4 internal emails                       |
| `page-visibility-strategies`    | `/strategies`    | Visible to all; same Coming Soon pattern                                                                     | 4 internal emails                       |
| `page-visibility-risk`          | `/risk`          | Hidden from sidenav unless flag is true                                                                      | TBD (currently same internal allowlist) |
| `page-visibility-tax`           | `/tax`           | Hidden from sidenav unless flag is true                                                                      | TBD                                     |
| `page-visibility-learning`      | `/learning`      | Collapsible parent + Courses link gated on `/learning`; Sage Tutor + Quiz sub-items gated on their own flags | TBD                                     |
| `page-visibility-sage-tutor`    | `/sage-tutor`    | Sub-item under Learning; only visible when both `/learning` and `/sage-tutor` flags are true                 | TBD                                     |
| `page-visibility-quizzes`       | `/quizzes`       | Sub-item under Learning; only visible when both `/learning` and `/quizzes` flags are true                    | TBD                                     |

### US / International - `UsFeatureFlag`

Non-route flags, evaluated via `getUsFeatureFlags()`. Read with the
`useUsFeatureFlags()` hook. Currently single-user gated to
`deepshaswat@gmail.com` only.

| Flag                | What it controls                                       |
| ------------------- | ------------------------------------------------------ |
| `us-stocks-listing` | Show US stocks (NASDAQ/NYSE/AMEX) on Discover listings |
| `us-stocks-search`  | Show US stocks in autocomplete + `/api/market/search`  |
| `us-broker-ib`      | Surface Interactive Brokers on the Brokers page        |
| `global-mf`         | Global mutual-fund cross-border comparison             |
| `us-stock-research` | Allow US stock queries in the AI agent                 |

### App-level - `AppFeatureFlag`

Non-route, non-locale flags introduced in MONEY-394 E. Each one gates a
single UI surface (button, dropdown, etc.) rather than a whole page.
Read with `useAppFeatureFlags()`.

| Flag              | What it controls                         | Initial cohort        |
| ----------------- | ---------------------------------------- | --------------------- |
| `generate-report` | Generate Report dropdown on `/documents` | deepshaswat@gmail.com |

## Naming convention

- **Page-visibility flags:** `page-visibility-<route-slug>` (e.g.
  `page-visibility-paper-trading`). One flag per gated route.
- **US/International:** `<scope>-<feature>` (e.g. `us-stocks-listing`,
  `global-mf`). Free-form because they pre-date the convention.
- **App-level:** descriptive kebab-case key (e.g. `generate-report`).
  Add an entry to `AppFeatureFlag` in `lib/types/feature-flags.ts` AND
  register it in `APP_FEATURE_FLAG_KEYS` + `APP_FLAGS_DEFAULT` in the
  server action.

## Adding a new flag

1. **Create in PostHog** with appropriate targeting (allowlist or
   rollout %). Tag it `gated` (page-visibility), `us-features` (US/
   International), or `app-feature` (app-level).
2. **Update the type union** in `lib/types/feature-flags.ts`.
3. **Wire it into the matching action map** (`GATED_FLAG_KEYS`,
   `US_FEATURE_FLAG_KEYS`, or `APP_FEATURE_FLAG_KEYS`).
4. **Update defaults** in both the server action's `*_DEFAULT` const
   AND the client hook (so the optimistic UI is correct).
5. **Reference the flag** via the appropriate hook
   (`useFeatureFlags`, `useUsFeatureFlags`, `useAppFeatureFlags`).
6. **Document it here** - add a row to the table above.

## Retiring a flag

When a feature is fully rolled out:

1. **Move the route into `ALWAYS_ON_ROUTES`** (if it's a page-visibility
   flag) so PageGuard short-circuits without hitting PostHog.
2. **Remove the flag from `GATED_FLAG_KEYS` / `GatedPageRoute` type**.
3. **Strip all client-side reads** of the flag - verify no `flags[…]`
   accesses remain.
4. **Soft-delete in PostHog** via the API (`delete-feature-flag` tool)
   or the dashboard.
5. **Update this document** - move the row to the always-on table with
   a note in the "Notes" column referencing the retirement.

## Background: MONEY-394 cleanup audit (2026-05-12)

Initial PostHog state: 20 active flags. Categorised into 4 groups:

- **Group 1 - DEPRECATED `page-visibility-*` (7 flags):** routes already
  in `ALWAYS_ON_ROUTES`; only legacy code refs remained. Cleaned in
  sub-task A.
- **Group 2 - US/International (5 flags):** no change.
- **Group 3 - Actively gating routes (7 flags + 1 stale):** Paper
  Trading + Strategies converted to allowlist-with-Coming-Soon pattern
  in sub-tasks B/C; Tax/Risk/Learning/Sage-Tutor/Quizzes nav entries
  gated on the same flag as the page in sub-task D; Documents ungated
  - new `generate-report` flag in sub-task E.
- **Group 4 - Code/PostHog mismatch (1 flag):** `page-visibility-tutor`
  referenced in code but not in PostHog. Dead refs removed in sub-task F.

PostHog deletion of Group 1 flags is partially complete; remaining
flags (`page-visibility-discover` 640047, `page-visibility-holdings`
640046, `page-visibility-tradebook` 640044) need manual deletion via
the dashboard.
