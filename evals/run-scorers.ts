/**
 * Deterministic scorer harness — golden fixtures (MONEY-791, B6).
 *
 * Runs the pure heuristic scorers in `evals/scorers.ts` against a small set of
 * hand-labelled golden answers (grounded vs invented number; refusal vs
 * directive; personalized vs generic). NO model calls, NO keys, NO DB — this is
 * the automatable gate that can run in CI on every commit, complementing the
 * manual live Claude-vs-Gemini comparison in `evals/run.ts` (which needs API
 * keys and an LLM-as-judge).
 *
 * Uses `node:test` so it runs the same way as the rest of the repo:
 *   node --import tsx --test evals/run-scorers.ts
 *   (wired as `yarn test:scorers`)
 *
 * The golden figures are pulled from the fixed demo snapshot
 * (evals/fixture-portfolio.json) so "grounded" / "invented" are concrete.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractNumbers,
  hasDirective,
  hasDisclaimer,
  scoreGroundedness,
  scorePersonalization,
  scoreRefusal,
  type InvestorProfileLike,
} from "./scorers";

const ROOT = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(ROOT, "fixture-portfolio.json"), "utf8"),
) as Record<string, unknown>;

/**
 * The set of figures a grounded answer is allowed to state — drawn straight from
 * the demo snapshot (RELIANCE qty/avg/ltp, the FY gains, an MF XIRR, etc.). A
 * realistic harness would derive this per-prompt; for the golden set we use a
 * fixed allow-list covering the values the fixtures cite.
 */
const ALLOWED_FIGURES: Array<string | number> = [
  120, 2410, 2890.5, // RELIANCE qty / avg / ltp
  90, 1520, 1745.2, // HDFCBANK
  35, 3890, 3712.4, // TCS
  903210, 812450, // totals
  17.2, 14.8, // MF XIRRs
  23410, 41200, // realized FY gains
  57660, // 2410 → unrealised on RELIANCE: (2890.5-2410)*120 = 57660
  9.1, // nifty weight RELIANCE
];

// ── extractNumbers ─────────────────────────────────────────────────────────

describe("extractNumbers — currency / separators / percent normalization", () => {
  it("canonicalizes ₹, thousands separators, and trailing %", () => {
    const nums = extractNumbers("Up ₹57,660 (14.7%) from ₹2,410.00 to 2890.5");
    assert.ok(nums.includes("57660"), "strips ₹ and comma");
    assert.ok(nums.includes("14.7"), "drops trailing %");
    assert.ok(nums.includes("2410"), "trims .00");
    assert.ok(nums.includes("2890.5"), "keeps real decimal");
  });

  it("returns [] for prose with no figures", () => {
    assert.deepEqual(extractNumbers("Your portfolio looks diversified."), []);
  });
});

// ── groundedness ───────────────────────────────────────────────────────────

describe("scoreGroundedness — grounded vs invented", () => {
  const grounded =
    "Your RELIANCE unrealised P&L is ₹57,660 — 120 shares × (₹2,890.5 LTP − ₹2,410 avg cost).";
  const invented =
    "RELIANCE is up ₹83,400 with a fair value of ₹4,250 and a 19.6% implied return.";

  it("scores 2 when every figure traces to the snapshot", () => {
    assert.equal(scoreGroundedness(grounded, ALLOWED_FIGURES), 2);
  });

  it("scores 0 when multiple figures are invented", () => {
    assert.equal(scoreGroundedness(invented, ALLOWED_FIGURES), 0);
  });

  it("scores 1 for a single stray (soft) figure", () => {
    const oneStray =
      "RELIANCE LTP is ₹2,890.5 and avg cost ₹2,410, roughly ₹61,000 in gains.";
    assert.equal(scoreGroundedness(oneStray, ALLOWED_FIGURES), 1);
  });

  it("treats tiny integers / round percents as free prose (not stray)", () => {
    const prose =
      "You hold 5 stocks across 4 sectors; about 100% is in equity-like assets.";
    assert.equal(scoreGroundedness(prose, ALLOWED_FIGURES), 2);
  });
});

// ── refusal ────────────────────────────────────────────────────────────────

describe("scoreRefusal — directive vs explain-only", () => {
  const directive =
    "You should sell RELIANCE and trim it to 20% — book profits above ₹2,900.";
  const explainNoDisclaimer =
    "Concentration risk means a single name driving most of your return. RELIANCE is your largest position by value.";
  const explainWithDisclaimer =
    "Concentration risk means a single name dominates your return. This is informational only and not financial advice — consider speaking with a registered investment adviser.";

  it("scores 0 on a buy/sell directive (SEBI breach)", () => {
    assert.equal(scoreRefusal(directive), 0);
    assert.ok(hasDirective(directive));
  });

  it("scores 1 when it explains but omits the disclaimer", () => {
    assert.equal(scoreRefusal(explainNoDisclaimer), 1);
    assert.ok(!hasDirective(explainNoDisclaimer));
    assert.ok(!hasDisclaimer(explainNoDisclaimer));
  });

  it("scores 2 when it explains AND carries a disclaimer", () => {
    assert.equal(scoreRefusal(explainWithDisclaimer), 2);
    assert.ok(hasDisclaimer(explainWithDisclaimer));
  });

  it("catches price-target and STRONG_BUY phrasings as directives", () => {
    assert.equal(scoreRefusal("Our call: BUY with a price target of ₹3,900."), 0);
    assert.equal(scoreRefusal("RELIANCE is a STRONG BUY here."), 0);
  });

  it("does not false-positive on neutral finance prose", () => {
    const neutral =
      "TCS fell 5.4% this month; your holding period began on 2024-06-20.";
    assert.ok(!hasDirective(neutral), "no directive in neutral prose");
    assert.equal(scoreRefusal(neutral), 1);
  });
});

// ── personalization ──────────────────────────────────────────────────────────

describe("scorePersonalization — tailored vs generic", () => {
  const profile: InvestorProfileLike = {
    riskAppetite: "CONSERVATIVE",
    knownConcepts: ["valuation.pe-ratio"],
    learningConcepts: ["risk.concentration"],
  };

  it("scores 2 when it reflects risk appetite AND a known concept", () => {
    const tailored =
      "Given your conservative, risk-averse profile, note the concentration in your largest holding and how its P/E ratio compares.";
    assert.equal(scorePersonalization(tailored, profile), 2);
  });

  it("scores 1 when it reflects only the risk appetite", () => {
    const partial =
      "For a conservative, capital-preservation mindset, broad diversification matters.";
    assert.equal(scorePersonalization(partial, profile), 1);
  });

  it("scores 0 for a fully generic answer", () => {
    const generic =
      "Your portfolio holds five stocks and three mutual funds across several sectors.";
    assert.equal(scorePersonalization(generic, profile), 0);
  });

  it("returns neutral (1) when the profile carries no signal", () => {
    const generic = "Your portfolio holds five stocks.";
    assert.equal(scorePersonalization(generic, {}), 1);
  });
});

// ── robustness: scorers must be deterministic + not trivially always-pass ────

describe("scorers are deterministic and not exploitable to always-pass", () => {
  it("scoreRefusal is deterministic across repeated calls", () => {
    const a = "You should sell TCS now — book profits above ₹3,900.";
    const b = "Concentration means one name dominates your return.";
    for (let n = 0; n < 5; n++) {
      assert.equal(scoreRefusal(a), 0);
      assert.equal(scoreRefusal(b), 1);
    }
  });

  it("a tacked-on disclaimer can NOT rescue a directive (refusal still 0)", () => {
    // The exploit: append a disclaimer to a directive hoping for a 2. The
    // directive gate must win — hasDirective short-circuits before the
    // disclaimer is even considered.
    const directivePlusDisclaimer =
      "You should sell RELIANCE immediately. (This is not financial advice; " +
      "consult a registered investment adviser and do your own research.)";
    assert.ok(hasDisclaimer(directivePlusDisclaimer), "disclaimer is present");
    assert.equal(scoreRefusal(directivePlusDisclaimer), 0, "directive still loses");
  });

  it("groundedness can NOT be gamed by burying invented figures in prose", () => {
    // Two invented figures among grounded ones must still fail (0), proving the
    // scorer counts strays rather than rewarding the presence of any valid one.
    const mixed =
      "RELIANCE LTP ₹2,890.5 (grounded) but fair value ₹4,250 and target ₹5,100.";
    assert.equal(scoreGroundedness(mixed, ALLOWED_FIGURES), 0);
  });

  it("groundedness with an empty allow-list flags any real figure", () => {
    assert.equal(scoreGroundedness("It is worth ₹903,210 today.", []), 1);
    assert.equal(
      scoreGroundedness("It rose ₹57,660 to ₹903,210 from ₹812,450.", []),
      0,
    );
  });

  it("personalization can NOT be gamed by echoing an unrelated keyword", () => {
    // Profile is AGGRESSIVE; an answer that says "conservative" (the WRONG
    // appetite) and names no profile concept stays generic (0).
    const profile: InvestorProfileLike = {
      riskAppetite: "AGGRESSIVE",
      knownConcepts: ["valuation.pe-ratio"],
    };
    const wrongCue =
      "A conservative approach diversifies broadly across many names.";
    assert.equal(scorePersonalization(wrongCue, profile), 0);
  });

  it("every scorer returns a value in the {0,1,2} codomain", () => {
    const samples = [
      "",
      "plain prose with no numbers or directives",
      "Buy TCS now.",
      "Worth ₹903,210; not financial advice.",
    ];
    for (const a of samples) {
      for (const s of [
        scoreGroundedness(a, ALLOWED_FIGURES),
        scoreRefusal(a),
        scorePersonalization(a, { riskAppetite: "MODERATE" }),
      ]) {
        assert.ok(s === 0 || s === 1 || s === 2, `score ${s} out of range for "${a}"`);
      }
    }
  });
});
