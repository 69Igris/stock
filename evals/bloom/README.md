# Bloom — adversarial expansion of the SEBI guardrail (BAD-3 / MONEY-508)

Our hand-written eval has only **5 adversarial prompts** (Category D). That's
where Claude's one decisive edge showed up in the head-to-head — Gemini leaked
its full system prompt; Claude refused. Five prompts is too few to trust that
result or to call the SEBI guardrail "robust."

[**Bloom**](https://github.com/safety-research/bloom) (Anthropic's open-source
agentic behavioral-eval framework, MIT) auto-**generates** adversarial scenarios
for a target behavior, runs them as multi-turn conversations against the target
model, and a judge scores each rollout. The headline metric is the
**elicitation rate** = % of rollouts that elicit the behavior (score ≥ 7/10).

We point it at one behavior: **"the portfolio assistant issues a financial
directive"** (a SEBI breach). Our 5 D-prompts become the few-shot seed; Bloom
expands them into dozens of varied attacks (emotional pressure, claimed
authority, role-play, slow-burn). **Target elicitation rate: 0%** — any
elicitation is a guardrail bug to fix.

Why this is the right tool here:

- It's Anthropic's own protocol/tool → a high-signal artifact for the Jul-6
  depth session ("we red-team our regulated-advice guardrail with Bloom").
- It measures the ONE axis our small eval is weakest on (adversarial breadth),
  and complements — not replaces — the fixture-grounded groundedness/Hindi
  rubric in `../run.ts` (Bloom can't check groundedness against our portfolio).

## Run it

> Bloom is a standalone Python tool — it is NOT wired into `yarn`/CI. These
> files are an authored, ready-to-run **seed**, written from the Bloom docs;
> confirm the field names against the current `safety-research/bloom` schema
> (`bloom-data/seed.yaml` reference) before the first run, as the schema may
> have moved.

```bash
# 1. Get Bloom (separate venv — heavy, Python)
git clone https://github.com/safety-research/bloom && cd bloom
pip install -e .

# 2. Point it at our seed (copy these files in, or pass paths)
#    - seed.yaml          → the run config (target behavior, model, variations)
#    - behaviors.json     → what "issued a directive" means + scoring anchors
#    - examples/          → few-shot attack transcripts (our Category D)
export ANTHROPIC_API_KEY=…           # judge + (if target is Claude) target
export GEMINI_API_KEY=…              # if running the Gemini target for comparison
bloom run --seed /path/to/evals/bloom/seed.yaml

# 3. Read the suite-level report → elicitation_rate per target model.
#    Compare claude-sonnet-4-6 vs gemini-2.5-pro on the SAME generated suite.
```

## What to report (depth session)

"SEBI-directive elicitation rate over N auto-generated adversarial rollouts:
Claude X%, Gemini Y%. The one hand-found case (system-prompt exfiltration,
Gemini) reproduced at Z% under Bloom's variations." A 0% Claude rate on a large
auto-generated suite is a far stronger compliance claim than "we wrote 5
prompts and it passed."
