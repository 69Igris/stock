---
name: writing-tests
description:
  "Test-writing policy for UseMoney. Use this skill whenever you implement a new
  feature, module, route, server action, broker/webhook/payment integration, or
  fix a bug — to write the RIGHT test layers (unit, contract, functional,
  integration, e2e) and to never ship a shadow test. Trigger on: 'add a
  feature', 'new module', 'new route', 'new server action', 'write tests', 'add
  test coverage', 'is this tested', 'fix a bug', 'de-shadow', 'flaky test',
  'orphan / hang / timeout', 'CI is red but passes locally', or any source
  change under apps/ , packages/ , or workers/. For the SOURCE side of a defect
  (bug taxonomy, finite() guards, the find→fix→verify loop) pair this with the
  `fixing-bugs` skill."
---

# UseMoney Test-Writing Policy

Every feature ships with tests that would actually FAIL if the feature broke.
This skill exists because a real production outage (the Zerodha OAuth
"security state missing" bug) shipped green: 11,500+ tests passed because the
test that "covered" it was a **shadow** — it reimplemented the source logic
inline and asserted the copy. The copy was correct; the real code was not.

## Prime Directive: NO SHADOW TESTS

> A test MUST import and execute the **real exported symbol** from the source
> module. It must NOT re-declare the logic inside the test file and assert the
> copy.

A shadow test is worse than no test: it's green while production burns, and it
hides the gap behind a passing check.

**How to spot a shadow** (audit any test you touch):

- The test file declares `function`/`const` logic — often under a comment like
  `// --- Inline Pure Functions from Source ---` / "mirrors the source" /
  "replicate".
- It does NOT import the thing it claims to test from `@/...`, `@usemoney/*`,
  `../src`, or a relative source path.
- It imports the source module but then redefines the same function locally and
  asserts the local one.

**The de-shadow recipe** (the only correct fix):

1. **Extract** the inline logic out of the route/action/class into a pure,
   **exported** symbol in the source (same file, or a sibling
   `*-logic.ts` / `*-helpers.ts` module if importing the route would drag in
   server-only deps like Prisma, `next/headers`, GCS, pubsub).
2. **Wire** the real source to CALL that export. The export must NOT be dead —
   the production code path and the test must execute the _same_ code.
3. **Rewrite** the test to import & assert the real export; delete the copy.
4. **Verify** it runs and exits cleanly (below).

Reference de-shadows already merged (copy these patterns):

- `apps/web/lib/brokers/oauth-url.ts` + `__tests__/brokers/oauth-url-state-contract.test.ts`
- `apps/web/lib/brokers/oauth-callback.ts` + `__tests__/api/broker-oauth-callbacks.test.ts` (+ the 7 callback routes that call it)
- `apps/web/lib/db/dashboard-logic.ts` + `__tests__/db/dashboard.test.ts`

## The Five Layers — write the ones the feature needs

| Layer           | What it proves                                                       | In this repo                                                                                                 |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Unit**        | A pure function maps inputs → outputs correctly, incl. edge cases    | Import the real exported helper; feed adversarial fixtures (null, "", NaN, empty arrays, malformed dates).   |
| **Contract**    | Our code obeys an EXTERNAL system's wire format / protocol           | The highest-value layer for integrations. See "Contract tests" below.                                        |
| **Functional**  | A feature's behavior end-to-end through its own modules (mocked I/O) | Drive the real action/handler with mocked DB/network; assert the observable result + side-effects.           |
| **Integration** | Two+ real modules cooperate correctly                                | Real module A calls real module B; only the outermost I/O is mocked.                                         |
| **E2E**         | A user flow works in a real browser/runtime                          | Reserved for critical flows; not part of `yarn test`. Note explicitly when an E2E is needed but not written. |

Scale to the change: a pure util needs **unit**. A broker/webhook/payment
integration needs **contract** (+ unit for its helpers). A new page/flow needs
**functional** and, for critical flows, **E2E**.

## The Five Blind Spots — what a layer must close

The default suite is `node:test` (no DOM, mocked boundaries, happy-path
fixtures), gated by `yarn build` (types only). Bugs escape through:

1. **No DOM render** → Radix a11y throws, JSX whitespace, render-time crashes.
   Cover with a render smoke test (`renderToStaticMarkup` / jsdom) for Dialogs,
   pages, and any component that formats data.
2. **Happy-path fixtures** → `.toISOString()` throwing on an invalid Date, etc.
   Cover by feeding every `safe*`/parse/format helper `null`/`""`/`NaN`/garbage.
3. **External contracts** → the broker echoes `state` differently, the webhook
   signature scheme, the payment idempotency gate. Cover with **contract tests**
   (below) — a mocked unit test can NEVER see these.
4. **Build catches types, not runtime** → `yarn build` greenlights code that
   compiles but throws when rendered or called. Contract/functional tests close
   this.
5. **Async loops that never terminate** → a `setInterval`/poll/retry that only
   clears on the SUCCESS path runs forever on the failure path. The classic case
   (MONEY-553): a `/compare/[sessionId]` status poll cleared its 4s interval only
   on COMPLETED/FAILED, so a thrown action (stale-deploy `UnrecognizedActionError`)
   or a `{success:false}` return looped forever — hundreds of identical exceptions
   from one stale tab. **Extract the loop's "what next?" into a PURE decision
   function** (`decideComparePoll`) and test that it STOPS on EVERY non-happy path:
   a sustained failure streak (thrown == returned-false), AND a hard wall-clock /
   max-iteration cap for a backend that never writes a terminal state. A loop must
   be provably terminating, not just "terminates when things go right."

## Contract tests for external systems

When code talks to an external system (broker OAuth, Dodo/Clerk webhooks via
`svix`, a market-data provider, GCS), pin the **real contract**, not a mock of
it:

- **OAuth URL / callback**: assert each broker carries `state` in the form it
  echoes back (Zerodha → `redirect_params`, never a bare `&state=`); assert each
  callback's code-param name + cancel signal. (`oauth-url.ts`,
  `oauth-callback.ts`.)
- **Webhook signatures**: use the REAL `svix` `Webhook` — sign a payload, assert
  it verifies; tamper the body/signature/timestamp, assert it is REJECTED. Never
  mock `Webhook.verify` away.
- **Checksums/hashes**: assert the exact hash the client sends
  (e.g. Zerodha `SHA256(apiKey:requestToken:apiSecret)`).
- **Idempotency**: simulate concurrent re-delivery; assert the effect applies
  exactly once.

## Repo mechanics (do not skip)

- **Runner:** `node:test` + `node:assert/strict`. Tests live in
  `apps/web/__tests__/**`, `apps/api/__tests__/**`, `workers/__tests__/**`,
  `packages/*/__tests__/**`.
- **Run one file:** `cd <app> && node --import tsx --test <relative-path>`
  (web tests need CWD `apps/web` for the `@/` alias). Full suite: `yarn test`.
- **NO ORPHANS:** tests must be pure & mocked — no real network, DB, timers, or
  open handles. They MUST exit cleanly in a couple seconds. A hang trips the
  `scripts/test-timeout.ts` process-group SIGKILL guard. Importing a source
  module must not open a Prisma/Redis/socket connection at module load — isolate
  pure logic into a `*-logic.ts` sibling if it does.
- **TEST-COVERAGE.md is the source of truth.** Adding/removing/modifying a test
  file REQUIRES updating `TEST-COVERAGE.md` in the same PR: add/remove the row,
  fix the case count, move source files between Tested/Not-Tested.
- **`yarn build` before every commit** (run Node 22 in the same shell:
  `source ~/.nvm/nvm.sh; nvm use 22`, husky needs it). Gate: `20 successful,
20 total`.
- **No `any`.** TypeScript strict everywhere.

## Orphan detection — `--test-force-exit` MASKS leaked handles

Every workspace runs `node --test --test-force-exit`, which exits the process the
instant known tests finish. A leaked handle (an uncleared `setTimeout`/
`setInterval`, an open socket, a live Prisma/Redis connection) is therefore
**invisible**: green on a fast machine because force-exit bails before the leaked
file hits its 30s per-test timeout — but a slower CI runner lets that timeout
fire FIRST → a red CI that "passes locally." (Exactly how CI #10 on
`test/MONEY-620` failed while the suite was green locally.)

**Find them: run WITHOUT `--test-force-exit` and watch for files that hang.**
Per workspace, from its dir (macOS bash 3.2 has no `globstar`, so use `find`):

```bash
files=( $(find __tests__ -type f -name '*.test.ts') )
TEST_TIMEOUT_MS=90000 node --import tsx ../../scripts/test-timeout.ts \
  --import tsx --test --test-timeout=30000 "${files[@]}"
```

- exit 0 (natural) → CLEAN.
- exit 124 (watchdog SIGKILL) or a file-level `test timed out after 30000ms` →
  ORPHAN: a handle outlived the tests. Bisect to the file, fix the SOURCE
  (`clearTimeout` the loser of a `Promise.race`, `.unref()` a heartbeat, close
  the connection) — never paper over it with `--test-force-exit`.
- exit 1 → a real failure or a flake; re-run the file 5–20× to confirm.

A test that needs `--test-force-exit` to pass is hiding a leak — fix the leak.

## De-shadowing at scale (parallel agent waves)

For a large campaign (dozens of files), fan out disjoint agents — one per
directory/area — each: triage true shadows, extract→export→wire→assert, fix any
source bug, verify ONLY via targeted single-file `node --test`. Agent rules:

- **NO `git`** (the orchestrator commits centrally; concurrent `git stash`
  corrupts the working tree).
- **NO full `apps/web` `tsc`/`yarn build`** (5-way concurrency past the 600s
  watchdog stalls — verify per-file only).
- Disjoint file surfaces; **only Zerodha is live → DEFER other-broker tests**.

**The orchestrator owns the central gate after EVERY wave**, because `tsx` runs
tests WITHOUT type-checking: a whole class of errors passes the agents' per-file
runs and only fails the real monorepo build — the type error lives at the
CONSUMING package's boundary (a `*-logic.ts` payload typed
`Record<string, unknown>` for a Prisma JSON column, or bare `string` for an enum
column, fails where `@usemoney/admin`/`web` type-checks the imported service, NOT
in the test or the logic file). Gate: `yarn build` 20/20 → `yarn test` 22/22 →
orphan re-check → commit. See `fixing-bugs` for the boundary fixes.

## Per-feature checklist

- [ ] Every new pure helper is **exported** and asserted via its real import.
- [ ] No logic is re-declared inside a test (no shadows).
- [ ] Edge-case fixtures: null / empty / NaN / malformed dates / huge inputs.
- [ ] External integration → a contract test pinning the real wire format.
- [ ] Data-formatting component → a render smoke test (no DOM-render blind spot).
- [ ] Any poll/interval/retry loop → a pure decision fn proven to TERMINATE on
      every failure path (streak cap + wall-clock/max-iteration cap).
- [ ] Test runs pure & exits clean (no orphan).
- [ ] `TEST-COVERAGE.md` updated.
- [ ] `yarn build` green before commit.
