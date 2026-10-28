---
name: fixing-bugs
description:
  "Bug-fixing policy for UseMoney. FIX THE SOURCE, never weaken the test. Use
  when investigating any defect, a failing or flaky test, a red CI that passes
  locally, an orphan/hang/timeout, or a 'find any bugs' sweep. Encodes the
  recurring bug classes in this codebase — non-finite money poison
  (NaN/Infinity/Invalid-Date), leaked-timer orphans, time & rounding flakes,
  Prisma-payload type mismatches, fail-open auth gates, stale-copy drift,
  IDOR/pagination-500 — plus the reproduce→root-cause→fix-source→regression→
  verify loop. Trigger on: 'fix a bug', 'failing test', 'flaky', 'CI is red',
  'orphan / hang / timeout', 'NaN' / 'Infinity' / 'Invalid Date' / 'div by zero',
  '₹NaN', 'fails in CI but not locally', or any defect investigation. Pair with
  the `writing-tests` skill for the test side (no-shadow, layers, orphan
  detection)."
---

# UseMoney Bug-Fixing Policy

## Prime Directive: FIX THE SOURCE — NEVER WEAKEN THE TEST

When a test fails, the bug is almost always in the SOURCE. Make the PRODUCTION
code correct and keep (or tighten) the assertion. Loosening a tolerance, adding
`--test-force-exit`, `.skip`-ing, or asserting the buggy output to "make it
green" hides a live defect. If a test's expectation is genuinely wrong, correct
it to the REAL, correct behavior — never to the broken output, and never weaken a
compliance/security guard (SEBI scrub, auth gate).

A green suite is not proof of correctness — see `writing-tests` for how shadow
tests and `--test-force-exit` hide bugs. Most real bugs here are found by binding
a test to the REAL exported source and feeding it adversarial fixtures.

## Bug taxonomy — the high-frequency classes in this repo

### 1. Non-finite money poison (the #1 class)

Mongo `Float` accepts `NaN`/`Infinity`; one poisoned row turns a whole aggregate
into `₹NaN`. The offending idioms:

- `a / b` with `b === 0` → `Infinity`/`NaN`. Guard: `b !== 0 ? a / b : 0`.
- `x ?? 0` does NOT catch `NaN` (only null/undefined). Use a `finite(v, fb)` =
  `Number.isFinite(v) ? v : fb` helper and derive every total from guarded values.
- `Infinity || 0` is `Infinity` (truthy) — don't rely on `|| 0`.
- `(NaN).toFixed(2) === "NaN"` — renders literally to the user.
- `new Date("garbage").toISOString()` throws `RangeError: Invalid time value`
  → a report-wide 500. Validate with `isValidDate` (a Date whose `getTime()` is
  finite) BEFORE `.toISOString()`; treat invalid as EXPIRED / `null`, never
  "never expires" (`new Date("garbage") > now` is `false` = silent privilege leak).
- `Array.sort` is order-unstable on `NaN` → wrong winner / gainer-loser ranking.
  Regression: feed the exact `NaN` / `Infinity` / `0` / `Invalid Date` input.

### 2. Leaked timer / orphan handle

`Promise.race([work, new Promise(r => setTimeout(r, ms))])` that never clears the
timer: when `work` wins (every normal call) the timeout stays pending for `ms`,
keeping the event loop alive — delays worker shutdown in prod and orphans the
test (`writing-tests` → Orphan detection). Fix: capture the handle, `clearTimeout`
in `finally`. (Real fix: `packages/research/src/executor.ts executeWithTimeout`.)

### 3. Time & rounding flakes (intermittent CI red)

- Multiple `Date.now()` / `new Date()` reads for values meant to be EQUAL → a 1ms
  tick between them breaks equality. Fix: ONE base read, derive the rest from it.
- Deriving a value from UNrounded inputs but emitting ROUNDED ones, while a test
  recomputes from the rounded output → drift past tolerance. Fix: round first,
  then derive (so the emitted invariant holds for the emitted values).
  Repro a suspected flake by running the file 5–20× (`Math.random`/clock varies).
  (Real fixes: `lib/demo/data.ts`, `packages/core/src/brokers/mock-data.ts`.)

### 4. Prisma-payload type mismatch (from extracting a `*-logic.ts`)

A pure logic module typed a DB-write payload with `Record<string, unknown>` for a
JSON column or bare `string` for an enum column. `tsx` tests pass; the real build
fails at the consuming package's `prisma.*.update`/`.create`. Fixes:

- JSON column → `import type { Prisma } from "@usemoney/database"` (erased at
  runtime, stays load-pure) and type the field `Prisma.InputJsonValue`; cast the
  boundary `as Prisma.InputJsonValue` if assigning a typed object.
- Enum column → the literal (`status?: "ACTIVE"`) or the Prisma enum type, not
  `string`.
- An index signature `[key: string]: unknown` on a param type REJECTS a concrete
  SDK/Prisma return type (which has none) — drop it.
- `export type {X} from "./m"` is a pass-through with NO local binding — a file
  that USES `X` as an annotation also needs `import type {X}`.

### 5. Fail-open authorization

A gate that THROWS (or 500s) on an unknown/missing key instead of DENYING is
fail-OPEN. e.g. `FEATURE_ACCESS[feature].includes(plan)` → TypeError on an unknown
feature. Fix: guard → return `false` (least privilege). Resolve an unknown/missing
plan / role / email to the LOWEST tier, never a paid one. An allow-list gate must
be honored consistently across every route (one route checking only `role` while
others also honor `ADMIN_EMAILS` is a real inconsistency).

### 6. Stale-copy drift

A second copy of source logic (a duplicated `lib/cache/keys.ts`, an inline
constant in a shadow test) silently diverges from the canonical one — a prior fix
never propagated (e.g. the cache-key escape fix lived in `packages/cache` but the
web copy still collided → cross-entry Redis bleed). Fix: collapse to ONE source of
truth (re-export the canonical module); the test must assert the REAL export so it
can never drift again.

### 7. IDOR / pagination-500

A service query missing `userId` scoping (one user reads another's rows), or a
`skip`/`take` of `NaN`/negative → Prisma 500s or silently drops ALL rows
(`Math.min(NaN, 50)` → `take: NaN` dropped every search result). Fix: scope every
query by the authenticated `userId`; clamp pagination to finite, non-negative.

## The fix loop

1. **Reproduce deterministically.** Flake → run the file 5–20×. Orphan/hang → run
   WITHOUT `--test-force-exit`. A bug a shadow test is masking → first bind the
   path to the REAL source (`writing-tests` de-shadow recipe), then watch it fail.
2. **Root-cause in SOURCE** — match it to the taxonomy above.
3. **Fix the source** minimally; add/keep a regression feeding the exact
   adversarial input (the `NaN`, the `Invalid Date`, the unknown key, the
   re-delivery, the `take: NaN`).
4. **Sweep for siblings** — these bugs travel in packs: scan every `Promise.race`,
   every `Date.now()` pair, every extracted payload type, every `[feature]`-index
   gate. Fix the whole class, not the one instance.

## Verify before commit (the central gate)

- `yarn build` (Node 22 first: `source ~/.nvm/nvm.sh; nvm use 22` — husky needs
  it) → `20/20`. The build/`tsc` catches the type-boundary class that `tsx` tests
  miss; run a clean `yarn build --force` after a multi-package change.
- `yarn test` → `22/22`.
- Orphan/flake fixes: re-run every workspace WITHOUT `--test-force-exit` (each must
  exit naturally) and loop the fixed file to confirm determinism.
- Preserve `vendor/charting_library` and the user's chore commits; commit only
  when asked; update `TEST-COVERAGE.md` when test files change.
