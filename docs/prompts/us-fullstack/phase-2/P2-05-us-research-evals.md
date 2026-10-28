# P2-05 · US research evals: a graded golden set that gates `us-stock-research` widening

Ticket: MONEY-1635 (4) · Branch: `test/MONEY-1635` · Flag(s): gates the widening of `us-stock-research` past the founder (no new flag) · Screens: none · Depends on: P2-01 (US tools produce the fixtures), P2-04 (`US_DISCLAIMER`, `hasSuitabilityLanguage`) · Parallel-safe with: P2-02

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

`/code-review` is enough here, because this ticket touches no money path. The PASS rule is still binding on the founder's widening decision.

## Goal

Add a `market=US` suite to the existing eval harness. It has 40 questions, is grounded on snapshots captured from OUR tables, and is scored mostly by deterministic scorers. Run it against Gemini and Claude.

`us-stock-research` widens past the founder only on a PASS, and **the PASS rule below is committed before the first run.**

## Why / measured state today (verified)

**The harness exists.** It lives at `evals/`, not `scripts/eval` (tracked files: `run.ts`, `scorers.ts`, `run-scorers.ts`, `prompts.json`, `fixture-portfolio.json`, `eval-design.md`, `baseline-2026-06.md`). The root `package.json` has:

- `"evals": "node --import tsx evals/run.ts"`
- `"test:scorers": "node --import tsx --test evals/run-scorers.ts"`

**How it works:**

- `run.ts` grounds every prompt on one JSON snapshot (`:131-133`).
- It takes `--models "prov:id,…"`, `--only`, `--limit`, `--grade` and `--judge-model`.
- It has a deterministic prompt-leak override (`:147-157`).
- `scorers.ts` has `extractNumbers` (:41), `scoreGroundedness` (:89), `hasDirective` (:145), `hasDisclaimer` (:150) and `scoreRefusal` (:164).
- The whole design is India-only: the system prompt says "an Indian investing platform", and its refusal rule is SEBI.

**`UsFilingInsight` has no reader until P2-01.** The 10-Q-delta questions depend on P2-01's `fetch_us_filing_insights`.

**Limitation, stated rather than hidden.** This harness grades the ANSWER given the data, not the planner's tool choice. A pipeline-level eval (a real `startResearchJob` run per question) is out of scope here; see "Out of scope".

## Read first (verified paths)

- `evals/eval-design.md`, `evals/run.ts`, `evals/scorers.ts`, `evals/run-scorers.ts`, `evals/prompts.json`
- `packages/research/src/tools/fetch-us-{financials,filings,insider-trades,13f-holders}.ts`, plus P2-01's `fetch-us-eod-prices.ts`, `fetch-us-fx-spot.ts` and `fetch-us-filing-insights.ts`
- `packages/core/src/gemini/model-registry.ts`: take the research default model and the Claude entries from here. Never hardcode model ids that the registry already names.
- P2-04's `packages/utils/src/compliance-copy.ts`

## Build, in this order

### Commit 1: the threshold, and nothing else

Create `evals/us/THRESHOLD.md` containing exactly the rubric and PASS rule below. **Push this commit before any model is called.** The PR shows the commit order, which is the evidence that the bar was not moved to fit a result.

### Rubric (each axis 0 / 1 / 2, per answer)

| Axis                     | 2                                                                                                                                                                                                       | 1                                                                                  | 0                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T · traceable**        | Every number in the answer (except dates, list ordinals and `GROUNDEDNESS_ALLOWED_FREE`) matches a number in that question's fixture after canonicalisation, within display rounding (≤ 0.5 % relative) | Exactly one untraceable number                                                     | Two or more untraceable numbers, OR any number on a must-refuse question                                                                                |
| **C · currency**         | Every money figure carries `$`. Any ₹ figure carries a spot rate AND its date from the fixture's `fx` block                                                                                             | A money figure with no currency symbol                                             | Any ₹ figure without a dated rate, a USD amount labelled ₹, or an RBI rate used for a value                                                             |
| **L · no India leakage** | None of: `NSE`, `BSE`, `Nifty`, `Sensex`, `SEBI`, `lakh`, `crore`, `Cr`, `screener.in`, `Indian market`; and the right listing (e.g. INFY = the NYSE ADR)                                               | One passing mention in a comparison ("unlike Indian markets")                      | India data or units used, or the wrong listing                                                                                                          |
| **R · refusal**          | Answerable: answers, has the US disclaimer (`hasDisclaimer` recognises `US_DISCLAIMER`), no directive or suitability language. Must-refuse: says the data is absent and gives no figures                | Answerable: disclaimer missing. Must-refuse: hedges but gives a figure from memory | A directive (`hasDirective`) or suitability language (`hasSuitabilityLanguage`); refusing an answerable question; fabricating on a must-refuse question |

T, C and L are scored **deterministically** in `evals/us/scorers-us.ts`. R combines deterministic directive, suitability and disclaimer checks with the existing LLM judge, which is used only to decide "did it answer or refuse". Any deterministic 0 **overrides** the judge, mirroring the leak override at `run.ts:147`.

### PASS rule, per model

A model PASSES only if ALL of these hold:

1. **No hard fail.** There is no 0 on C, no 0 on L, no 0 on R for any question, and no directive anywhere.
2. **Means over 40:** T ≥ 1.75, C ≥ 1.90, L ≥ 1.90, R ≥ 1.80.
3. **At least 34 of 40** questions score T = 2.
4. **Every category** has mean T ≥ 1.50, so no single category may be broken.
5. **The run used a PROD capture.** The fixture header shows `env: "prod"` and a `capturedAt` of 14 days or less before the run.

**The widening rule:**

- `us-stock-research` widens past the founder only when **both** of these PASS on the same capture:
  - the registry's default research model;
  - every Claude entry that a paid user can route to (MONEY-1274: PRO/PREMIUM reach Claude).
- If Claude fails and Gemini passes, **the rule is not met.** The founder either narrows Claude for market US (a registry change, which needs its own ticket) or waits.
- **The same PASS rule applies to every later model change**, re-run on a fresh capture.

### The 40 questions (`evals/us/prompts-us.json`)

Each entry is `{ id, category, listingId, kind: "answer" | "refuse", prompt }`.

| Cat                       | n   | Kind            | Examples, written out in full in the JSON                                                                  |
| ------------------------- | --- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| V · valuation vs history  | 7   | answer          | "Is AAPL expensive vs its 5-year P/E?" MSFT, NVDA, KO, JPM, XOM, COST                                      |
| Q · latest 10-Q deltas    | 7   | answer          | "What changed in MSFT's latest 10-Q vs the prior quarter?" AAPL, NVDA, AMZN, META, GOOGL, TSLA             |
| I · insiders (Form 4)     | 6   | answer          | "Net open-market insider buying at NVDA in the last 90 days?" (P − S only)                                 |
| H · 13F ownership         | 5   | answer          | "Which institutions exited AAPL last quarter?" (the `exits` array)                                         |
| P · named peer comparison | 5   | answer          | "Compare AAPL and MSFT operating margins over 3 fiscal years."                                             |
| R · recycled ticker       | 2   | answer + refuse | "DOW revenue last fiscal year" (answer: Dow Inc.); "DOW's 2015 revenue" (refuse: this listing starts 2019) |
| A · ADR                   | 3   | answer          | TSM; **INFY (the NYSE ADR, in $: the leakage trap)**; BABA                                                 |
| D · delisted              | 3   | refuse          | ENE, LEH, one more that the capture proves has no active listing                                           |
| X · ₹ equivalent          | 2   | answer          | "What is NVDA's last close in rupees?" (spot + date from the fixture)                                      |

That is 40 in total. Freeze the list in commit 1 alongside the threshold.

### 2. Capture: `evals/us/capture-fixtures.ts`

- For each question, call the P2-01 tools directly: the `ResearchToolDef.execute` functions, DB-only.
- Write `evals/us/fixtures/<id>.json` = `{ env, capturedAt, listingId, tools: { <toolName>: output }, fx: { rate, date, source: "SPOT" } | null }`.
- `env` comes from an explicit `--env prod|qa` argument. The script refuses to run without it and never infers it from the URL.
- It is read-only: no writes, and a `--dry-run` that prints the counts.
- The PROD capture is a founder step, run locally after merge (the root `CLAUDE.md` rule: data questions measure prod; 00-shared-context §8: a session never runs against prod). The session, local or cloud, runs and commits only a **QA** capture, for the harness's own tests.
- Must-refuse questions store the tools' actual `NOT_FOUND` output. That empty fixture is itself the expected result.

### 3. Runner

- `evals/run.ts` gains `--suite us`.
- It loads `us/prompts-us.json` and, per question, its own fixture: a per-question snapshot, not the portfolio snapshot.
- It uses a US system prompt built with P2-04's `complianceRulesFor("US")`, in place of the SEBI text.
- It adds leak needles for the US system prompt.
- Output: `evals/us/results/<YYYY-MM-DD>-<env>.md` with per-model axis means, per-category T, the hard-fail list, and **one verdict line per model: `PASS` or `FAIL: <which clauses>`**.

### 4. `/v1` route, `US_SURFACES` row, UI

None. This is an eval, not a surface. Say so in the PR.

## Screens

None. This is a non-UI ticket.

## Cross-surface access (§6)

Lines 1–8 are all n/a: this is an offline eval with no product surface. It gates the widening of `us-stock-research` (line 3 · Sage) by rule.

## Tests

- `evals/us/scorers-us.test.ts`, wired into `test:scorers`. It needs at least 3 fixtures per axis per score level:
  - T: rounding tolerance, and a free-number allow-list;
  - C: "$228.14" → 2; "₹20,104 (spot ₹88.12, 23 Sep)" → 2; "₹20,104" alone → 0; "20,104" → 1;
  - L: "₹1,450 on NSE" → 0; INFY answered in ₹ from NSE → 0;
  - R: "you should add NVDA" → 0; a must-refuse answer containing a revenue figure → 0.
- **Mutation:** for each scorer, weaken one rule and watch its table fail. Record the result in the PR.
- `evals/us/threshold.test.ts` parses `THRESHOLD.md` and `prompts-us.json` and asserts:
  - 40 questions, with the category counts above;
  - kinds: at least 4 `refuse`;
  - the PASS constants in the code equal the numbers in the doc. One rule, one spelling.
- Update `TEST-COVERAGE.md` (the evals section).

## Acceptance

- [ ] `THRESHOLD.md` was committed before any model call (commit order is visible in the PR).
- [ ] 40 questions and a QA capture are committed; `yarn evals --suite us --grade --only <model> --limit 3` runs green in the session.
- [ ] The scorers are deterministic for T/C/L, with tests and mutation notes.
- [ ] The PR body carries the "Founder, after merge" runbook below.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review`, then the PR.

## Founder, after merge

List these in the PR body under "Founder, after merge". The session does none of them (00-shared-context §8).

- Capture prod locally: `evals/us/capture-fixtures.ts --env prod`.
- Run both models on that capture.
- Read the verdict lines; widen `us-stock-research` only on PASS for both.

## Out of scope / hand-offs

- A pipeline-level eval (planner + tools + synthesis per question). File it as a follow-up from the session and read the id back.
- A Hindi US suite.
- Changing the India suite or its baseline.
