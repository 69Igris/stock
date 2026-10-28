# UseMoney - Pending Ops + Code TODOs

> **Source of truth for things that ship as code but aren't done until an ops
> step runs by hand.** Each entry has an owner, a "blocks?" answer, and the
> exact command to run when the prereq is met. Move closed items to the bottom
> under "Done".
>
> When you add a new entry, keep the format: `### MONEY-XXX · short title` then
> `Blocks?` / `Trigger` / `Steps` / `Verification`.

---

## Open

### MONEY-241 · Implement missing v2 compute tools (~24 tools)

**Status:** P0 / Urgent - filed, not yet started **Owner:** research-platform
engineer **Filed:** 2026-05-03 **Linear:**
https://linear.app/dis-digital/issue/MONEY-241

#### Blocks?

**Partially.** The Deep mode + multi-skill flow already runs (per the MONEY-240
prompt fix), but the analytical depth users see is capped at the ~25 tools that
exist. Picking `quant-factor-scores`, `regime-volatility`, or
`risk-portfolio-impact` falls back to their dependency fetches - synthesis
comments on the gap rather than running the actual factor model / vol regime /
portfolio VaR.

- Stops users from getting the full v2 vision when they pick those three skills.
- Other v2 skills (fundamentals-core, dcf-valuation, technical-trend,
  chart-pattern-detection, etc.) are fully wired and unaffected.
- New analyses (with the 9-skill "Deep" preset) emit ~22 tasks post-fix instead
  of the broken 17.

#### Today's mitigation (already shipped on `feat/MONEY-240`)

`buildPlannerUserPrompt` in `packages/research/src/prompts.ts` now:

1. Names ONLY tools that exist in the registry - no more phantom
   `compute_factor_scores` etc. that the executor can't dispatch
2. Marks unimplemented v2 skills explicitly so the LLM emits their data
   dependencies as fallback tasks
3. Computes `minTasks = min(28, 8 + customSkills.length × 2)` so the planner is
   forced to expand per-skill

The mitigation prevents executor "tool not found" errors but does NOT restore
the full v2 capability.

#### Trigger

After MONEY-240 ships and stabilises in prod (give it ~3 days of clean runs to
confirm the prompt rewrite holds).

#### Steps

See the full tool list (~24 entries) on the Linear ticket. Each new tool is a
new file under `packages/research/src/tools/`, registered in the tool registry,
added to `SKILL_TOOL_ALLOWLIST`, and unit-tested.

#### Verification

Pick 9 skills + Deep mode → planner emits ≥ 22 tasks, all execute without
`tool not found` errors in worker logs.

---

### MONEY-240 · Run ETF expense audit + flip weekly scheduler — **SUPERSEDED**

**Status:** closed by MONEY-1404 (2026-09-13) **Filed:** 2026-05-03

#### Do NOT do what this said

Step 2 used to read "flip the scheduler". Following it today would provision a
Cloud Scheduler job firing at `/jobs/etf-expense-enrichment`, which answers 200
`{retired:true}` and **drops every message** — a weekly no-op that reads as a
healthy job. The scheduler is already removed from `setup-scheduler.sh` AND is
on its stale-delete list.

#### Why the worker could never have worked

Its only source, `https://mf.captnemo.in/kuvera/{ISIN}.json`, is dead — 404 for
every ISIN including captnemo's own documented sample (re-probed 2026-08-18).
But it never reached the 404: `fetchKuveraMetadata` short-circuited to `null`
unless `MF_METADATA_PROVIDER === "kuvera"`, and both cloudbuild specs set
`"amfi"`. Every candidate fell to `notFound++`, `written` was 0, and the job
returned cleanly. Every Sunday, in both environments, since MONEY-209. The
provider itself is now deleted outright (MONEY-1409).

The verification query that used to sit here counted
`metadataSource: "kuvera"` and asserted `>= 200`. Nothing has ever written that
value and nothing can now, so it was a check that could only ever fail — or,
worse, be "fixed" by re-arming the dead path.

#### What actually fills the column

AMFI's own monthly TER file, parsed by `mf-metadata-weekly` through
`amfi-fund-metadata-provider.ts` — a primary source, from the regulator's own
publication, **63.5% coverage measured 2026-08-18** against this job's zero.

#### What is still worth running

`scripts/data/audit-etf-expense-ratio.ts` (READ-ONLY). It is no longer a
feasibility gate for a worker; it is the standing coverage count, i.e. whether
the AMFI source is keeping up. See `scripts/README.md`.

---

### MONEY-218 · Flip `ENABLE_GEMINI_3_1_PRO` env after Vertex GAs 3.1-Pro

**Status:** waiting on Vertex GA in `asia-south1` **Owner:** anyone with Vertex
AI console access **Filed:** 2026-05-03 (re-opened after MONEY-240 partial drop)

#### Blocks?

**No** - `gemini-3.1-pro` is hidden from the picker until the env flag is
flipped. Users can pick `gemini-3.0-pro` (richer) or `gemini-2.5-pro` (cheapest
Pro) instead.

The 3.0-flash family is NOT env-gated - Google's GA catalog confirms
availability. Only 3.1-pro stays gated because Vertex returns 404 in
`asia-south1` at the time of writing (otherwise PRO users would see a silent
failure on selection).

#### Steps

1. Test a one-off Vertex AI call with `model="gemini-3.1-pro"` from a Cloud Run
   instance in `asia-south1`. Confirm it returns 200.
2. Set `ENABLE_GEMINI_3_1_PRO=true` in Cloud Run env vars (QA + prod).
3. Set the same in `apps/web` Vercel env vars.
4. Re-deploy.
5. Verify the picker now shows "Gemini 3.1 Pro" with the +2 credit premium for
   PRO users.

---

## Done

_Move closed items here with the date they shipped + a one-line note on the
outcome. Keeps the open list scannable._

### 2026-05-03 · 3.0-flash family env-gate dropped

`gemini-3.0-flash` and `gemini-3.0-flash-lite` are paywall-only now (no env
flag). PRO users see them in the picker immediately. 3.1-pro stays env-gated -
see the open MONEY-218 entry.

## Remove the web UDF fallback routes — 14 days AFTER the prod flag goes on (MONEY-1468 / A3)

`apps/web/app/api/market/udf/*` stays as the fallback for two weeks after the
`MARKET_DATA_TILES` flag reaches prod, then comes out.

**Do not remove it while the flag is OFF in prod.** The flag is the rollback:
`resolveUdfBaseUrl` returns the legacy route for every ambiguous input — flag
unset, URL malformed, Mongo unreachable — so deleting these routes converts a
graceful fallback into a blank chart with no error, which is the failure mode
the whole A1–A3 design is written against.

Preconditions, all of them:

- [ ] `MARKET_DATA_TILES` ON in prod for 14 clear days. **THE CLOCK STARTED
      2026-09-18** — the row was set `true` on PROD that day and VERIFIED
      (`set-market-data-flags.ts --env prod` reads
      `effect: chart reads /udf from the market-data SERVICE`), so every chart is
      now on the service. **Earliest removal date: 2026-10-02.**
      This entry read "THE CLOCK HAS NOT STARTED — as of 2026-09-15 the row does
      not exist in any environment" until MONEY-1475 measured it. Re-read the flag
      before trusting this line; it is a PlatformConfig row, so nothing in the repo
      can tell you its value.
      An earlier draft of this file recorded "set 2026-09-15 → earliest 2026-09-29"
      while the cutover was not even wired — a countdown toward deleting the routes
      the flag was silently still using.
- [ ] `docs/reference/udf-parity-2026-09.md` shows zero UNEXPLAINED failures
- [ ] the `usemoney-market-data` p95 monitor has been green across a full trading week
- [ ] `tile-build-d1-in-daily-prod` has run nightly with `builtEmpty` well below `built`

Ten `apps/web/__tests__` files import the UDF route logic; removing the routes
means removing or repointing those too.
