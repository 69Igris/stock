# P0-02 · US flag registry — one declaration, every copy derived, `/v1/me/flags`

Ticket: MONEY-1622 · Branch: `feat/MONEY-1622` · Flag(s): declares all 20 `us-*` flags (`US_FLAGS`) and the 4 `snaptrade-*` broker flags (`BROKER_FLAGS`), all default OFF · Screens: `/debug-posthog` (internal, founder-only) · Depends on: nothing · Parallel-safe with: P0-01

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt. §3 of the US file is the flag law this prompt makes executable.

## Goal

Every `us-*` PostHog flag is declared ONCE, with its default (OFF), owning screen and ticket. The server evaluator, the client hook, the debug page and a new `GET /v1/me/flags` for mobile all derive from that one declaration, and a source scan fails the build when a `us-*` (or `snaptrade-*`) string is read as a flag without being declared. The four SnapTrade broker flags are declared here too, in a sibling `BROKER_FLAGS` list, so P3-02 reads them from the same registry. Two legacy keys are renamed without a flag-day.

## Why / measured state today

The five US flag names are hand-synced in four places, and they have already drifted:

| Copy               | Location                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type               | `apps/web/lib/types/feature-flags.ts:73` `UsFeatureFlag` (5 keys)                                                                                                                                                 |
| key map + defaults | `apps/web/lib/actions/feature-flags.ts:395` `US_FEATURE_FLAG_KEYS`, `:403` `US_FLAGS_DEFAULT`                                                                                                                     |
| client defaults    | `apps/web/lib/hooks/useUsFeatureFlags.ts:8` `US_FLAGS_DEFAULT` (a second copy)                                                                                                                                    |
| debug list         | `apps/web/app/debug-posthog/client.tsx:21` `flagKeys` — still lists the retired `page-visibility-documents` and omits `page-visibility-scans` (`GATED_FLAG_KEYS` has `/discover/scans` → `page-visibility-scans`) |

- `useUsFeatureFlags` has **zero consumers** (grep: only its own file and `useAppFeatureFlags.ts:27`'s comment mention it).
- Readers of US flags in production code: `apps/web/app/stock/[symbol]/page.tsx:187-195` (`us-stocks-listing`) and `apps/web/app/api/market/search/route.ts:123` (`us-stocks-search`). `us-broker-ib`, `global-mf` and `us-stock-research` are **read by nothing** (`us-stock-research` appears only in a comment at `apps/web/app/api/chat/route.ts:168`).
- **apps/api cannot evaluate flags at all.** The PostHog Decide call (`fetchFlagsFromPostHog`, `apps/web/lib/actions/feature-flags.ts:112`) lives inside a `"use server"` file in `apps/web`; `apps/api` may not import it.
- PostHog `distinct_id` on the web is the **Clerk** user id (`auth().userId`, `feature-flags.ts:426-470`). Any shared evaluator must keep that, or targeting splits into two people.
- `docs/setup/us-feature-flags-setup.md` lists five flags and no routes.

## Read first (verified paths)

- `apps/web/lib/types/feature-flags.ts`, `apps/web/lib/actions/feature-flags.ts` (read MONEY-1123 notes: `null` = transient failure, never cached; `{}` = evaluated, matched nothing)
- `apps/web/lib/hooks/useUsFeatureFlags.ts`, `apps/web/lib/hooks/useAppFeatureFlags.ts`, `apps/web/app/debug-posthog/client.tsx`
- `apps/web/__tests__/actions/feature-flags.test.ts`, `apps/web/__tests__/actions/feature-flags-perf.test.ts` (must stay green)
- `apps/api/src/routes/v1/me.ts` (`meRoutes`, handlers from `:203`), `apps/api/src/middleware/auth.ts:42-43` (sets `clerkUserId` and `userId`)
- `packages/services/src/analytics.ts` (posthog-node already a services dependency), `packages/core/package.json` (explicit subpath exports)

## Build — in this order

### 1. Declaration — `packages/core/src/flags/us-flags.ts` (no imports; client-safe)

Add core subpath export `"./flags/us-flags": "./src/flags/us-flags.ts"`.

```ts
/** One declaration shape for every flag family this registry owns. */
export interface FlagDecl<K extends string = string> {
  key: K;
  phase: 0 | 1 | 2 | 3;
  screens: string; // screen catalogue ids, README
  ticket: string; // owning MONEY ticket (existing ids only)
  /** true = the surface shows US MARKET DATA, so it must be composed with the licence via useUsLayer/resolveUsLayer (P0-03 scan). false = profile/flow/chrome that India-only users also see. */
  licensed: boolean;
  legacyKeys?: readonly string[]; // read as OR for ONE release, then deleted
}
export type UsFlagDecl = FlagDecl<`us-${string}`>;
export type BrokerFlagDecl = FlagDecl<`snaptrade-${string}`>;

export const US_FLAGS = [
  {
    key: "us-onboarding",
    phase: 0,
    screens: "S0.1 S0.2 S0.3 S0.7",
    licensed: false,
    ticket: "MONEY-1623",
  },
  {
    key: "us-market-switch",
    phase: 0,
    screens: "S0.6",
    licensed: false,
    ticket: "MONEY-1625",
  },
  {
    key: "us-upgrade",
    phase: 0,
    screens: "S0.4 S0.5",
    licensed: false,
    ticket: "MONEY-1624",
  },
  {
    key: "us-currency-toggle",
    phase: 0,
    screens: "$↔₹ toggle",
    licensed: false,
    ticket: "MONEY-1578",
  },
  {
    key: "us-stocks-search",
    phase: 1,
    screens: "S1.1",
    licensed: true,
    ticket: "MONEY-1627",
  },
  {
    key: "us-stocks-listing",
    phase: 1,
    screens: "S1.3",
    licensed: true,
    ticket: "MONEY-1586",
  },
  {
    key: "us-stock-chart",
    phase: 1,
    screens: "S1.3 chart",
    licensed: true,
    ticket: "MONEY-1586",
  },
  {
    key: "us-stock-fundamentals",
    phase: 1,
    screens: "S1.3 fundamentals",
    licensed: true,
    ticket: "MONEY-1586",
  },
  {
    key: "us-news",
    phase: 1,
    screens: "S1.3 S1.2 news",
    licensed: true,
    ticket: "MONEY-1629",
  },
  {
    key: "us-market-overview",
    phase: 1,
    screens: "S1.2",
    licensed: true,
    ticket: "MONEY-1628",
  },
  {
    key: "us-screener",
    phase: 1,
    screens: "S1.4",
    licensed: true,
    ticket: "MONEY-1587",
  },
  {
    key: "us-funds",
    phase: 1,
    screens: "S1.4 funds, fund page",
    licensed: true,
    ticket: "MONEY-1572",
    legacyKeys: ["global-mf"],
  },
  {
    key: "us-watchlist",
    phase: 1,
    screens: "S1.5",
    licensed: true,
    ticket: "MONEY-1589",
  },
  {
    key: "us-dashboard",
    phase: 1,
    screens: "S1.6",
    licensed: true,
    ticket: "MONEY-1631",
  },
  {
    key: "us-stock-research",
    phase: 2,
    screens: "S2.2",
    licensed: true,
    ticket: "MONEY-1583",
  },
  {
    key: "us-sage-entrypoints",
    phase: 2,
    screens: "S2.1 S2.3",
    licensed: true,
    ticket: "MONEY-1634",
  },
  {
    key: "us-broker-connect",
    phase: 3,
    screens: "S3.1",
    licensed: true, // S3.1 shows US brokers and, once connected, US positions: compose with the licence
    ticket: "MONEY-1638",
    legacyKeys: ["us-broker-ib"],
  },
  {
    key: "us-holdings",
    phase: 3,
    screens: "S3.2",
    licensed: true,
    ticket: "MONEY-1639",
  },
  {
    key: "us-lrs-tracker",
    phase: 3,
    screens: "S3.3",
    licensed: false,
    ticket: "MONEY-915",
  },
  {
    key: "us-statement-import",
    phase: 3,
    screens: "S3.4",
    licensed: false,
    ticket: "MONEY-915",
  },
] as const satisfies readonly UsFlagDecl[];

/**
 * The SnapTrade rail's flags (P3-02 / MONEY-1637 reads them; this prompt only declares them).
 * Sibling of US_FLAGS, not part of it: the rail also serves Indian brokers (P28/P29),
 * so these are not `us-*` flags and are NOT counted in the 20.
 * `snaptrade-brokers` carries a PostHog payload `{ slugs: string[] }`; P3-02 reads it.
 */
export const BROKER_FLAGS = [
  {
    key: "snaptrade-brokers",
    phase: 3,
    screens: "S3.1 broker cards (master)",
    licensed: false,
    ticket: "MONEY-1637",
  },
  {
    key: "snaptrade-zerodha",
    phase: 3,
    screens: "Zerodha via SnapTrade (P28)",
    licensed: false,
    ticket: "MONEY-1637",
  },
  {
    key: "snaptrade-upstox",
    phase: 3,
    screens: "Upstox via SnapTrade (P29)",
    licensed: false,
    ticket: "MONEY-1637",
  },
  {
    key: "snaptrade-crypto",
    phase: 3,
    screens: "crypto venues (P30–P33, out of scope)",
    licensed: false,
    ticket: "MONEY-1637",
  },
] as const satisfies readonly BrokerFlagDecl[];

export type UsFlagKey = (typeof US_FLAGS)[number]["key"];
export type UsFlagMap = Record<UsFlagKey, boolean>;
export type BrokerFlagKey = (typeof BROKER_FLAGS)[number]["key"];
export type BrokerFlagMap = Record<BrokerFlagKey, boolean>;

/** Every default is OFF. Derived, never hand-written. */
export const US_FLAG_DEFAULTS: UsFlagMap = Object.fromEntries(
  US_FLAGS.map((f) => [f.key, false]),
) as UsFlagMap;
export const BROKER_FLAG_DEFAULTS: BrokerFlagMap = Object.fromEntries(
  BROKER_FLAGS.map((f) => [f.key, false]),
) as BrokerFlagMap;

/** PostHog payload → map. Truthiness rule copied from feature-flags.ts:488-494 (true, or a non-empty string that is not "false"/"off"); a legacy key ORs in. */
export function readUsFlags(
  payload: Record<string, boolean | string | undefined>,
): UsFlagMap {
  /* … */
}
```

Ticket ids above are the ones in `docs/prompts/us-fullstack/README.md`; do not invent others. There is no default-ON path: a test asserts every `US_FLAG_DEFAULTS` and `BROKER_FLAG_DEFAULTS` value is `false`. `BROKER_FLAGS` gets no reader in this prompt; P3-02 reads it from `@usemoney/core/flags/us-flags` (never a second declaration).

### 2. Service — `packages/services/src/flags/us-flags.service.ts` (+ `-logic.ts` is `readUsFlags` above)

Move the Decide HTTP call out of the web action into `packages/services/src/flags/posthog-decide.ts` (`fetchPostHogFlags(distinctId, personProps): Promise<Payload | null>` — same 2 s `AbortSignal.timeout`, same `null` vs `{}` contract, same missing-key → `{}`). The web action then calls it for page, app AND US flags, so there is one Decide client, not two.

```ts
// packages/services/src/flags/us-flags.service.ts
export async function getUsFlags(
  userId: string, // Mongo id
  _input: {} = {},
  deps: {
    prisma?: Pick<typeof prisma, "user">;
    decide?: typeof fetchPostHogFlags;
  } = {},
): Promise<ServiceResult<{ flags: UsFlagMap; evaluated: boolean }>>;
```

- Look up `{clerkId, email, name}` by `userId`; `distinct_id = clerkId` (NOT the Mongo id — targeting must match the web's person). No `clerkId` → defaults, `evaluated:false`.
- Cache FIRST, keyed by the Mongo `userId`, so a hit costs no DB read and no Decide call (the MONEY-1123 perf rule: `/api/market/search` evaluates on every debounced keystroke). Decide returns `null` → defaults, `evaluated:false`, **not cached**. `{}` or a payload → `readUsFlags`, cached in-process 5 min (same TTL and never-cache-a-failure rule as MONEY-1123).
- Add services subpath `"./flags/*": "./src/flags/*.ts"`.

### 3. Web — derive, don't copy

- `apps/web/lib/types/feature-flags.ts`: `export type UsFeatureFlag = UsFlagKey; export type UsFeatureFlagMap = UsFlagMap;` (re-export from `@usemoney/core/flags/us-flags`). Delete the literal union.
- `apps/web/lib/actions/feature-flags.ts`: delete `US_FEATURE_FLAG_KEYS` and `US_FLAGS_DEFAULT`. `getUsFeatureFlags()` keeps its signature (both readers keep working) and becomes a thin caller: `getAuthenticatedUser()` (`auth()` + the in-memory `getOrCreateDbUser` cache) → `getUsFlags(user.userId)`; signed-out/demo → `US_FLAG_DEFAULTS`. Same function as `/v1/me/flags`. `getFeatureFlags`/`getAppFeatureFlags` keep their own maps but switch transport to `fetchPostHogFlags`; `fetchFlagsFromPostHog` is deleted. `feature-flags-perf.test.ts` must still show zero `currentUser()` calls on a warm hit.
- `apps/web/lib/hooks/useUsFeatureFlags.ts`: initial state `US_FLAG_DEFAULTS`. It stays the ONE client hook; P0-03 builds `useUsLayer()` on it.
- `apps/web/app/debug-posthog/client.tsx`: `flagKeys` = the gated page keys derived from `GATED_FLAG_KEYS` (export it, or move the list next to it) + `US_FLAGS.flatMap(f => [f.key, ...(f.legacyKeys ?? [])])` + `BROKER_FLAGS.map(f => f.key)`. Drop the retired `page-visibility-documents`. Group the US rows under "US layer" and the broker rows under "Broker rail", with each row's `screens` and `ticket` shown.

### 4. `/v1/me/flags` — `apps/api/src/routes/v1/me.ts`

`GET /v1/me/flags` → `200 { flags: UsFlagMap, evaluated: boolean }` via `getUsFlags(c.get("userId"))`. Sub-path of the existing `/me` family — family count unchanged. Not a `US_SURFACES` row: it lives under `/me`, serves no US data, and every user (India-only included) reads it. The web equivalent is the existing `getUsFeatureFlags` action; both now call the same Decide client and `readUsFlags`.

### 5. Renames (one release of overlap)

`us-broker-ib` → `us-broker-connect`, `global-mf` → `us-funds`: `readUsFlags` ORs the legacy key in. The founder creates the two new flags in PostHog with the same targeting before merge (list it in the PR). A follow-up deletes `legacyKeys` — note it in the PR; do not file a ticket number you have not read back from Linear.

### 6. Docs

Rewrite `docs/setup/us-feature-flags-setup.md`: the 20 flags as a table generated from `US_FLAGS` (a test asserts every key appears in the doc), each "default OFF, target founder email only", plus the two legacy keys and when they die. P0-03 adds the routes column.

## Screens

`/debug-posthog` only (internal). No wireframe: it is a flat list. States: flag unset in PostHog → "Not set" (existing), PostHog client not loaded → existing alert. Must render at 375px without horizontal scroll (the rows wrap).

## Cross-surface access (§6)

1–5 n/a: no user-facing surface. 6. API — `GET /v1/me/flags` (under `/me`, not `/v1/us`; see §4). 7. Demo — demo has no Clerk user → all defaults (false); asserted. 8. Telemetry — n/a: flag reads are not events.

## Tests

- `packages/core/__tests__/flags/us-flags.test.ts` — `US_FLAGS` has exactly 20 keys, unique, all `us-` prefixed (this count applies to `US_FLAGS` ONLY); `BROKER_FLAGS` has exactly 4 keys (`snaptrade-brokers`, `snaptrade-zerodha`, `snaptrade-upstox`, `snaptrade-crypto`), all `snaptrade-` prefixed; no key appears in both; every default in both maps `false`; `readUsFlags`: `true`, `"on"`, `"variant-a"` → true; `"false"`, `"off"`, `""`, `undefined` → false; legacy `global-mf:true` → `us-funds:true`; new key `false` + legacy `true` → true (documented overlap).
- `packages/services/__tests__/flags/us-flags-service.test.ts` — distinct id is the clerkId; a warm hit makes zero prisma and zero Decide calls; Decide `null` → defaults + `evaluated:false` + NOT cached (second call calls Decide again); `{}` → defaults, cached.
- `packages/services/__tests__/flags/us-flag-usage-scan.test.ts` — source scan over `apps/web/{app,components,lib,hooks}`, `apps/api/src`, `packages/services/src`, **excluding `packages/services/src/us/registry.ts`** (and `packages/services/src/brokers/registry.ts` once P3-02 adds it): those files hold the registry's `flag:` values by design, and the registry's own parity test (P0-01) owns them.
  - **It checks literals in FLAG-READING POSITIONS only, and that is feasible with regexes, so it is what ships.** A literal matching `(us-[a-z0-9-]+|global-mf|snaptrade-[a-z0-9-]+)` is checked when it is (a) a member-access key, ``/[\w)\]]\s*\[\s*["'`](…)["'`]\s*\]/`` (`flags["us-news"]`; an array literal `["us-central1"]` is not preceded by an identifier and is not matched); (b) the FIRST argument of a flag reader, ``/\b(useUsLayer|resolveUsLayer|usLayerForRequest|usLayerFor|isFeatureEnabled|getFeatureFlag|useFeatureFlagEnabled|useFeatureFlagPayload|getFeatureFlagPayload)\(\s*["'`](…)["'`]/``; or (c) a `flag:` property value, ``/\bflag:\s*["'`](…)["'`]/`` (telemetry payloads and surface rows). Each hit must be a declared `US_FLAGS` / `BROKER_FLAGS` key or a declared `legacyKeys` entry. A literal elsewhere (a Cloud Run region `us-central1`, a job name `us-eod-sync`, a topic `us-filing-events`, an import path) is not a flag read and is not checked, so there is no allow-list to maintain. The any-literal form was rejected: it had to allow-list non-flag strings by hand and would re-break every time a job or region name was added.
  - Surface ids no longer carry a `us-` prefix (P0-01 rule 1), so a registry `surface:` value can never be mistaken for a flag even outside the excluded file.
  - Also: no file other than `packages/core/src/flags/us-flags.ts` declares `Record<UsFeatureFlag…` / `Record<UsFlagKey…` / `Record<BrokerFlagKey…` with literal keys (catches a fifth copy). PREMISE: scanned ≥ 1 file per root, and ≥ 1 positional hit repo-wide (a scan that matches nothing passes forever).
  - **Mutation check:** add `flags["us-nonsense"]` to any web file → red (position a); `useFeatureFlagEnabled("snaptrade-nonsense")` → red (position b); `{ flag: "us-nonsense" }` in a telemetry call → red (position c); add a literal `US_FLAGS_DEFAULT` object back to the hook → red; flip one default to `true` → the defaults test is red.
- `apps/api/__tests__/routes/me-flags-contract.test.ts` — envelope `{success, data:{flags, evaluated}}`, 20 keys, all false with Decide stubbed to `{}`.
- `apps/web/__tests__/actions/feature-flags.test.ts` / `-perf.test.ts` — keep green; update the US map expectations to 20 keys.
- `apps/web/__tests__/docs/us-feature-flags-doc.test.ts` (or colocate in the scan test) — every key appears in `docs/setup/us-feature-flags-setup.md`.
- Update `TEST-COVERAGE.md`.

## Acceptance

- [ ] `grep -rn '"us-stocks-listing"' apps/web/lib` finds only the two production readers and no maps.
- [ ] `GET /v1/me/flags` for the founder returns the same booleans as `getUsFeatureFlags()` on the web for the same person (run both against QA; paste output).
- [ ] With PostHog down (unset `NEXT_PUBLIC_POSTHOG_KEY` → `{}`, or stub `null`), every flag is false and the null case is not cached.
- [ ] Debug page lists the 20 US keys + 2 legacy keys + the 4 broker keys, grouped, with screens/ticket.
- [ ] Scan and mutation checks as above; `verify:push`; `/code-review`.

## Out of scope / hand-offs

- Composing flag with licence (`useUsLayer`, `resolveUsLayer`) → **P0-03**.
- Adding `us-stocks-listing` to the three API routes that lack it → **P0-03** (MONEY-1561).
- Deleting `legacyKeys` after one release → a follow-up the founder files.
- Page-visibility and app flags stay where they are; only their Decide transport is shared.
