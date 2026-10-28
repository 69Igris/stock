/**
 * MONEY-1255 (A2) — resolving a BSE-only company to its screener slug.
 *
 * ## What is actually under test
 *
 * 2,389 real companies are listed on BSE with no NSE row, and every
 * financial-document producer in this repo is NSE-keyed. screener.in reaches
 * them, but keys its company page by a SLUG — which is the BSE SCRIP CODE.
 *
 * The resolution is an ISIN JOIN against BSE's own scrip master, the feed
 * `instrument-sync-daily` already pulls nightly. That makes the DANGEROUS
 * failure — "we found the wrong company", where another issuer's annual reports
 * get filed under our symbol and nothing downstream can tell (the PDF parses,
 * the numbers project into `stock_financials` under our key, every dashboard
 * reads green) — IMPOSSIBLE BY CONSTRUCTION rather than merely unlikely. There
 * is no similarity judgement on the live path, so there is no threshold to
 * mis-tune.
 *
 * What remains testable, and is tested hard, is the honesty of the four
 * outcomes:
 *
 *   resolved     an exchange-published ISIN -> scrip-code fact
 *   miss         we looked and BSE has no row — a FINDING, cached 90d
 *   ambiguous    one ISIN, two scrip codes — EXCLUDED, never last-wins
 *   unavailable  we could NOT look — cached NEVER
 *
 * The last one is the subtle one and it has its own section: an empty master is
 * what `fetchBseScripMaster` returns both on a failed fetch and under
 * `BSE_MASTER_ENRICH=off`, so treating it as "no match" would stamp a 90-day
 * "no page" onto every BSE-only company during a transient BSE outage.
 *
 * ## The name-similarity block below is NOT on the live path
 *
 * It is retained, exported and tested because it encodes a trap worth keeping
 * (`Bosch India` and `Bosch Rexroth India` score IDENTICALLY to a legitimate
 * name variant), and an alpha-slug source would need it. The last case in this
 * file asserts it has no caller in `src/`, so "not on the live path" is a
 * CHECKED property rather than a claim in a comment — and, with it, that
 * nothing in the tree fetches screener's robots-Disallowed `?q=` search.
 *
 * Every case is pure. This module makes no HTTP request of any kind, so there
 * is no socket to open and nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBseScripIndex,
  buildQuarterSourceUrl,
  chooseScreenerCandidate,
  companyNameTokens,
  extractSlugFromUrl,
  isNumericSlug,
  nameSimilarity,
  namesAgree,
  NAME_MATCH_THRESHOLD,
  planScreenerSlugResolution,
  resolveScreenerSlugFromBse,
  SCREENER_SLUG_TTL_MS,
  type BseScripMasterRow,
} from "../src/data-sources/screener-resolve";

/** BSE's master, as `fetchBseScripMaster` hands it over. */
const MASTER: BseScripMasterRow[] = [
  { scripId: "KRISNAFILA", scripCode: "511122", isin: "INE398D01015" },
  { scripId: "SMALLCO", scripCode: "530127", isin: "INE111A01017" },
  { scripId: "ALEMBIC", scripCode: "506235", isin: "INE428A01015" },
  { scripId: "NOISIN", scripCode: "512517", isin: null },
];

/* -------------------------------------------------------------------------- */
/* The slug, out of a screener URL                                            */
/* -------------------------------------------------------------------------- */

describe("extractSlugFromUrl", () => {
  it("takes the segment after `company`, tail or no tail", () => {
    assert.equal(extractSlugFromUrl("/company/511122/"), "511122");
    assert.equal(extractSlugFromUrl("/company/KRISNAFILA/"), "KRISNAFILA");
    // The `/consolidated/` tail the founder's probe saw on some results. It is
    // handled by POSITION rather than by stripping a list of known suffixes:
    // screener serves several (`standalone`, and more), and a suffix that got
    // missed would turn a good slug into `KRISNAFILA/standalone` — a 404 that
    // reads exactly like "this company has no page" and is then cached as a
    // finding for 90 days.
    assert.equal(
      extractSlugFromUrl("/company/KRISNAFILA/consolidated/"),
      "KRISNAFILA",
    );
    assert.equal(extractSlugFromUrl("/company/511122/standalone/"), "511122");
    assert.equal(
      extractSlugFromUrl("https://www.screener.in/company/INFY/"),
      "INFY",
    );
  });

  it("returns null rather than a guess for anything unusable", () => {
    assert.equal(extractSlugFromUrl("/company/"), null);
    assert.equal(extractSlugFromUrl("/"), null);
    assert.equal(extractSlugFromUrl(""), null);
    assert.equal(extractSlugFromUrl("/screens/123/some-screen/"), null);
    // A slug is pasted into a fetch path. Anything that could steer that path
    // somewhere else is refused outright.
    assert.equal(extractSlugFromUrl("/company/../../etc/passwd/"), null);
    assert.equal(extractSlugFromUrl("/company/a b/"), null);
    assert.equal(extractSlugFromUrl(undefined as never), null);
  });

  it("isNumericSlug is what makes a slug a BSE scrip code", () => {
    assert.equal(isNumericSlug("511122"), true);
    assert.equal(isNumericSlug("KRISNAFILA"), false);
    assert.equal(isNumericSlug("5111A"), false);
    assert.equal(isNumericSlug(""), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Name identity — the arm that carries every numeric slug                     */
/* -------------------------------------------------------------------------- */

describe("nameSimilarity", () => {
  it("a corporate suffix carries no identity", () => {
    assert.equal(nameSimilarity("Krisna Filaments", "Krisna Filaments Ltd"), 1);
    assert.equal(
      nameSimilarity(
        "Tata Consultancy Services",
        "TATA CONSULTANCY SERVICES LIMITED",
      ),
      1,
    );
  });

  it("scores the sibling-company shape below the bar", () => {
    // A real, differently-listed entity sharing a house name. This is the
    // failure that would file Sun Pharma Advanced Research's annual reports
    // under Sun Pharmaceutical's ticker, and nothing downstream could tell.
    for (const [a, b] of [
      ["Sun Pharmaceutical Industries", "Sun Pharma Advanced Research"],
      ["Reliance Industries", "Reliance Industrial Infrastructure"],
      ["Bajaj Finance", "Bajaj Finserv"],
    ] as const) {
      assert.ok(
        nameSimilarity(a, b) < NAME_MATCH_THRESHOLD,
        `"${a}" vs "${b}" scored ${nameSimilarity(a, b)} — above the bar`,
      );
    }
  });

  it("ACCEPTS a name variant, so the bar is not simply unreachable", () => {
    // The negative control for the case above: a threshold that rejects
    // everything is not a safe threshold, it is a broken feature.
    assert.ok(
      nameSimilarity("Krisna Filaments", "Krisna Filaments Industries") >=
        NAME_MATCH_THRESHOLD,
    );
  });
});

describe("namesAgree: the overlap ALONE is not enough", () => {
  it("REGRESSION: 0.67 is scored by a VARIANT and by a SIBLING alike", () => {
    // Found by this test, not by reasoning. The threshold was picked against a
    // table of six examples and the seventh broke it: an inserted qualifier
    // scores exactly what an appended one does.
    const variant = nameSimilarity(
      "Krisna Filaments",
      "Krisna Filaments Industries",
    );
    const sibling = nameSimilarity("Bosch India", "Bosch Rexroth India");
    assert.equal(variant, sibling, "the overlap CANNOT tell these apart");
    assert.ok(variant >= NAME_MATCH_THRESHOLD, "and both clear the threshold");

    // The ordered-prefix test is what separates them.
    assert.equal(
      namesAgree("Krisna Filaments", "Krisna Filaments Industries"),
      true,
    );
    assert.equal(namesAgree("Bosch India", "Bosch Rexroth India"), false);
  });

  it("REGRESSION: the PREFIX test alone would accept 'Tata' as 'Tata Motors'", () => {
    // The mirror image, and why BOTH tests are required. A prefix rule with no
    // overlap floor accepts any one-token head.
    const A = ["TATA"];
    const B = ["TATA", "MOTORS"];
    assert.equal(
      A.every((t, i) => B[i] === t),
      true,
      "the prefix test alone says yes",
    );
    assert.ok(nameSimilarity("Tata", "Tata Motors") < NAME_MATCH_THRESHOLD);
    assert.equal(namesAgree("Tata", "Tata Motors"), false);
  });

  it("agrees on the ordinary cases, in both argument orders", () => {
    for (const [a, b] of [
      ["Krisna Filaments Ltd", "Krisna Filaments Limited"],
      ["The Tata Power Company Limited", "Tata Power Co Ltd"],
      ["360 ONE WAM LTD", "360 One Wam Ltd"],
      ["Infosys Limited", "Infosys Ltd"],
    ] as const) {
      assert.equal(namesAgree(a, b), true, `${a} vs ${b}`);
      assert.equal(namesAgree(b, a), true, `${b} vs ${a} (symmetry)`);
    }
    for (const [a, b] of [
      ["Sun Pharmaceutical Industries", "Sun Pharma Advanced Research"],
      ["Bajaj Finance", "Bajaj Finserv"],
      ["Bosch India", "Bosch Rexroth India"],
    ] as const) {
      assert.equal(namesAgree(a, b), false, `${a} vs ${b}`);
      assert.equal(namesAgree(b, a), false, `${b} vs ${a} (symmetry)`);
    }
  });

  it("an empty side never agrees", () => {
    assert.equal(namesAgree("", "Infosys Ltd"), false);
    assert.equal(namesAgree("Ltd", "Infosys Ltd"), false);
  });

  it("a name that is ENTIRELY boilerplate scores 0, never NaN", () => {
    // The non-finite guard. `0/0` is NaN, and `NaN >= threshold` is false only
    // by luck; it must be 0 by construction.
    const s = nameSimilarity("Ltd", "The Company Limited");
    assert.equal(Number.isFinite(s), true);
    assert.equal(s, 0);
    assert.equal(nameSimilarity("", "Infosys Ltd"), 0);
  });

  it("only corporate FORM is stripped — never a business word or a geography", () => {
    // Every word removed makes two different companies look more alike.
    const tokens = companyNameTokens("Bosch India Industries Private Limited");
    assert.deepEqual([...tokens].sort(), ["BOSCH", "INDIA", "INDUSTRIES"]);
  });
});

/* -------------------------------------------------------------------------- */
/* THE ACCEPTANCE RULE                                                        */
/* -------------------------------------------------------------------------- */

describe("chooseScreenerCandidate (RETAINED, not on the live path)", () => {
  const KRISNA = { symbol: "KRISNAFILA", name: "Krisna Filaments Ltd" };

  it("REGRESSION: does NOT take the first result on faith", () => {
    // The mutation this whole module exists to survive. Screener answers a
    // ticker query with SOMETHING for almost anything; accepting the head of
    // the list attaches another company's filings to our symbol.
    const firstResultIsWrong = [
      {
        id: 1,
        name: "Krishna Institute of Medical Sciences",
        url: "/company/543308/",
      },
    ];
    const choice = chooseScreenerCandidate(KRISNA, firstResultIsWrong);

    assert.equal(choice.outcome, "ambiguous");
    assert.equal(choice.slug, null);
    assert.equal(choice.bseScripCode, null);
    // FALSIFIABLE CEILING: proving "we did not accept it" is worthless unless
    // the fixture actually reached the rule. The reason string names the
    // candidate, which only the rejection path can produce.
    assert.match(choice.reason, /none defensible/);
    assert.match(choice.reason, /543308/);
  });

  it("accepts an ALPHA slug on slug identity, and derives no scrip code", () => {
    const choice = chooseScreenerCandidate(KRISNA, [
      { id: 7, name: "Krisna Filaments Ltd", url: "/company/KRISNAFILA/" },
    ]);
    assert.equal(choice.outcome, "resolved");
    assert.equal(choice.slug, "KRISNAFILA");
    assert.equal(choice.screenerId, 7);
    assert.equal(
      choice.bseScripCode,
      null,
      "an alpha slug means we do NOT know the scrip code — never invent one",
    );
    assert.equal(choice.reason, "slug==symbol");
  });

  it("accepts a NUMERIC slug on the NAME, and derives the scrip code", () => {
    // A scrip code is not a ticker, so slug identity can never carry a numeric
    // slug. Its identity comes entirely from the name — which is the point:
    // "the slug is numeric" describes the FORM of the answer, never whose
    // page it is.
    const choice = chooseScreenerCandidate(KRISNA, [
      { id: 88, name: "Krisna Filaments Limited", url: "/company/511122/" },
    ]);
    assert.equal(choice.outcome, "resolved");
    assert.equal(choice.slug, "511122");
    assert.equal(choice.bseScripCode, "511122");
    assert.match(choice.reason, /name overlap 1\.00/);
  });

  it("REGRESSION: a numeric slug with a WRONG name is refused", () => {
    // The mutation that would make the case above pass for the wrong reason:
    // "accept any numeric slug". Same shape, different company.
    const choice = chooseScreenerCandidate(KRISNA, [
      { id: 88, name: "Alembic Pharmaceuticals", url: "/company/533573/" },
    ]);
    assert.equal(choice.outcome, "ambiguous");
    assert.equal(choice.slug, null);
  });

  it("TWO acceptable candidates is a refusal, not a tie to be broken", () => {
    const choice = chooseScreenerCandidate(
      { symbol: "KRISNAFILA", name: "Krisna Filaments Ltd" },
      [
        { id: 1, name: "Krisna Filaments Ltd", url: "/company/511122/" },
        {
          id: 2,
          name: "Krisna Filaments Limited",
          url: "/company/KRISNAFILA/",
        },
      ],
    );
    assert.equal(choice.outcome, "ambiguous");
    assert.equal(choice.slug, null);
    assert.match(choice.reason, /cannot tell which page is ours/);
  });

  it("the SAME company under two URLs is one candidate, not a tie", () => {
    // Screener returns `/company/X/` and `/company/X/consolidated/`. Counting
    // those as two acceptable candidates would report every ordinary success
    // as ambiguous — a rule that refuses everything is not a safe rule.
    const choice = chooseScreenerCandidate(KRISNA, [
      { id: null, name: "Krisna Filaments Ltd", url: "/company/511122/" },
      {
        id: 5,
        name: "Krisna Filaments Ltd",
        url: "/company/511122/consolidated/",
      },
    ]);
    assert.equal(choice.outcome, "resolved");
    assert.equal(choice.slug, "511122");
    assert.equal(choice.screenerId, 5, "the richer of the two rows wins");
  });

  it("zero results is a MISS — a finding, distinct from a refusal", () => {
    const choice = chooseScreenerCandidate(KRISNA, []);
    assert.equal(choice.outcome, "miss");
    assert.equal(choice.slug, null);
    assert.match(choice.reason, /no results/);
  });

  it("results with no usable company url are a MISS, not a crash", () => {
    const choice = chooseScreenerCandidate(KRISNA, [
      { id: 1, name: "A Screen", url: "/screens/12/momentum/" },
    ]);
    assert.equal(choice.outcome, "miss");
    assert.equal(choice.slug, null);
  });

  it("picks OUR company out of a crowded, realistic result list", () => {
    // The positive control at scale: the rule must still resolve when screener
    // answers with neighbours, or it is safe and useless.
    const choice = chooseScreenerCandidate(
      { symbol: "TATAPOWER", name: "Tata Power Company Ltd" },
      [
        { id: 1, name: "Tata Power Company Ltd", url: "/company/TATAPOWER/" },
        { id: 2, name: "Tata Steel Ltd", url: "/company/TATASTEEL/" },
        { id: 3, name: "Tata Motors Ltd", url: "/company/TATAMOTORS/" },
        { id: 4, name: "Tata Chemicals Ltd", url: "/company/TATACHEM/" },
      ],
    );
    assert.equal(choice.outcome, "resolved");
    assert.equal(choice.slug, "TATAPOWER");
  });
});

/* -------------------------------------------------------------------------- */
/* THE LIVE PATH — ISIN -> BSE's own scrip master                              */
/* -------------------------------------------------------------------------- */

describe("buildBseScripIndex", () => {
  it("indexes by ISIN and by scrip_id", () => {
    const ix = buildBseScripIndex(MASTER);
    assert.equal(ix.size, 4);
    assert.equal(ix.byIsin.get("INE398D01015"), "511122");
    assert.equal(ix.byScripId.get("KRISNAFILA"), "511122");
    assert.equal(ix.byScripId.get("NOISIN"), "512517");
  });

  it("normalises case and whitespace on both sides of the join", () => {
    const ix = buildBseScripIndex([
      {
        scripId: " krisnafila ",
        scripCode: " 511122 ",
        isin: " ine398d01015 ",
      },
    ]);
    assert.equal(ix.byIsin.get("INE398D01015"), "511122");
    assert.equal(ix.byScripId.get("KRISNAFILA"), "511122");
  });

  it("REGRESSION: a CONFLICTING key is EXCLUDED, never last-wins", () => {
    // The one way a join can still hand back a wrong company: `Map.set` in a
    // loop resolves a duplicate key by iteration order. Excluding it turns a
    // silent wrong answer into a reported `ambiguous`.
    const ix = buildBseScripIndex([
      { scripId: "A", scripCode: "500001", isin: "INE000A01011" },
      { scripId: "B", scripCode: "500002", isin: "INE000A01011" },
    ]);
    assert.equal(ix.byIsin.has("INE000A01011"), false);
    assert.equal(ix.ambiguousIsins.has("INE000A01011"), true);
  });

  it("a key repeated with the SAME code is not a conflict", () => {
    // The negative control: BSE lists a company under several segments. That is
    // one company, not an ambiguity, and refusing it would lose a resolution.
    const ix = buildBseScripIndex([
      { scripId: "A", scripCode: "500001", isin: "INE000A01011" },
      { scripId: "A", scripCode: "500001", isin: "INE000A01011" },
    ]);
    assert.equal(ix.byIsin.get("INE000A01011"), "500001");
    assert.equal(ix.ambiguousIsins.size, 0);
  });

  it("a NON-NUMERIC scrip code is refused — it goes into a URL path", () => {
    const ix = buildBseScripIndex([
      { scripId: "BAD", scripCode: "../../etc", isin: "INE000A01011" },
      { scripId: "OK", scripCode: "500001", isin: "INE000A01012" },
    ]);
    assert.equal(ix.size, 1);
    assert.equal(ix.byIsin.has("INE000A01011"), false);
  });

  it("blank keys never enter the index", () => {
    const ix = buildBseScripIndex([
      { scripId: "", scripCode: "500001", isin: "" },
    ]);
    assert.equal(ix.byIsin.size, 0);
    assert.equal(ix.byScripId.size, 0);
    assert.equal(ix.size, 1, "the row was seen — it just has no usable key");
  });
});

describe("resolveScreenerSlugFromBse: wrong is IMPOSSIBLE, not unlikely", () => {
  const ix = buildBseScripIndex(MASTER);

  it("resolves on the ISIN, and the scrip code IS the slug", () => {
    const r = resolveScreenerSlugFromBse(
      { symbol: "KRISNAFILA", isin: "INE398D01015" },
      ix,
    );
    assert.equal(r.outcome, "resolved");
    assert.equal(r.slug, "511122");
    assert.equal(
      r.bseScripCode,
      "511122",
      "authoritative, from the exchange that issues both identifiers",
    );
    assert.match(r.reason, /BSE master/);
  });

  it("REGRESSION: the ISIN WINS over a scrip_id that says otherwise", () => {
    // A rename (MONEY-1177) leaves the two exchanges carrying different tickers
    // for one company, so our stored symbol can collide with a DIFFERENT
    // company's BSE scrip_id. The ISIN is the stable identity and must decide.
    const r = resolveScreenerSlugFromBse(
      { symbol: "ALEMBIC", isin: "INE398D01015" },
      ix,
    );
    assert.equal(r.slug, "511122", "the ISIN's company, not the ticker's");
    assert.notEqual(r.slug, "506235");
  });

  it("falls back to scrip_id ONLY when there is no ISIN match", () => {
    const r = resolveScreenerSlugFromBse({ symbol: "NOISIN", isin: null }, ix);
    assert.equal(r.outcome, "resolved");
    assert.equal(r.slug, "512517");
    assert.match(r.reason, /scrip_id/);
  });

  it("a company BSE's master does not carry is a MISS — a finding", () => {
    const r = resolveScreenerSlugFromBse(
      { symbol: "GHOSTCO", isin: "INE999Z01019" },
      ix,
    );
    assert.equal(r.outcome, "miss");
    assert.equal(r.slug, null);
    assert.equal(r.bseScripCode, null);
    // FALSIFIABLE CEILING: a miss against an EMPTY index would also say
    // "miss" if the outage branch were deleted. The reason names the row count,
    // which proves the index was populated when we looked.
    assert.match(r.reason, /4 rows indexed/);
  });

  it("a CONFLICTING ISIN is ambiguous — it never picks one", () => {
    const conflicted = buildBseScripIndex([
      { scripId: "A", scripCode: "500001", isin: "INE000A01011" },
      { scripId: "B", scripCode: "500002", isin: "INE000A01011" },
    ]);
    const r = resolveScreenerSlugFromBse(
      { symbol: "A", isin: "INE000A01011" },
      conflicted,
    );
    assert.equal(r.outcome, "ambiguous");
    assert.equal(r.slug, null);
    assert.match(r.reason, /more than one scrip code/);
  });

  it("REGRESSION: an EMPTY master is `unavailable`, NEVER a miss", () => {
    // `fetchBseScripMaster` returns [] on a failed fetch AND under
    // `BSE_MASTER_ENRICH=off`. Reading that as "no match" would stamp a 90-day
    // "screener has no page" onto every BSE-only company on the page during a
    // transient BSE outage — caching a failure as a fact, which is the one
    // thing this codebase has a standing rule against.
    const r = resolveScreenerSlugFromBse(
      { symbol: "KRISNAFILA", isin: "INE398D01015" },
      buildBseScripIndex([]),
    );
    assert.equal(r.outcome, "unavailable");
    assert.equal(r.slug, null);
    assert.notEqual(
      r.outcome,
      "miss",
      "'we could not look' must never be spelled the same as 'we looked'",
    );
    assert.match(r.reason, /NOT a finding/);
  });

  it("there is no name comparison anywhere on this path", () => {
    // The property the whole redesign buys. A company whose stored name is
    // nothing like BSE's still resolves, because identity comes from the ISIN
    // and not from a similarity score — so there is no threshold to mis-tune
    // and no near-match to accept by mistake.
    const r = resolveScreenerSlugFromBse(
      { symbol: "WHATEVER", isin: "INE398D01015" },
      ix,
    );
    assert.equal(r.outcome, "resolved");
    assert.equal(r.slug, "511122");
  });
});

/* -------------------------------------------------------------------------- */
/* The cache plan — 90 days, and never a Mongo `where`                         */
/* -------------------------------------------------------------------------- */

describe("planScreenerSlugResolution", () => {
  const NOW = Date.parse("2026-08-27T00:00:00.000Z");

  it("a stored slug is used, and costs nothing", () => {
    assert.equal(
      planScreenerSlugResolution({ screenerSlug: "511122" }, NOW),
      "cached",
    );
  });

  it("NEVER ASKED — the field ABSENT, not null — resolves", () => {
    // `db push` creates indexes and never fields, so on all ~20,804 existing
    // rows neither attribute is present at all. A plan written for `null`
    // would never fire.
    const row = {};
    assert.equal(
      Object.prototype.hasOwnProperty.call(row, "screenerSlugCheckedAt"),
      false,
      "the fixture must model ABSENT, not null",
    );
    assert.equal(planScreenerSlugResolution(row, NOW), "resolve");
  });

  it("a FRESH negative is a finding — do not re-ask", () => {
    assert.equal(
      planScreenerSlugResolution(
        {
          screenerSlug: null,
          screenerSlugCheckedAt: new Date(NOW - 89 * 86_400_000),
        },
        NOW,
      ),
      "skip",
    );
  });

  it("REGRESSION: the negative EXPIRES at 90 days", () => {
    // The TTL is the whole reason a `null` is safe to store. New companies
    // list; a cached "no" that never expires is a fail-open default frozen
    // into the database. Asserted at both edges so deleting the comparison
    // cannot pass.
    const justInside = planScreenerSlugResolution(
      {
        screenerSlug: null,
        screenerSlugCheckedAt: new Date(NOW - (SCREENER_SLUG_TTL_MS - 1000)),
      },
      NOW,
    );
    const justOutside = planScreenerSlugResolution(
      {
        screenerSlug: null,
        screenerSlugCheckedAt: new Date(NOW - (SCREENER_SLUG_TTL_MS + 1000)),
      },
      NOW,
    );
    assert.equal(justInside, "skip");
    assert.equal(justOutside, "resolve");
    assert.equal(SCREENER_SLUG_TTL_MS, 90 * 24 * 60 * 60 * 1000);
  });

  it("an INVALID timestamp is corrupt, not fresh", () => {
    assert.equal(
      planScreenerSlugResolution(
        { screenerSlug: null, screenerSlugCheckedAt: new Date("nope") },
        NOW,
      ),
      "resolve",
    );
  });

  it("an empty-string slug is not a slug", () => {
    assert.equal(
      planScreenerSlugResolution({ screenerSlug: "   " }, NOW),
      "resolve",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The quarterly fallback — recorded, deliberately not built                   */
/* -------------------------------------------------------------------------- */

describe("buildQuarterSourceUrl (A2.4 — documented, never fetched)", () => {
  it("is the proven endpoint shape, kept as knowledge not as a fetcher", () => {
    assert.equal(
      buildQuarterSourceUrl(511122, 6, 2026),
      "https://www.screener.in/company/source/quarter/511122/6/2026/",
    );
  });

  it("nothing in this package CALLS it", async () => {
    // The point of the function is that the knowledge survives without a second
    // writer for a docType `bse-announcements-sync` already owns — two writers
    // on one `@@unique([symbol, exchange, docType, period])` overwrite each
    // other on a schedule nobody watches. (screener.in's robots.txt also names
    // this exact path in a Disallow line.)
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join("src", "data-sources");
    const callers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "screener-resolve.ts")
      .filter((f) =>
        /\bbuildQuarterSourceUrl\s*\(/.test(readFileSync(join(dir, f), "utf8")),
      );
    assert.deepEqual(callers, []);
  });
});

/* -------------------------------------------------------------------------- */
/* robots.txt, enforced by a scan instead of by a comment                      */
/* -------------------------------------------------------------------------- */

describe("MONEY-1255 (A2): the Disallowed screener paths are UNREACHABLE", () => {
  /** Every `.ts` under a directory, recursively. */
  async function walk(dir: string): Promise<string[]> {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const out: string[] = [];
    const visit = (d: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e === "node_modules" || e === "dist" || e === "__tests__") continue;
        const full = join(d, e);
        if (statSync(full).isDirectory()) visit(full);
        else if (full.endsWith(".ts")) out.push(full);
      }
    };
    visit(dir);
    return out;
  }

  /** Source with line and block comments blanked, so prose cannot trip a scan. */
  async function code(file: string): Promise<string> {
    const { readFileSync } = await import("node:fs");
    return readFileSync(file, "utf8")
      .replace(/^[^\S\n]*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ""));
  }

  const ROOTS = ["src", "../core/src", "../../workers/src"];

  /**
   * PRE-EXISTING violations of the same robots.txt rule, each a dated,
   * reasoned, PINNED entry — the discipline `HTTP_EXEMPTIONS` and
   * `NSE_ARCHIVE_EXEMPTIONS` already use in this repo.
   *
   * This table may only SHRINK. It exists so a finding this scan made is
   * recorded rather than hidden: shrinking the scan to fit the code would make
   * the suite green by agreeing the call is not there, and it is.
   */
  const KNOWN_SEARCH_CALLERS: Record<
    string,
    { reason: string; pinnedTo: readonly string[] }
  > = {
    // EMPTY, and that is the steady state.
    //
    // This table held ONE entry when A2 wrote it: `searchScreener` in
    // `screener-client.ts`, a dead export calling `/api/company/search/?q=`
    // against screener's `Disallow: /*?q=`. A2 recorded it rather than
    // deleting it, because it did not own that file.
    //
    // It has since been DELETED (function + barrel export + type), which is
    // what closed the entry — and the assertion below is what forced the
    // closure to be recorded here rather than left stale. An exemption that
    // matches nothing is a hole that reads like coverage, so a violation
    // being FIXED must shrink this table exactly as loudly as a new one
    // would grow it.
  };

  it("every known-search-caller exemption still names a live call site", async () => {
    // An exemption that matches nothing is a hole that reads like coverage.
    const { readFileSync } = await import("node:fs");
    for (const [file, entry] of Object.entries(KNOWN_SEARCH_CALLERS)) {
      const raw = readFileSync(file, "utf8");
      for (const pin of entry.pinnedTo) {
        assert.ok(
          raw.includes(pin),
          `${file} no longer contains ${JSON.stringify(pin)}, which its ` +
            `exemption is pinned to. DELETE the exemption — the violation is ` +
            `gone.\nReason on file: ${entry.reason}`,
        );
      }
    }
  });

  it("REGRESSION: no NEW code builds screener's robots-Disallowed `?q=` search", async () => {
    // screener.in's robots.txt (fetched 2026-08-26) carries `Disallow: /*?q=`,
    // which covers `/api/company/search/?q=`. An earlier draft of this feature
    // called it. It was removed OUTRIGHT rather than demoted to a guarded
    // fallback, because a code path that CAN fetch a Disallowed URL is one flag
    // flip from fetching it — and this scan is what makes "removed" stay true.
    //
    // Matched on the PATH, not on the hostname: an assembled URL still forces a
    // look, and `company/search` is not a string anything else in this tree has
    // a reason to contain.
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of await walk(root)) {
        const src = await code(file);
        if (
          /company\/search/.test(src) ||
          /screener\.in[^"'`]*\?q=/.test(src)
        ) {
          const rel = file.replace(/^\.\.\/core\//, "../core/");
          if (KNOWN_SEARCH_CALLERS[rel]) continue;
          offenders.push(file);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "these files reference screener's Disallowed company-search endpoint:\n" +
        offenders.join("\n"),
    );
  });

  it("the scan FIRES on the shape it exists to forbid", async () => {
    // A guard that only reports "no offenders" is indistinguishable from a
    // guard whose regex stopped matching — which is how the MONEY-1157 version
    // of the feed scan was green for months.
    const preFix = [
      'const U = "https://www.screener.in/api/company/search/";',
      "async function search(q: string) {",
      "  return ky.get(`${U}?q=${q}`);",
      "}",
    ].join("\n");
    assert.equal(/company\/search/.test(preFix), true);

    const prose = "// we deliberately never call /api/company/search/?q=";
    const blanked = prose.replace(/^[^\S\n]*\/\/.*$/gm, "");
    assert.equal(
      /company\/search/.test(blanked),
      false,
      "a comment explaining the rule must not trip the rule",
    );
  });

  it("the retained validation helpers have NO caller in src", async () => {
    // `chooseScreenerCandidate` and `namesAgree` are kept because they encode a
    // real trap (`Bosch India` vs `Bosch Rexroth India` scoring exactly what a
    // legitimate variant scores) and an alpha-slug source would need them. The
    // module header says they are not on the live path; this is what makes that
    // a CHECKED property rather than a claim that decays.
    //
    // If you are here because this failed: a new caller is fine, but it must
    // not be one that reaches a Disallowed URL to build its candidates.
    const callers: string[] = [];
    for (const root of ROOTS) {
      for (const file of await walk(root)) {
        if (file.endsWith("screener-resolve.ts")) continue;
        const src = await code(file);
        if (/\bchooseScreenerCandidate\s*\(|\bnamesAgree\s*\(/.test(src)) {
          callers.push(file);
        }
      }
    }
    assert.deepEqual(callers, []);
  });

  it("screener-resolve.ts is PURE — it imports no HTTP client at all", async () => {
    // The strongest form of the guarantee: the module that decides company
    // identity cannot make a request, correct or otherwise.
    const src = await code("src/data-sources/screener-resolve.ts");
    assert.equal(/^\s*import\s+ky\b/m.test(src), false, "no ky import");
    assert.equal(/\bfetch\s*\(/.test(src), false, "no fetch()");
    assert.equal(/\bhttpGet\s*\(/.test(src), false, "no injected http seam");
  });
});
