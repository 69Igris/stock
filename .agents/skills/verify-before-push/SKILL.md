---
name: verify-before-push
description:
  "Pre-push / pre-PR verification gate for UseMoney. Use BEFORE any git push,
  before opening a PR, and before declaring a change 'done', 'ready', or
  'shipped'. Encodes the standing rules as one deterministic sequence:
  yarn build → full yarn test --force → TEST-COVERAGE.md sync check →
  runtime proof for any 'wired' claim → fresh-context code review before PR.
  Trigger on: 'push', 'push it', 'open a PR', 'create a PR', 'ready to
  merge', 'ship it', 'is this done', 'looks done', or any request that ends
  in publishing commits. Pair with `writing-tests` (test layers) and
  `fixing-bugs` (when the suite goes red — fix the SOURCE, never weaken the
  test)."
---

# UseMoney Pre-Push Verification

Never push or declare done on a successful edit alone. A green build is not a
green suite; a green suite is not runtime proof. Run the whole ladder:

## The gate, in order

1. **`yarn verify:push`** — runs `yarn build` then `yarn test --force` and, on
   success, writes `.Codex/.verify-ok` keyed to a content hash of the exact
   tree it verified. This is the single command form of the two standing
   rules ("yarn build before commit", "full yarn test --force before every
   push"). Editing ANY file after it passes invalidates the marker — re-run.
   - Suite failed at TASK level with zero failing CASES? That is the known
     24-way parallel resource-contention flake (see TEST-COVERAGE.md):
     re-run serialized with `VERIFY_SERIAL=1 yarn verify:push`.
   - Any real failure → load the `fixing-bugs` skill. Fix the source. Never
     `.skip`, never loosen an assertion, never `--test-force-exit` your way
     to green.

2. **`yarn test:coverage-check`** — if this change added/removed/renamed any
   test file, TEST-COVERAGE.md MUST be updated in the same change (headline
   count + the per-file section). The checker fails on headline drift.

3. **Runtime proof for "wired" claims** — "wired" needs a real entry point
   observed doing the work (a request served, a job consumed, data landing).
   A 0-count anywhere in the observed path is a red flag, not a pass. If the
   change has UI surface, actually drive it (dev server, click the control,
   check the console) — an edit that compiles is not a feature that works.

4. **Fresh-context code review before every PR** — this repo has NO human
   reviewer (owner is approval-exempt), so a second-agent review is the only
   review. Run the `code-review` skill on the diff before opening the PR.
   For money paths — payments/Dodo, broker sync/tokens, auth/middleware,
   subscription entitlements — use `/code-review ultra` (user-triggered).
   When review finds a RECURRING defect class, encode it into `fixing-bugs`
   or `writing-tests` so every future run inherits the lesson.

## Hard boundaries (unchanged by this skill)

- No `git add` / `git commit` / PR creation unless the user asked.
- Branch must match `{type}/MONEY-{number}`.
- Never weaken a compliance/security guard (SEBI scrub, auth gate) to pass.
- Emergency bypass of the push gate (`VERIFY_GATE_BYPASS=1 git push …`) is
  for hotfixes only and must be called out loudly in the report.

## Definition of done

Done = built + full suite green on the final tree content + coverage doc in
sync + runtime-observed behavior + reviewed. Anything less is "in progress" —
say so plainly.
