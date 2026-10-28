# Personalization — Implementation Plan & Costing

_Companion to [`PERSONALIZATION-STRATEGY.md`](./PERSONALIZATION-STRATEGY.md). That
doc owns the **strategy** (3 levels × 4 types, layouts, moat, SEBI, Linear map).
This one owns **execution order, the sub-category axis, the data loop, and cost.**_

---

## 0. The finding that reorders the phasing

`PERSONALIZATION-STRATEGY.md` §3 specifies drift precisely:

> bumps `confidence` (+0.05/consistent night, cap 0.95; **contradiction decays 0.1**)

**That decay does not exist in the code.** Three independent updates are
monotonic, so a persona today can only ever climb:

| Ratchet                         | Where                                                                                                                       | Effect                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pKnown` only rises             | `applyUpdate` NEUTRAL branch — `pKnown + (1−pKnown)·pLearn·0.25`                                                            | Asking "what is P/E?" 10× drives mastery → 1.0. Confusion reads as competence. |
| `experienceLevel` only promotes | [investor-rollup-logic.ts:421](../../workers/src/processors/investor-rollup-logic.ts) calls `promoteExperience`, no inverse | One month of F&O ⇒ `ADVANCED` permanently                                      |
| `confidence` only rises         | `Math.min(CEIL, confidence + step)`                                                                                         | A profile that went quiet 8 months ago is still trusted at 0.85                |

The only downward force anywhere is `decayStaleMastery`, and it fires on
**absence**, never on struggle — so a confused-but-active user decays _slower_
than a competent-but-quiet one.

Consequence: every P0 ticket (layouts, sidebar matrix, settings panel) would ship
on top of a classifier that cannot demote. Users would be sorted upward into
dense ADVANCED layouts and never sorted back. **Phase 0 below must land first**;
it is ~4 dev-days and unblocks the correctness of everything after it.

A second, independent disconnect: the welcome quiz writes to Clerk
`unsafeMetadata` ([welcome/client.tsx:169](../../apps/web/app/welcome/client.tsx)),
which nothing in the personalization path reads. `seedProfile` derives everything
from behavior, so a brand-new user with no holdings gets
`MODERATE / BEGINNER / confidence 0.1` **regardless of what they answered**. The
questionnaire is currently decorative. MONEY-397 must include the write-through.

---

## 1. Category model — reconciling the two framings

Keep the strategy doc's model. It is the right one; it just needs its naming
levels separated:

| Axis             | Field             | Cardinality | Drives                             | Status            |
| ---------------- | ----------------- | ----------- | ---------------------------------- | ----------------- |
| **Category**     | `experienceLevel` | 3           | Layout density + jargon depth      | ✅ in prod schema |
| **Type**         | `userType` (new)  | 4           | Module mix / accent pack           | 🎫 MONEY-999      |
| **Sub-category** | derived (§2)      | ~3 per cell | Content, nudge, and chip selection | new — this doc    |

3 × 4 = 12 cells, ~9 real (FIRST_TIME collapses at INTERMEDIATE/ADVANCED). The
human-readable persona names (_"Advanced Trader"_, _"Learner"_, _"FIRE Seeker"_)
are a **display label** computed from the cell — used in the Settings panel and
nowhere else. They are not a third stored enum.

**Nothing materializes the category.** `classifySegment(profile) → cell` is a pure
function of the live vector, so when drift moves the vector the cell follows —
with no backfill job and no reconciliation branch. This is the whole answer to
"categories shouldn't be hardcoded": don't store the label, store the evidence.

### Hysteresis (required, not optional)

A pure argmax over a nightly-drifting vector makes boundary users flip-flop —
`Learner` Monday, `Stock Picker` Tuesday — and the dashboard variant and nav
order visibly thrash. So persist `{ segment, since, challenger, challengerSince }`
as a **debounced cache, explicitly not as truth**:

- challenger must beat incumbent by margin **M** (start: 0.15 on the score), and
- hold that lead for **D** consecutive nights (start: 3), then promote.
- `MANUAL` override pins the cell and is exempt (per strategy §0 resolution order).

---

## 2. Sub-categories — the third axis, free from existing data

The strategy doc's accent packs cover _type_. Sub-categories should answer a
different question: **within a cell, what does this user actually engage with?**

Derive from data already being written, so collection cost is zero:

| Sub-axis             | Source                                                      | Values                                                     |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| **Dominant domain**  | `ConceptMastery` grouped by `ConceptDomain` (`concepts.ts`) | asset · valuation · risk · deriv · tax · portfolio · macro |
| **Engagement state** | `UserEvent` recency                                         | onboarding · active · cooling · dormant                    |

Sub-category = _(dominant domain, engagement state)_. Worked examples:

- `ADVANCED × TRADER × deriv/active` → expiry ladder leads, options-greeks chips
- `ADVANCED × TRADER × deriv/cooling` → same layout, re-engagement nudge instead of new modules
- `INTERMEDIATE × INVESTOR × tax/active` → tax preview leads (the FIFO moat widget)
- `INTERMEDIATE × INVESTOR × valuation/active` → screener + factor x-ray lead

Critically, sub-category drives **content selection only** — which chips, which
nudge, which widget leads. It never changes layout or nav, so it can move daily
without needing hysteresis. That split is what keeps 9 cells × ~3 sub-categories
from becoming 27 things to design: it stays **3 layouts × 4 accent packs +
a content ranker**.

---

## 3. Phasing

### Phase 0 — Unblock drift (4 dev-days) · prerequisite for all P0 tickets

| Task                                                                                                                   | Est  |
| ---------------------------------------------------------------------------------------------------------------------- | ---- |
| `comprehension.ts` classifier + unit tests ([seam already created](../../packages/core/src/investor/comprehension.ts)) | 1.0d |
| Wire into `capture.ts`; **batch** the write path (§5)                                                                  | 1.0d |
| Symmetric `driftProfile`: demotion branch + confidence decay + tests                                                   | 1.5d |
| Bandit cold-start fix: global-prior fallback under N tagged rows                                                       | 0.5d |

### Phase 1 — Categories (13 dev-days) · maps to existing P0 tickets

| Task                                                                        | Ticket          | Est  |
| --------------------------------------------------------------------------- | --------------- | ---- |
| Schema: `userType`, `personaSource`, `personaUpdatedAt`, `UserUiPreference` | MONEY-999       | 1.0d |
| Quiz → `InvestorProfile` write-through at `confidence 0.6` (§0 disconnect)  | MONEY-397       | 1.0d |
| `classifySegment` + hysteresis cache + tests                                | MONEY-1004      | 2.0d |
| 3 dashboard layouts                                                         | MONEY-1000/1012 | 5.0d |
| Sidebar visibility matrix + overrides                                       | MONEY-1005      | 1.5d |
| Settings → Personalization panel incl. the "why" from `seededFrom`          | MONEY-1006      | 2.0d |

### Phase 2 — Sub-categories + the data loop (8 dev-days)

| Task                                                      | Ticket     | Est  |
| --------------------------------------------------------- | ---------- | ---- |
| Sub-category derivation + content ranker                  | new        | 1.5d |
| Accent packs (4)                                          | MONEY-1007 | 3.0d |
| Instrumentation events + in-DB aggregation (§5 cost note) | MONEY-1010 | 2.0d |
| Weekly persona-health query + KPI review wiring           | MONEY-907  | 1.5d |

**Total: ~25 dev-days ≈ 5 working weeks for one engineer.**

---

## 4. The data loop — what gets collected and how it is analysed

Already-flowing writes (no new collection needed):

| Table                       | Written by                      | Reads as                                   |
| --------------------------- | ------------------------------- | ------------------------------------------ |
| `ConceptMastery`            | `applyConceptSignal` per turn   | knowledge depth per domain                 |
| `UserEvent`                 | `capture.ts` per turn/run/roast | engagement recency + surface mix           |
| `PortfolioBehaviorSnapshot` | nightly rollup                  | the level/type inference inputs            |
| `ResultFeedback`            | 👍/👎                           | bandit reward                              |
| `PortfolioInsight`          | nightly rollup                  | narrative, incl. `persona_shift` proposals |

The weekly analysis that closes the loop — four questions, all answerable from
the tables above with no new pipeline:

1. **Misclassification proxy** — override rate per cell. >15% in any cell means
   that cell's inference rule is wrong (strategy §11 KPI).
2. **Drift sanity** — distribution of promotions vs demotions. After Phase 0,
   a healthy system shows _both_. All-promotions means a ratchet survived.
3. **Layout efficacy** — D7 retention and widget CTR by cell vs the flat
   baseline. This is what eventually feeds the bandit (MONEY-791) at the layout
   level rather than just the prose level.
4. **Comprehension calibration** — for users who self-reported `pro`, what
   fraction had mastery demoted within 30 days? That number tells you how badly
   self-report over-reads, and it retunes the questionnaire's confidence prior.

---

## 5. Costing

### Assumptions (replace with real figures as they land)

50,000 free + 1,000 paid (the 6-month goal in the strategy doc header) · free
2 chat turns/user/day · paid 8 · memory block ≈ 250 input tokens/turn · pricing
from [`packages/core/src/gemini/pricing.ts`](../../packages/core/src/gemini/pricing.ts).

### A. Inference / token cost — small

| Item                                             | Volume/month                   | Rate             | Cost/month |
| ------------------------------------------------ | ------------------------------ | ---------------- | ---------- |
| Memory block, free tier (`gemini-2.5-flash`)     | 3.0M turns × 250 tok = 750M in | $0.075/1M        | **$56**    |
| Memory block, paid (`gemini-3.5-flash`)          | 240k turns × 250 tok = 60M in  | $0.60/1M         | **$36**    |
| Comprehension classifier (heuristic)             | —                              | —                | **$0**     |
| Nightly rollup compute (Cloud Run, ~8 min/night) | 500 vCPU-s/night               | $0.000024/vCPU-s | **~$0.50** |

**Subtotal ≈ $93/month.** If paid users route to `gemini-3.1-pro-preview`
($2.00/1M in) instead, the paid line becomes $120 and the subtotal ~$177.

An LLM-based comprehension classifier (Flash-Lite, ~300 in / 30 out per turn)
would cost ≈ **$68/month**. To be straight about it: that is _not_ a meaningful
saving at this scale. The real arguments for the pure heuristic are per-turn
**latency** and **determinism under test** — not the money.

### B. Atlas write amplification — the avoidable one

`captureChatSignal` → `nudgeConcepts` loops up to `MAX_CONCEPTS_PER_CAPTURE = 8`
concepts, and `applyConceptSignal` does `findUnique` + `upsert` per concept —
**16 sequential round-trips per chat turn**, plus the `UserEvent` create. At
3.24M turns/month that is ~55M ops.

It is `void`-ed so it never blocks the response, but it consumes connection pool
and IOPS, and it is the highest-volume write path in the product. Replacing the
loop with one `findMany` + one `bulkWrite` cuts 17 ops → 3.

Atlas is provisioned, not per-op, so the saving is a **tier**: M30 ≈ $390/mo vs
M40 ≈ $685/mo. Batching is ~2 hours of work against **~$295/month** of avoidable
spend — by far the best ratio in this plan.

### C. Analytics — the largest line item, and the surprising one

50k users × ~20 events/day ≈ **30M events/month** to PostHog. On declining
volume tiers that lands roughly **$450–900/month** (wide band — PostHog's per-event
rate falls steeply with volume; confirm against the actual bill before committing).

**Instrumentation costs more than inference — by roughly 5–10×.** The mitigation
is architectural: `UserEvent` already durably records the persona events in Mongo,
which you are paying for regardless. Aggregate the persona KPIs **in-DB** for the
weekly review and send PostHog only the funnel-critical events
(`persona_questionnaire_completed|skipped`, `persona_overridden`,
`layout_rendered`). That is a ~5-event subset, cutting this line by an estimated
60–75%.

### D. Run-rate summary

| Line                  | Naive          | Optimised                    |
| --------------------- | -------------- | ---------------------------- |
| Tokens (memory block) | $93            | $93                          |
| Atlas tier headroom   | $295           | $0 (batch writes)            |
| Analytics             | $450–900       | $110–270 (in-DB aggregation) |
| Cloud Run             | $0.50          | $0.50                        |
| **Total/month**       | **$840–1,290** | **$205–365**                 |

Two conclusions worth internalising: **the AI is the cheap part**, and the two
biggest levers are both engineering hygiene (batch the writes, aggregate events
in-DB) rather than model or vendor choices.

### E. Build cost

~25 dev-days. Converting that to money depends on whose time it is — at a
notional ₹12,000/day contractor rate it is ≈ ₹3.0L; as founder time it is 5
weeks of opportunity cost. Add Claude Code usage for the build itself, which for
25 days of agent-assisted work on a repo this size is a real but modest line —
size it from your own recent per-day burn rather than an estimate here.

---

## 6. Ordering constraint, stated once

Phase 0 → Phase 1 → Phase 2 is a hard dependency chain, not a preference:

- Layouts (P1) sort users into densities. Without Phase 0's demotion they sort
  **one way only**, and the mistake is unrecoverable per-user.
- Sub-categories (P2) rank content by mastery domain. Without Phase 0's
  comprehension signal, mastery reflects _exposure_, so the ranker would
  confidently promote the domains a user is most confused about.

_Last updated: 2026-08-05_
