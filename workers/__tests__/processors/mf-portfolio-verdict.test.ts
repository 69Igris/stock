/**
 * UNIT TEST — mf-portfolio-sync's `ok` must mean WROTE, not PARSED.
 * MONEY-1238, item 2.
 *
 * ## The defect
 *
 * Three sites, all of them reporting success without consulting the write:
 *
 *     out.perAmc.push({ ok: true, status: "OK", … });   // template loop
 *     const gotSomething = amcSheets > 0;               // page-scrape loop
 *     out.ok = out.perAmc.length > 0 && out.perAmc.some((r) => r.ok);
 *
 * So every workbook could download, every sheet could parse, `writeSheet` could
 * return 0 for all of them, and the run reported `ok: true` with `written: 0`
 * under a 200 — on the 12th AND again on the 20th straggler sweep. The one
 * branch that was already right was HDFC (`ok: written > 0`), which is why it
 * is the shape the whole file now uses.
 *
 * `writeSheet` returning 0 with sheets in hand is not hypothetical: it returns
 * early on `if (!schemeKey) return 0`, and `schemeKey` is OUR normalisation of a
 * printed name. A change to `schemeKeyOf`, or an AMC moving the scheme name into
 * a merged cell, produces exactly this shape.
 *
 * ## What is asserted
 *
 * BEHAVIOUR on the real `judgeAmcAttempt` / `mfPortfolioRunOk`, and WIRING —
 * that all three sites call them and none re-derives `ok` from `sheets`. A
 * verdict function nobody calls is the defect, not the fix.
 *
 * LINE comments are stripped before BLOCK comments (MONEY-1143). Required here:
 * the processor's comments quote `const gotSomething = amcSheets > 0` verbatim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../_support/repo-root";

import {
  judgeAmcAttempt,
  mfPortfolioRunOk,
  type AmcAttemptTotals,
} from "../../src/processors/mf-portfolio-sync-logic";
import { amcsSkippedByProvenance } from "../../src/processors/mf-portfolio-sync";
import {
  AMC_SOURCES,
  AMC_PAGE_SCRAPERS,
  fetchableSources,
  scrapableAmcs,
} from "@usemoney/core/market-data";

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

function blankComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

const RAW = readFileSync(
  join(repoRoot(), "workers", "src", "processors", "mf-portfolio-sync.ts"),
  "utf8",
);
const CODE = blankComments(RAW);

/** One house, one whole-AMC workbook, everything stored. */
const healthy: AmcAttemptTotals = {
  sheets: 12,
  holdings: 640,
  written: 640,
  parsedOk: true,
};

describe("mf-portfolio verdict: ok means STORED (MONEY-1238)", () => {
  it("[meta] the source this file reasons over actually loaded", () => {
    assert.ok(
      RAW.length > 5000,
      `mf-portfolio-sync.ts did not load (${RAW.length}B)`,
    );
    assert.ok(
      CODE.includes("processMfPortfolioSync"),
      "comment-stripping ate the code it was supposed to preserve",
    );
  });

  it("[meta] the stripper strips LINE before BLOCK", () => {
    const src = [
      "// a line comment mentioning /* an unterminated block",
      "const verdict = judgeAmcAttempt({ sheets, holdings, written });",
      "/* a block mentioning const gotSomething = amcSheets > 0 inside */",
    ].join("\n");
    const out = blankComments(src);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.ok(out.includes("judgeAmcAttempt("));
    assert.ok(!/gotSomething/.test(out));
  });

  it("HDFC's missing scheme index is a NAMED refusal, not a falsy `&&`", () => {
    // MONEY-1401 review finding 6. `schemeIndex` used to sit INSIDE the HDFC
    // `if`, so an unreachable NAVAll skipped the house with no `attempted`, no
    // `perAmc`, no `deferred` and no `skippedReason` — `selected` just read one
    // lower. HDFC is the one house where that is total: it publishes a file PER
    // SCHEME and has no `buildUrl`, so the index is the only thing that can
    // name its files. One AMFI outage made `mf-sync` throw loudly and this job
    // lose its largest house in silence.
    //
    // A source scan is the right instrument: the question is whether the branch
    // EXISTS, not which of two near-identical expressions is in it.
    // MUTATION: delete the `hdfcRequested && !schemeIndex` block -> RED.
    const refusal = CODE.indexOf("hdfcRequested && !schemeIndex");
    assert.ok(
      refusal > 0,
      "the missing-index case must be its own branch, not a falsy conjunct " +
        "inside the fetch condition",
    );

    // It must REPORT — a branch that refuses without a row is the same silence
    // wearing an `if`.
    //
    // BOUNDED TO THIS BRANCH, by brace matching rather than by a character
    // window. A fixed slice ran past the closing brace into the FETCH block
    // below, which pushes the identical `out.attempted.push("HDFC")` — so
    // deleting the push from the refusal branch left this test GREEN. Caught by
    // mutation M2; an unbounded span around a first-match locator is the
    // vacuity this repo keeps re-finding.
    const open = CODE.indexOf("{", refusal);
    let depth = 0;
    let close = open;
    for (let i = open; i < CODE.length; i++) {
      if (CODE[i] === "{") depth++;
      else if (CODE[i] === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    assert.ok(close > open, "could not bound the refusal branch");
    const body = CODE.slice(open, close);
    assert.match(
      body,
      /out\.attempted\.push\("HDFC"\)/,
      "a refused house is still an ATTEMPTED house; without this the run's " +
        "denominator silently shrinks",
    );
    assert.match(
      body,
      /out\.perAmc\.push\(\{[\s\S]*?ok: false[\s\S]*?NO_SCHEME_INDEX/,
      "the refusal needs a NAMED status and ok:false, so judgeAmcAttempt's " +
        "contract (ok means STORED) holds for it too",
    );
  });

  it("a house that stored rows is OK", () => {
    assert.deepEqual(judgeAmcAttempt(healthy), { ok: true, status: "OK" });
  });

  it("REGRESSION: sheets parsed, holdings read, NOTHING written is NOT ok", () => {
    // The exact shape the old `gotSomething = amcSheets > 0` called success.
    const v = judgeAmcAttempt({ ...healthy, written: 0 });
    assert.equal(v.ok, false);
    assert.equal(v.status, "PARSED_BUT_NOTHING_WRITTEN");
  });

  it("a workbook that parsed to ZERO holdings is its own, named state", () => {
    // Distinct from "we had holdings and stored none": one says the sheet
    // layout moved, the other says the write path did. Collapsing them sends an
    // operator to the wrong half of the pipeline.
    const v = judgeAmcAttempt({
      sheets: 12,
      holdings: 0,
      written: 0,
      parsedOk: true,
    });
    assert.equal(v.ok, false);
    assert.equal(v.status, "PARSED_BUT_NO_HOLDINGS");
  });

  it("the pre-existing fetch/parse statuses are preserved verbatim", () => {
    assert.deepEqual(
      judgeAmcAttempt({
        sheets: 0,
        holdings: 0,
        written: 0,
        unrecognised: 3,
        // Consulted only when nothing else names the state; `unrecognised`
        // wins here regardless, which is itself worth pinning.
        parsedOk: false,
      }),
      { ok: false, status: "UNRECOGNISED_WORKBOOK" },
    );
    assert.deepEqual(
      judgeAmcAttempt({
        sheets: 0,
        holdings: 0,
        written: 0,
        fetchFailed: 3,
        parsedOk: false,
      }),
      { ok: false, status: "FETCH_FAILED" },
    );
    assert.deepEqual(
      judgeAmcAttempt({
        sheets: 0,
        holdings: 0,
        written: 0,
        parsedOk: false,
      }),
      { ok: false, status: "FETCH_FAILED" },
    );
  });

  it("MONEY-1405: parsed-to-zero-sheets is NOT a fetch failure", () => {
    // THE TATA BUG, as a unit. `parsedOk` shipped OPTIONAL and two of the three
    // call sites never passed it, so this state fell through to the
    // `: "FETCH_FAILED"` arm — and Tata reported a network failure on a run
    // that downloaded 1,762,746 bytes and parsed them fine. The real cause was
    // one over-anchored header regex (`/^isin$/` against a column headed
    // `ISIN CODE`), and the status pointed at the one subsystem that worked.
    //
    // The two inputs differ in ONE field and must produce different answers.
    // That is the whole contract of the flag, and it had no test.
    assert.deepEqual(
      judgeAmcAttempt({ sheets: 0, holdings: 0, written: 0, parsedOk: true }),
      { ok: false, status: "PARSED_BUT_NO_SHEETS" },
    );
    assert.deepEqual(
      judgeAmcAttempt({ sheets: 0, holdings: 0, written: 0, parsedOk: false }),
      { ok: false, status: "FETCH_FAILED" },
    );
  });

  it("a partial month stays OK but SAYS it is partial", () => {
    // Mirae publishes 97 workbooks a month; the 40th 404ing must not discard
    // the other 96. It must also not report as a clean month.
    const v = judgeAmcAttempt({ ...healthy, fetchFailed: 1, unrecognised: 0 });
    assert.equal(v.ok, true);
    assert.match(v.status, /^OK_PARTIAL /);
    assert.match(v.status, /1 fetch-failed/);
  });

  it("written > 0 outranks a fetch failure, and 0 written outranks nothing", () => {
    // Ordering: `written > 0` is checked FIRST, so a house that stored rows is
    // never reported as FETCH_FAILED just because one of its files was missing.
    assert.equal(
      judgeAmcAttempt({
        sheets: 1,
        holdings: 5,
        written: 5,
        fetchFailed: 90,
        parsedOk: true,
      }).ok,
      true,
    );
    // And a house that stored nothing is never OK, however many sheets parsed.
    assert.equal(
      judgeAmcAttempt({
        sheets: 900,
        holdings: 9000,
        written: 0,
        parsedOk: true,
      }).ok,
      false,
    );
  });

  it("the RUN needs a write AND an ok house", () => {
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: true }], written: 640 }),
      true,
    );
    // Nothing attempted.
    assert.equal(mfPortfolioRunOk({ perAmc: [], written: 0 }), false);
    // Attempted, every house failed.
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: false }, { ok: false }], written: 0 }),
      false,
    );
  });

  it("an empty house list is refused however the total reads", () => {
    // Both spellings of "nothing was attempted", including the incoherent one
    // (`written` non-zero with no house to have written it), which is
    // unreachable in the processor but must not become the one input that slips
    // through if a future branch ever produces it.
    //
    // NOTE this is `some()` doing the work, not a length check. The verdict
    // deliberately has NO `perAmc.length > 0` conjunct: `[].some()` is already
    // false, so such a floor could not change the answer for any input, and a
    // guard no input can exercise is the very thing this ticket removes
    // elsewhere. See `mfPortfolioRunOk`.
    assert.equal(mfPortfolioRunOk({ perAmc: [], written: 5 }), false);
    assert.equal(mfPortfolioRunOk({ perAmc: [], written: 0 }), false);
  });

  it("REGRESSION: an ok house with a ZERO run total cannot pass", () => {
    // The belt to `ok`'s braces. If some future branch ever reports ok:true
    // without contributing to `out.written`, the run verdict still refuses —
    // stated directly rather than inferred from the per-house booleans.
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: true }], written: 0 }),
      false,
    );
  });

  it("a non-zero TOTAL is not enough — a house must own it", () => {
    // Isolates the `some((r) => r.ok)` conjunct against `written > 0`.
    //
    // Unreachable through the processor TODAY, because `judgeAmcAttempt` sets
    // `ok` to exactly `written > 0`, so a non-zero run total always has an ok
    // house behind it. That implication is a coupling between two functions,
    // not a property of this one — and `mfPortfolioRunOk` takes a plain
    // `{ok}[]`, so it must not silently assume the caller's rule. If a future
    // branch ever judges a house not-ok for some other reason while still
    // adding to `out.written`, the run does not pass on the total alone.
    //
    // Contrast the `perAmc.length > 0` conjunct removed from this function: NO
    // input distinguished that one. This one has an input, and it is here.
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: false }], written: 5 }),
      false,
    );
  });

  it("one surviving house keeps the run ok — `some`, not `every`", () => {
    // Deliberate: the route turns !ok into a 500 that redelivers all seventeen
    // houses, so one AMC's 404 must not cost the other sixteen a retry.
    assert.equal(
      mfPortfolioRunOk({
        perAmc: [{ ok: false }, { ok: true }, { ok: false }],
        written: 12,
      }),
      true,
    );
  });
});

describe("mf-portfolio verdict: a SCOPED run may legitimately store nothing (MONEY-1490)", () => {
  /**
   * Until `only` actually reached the processor, this whole branch was
   * unreachable: every hop ran all 19 houses and stored ~22k rows, so
   * `written > 0` was true on every run the job had ever performed.
   *
   * Making the continuation cursor work is what put a narrow tail hop —
   * sometimes ONE house — on this path. A tail house legitimately has nothing
   * whenever its month is not published yet, and the old verdict called that a
   * failed run. The consequence was not one bad HTTP code: the route 500s,
   * Pub/Sub redelivers the IDENTICAL scoped message five times, dead-letters,
   * pages the founder — and `chainDeferredHouses` refuses to publish on `!ok`,
   * so the rest of the month's tail is abandoned behind it.
   */
  it("a scoped hop that reached houses and stored nothing is OK", () => {
    assert.equal(
      mfPortfolioRunOk({
        perAmc: [{ ok: false }, { ok: false }],
        written: 0,
        scoped: true,
      }),
      true,
      "a tail hop whose houses have not published yet must not 500 — a " +
        "redelivery re-reads the same absent files, and refusing here also " +
        "abandons every house behind it in the chain",
    );
  });

  it("REGRESSION: an UNSCOPED run storing nothing is still a failure", () => {
    // The strict rule is the whole of MONEY-1238 and must survive untouched:
    // if the entire industry stored nothing, that IS broken and a retry is the
    // right answer. MUTATION: drop the `scoped === true` test -> RED.
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: false }], written: 0 }),
      false,
    );
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: false }], written: 0, scoped: false }),
      false,
    );
  });

  it("REGRESSION: a scoped run that reached NO house is still a failure", () => {
    // "We reached houses and they had nothing" and "we reached no house at
    // all" are different states. The second is a SELECTION bug — the shape
    // MONEY-1198 and the provenance hazard both produce — and must stay loud.
    // MUTATION: drop `perAmc.length > 0` -> RED.
    assert.equal(
      mfPortfolioRunOk({ perAmc: [], written: 0, scoped: true }),
      false,
    );
  });

  it("the scoped clause cannot rescue a run that DID reach a working house", () => {
    // Guards the other direction: scoping must not change the answer for any
    // run the strict rule already accepts or rejects on real evidence.
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: true }], written: 640, scoped: true }),
      true,
    );
    assert.equal(
      mfPortfolioRunOk({ perAmc: [{ ok: true }], written: 640 }),
      true,
    );
  });

  it("the processor passes `scoped` from the presence of `only`", () => {
    assert.match(
      CODE,
      /mfPortfolioRunOk\(\{[\s\S]{0,80}scoped: opts\?\.only !== undefined/,
      "the verdict must learn scoping from the message, not from a count",
    );
  });
});

describe("mf-portfolio verdict: WIRED at all three sites (MONEY-1238)", () => {
  it("REGRESSION: no site pushes an unconditional ok:true", () => {
    assert.doesNotMatch(
      CODE,
      /ok: true,\s*\n\s*status: "OK",/,
      "the template loop must not report success without consulting `written`",
    );
  });

  it("REGRESSION: `ok` is never re-derived from sheet COUNT", () => {
    assert.doesNotMatch(
      CODE,
      /const gotSomething = amcSheets > 0;/,
      "`amcSheets > 0` is PARSED, not WROTE — the whole defect",
    );
  });

  it("all three per-AMC sites call judgeAmcAttempt", () => {
    const calls = CODE.match(/judgeAmcAttempt\(/g) ?? [];
    assert.equal(
      calls.length,
      3,
      `expected the template loop, the page-scrape loop and HDFC to share one ` +
        `judgement; found ${calls.length} call(s)`,
    );
  });

  it("each site pushes the judged verdict rather than its own boolean", () => {
    const okFromVerdict = CODE.match(/ok: verdict\.ok,/g) ?? [];
    assert.equal(
      okFromVerdict.length,
      3,
      `expected 3 sites to take ok from the shared verdict, found ` +
        `${okFromVerdict.length}`,
    );
  });

  it("the RUN verdict comes from mfPortfolioRunOk", () => {
    // Matches the CALL, not one spelling of its argument — MONEY-1490.
    //
    // This read `mfPortfolioRunOk\(out\);` and went red when the call gained a
    // `scoped` field. The property it names ("the shared function, not a
    // re-typed `some`") was never violated, so the literal was over-specified
    // against the argument rather than the wiring. Widened to the call; the
    // `doesNotMatch` below is what actually forbids a hand-rolled expression,
    // and it is untouched.
    assert.match(
      CODE,
      /out\.ok = mfPortfolioRunOk\(/,
      "the run-level `ok` must be the shared function, not a re-typed `some`",
    );
    assert.doesNotMatch(
      CODE,
      /out\.ok = out\.perAmc\.length > 0 && out\.perAmc\.some/,
      "the old inline expression must not come back — it says nothing about " +
        "whether anything was written",
    );
  });
});

describe("MONEY-1401 F2 — no house may vanish from the report", () => {
  // `scrapableAmcs()` filters `provenance === "verified"`, and
  // `skippedByProvenance` used to be built from `AMC_SOURCES` alone. So a
  // DEMOTED page-scrape house appeared in NONE of `attempted`, `perAmc`,
  // `deferred` or `skippedByProvenance` — `selected` simply read one lower,
  // which is the HDFC bug this ticket fixed, over 13 more houses. Zero are
  // demoted today, which is exactly why nothing caught it.
  const FULL = [...AMC_SOURCES, ...AMC_PAGE_SCRAPERS];

  it("the domain is the FULL registry — both source lists", () => {
    // With nothing visitable, EVERY registered house must be reported.
    // MUTATION: drop `...AMC_PAGE_SCRAPERS` from the function's domain -> RED.
    // A partition assertion alone could not catch that: all 13 page-scrapers
    // are verified today, so they sit in `visitable` either way and the
    // partition still balances.
    const all = amcsSkippedByProvenance(new Set());
    assert.deepEqual(
      all.map((r) => r.amc).sort(),
      FULL.map((s) => s.id).sort(),
    );
    assert.ok(
      all.length > AMC_SOURCES.length,
      "the page-scrape registry is not in the domain at all",
    );
  });

  it("a DEMOTED page-scrape house is REPORTED, not silently dropped", () => {
    // The condition that has no fixture in the real registry, exercised on the
    // real registry: take one verified page-scrape house out of the visitable
    // set, exactly as a provenance demotion would.
    const demoted = scrapableAmcs()[0]!;
    const visitable = new Set<string>([
      ...fetchableSources().map((s) => s.id),
      ...scrapableAmcs()
        .filter((s) => s.id !== demoted.id)
        .map((s) => s.id),
    ]);

    const rows = amcsSkippedByProvenance(visitable);
    const hit = rows.find((r) => r.amc === demoted.id);
    assert.ok(
      hit,
      `${demoted.id} was demoted and reported by nothing — the run would just ` +
        `select one house fewer`,
    );
    // NOT ASSERTED, and said out loud rather than faked: all 19 registered
    // houses carry `provenance: "verified"` today, so `hit.provenance ===
    // demoted.provenance` holds for a hardcoded `"verified"` too — mutation-
    // checked and GREEN. There is no second value in the registry to pin it
    // against, and inventing a synthetic registry would test the fake.
    // Re-add a value assertion the day a house is genuinely demoted.
    assert.equal(typeof hit.provenance, "string");
  });

  it("the REAL gates partition the registry exactly — nothing double-counted", () => {
    // The live wiring, with no injection: a house is visited or reported,
    // never both and never neither.
    const visitable = new Set<string>([
      ...fetchableSources().map((s) => s.id),
      ...scrapableAmcs().map((s) => s.id),
    ]);
    const skipped = amcsSkippedByProvenance().map((r) => r.amc);

    assert.equal(
      new Set(skipped).size,
      skipped.length,
      "a house reported twice",
    );
    assert.equal(
      skipped.length + visitable.size,
      FULL.length,
      "a house is either visited or reported as skipped, never both or neither",
    );
    for (const id of skipped) {
      assert.ok(
        !visitable.has(id),
        `${id} is both visited and reported skipped`,
      );
    }
    // Every page-scrape house is verified TODAY, so none of them may appear.
    // If this ever fails, a demotion landed — which is the case above, and a
    // finding rather than a test bug.
    for (const s of scrapableAmcs()) {
      assert.ok(!skipped.includes(s.id), `${s.id} is verified and scrapable`);
    }
  });

  it("processMfPortfolioSync calls it rather than re-deriving the rule", () => {
    // A verdict function nobody calls is the defect, not the fix — the same
    // argument this file already makes for `judgeAmcAttempt`.
    // NO ARGUMENT, which is also how it stays independent of `opts.only`:
    // that flag scopes one run and says nothing about a house's provenance.
    assert.match(CODE, /skippedByProvenance = amcsSkippedByProvenance\(\);/);
  });
});
