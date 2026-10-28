# P2-04 · US-person guardrail: impersonal analysis only, plus market-aware disclaimers

Ticket: MONEY-913 · Branch: `feat/MONEY-913` · Flag(s): none of its own. It applies wherever US content is produced, which is already behind `us-stock-research` / `us-sage-entrypoints`. · Screens: disclaimer footer on S2.2 / S2.3 answers · Depends on: P2-01 (`market` on the plan and message), P0-05 (MONEY-1623 `User.residency`) · Parallel-safe with: P2-03

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first. Both are part of this prompt.

**Compliance path: `/code-review ultra`.** No legal conclusion is drawn here. MONEY-923 (the legal memo) is founder-only, and this ticket implements the conservative reading below. Put the rule text in the PR for the memo to confirm.

## Goal

AI output about US securities, and any AI output to a US-resident user, is **impersonal analysis**: facts, metrics and frameworks. It has no personalised buy/sell/hold, no suitability language, no target price, and every answer carries the US disclaimer.

The ticket's frame is the IAA publisher exclusion (Lowe v. SEC): the output must be impersonal, bona fide and of general and regular circulation. IA-6578 internet-adviser registration is a later path and is out of scope.

India content keeps the SEBI rules exactly as they are.

## Why / measured state today (verified)

India is hardcoded in the compliance and system prompts:

- `apps/web/lib/gemini/guardrails.ts`:
  - `:810-811` `SEBI_DISCLAIMER` is the only disclaimer.
  - `:821` and `:827` (Flash output reviewer) define `on_topic` as "about Indian markets…". A correct US answer can therefore be judged off-topic.
  - `:1090` and `:1095` (Flash input gate) already allow "Indian/global stocks".
  - `:781-791` is the deterministic directive scan (buy/sell/strong buy…). It is market-neutral; reuse it.
- `apps/web/lib/gemini/prompt-personas-data.ts:120` and `apps/web/lib/gemini/tool-prompts.ts:101` say "This platform ONLY supports Indian stocks listed on NSE and BSE exchanges". That actively refuses US questions in chat.
- `packages/research/src/prompts.ts:15-28` is `SEBI_COMPLIANCE_RULES`. It is appended at `:431, :747, :855, :891, :982`. P2-01 makes the planner/analyst text market-aware; the compliance block is this ticket's.
- `packages/utils/src/sanitize-recommendation.ts` is the render-time BUY/SELL/HOLD scrubber (MONEY-457). It is market-neutral; reuse it.
- `apps/web/app/api/chat/route.ts:2248-2260` appends `flashVerdict.disclaimer` / `outputValidation.disclaimers` to responses.

## Read first (verified paths)

- The files above, plus `apps/web/lib/gemini/flash-prompt.ts`, `apps/web/components/chat/message-advisory-gate.ts`, `evals/eval-design.md` (Category C/D refusal patterns), and `evals/scorers.ts` (`hasDirective` :145, `hasDisclaimer` :150).
- `docs/design/v2-bundle/v2 StockSage.dc.html` footer copy: "Analysis and education only — not investment advice. Not a broker-dealer or RIA in the US; SEBI framing on India figures."

## Build, in this order

### 1. Service (pure, one module)

Create `packages/utils/src/compliance-copy.ts`. It sits in `@usemoney/utils` so the web app, the worker (`packages/research`) and `apps/api` all import one copy.

```ts
export type ComplianceMarket = "IN" | "US" | "MIXED";

export function complianceMarket(input: {
  contentMarkets: ReadonlySet<"IN" | "US">;
  userResidency?: string | null;
}): ComplianceMarket;
// A US-resident user makes US rules apply even to India content: the output
// is going TO a US person. Name the residency values from P0-05's enum; do
// not invent them.

export const US_DISCLAIMER =
  "Analysis and education only — not investment advice. UseMoney is not a broker-dealer or registered investment adviser in the US.";
export const MIXED_DISCLAIMER =
  "Analysis and education only — not investment advice. Not a broker-dealer or RIA in the US; SEBI framing on India figures.";

export function disclaimerFor(m: ComplianceMarket): string;
// IN → the existing SEBI text, moved here verbatim from guardrails.ts:810

export function complianceRulesFor(m: ComplianceMarket): string;
// IN → SEBI_COMPLIANCE_RULES verbatim.
// US adds, on top of the no-directive rules:
//   (a) no suitability language ("right for you", "given your risk profile,
//       consider", "you should add/trim")
//   (b) no target prices or expected returns for a named security
//   (c) portfolio facts about the user's own US holdings may be DESCRIBED
//       (weights, P&L, concentration), never turned into an action for them
//   (d) never name the data vendor ("third-party consolidated tape")
```

Add `hasSuitabilityLanguage(text)`: a deterministic regex list next to the directive scan in `guardrails.ts`, with a test table.

### 2. Wire it

**Chat (`apps/web`):**

- `guardrails.ts`: `SEBI_DISCLAIMER` is imported from `compliance-copy.ts`.
- The Flash output reviewer's `on_topic` gains "or US-listed securities when the user has the US layer". The route passes `hasUsLayer` into the prompt builder.
- When `complianceMarket !== "IN"`, `investment_advice` also covers suitability language.
- The deterministic scan runs `hasSuitabilityLanguage` for US/MIXED. On a hit it sanitizes and appends `disclaimerFor(m)`, like today's SEBI path; it does not block.

**Chat system prompts:**

- `prompt-personas-data.ts:120` and `tool-prompts.ts:101`: the "ONLY supports Indian stocks" line becomes market-aware.
  - If the user has the US layer: "supports Indian (NSE/BSE) and US-listed (NYSE/NASDAQ) securities".
  - Otherwise it stays as it is today. U1 must not learn that US exists.

**Research worker:**

- `packages/research/src/prompts.ts` appends `complianceRulesFor(message.market === "US" ? "US" : "IN")`.
- Report footers carry `disclaimerFor(...)`.

**Routes:**

- The chat route computes `complianceMarket` from the answer's resolved instruments (P2-01/P2-02 context) and `User.residency`, and appends `disclaimerFor(m)` to every US or MIXED answer.
- This is **always** appended, not only on sanitize. That is the "disclaimers" half of the ticket, and it is judge-independent.

### 3. `/v1` route + `US_SURFACES` row

- No new route. `/v1/research/:id/result` returns report blocks with the footer already in place, which a contract test asserts.
- There is no `US_SURFACES` row, because this is a cross-cutting rule and not a surface. Say so in the PR.

### 4. UI

- A disclaimer footer line under every US/MIXED answer and report. It uses the existing muted footer style (`.pf-*` tokens), with no new colours, and is 14px or larger.
- No modal and no acknowledgement click.

## Screens

### US answer footer inside S2.3 / chat (375px)

```
┌──────────────────────────────────────┐
│ AAPL trades at 30.8× trailing        │
│ earnings, above its 5-year median    │
│ of 27.4× (10-K filed 31 Oct 2025;    │
│ price: 23 Sep close).                │
│                                      │
│ What that premium usually reflects:  │
│ • margin durability                  │
│ • buyback yield                      │
│ • services growth                    │
│ ──────────────────────────────────── │
│ Analysis and education only — not    │
│ investment advice. UseMoney is not   │
│ a broker-dealer or registered        │
│ investment adviser in the US.        │
└──────────────────────────────────────┘
```

At 1280px there is no layout change. It is the same footer line at the bottom of the message bubble.

### States

| State    | Behaviour                                                            |
| -------- | -------------------------------------------------------------------- |
| loading  | Footer rendered with the final message only (never a partial footer) |
| empty    | n/a                                                                  |
| error    | ErrorBlock carries no disclaimer (no advice content)                 |
| DataGap  | Footer unchanged                                                     |
| gated    | n/a (upstream gates)                                                 |
| flag-off | No US content, so the IN footer is exactly as today                  |
| demo     | Demo US answers carry the US footer                                  |

### Users

| User               | Behaviour                                                             |
| ------------------ | --------------------------------------------------------------------- |
| U1                 | SEBI rules only; the persona line still says India-only               |
| U2 (resident, LRS) | US rules on US content; SEBI on India content; MIXED footer when both |
| U2 (NRI in US)     | Residency is US, so US rules on ALL content, India included           |
| U3                 | As U1 until US added                                                  |
| U4                 | Demo carries the footers                                              |
| U5 / U6 / U7       | Same rule by content and residency; the plan never changes compliance |

## Cross-surface access (§6)

| #   | Line      | Answer                                                             |
| --- | --------- | ------------------------------------------------------------------ |
| 1   | Search    | n/a: output rule                                                   |
| 2   | Watchlist | n/a: output rule                                                   |
| 3   | Sage      | Applies to every Sage and research answer                          |
| 4   | Home      | n/a: output rule                                                   |
| 5   | Deep link | n/a: output rule                                                   |
| 6   | API       | The footer is present in `/v1/research/:id/result` (contract)      |
| 7   | Demo      | Demo US answers carry the footer                                   |
| 8   | Telemetry | `compliance_sanitized` {market, reason:"directive"\|"suitability"} |

## Tests

- `packages/utils/__tests__/compliance-copy.test.ts`:
  - the `complianceMarket` truth table, including an NRI in the US reading India content → US;
  - the IN strings are byte-equal to the old constants.
- `apps/web/__tests__/gemini/suitability-scan.test.ts`:
  - 12 positives, e.g. "given your risk profile, consider adding NVDA" and "AAPL is right for you";
  - 12 negatives, e.g. "AAPL's P/E is above its median" and "concentration risk frameworks".
  - **Mutation:** delete one regex and watch a positive fail.
- `apps/web/__tests__/api/chat-us-disclaimer.test.ts`:
  - a US answer always ends with `US_DISCLAIMER`;
  - an India answer carries no US text;
  - MIXED gets `MIXED_DISCLAIMER`.
- `apps/web/__tests__/gemini/persona-market-line.test.ts`: without the US layer the "ONLY supports Indian stocks" line is byte-identical (U1 must not learn about US).
- `packages/research/__tests__/prompts-compliance-market.test.ts`: `message.market` US → US rules appended; IN unchanged.
- `evals/`: P2-05's refusal axis reuses `hasDirective` / `hasDisclaimer`, and `hasDisclaimer` must recognise `US_DISCLAIMER`. Extend `evals/scorers.ts:150` and `evals/run-scorers.ts`.

## Acceptance

- [ ] Every US or MIXED answer and report carries the right footer (tests).
- [ ] Suitability language on US content is sanitized plus disclaimed (tests + mutation).
- [ ] The India output, prompts and disclaimers are byte-identical for U1.
- [ ] The rule text is quoted in the PR for MONEY-923.
- [ ] `VERIFY_SERIAL=1 yarn verify:push`, then `/code-review ultra`, then the PR.

## Out of scope / hand-offs

- The legal memo (MONEY-923) and IA-6578 registration.
- The eval gate is P2-05.
- Roast copy for US holdings is P3-06, and that prompt must call `complianceRulesFor`.
