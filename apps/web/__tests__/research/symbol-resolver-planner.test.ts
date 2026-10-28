/**
 * Symbol Resolver & Planner — real-export tests.
 *
 * De-shadowed (MONEY-620 / task 185). The previous version inline-reimplemented
 * `resolveSymbol`, `toNseSymbol`, `extractSymbolsFromQuery`, `parsePlanResponse`,
 * `extractSectorFromQuery` and `createRefinementTasks` and asserted the copies.
 * Auditing the copies against source exposed two shadow-hidden divergences:
 *
 *   1. The shadow's `parsePlanResponse` fallback produced a fabricated 4-task
 *      "fallback_*" plan and DEFAULTED a missing symbol to "RELIANCE.NS". The
 *      REAL planner builds a 6-task fast / 17-task advanced fallback and, when
 *      no symbol is identifiable, THROWS (MONEY-612 trust — never report on the
 *      wrong company). The shadow asserted behaviour that does not exist.
 *   2. The shadow's `extractSectorFromQuery` DEFAULTED to "banking" on no match;
 *      the real one returns `undefined` (same MONEY-612 trust fix).
 *
 * This file now imports and asserts the REAL exported symbols. (Deep planner
 * mode/cap coverage lives in planner-mode-routing.test.ts.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSymbol,
  toNseSymbol,
  extractSymbolsFromQuery,
} from "@usemoney/research/data-sources/symbol-resolver";
import {
  parsePlanResponse,
  extractSectorFromQuery,
  ResearchPlanner,
} from "@usemoney/research/planner";
import type { ResearchPlan } from "@usemoney/research";

// ─── resolveSymbol ──────────────────────────────────────────────────────

describe("resolveSymbol (real)", () => {
  it("appends .NS by default", () => {
    assert.equal(resolveSymbol("RELIANCE"), "RELIANCE.NS");
    assert.equal(resolveSymbol("TCS"), "TCS.NS");
    assert.equal(resolveSymbol("ITC"), "ITC.NS");
  });

  it("appends .BO for BSE (case-insensitive)", () => {
    assert.equal(resolveSymbol("RELIANCE", "BSE"), "RELIANCE.BO");
    assert.equal(resolveSymbol("TCS", "bse"), "TCS.BO");
    assert.equal(resolveSymbol("INFY", "Bse"), "INFY.BO");
  });

  it("applies known symbol corrections (indices + & encodings)", () => {
    assert.equal(resolveSymbol("NIFTY"), "^NSEI");
    assert.equal(resolveSymbol("NIFTY50"), "^NSEI");
    assert.equal(resolveSymbol("SENSEX"), "^BSESN");
    assert.equal(resolveSymbol("BANKNIFTY"), "^NSEBANK");
    assert.equal(resolveSymbol("NIFTYBANK"), "^NSEBANK");
    assert.equal(resolveSymbol("NIFTYIT"), "^CNXIT");
    assert.equal(resolveSymbol("M&M"), "M%26M");
    assert.equal(resolveSymbol("M_M"), "M%26M");
    assert.equal(resolveSymbol("L&T"), "LT");
  });

  it("applies corrections regardless of exchange + case", () => {
    assert.equal(resolveSymbol("NIFTY", "BSE"), "^NSEI");
    assert.equal(resolveSymbol("nifty"), "^NSEI");
    assert.equal(resolveSymbol("Sensex"), "^BSESN");
  });

  it("returns an already-suffixed symbol as-is (uppercased)", () => {
    assert.equal(resolveSymbol("RELIANCE.NS"), "RELIANCE.NS");
    assert.equal(resolveSymbol("TCS.BO"), "TCS.BO");
    assert.equal(resolveSymbol("reliance.ns"), "RELIANCE.NS");
    assert.equal(resolveSymbol("tcs.bo"), "TCS.BO");
  });

  it("returns ^-prefixed index symbols unchanged", () => {
    assert.equal(resolveSymbol("^NSEI"), "^NSEI");
    assert.equal(resolveSymbol("^BSESN"), "^BSESN");
    assert.equal(resolveSymbol("^CUSTOM"), "^CUSTOM");
  });

  it("uppercases + trims input", () => {
    assert.equal(resolveSymbol("reliance"), "RELIANCE.NS");
    assert.equal(resolveSymbol("  RELIANCE  "), "RELIANCE.NS");
    assert.equal(resolveSymbol("  NIFTY  "), "^NSEI");
  });

  it("defaults unknown exchanges to .NS", () => {
    assert.equal(resolveSymbol("RELIANCE", "UNKNOWN"), "RELIANCE.NS");
    assert.equal(resolveSymbol("RELIANCE", ""), "RELIANCE.NS");
    assert.equal(resolveSymbol("GOLD", "MCX"), "GOLD.NS");
  });

  it("edge cases: empty / whitespace / single char / numeric", () => {
    assert.equal(resolveSymbol(""), ".NS");
    assert.equal(resolveSymbol("   "), ".NS");
    assert.equal(resolveSymbol("A"), "A.NS");
    assert.equal(resolveSymbol("BAJAJ500"), "BAJAJ500.NS");
  });
});

// ─── toNseSymbol ────────────────────────────────────────────────────────

describe("toNseSymbol (real)", () => {
  it("strips .NS / .BO suffix (case-insensitive) and uppercases", () => {
    assert.equal(toNseSymbol("RELIANCE.NS"), "RELIANCE");
    assert.equal(toNseSymbol("reliance.NS"), "RELIANCE");
    assert.equal(toNseSymbol("TCS.BO"), "TCS");
    assert.equal(toNseSymbol("RELIANCE.ns"), "RELIANCE");
    assert.equal(toNseSymbol("TCS.Bo"), "TCS");
  });

  it("decodes %26 back to &", () => {
    assert.equal(toNseSymbol("M%26M"), "M&M");
    assert.equal(toNseSymbol("M%26M.NS"), "M&M");
    assert.equal(toNseSymbol("A%26B%26C"), "A&B&C");
    assert.equal(toNseSymbol("%26TEST"), "&TEST");
    assert.equal(toNseSymbol("TEST%26"), "TEST&");
  });

  it("uppercases plain symbols + trims", () => {
    assert.equal(toNseSymbol("infy"), "INFY");
    assert.equal(toNseSymbol("  RELIANCE.NS"), "RELIANCE");
  });

  it("strips the suffix regardless of surrounding whitespace", () => {
    // This case previously asserted the OPPOSITE, as a "documented real quirk":
    // the suffix regex is `$`-anchored, so a trailing space stopped it matching
    // and "RELIANCE.NS " came back as "RELIANCE.NS".
    //
    // That is not a quirk, it is the bug. The output is WRONG and non-empty, so
    // every caller's `if (!symbol)` guard passes it straight through to a fetch
    // for a symbol that does not exist — and the input is reachable from LLM
    // output, which `planner.ts` forwards verbatim. A test that pins a defect as
    // a specification is worse than no test: it makes the one-character fix look
    // like a regression.
    assert.equal(toNseSymbol("RELIANCE.NS  "), "RELIANCE");
    assert.equal(toNseSymbol("  RELIANCE.NS  "), "RELIANCE");
    assert.equal(toNseSymbol("\tM&M.NS\n"), "M&M");
  });

  it("edge cases: empty, '.NS' alone, ^index, mid-string suffix", () => {
    assert.equal(toNseSymbol(""), "");
    assert.equal(toNseSymbol(".NS"), "");
    assert.equal(toNseSymbol("^NSEI"), "^NSEI");
    assert.equal(toNseSymbol("ANS.NSFOO"), "ANS.NSFOO");
  });
});

// ─── extractSymbolsFromQuery ────────────────────────────────────────────

describe("extractSymbolsFromQuery (real)", () => {
  it("extracts explicit .NS / .BO symbols", () => {
    assert.deepEqual(extractSymbolsFromQuery("What about RELIANCE.NS?"), [
      "RELIANCE.NS",
    ]);
    assert.deepEqual(extractSymbolsFromQuery("Tell me about TCS.BO"), [
      "TCS.BO",
    ]);
    assert.deepEqual(
      extractSymbolsFromQuery("Compare RELIANCE.NS with TCS.NS and INFY.BO"),
      ["RELIANCE.NS", "TCS.NS", "INFY.BO"]
    );
    assert.deepEqual(extractSymbolsFromQuery("what about reliance.ns?"), [
      "RELIANCE.NS",
    ]);
  });

  it("explicit symbols take priority over implicit words", () => {
    assert.deepEqual(
      extractSymbolsFromQuery("Compare RELIANCE.NS with TCS for investment"),
      ["RELIANCE.NS"]
    );
    assert.deepEqual(
      extractSymbolsFromQuery("Should I buy RELIANCE.NS stock?"),
      ["RELIANCE.NS"]
    );
  });

  it("extracts implicit uppercase-word symbols", () => {
    assert.ok(
      extractSymbolsFromQuery("Tell me about RELIANCE").includes("RELIANCE")
    );
    const both = extractSymbolsFromQuery("Compare TCS and INFY");
    assert.ok(both.includes("TCS"));
    assert.ok(both.includes("INFY"));
    assert.ok(
      extractSymbolsFromQuery("analyze reliance stock").includes("RELIANCE")
    );
  });

  it("filters stop words (incl. financial acronyms + index names)", () => {
    const stopWords = [
      "THE",
      "AND",
      "FOR",
      "WITH",
      "FROM",
      "ABOUT",
      "WHAT",
      "HOW",
      "SHOULD",
      "BUY",
      "SELL",
      "HOLD",
      "STOCK",
      "SECTOR",
      "MARKET",
      "ANALYZE",
      "COMPARE",
      "NSE",
      "BSE",
      "NIFTY",
      "SENSEX",
      "PE",
      "PB",
      "ROE",
      "EPS",
      "SEBI",
    ];
    assert.equal(extractSymbolsFromQuery(stopWords.join(" ")).length, 0);

    const buy = extractSymbolsFromQuery("Should I BUY RELIANCE");
    assert.ok(!buy.includes("BUY"));
    assert.ok(buy.includes("RELIANCE"));

    const pe = extractSymbolsFromQuery("PE ratio of RELIANCE is good");
    assert.ok(!pe.includes("PE"));
    assert.ok(pe.includes("RELIANCE"));

    assert.ok(
      !extractSymbolsFromQuery("How is NIFTY performing?").includes("NIFTY")
    );
  });

  it("deduplicates repeated symbols", () => {
    const r = extractSymbolsFromQuery(
      "Compare RELIANCE with RELIANCE performance"
    );
    assert.equal(r.filter((s) => s === "RELIANCE").length, 1);
  });

  it("length filtering: rejects 1-char + 16-char, accepts 2..15", () => {
    assert.equal(extractSymbolsFromQuery("I A B C").length, 0);
    assert.ok(
      extractSymbolsFromQuery("Check TV18 performance").includes("TV18")
    );
    const longSym = "ABCDEFGHIJKLMNO"; // 15 chars
    assert.ok(
      extractSymbolsFromQuery(`Check ${longSym} status`).includes(longSym)
    );
    const tooLong = "ABCDEFGHIJKLMNOP"; // 16 chars
    assert.ok(
      !extractSymbolsFromQuery(`Check ${tooLong} status`).includes(tooLong)
    );
  });

  it("handles & in symbols and splits hyphenated words", () => {
    assert.ok(extractSymbolsFromQuery("How is M&M doing?").includes("M&M"));
    const baj = extractSymbolsFromQuery("How is BAJAJ-AUTO doing?");
    assert.ok(!baj.includes("BAJAJ-AUTO"));
    assert.ok(baj.includes("BAJAJ"));
    assert.ok(baj.includes("AUTO"));
  });

  it("returns [] for stop-word-only / empty / punctuation queries", () => {
    assert.equal(
      extractSymbolsFromQuery("WHAT SHOULD THE BEST WORST ALL").length,
      0
    );
    assert.equal(extractSymbolsFromQuery("").length, 0);
    assert.equal(extractSymbolsFromQuery("!!! ??? ...").length, 0);
  });

  it("tolerates extra spaces, commas, parentheses", () => {
    const sp = extractSymbolsFromQuery("Compare   RELIANCE   TCS");
    assert.ok(sp.includes("RELIANCE") && sp.includes("TCS"));
    const comma = extractSymbolsFromQuery("RELIANCE, TCS, INFY");
    assert.ok(
      comma.includes("RELIANCE") &&
        comma.includes("TCS") &&
        comma.includes("INFY")
    );
    const paren = extractSymbolsFromQuery("(RELIANCE) and (TCS)");
    assert.ok(paren.includes("RELIANCE") && paren.includes("TCS"));
  });
});

// ─── parsePlanResponse (valid-plan paths + REAL fallback contract) ───────

describe("parsePlanResponse (real)", () => {
  it("parses a valid JSON plan, resolving symbols + marking tasks pending", () => {
    const response = JSON.stringify({
      symbols: ["RELIANCE"],
      complexity: "simple",
      tasks: [
        {
          id: "t1",
          type: "data_fetch",
          tool: "fetch_company_profile",
          params: { symbol: "RELIANCE" },
          dependsOn: [],
        },
      ],
    });
    const plan = parsePlanResponse(response, "Analyze RELIANCE", "advanced");
    assert.equal(plan.query, "Analyze RELIANCE");
    assert.deepEqual(plan.symbols, ["RELIANCE.NS"]);
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0]!.id, "t1");
    assert.equal(plan.tasks[0]!.status, "pending");
    assert.equal(plan.complexity, "simple");
    assert.equal(plan.estimatedSteps, 1);
  });

  it("resolves each symbol through resolveSymbol", () => {
    const plan = parsePlanResponse(
      JSON.stringify({ symbols: ["NIFTY", "TCS"], tasks: [] }),
      "test",
      "advanced"
    );
    assert.deepEqual(plan.symbols, ["^NSEI", "TCS.NS"]);
  });

  it("unwraps ```json and bare ``` code blocks", () => {
    const fenced =
      "Here is the plan:\n```json\n" +
      JSON.stringify({
        symbols: ["TCS"],
        complexity: "complex",
        tasks: [],
      }) +
      "\n```";
    const plan = parsePlanResponse(fenced, "Analyze TCS", "advanced");
    assert.deepEqual(plan.symbols, ["TCS.NS"]);
    assert.equal(plan.complexity, "complex");
  });

  it("defaults missing symbols/tasks/params/dependsOn and complexity", () => {
    const plan = parsePlanResponse(
      JSON.stringify({
        tasks: [{ id: "t1", type: "data_fetch", tool: "test" }],
      }),
      "q",
      "advanced"
    );
    assert.deepEqual(plan.symbols, []);
    assert.deepEqual(plan.tasks[0]!.params, {});
    assert.deepEqual(plan.tasks[0]!.dependsOn, []);
    assert.equal(plan.complexity, "moderate"); // advanced default
    assert.equal(plan.estimatedSteps, 1);
  });

  it("preserves the original query", () => {
    const plan = parsePlanResponse(
      JSON.stringify({ symbols: [], tasks: [] }),
      "My specific query about TCS",
      "advanced"
    );
    assert.equal(plan.query, "My specific query about TCS");
  });

  describe("REAL fallback on unparseable JSON (NOT the shadow's 4-task plan)", () => {
    it("builds the 17-task advanced fallback when the query names a symbol", () => {
      const plan = parsePlanResponse(
        "this is not json",
        "Analyze RELIANCE",
        "advanced"
      );
      assert.equal(plan.tasks.length, 17);
      assert.equal(plan.complexity, "moderate");
      assert.deepEqual(plan.symbols, ["RELIANCE.NS"]);
      assert.equal(
        plan.tasks[plan.tasks.length - 1]!.tool,
        "synthesize_report"
      );
      for (const t of plan.tasks) assert.equal(t.status, "pending");
    });

    it("builds the 6-task fast fallback in fast mode", () => {
      const plan = parsePlanResponse("broken", "Analyze TCS stock", "fast");
      assert.equal(plan.tasks.length, 6);
      assert.equal(plan.complexity, "simple");
      assert.deepEqual(plan.symbols, ["TCS.NS"]);
    });

    it("THROWS when no symbol can be identified (MONEY-612, never defaults to RELIANCE)", () => {
      assert.throws(
        () =>
          parsePlanResponse(
            "broken",
            "what should the best worst all",
            "advanced"
          ),
        /could not build a plan|no stock symbol/i
      );
    });
  });
});

// ─── extractSectorFromQuery ─────────────────────────────────────────────

describe("extractSectorFromQuery (real)", () => {
  it("matches each sector keyword (case-insensitive, substring)", () => {
    assert.equal(extractSectorFromQuery("banking sector stocks"), "banking");
    assert.equal(extractSectorFromQuery("it sector analysis"), "it");
    assert.equal(extractSectorFromQuery("PHARMA sector"), "pharma");
    assert.equal(extractSectorFromQuery("auto industry trends"), "auto");
    assert.equal(extractSectorFromQuery("Energy stocks"), "energy");
    assert.equal(extractSectorFromQuery("FMCG companies"), "fmcg");
    assert.equal(extractSectorFromQuery("metals sector outlook"), "metals");
    assert.equal(extractSectorFromQuery("realty stocks analysis"), "realty");
    assert.equal(extractSectorFromQuery("finance sector review"), "finance");
    assert.equal(extractSectorFromQuery("technology companies"), "technology");
    assert.equal(
      extractSectorFromQuery("healthcare sector performance"),
      "healthcare"
    );
  });

  it("substring matches inside longer words", () => {
    assert.equal(
      extractSectorFromQuery("pharmaceutical industry trends"),
      "pharma"
    );
    assert.equal(extractSectorFromQuery("automobile sector report"), "auto");
    // No longer "it": the two-character token is anchored at BOTH ends now,
    // because a start-anchor still matched "ITC" — a top-10 NSE name that lives
    // in this repo's FMCG basket, so an FMCG question was answered with
    // TCS/Infosys/Wipro.
    assert.equal(extractSectorFromQuery("itinerary planning"), undefined);
    assert.equal(
      extractSectorFromQuery("non-ferrous metals industry"),
      "metals"
    );
  });

  it("first match in the sector list wins", () => {
    assert.equal(
      extractSectorFromQuery("banking and pharma sectors"),
      "banking"
    );
    assert.equal(extractSectorFromQuery("it and technology companies"), "it");
  });

  it("recognises REAL ESTATE, in every natural phrasing (MONEY-1093)", () => {
    // The gap that shipped a user-visible crash: this list enumerated all 11
    // keywords and had no real-estate case. "real estate" was absent from the
    // planner, so the sector arrived `undefined` and the skill did
    // `undefined.toLowerCase()` — a raw TypeError shown to the user on a FAILED
    // run, with the credit spent. Only the NSE-flavoured "realty" worked.
    assert.equal(
      extractSectorFromQuery("Real Estate sector analysis"),
      "real estate"
    );
    assert.equal(
      extractSectorFromQuery("how is the real estate sector"),
      "real estate"
    );
    assert.equal(extractSectorFromQuery("property sector outlook"), "property");
    assert.equal(extractSectorFromQuery("realty outlook"), "realty");
  });

  it("does NOT match a token in the MIDDLE of a word", () => {
    // "it" matched inside "util-it-ies" and "commod-it-ies", so asking about
    // Utilities returned an analysis of TCS/Infosys/Wipro. The match is
    // anchored at a word START — which is what keeps "pharmaceutical" -> pharma
    // and "automobile" -> auto working (asserted above).
    // These now RESOLVE: the canonical names were added as tokens, because this
    // function is the ONLY producer of params.sector and 8 of the 13 canonical
    // names previously returned undefined — which meant an empty report. The
    // point of this case is that they no longer resolve to "it" via an infix
    // match; asserting the real token is a stronger claim than undefined.
    assert.equal(
      extractSectorFromQuery("Utilities sector analysis"),
      "utilities"
    );
    assert.equal(
      extractSectorFromQuery("Commodities sector overview"),
      "commodities"
    );
  });

  it("returns undefined when NO sector matches (MONEY-612 — not 'banking')", () => {
    assert.equal(extractSectorFromQuery("what are good stocks"), undefined);
    assert.equal(extractSectorFromQuery(""), undefined);
    assert.equal(extractSectorFromQuery("xyz abc 123"), undefined);
    // "financial services" IS now a token — it is a canonical sector name, and
    // omitting it meant a Financial Services question produced a report with no
    // constituents. The MONEY-612 rule this case protects is "never silently
    // substitute banking", which still holds: an UNRECOGNISED sector returns
    // undefined, asserted by the three cases above.
    assert.equal(
      extractSectorFromQuery("financial services overview"),
      "financial services"
    );
  });
});

// ─── ResearchPlanner.createRefinementTasks ───────────────────────────────

describe("ResearchPlanner.createRefinementTasks (real)", () => {
  const planner = new ResearchPlanner([]);

  function makePlan(symbols: string[], tools: string[]): ResearchPlan {
    return {
      query: "test query",
      symbols,
      tasks: tools.map((tool, i) => ({
        id: `t${i}`,
        type: "data_fetch",
        tool,
        params: {},
        dependsOn: [],
        status: "pending",
      })),
      estimatedSteps: tools.length,
      complexity: "moderate",
    };
  }

  it("creates fetch_peer_companies tasks per symbol for a 'peer' gap", () => {
    const tasks = planner.createRefinementTasks(
      ["Need peer comparison"],
      makePlan(["RELIANCE.NS", "TCS.NS"], [])
    );
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.tool, "fetch_peer_companies");
    assert.equal(tasks[0]!.params.symbol, "RELIANCE.NS");
    assert.equal(tasks[0]!.id, "refine_peers_0");
    assert.equal(tasks[1]!.params.symbol, "TCS.NS");
    assert.equal(tasks[1]!.id, "refine_peers_1");
    assert.equal(tasks[0]!.type, "data_fetch");
    assert.equal(tasks[0]!.status, "pending");
    assert.deepEqual(tasks[0]!.dependsOn, []);
  });

  it("skips peer tasks when fetch_peer_companies already present", () => {
    const tasks = planner.createRefinementTasks(
      ["Need peer data"],
      makePlan(["RELIANCE.NS"], ["fetch_peer_companies"])
    );
    assert.equal(tasks.length, 0);
  });

  it("creates fetch_news tasks per symbol for a 'news' gap, skips if present", () => {
    const created = planner.createRefinementTasks(
      ["Missing recent news"],
      makePlan(["A.NS", "B.NS", "C.NS"], [])
    );
    assert.equal(created.length, 3);
    for (const t of created) assert.equal(t.tool, "fetch_news");

    const skipped = planner.createRefinementTasks(
      ["Need news updates"],
      makePlan(["INFY.NS"], ["fetch_news"])
    );
    assert.equal(skipped.length, 0);
  });

  it("creates fetch_earnings tasks for an 'earnings' or 'eps' gap", () => {
    const earnings = planner.createRefinementTasks(
      ["earnings trend"],
      makePlan(["TCS.NS"], [])
    );
    assert.equal(earnings.length, 1);
    assert.equal(earnings[0]!.tool, "fetch_earnings");

    const eps = planner.createRefinementTasks(
      ["eps growth"],
      makePlan(["TCS.NS"], [])
    );
    assert.equal(eps[0]!.tool, "fetch_earnings");
  });
});
