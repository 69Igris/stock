---
name: babysit-pr
description:
  "Watch a UseMoney PR through to merge and clean up after it — designed as
  the body of a time-based loop: `/loop 10m /babysit-pr <PR# or branch>`.
  Each run: fetch, detect the squash-merge on origin/main, (with gh) check
  CI and fix failures, and after merge do the post-squash-merge local
  cleanup (checkout main, ff-pull, delete the stale branch) then END the
  loop. Trigger on: 'babysit the PR', 'watch my PR', 'check my PR until it
  merges', 'address review comments and fix CI', or after pushing a branch
  the user intends to merge."
---

# Babysit a PR to merge

One invocation = one check cycle. In a `/loop`, each interval runs this once;
the loop ENDS when the merged-and-cleaned report is delivered.

## Resolve the target

- Arg is a PR number, a branch (`{type}/MONEY-{n}`), or empty (= current
  branch). Extract the ticket `MONEY-{n}` from the branch name — squash
  commits on main are titled like `fix(MONEY-1051): … (#250)`, so both the
  ticket and the PR number are grep-able merge signals.

## Check cycle

1. `git fetch origin main --quiet` (never `pull` here; don't touch the
   working tree while the user may be mid-edit).
2. **Merged?** `git log origin/main --oneline -30` and grep for `(#<PR>)` or
   `<TICKET>:`. Corroborate with `git ls-remote --heads origin <branch>`
   (branch gone = merged + auto-deleted). Either signal → step 4.
3. **Not merged — CI state:**
   - If `gh` is installed (`command -v gh`): `gh pr checks <PR>` /
     `gh pr view <PR> --json state,statusCheckRollup,reviews`. Failing CI →
     read the failing job's log, load `fixing-bugs`, fix the SOURCE, run the
     full `verify-before-push` gate, and push the fix (the push gate applies
     — no shortcuts). Unresolved review comments → address them the same
     way.
   - If `gh` is absent (current state of this machine): CI status is not
     visible from git alone. Report "not merged yet; CI unknown (install gh
     — `brew install gh` — to unlock CI-fixing in this loop)" and end this
     cycle. Do NOT guess CI state.
4. **Merged → cleanup** (this skill IS the standing consent to switch
   branches for post-squash-merge cleanup; it exists to enforce the
   check-branch-after-merge rule):
   - Working tree must be clean apart from intentionally-kept files;
     NEVER stash to force it (agents must never `git stash`). Dirty tree →
     report and stop instead.
   - `git checkout main && git pull --ff-only origin main`
   - Confirm the squash commit for the ticket is in `git log -5 --oneline`.
   - `git branch -D <branch>` (squash merges need `-D`; the log check above
     is the safety), only for the babysat branch — never touch other
     branches or the user's chore commits.
5. **Report and end the loop**: merged PR, squash SHA, branch cleaned,
   anything skipped. In a `/loop`, say the goal is reached so the loop
   stops; mid-loop cycles report one line ("PR #N: CI pending, next check in
   10m").

## Boundaries

- Never force-push, never rebase the PR branch, never close/merge the PR
  yourself — merging is the founder's call (self-approval repo).
- Fixes pushed from this loop follow every standing rule: full verify gate
  before push, no test-weakening, TEST-COVERAGE.md sync if tests changed.
