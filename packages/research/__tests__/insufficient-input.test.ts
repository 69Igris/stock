/**
 * MONEY-1274 / MONEY-1155 #30 — "not enough data" is not "the computation failed".
 *
 * ## The cascade this breaks
 *
 * `compute_growth_metrics` began:
 *
 *     if (!statements?.length || statements.length < 2) {
 *       return { success: false, error: "At least 2 annual statements required" };
 *     }
 *
 * `success: false` makes the executor mark the task FAILED, and
 * `buildUnavailableSourceLines` then lists it under "FAILED / UNAVAILABLE
 * SOURCES". So when `fetch_income_statement` returned nothing — which it does
 * for ~90% of symbols (2,123 of 20,637 covered, measured 2026-08-28) and did
 * for EVERY quarterly request before this ticket — the report told the user the
 * COMPUTATION failed.
 *
 * Nothing computed wrongly; the arithmetic was never reached. But a run that
 * merely fetched thin data read as a run where the analysis engine broke, which
 * is #30's screenshot: a wall of failed computations whose real cause is one
 * empty upstream table.
 *
 * ## The distinction being encoded
 *
 * CALLER ERROR (a required parameter never supplied — "sector is required")
 * stays `success: false`: the planner called the tool wrong and the run has a
 * real defect. INSUFFICIENT DATA (the parameter arrived and is too thin) is
 * what this reports. Only the second kind was converted; the first is
 * deliberately left alone.
 *
 * Source under test: packages/research/src/tools/insufficient-input.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { insufficientInput } from "../src/tools/insufficient-input";

describe("insufficientInput", () => {
  it("[regression] reports SUCCESS — the tool did its job", () => {
    // The whole fix. The tool looked at what it was given and correctly
    // declined to invent a number; reporting that as a failure tells the model
    // the engine is broken.
    const out = insufficientInput("At least 2 annual statements are required");
    assert.equal(out.success, true);
  });

  it("marks the result unavailable so nothing reads it as a value", () => {
    const out = insufficientInput("no series");
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.equal(d.reason, "no series");
  });

  it("carries the SHORTFALL, not just the fact of one", () => {
    // "not enough data" without the gap is not actionable: a run that fetched
    // 1 of 2 statements and one that fetched none look identical otherwise,
    // and they have different causes.
    const out = insufficientInput("At least 2 annual statements are required", {
      needed: "2 annual statements",
      got: 1,
    });
    const d = out.data as Record<string, unknown>;
    assert.equal(d.needed, "2 annual statements");
    assert.equal(d.got, 1);
  });

  it("omits the shortfall keys entirely when not supplied", () => {
    // `got: undefined` in a JSON payload reads as a measured absence rather
    // than an unmeasured one.
    const d = insufficientInput("r").data as Record<string, unknown>;
    assert.ok(!("needed" in d));
    assert.ok(!("got" in d));
  });

  it("is distinguishable from a source outage in metadata", () => {
    // `sourceError` means a source THREW (see unavailable.ts). This run is
    // healthy and merely under-supplied — a reader of the metadata must not be
    // able to mistake one for the other.
    const out = insufficientInput("r");
    assert.equal(out.metadata?.unavailableReason, "insufficient_input");
    assert.equal(out.metadata?.sourceError, undefined);
  });

  it("reports got:0 distinctly from an unmeasured shortfall", () => {
    // 0 is a real measurement and must survive — the `??`/`||` trap that cost
    // MONEY-1253 a working feature.
    const d = insufficientInput("r", { got: 0 }).data as Record<
      string,
      unknown
    >;
    assert.equal(d.got, 0);
    assert.ok("got" in d);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The wiring.
// ─────────────────────────────────────────────────────────────────────────

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const CONVERTED = [
  "compute-growth-metrics",
  "compute-beta",
  "compute-drawdown",
  "compute-correlation-matrix",
  "compute-forward-scenarios",
  "compute-var",
  "compute-risk-adjusted-returns",
  "compute-technical-analysis",
  "compute-strategy-fit",
  "compute-valuation-bands",
  "compute-relative-valuation",
  "compute-sector-aggregates",
  "compute-revenue-mix",
  "compute-earnings-estimates",
  "compute-earnings-surprise",
  "compute-comparison-scores",
  "compute-commodity-correlation",
  "compute-cash-flow-quality",
] as const;

/**
 * Guards that must KEEP failing — a required parameter was never supplied, so
 * the planner called the tool wrong and the run has a real defect.
 *
 * This is the half that makes the change safe. Converting these would hide a
 * genuine fault behind "not enough data", which is the opposite of the bug
 * being fixed: it would make a broken run look merely under-supplied.
 */
const CALLER_ERRORS = [
  "symbol is required",
  "sector is required",
  "growth_rate is required",
  "commodity_name is required",
  "holdings array is required",
] as const;

describe("the thin-input guards report unavailable, not failure", () => {
  for (const tool of CONVERTED) {
    it(`${tool} uses insufficientInput for its "at least N" guard`, () => {
      const src = read(`src/tools/${tool}.ts`);
      assert.match(src, /insufficientInput\(/);
      assert.match(
        src,
        /^import \{ insufficientInput \} from "\.\/insufficient-input";$/m,
        `${tool} must IMPORT the helper — a call without the import does not ` +
          `compile, and the import line is what a scan can actually pin`,
      );
    });

    it(`${tool} no longer returns success:false for an "at least N" shortfall`, () => {
      const src = read(`src/tools/${tool}.ts`);
      // Comments stripped: these files now EXPLAIN the old success:false shape
      // in prose, and matching the explanation would fail a correct file — the
      // same trap that broke the anchor-context ownership scan.
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      assert.doesNotMatch(
        code,
        /success: false,\s*\n?\s*error: "At least/,
        `${tool} still fails the task for a thin input`,
      );
    });
  }

  it("[regression] genuine CALLER errors still fail — the distinction is preserved", () => {
    // The half that makes this safe. "sector is required" means the planner
    // called the tool wrong; converting it would hide a real defect behind
    // "not enough data" and make a broken run look merely under-supplied.
    //
    // Asserted over the WHOLE tool directory rather than one file, because the
    // conversion was applied by a script over 19 guards — the risk is not that
    // one file was missed but that the pattern matched something it should not
    // have.
    const files = readdirSync(join(process.cwd(), "src/tools")).filter((f) =>
      f.startsWith("compute-"),
    );
    const sources = files.map((f) => read(`src/tools/${f}`)).join("\n");

    for (const msg of CALLER_ERRORS) {
      assert.ok(
        sources.includes(`error: "${msg}"`),
        `"${msg}" is a caller error and must still return success:false — ` +
          `the conversion has swallowed it`,
      );
      assert.ok(
        !sources.includes(`insufficientInput("${msg}")`),
        `"${msg}" was converted to insufficientInput, hiding a real defect`,
      );
    }
  });

  it("[regression] no guard MERGES a caller error into an insufficientInput", () => {
    // The gap the allowlist above cannot see. CALLER_ERRORS matches known
    // message STRINGS, so it proves those five specific guards stayed failing —
    // it says nothing about a guard that folds "the argument is absent or the
    // wrong type" INTO a data-shaped message and returns insufficientInput for
    // both. That is a shape question, not a string question, and eleven guards
    // had exactly that shape:
    //
    //     if (!Array.isArray(stocks) || stocks.length < 2)
    //       return insufficientInput("requires at least 2 stocks");
    //
    // A planner that omits `stocks` is then told the MARKET was thin. It either
    // accepts that as fact or retries the same malformed call.
    //
    // So: any `insufficientInput` whose guard also tests presence or type must
    // be split — the absent/wrong-type half fails, the too-short half reports
    // unavailable.
    const files = readdirSync(join(process.cwd(), "src/tools")).filter((f) =>
      f.startsWith("compute-"),
    );

    // Guards that legitimately test presence are the ones where EVERY input is
    // optional and the tool needs at least one of them — "pe_history or
    // pb_history", "operatingCashFlow or netIncome". Those are genuinely about
    // the data, not about a malformed call, and are listed rather than pattern-
    // matched so adding one is a deliberate act.
    const OPTIONAL_EITHER_OR = new Set([
      "compute-valuation-bands.ts",
      "compute-cash-flow-quality.ts",
    ]);

    const offenders: string[] = [];
    for (const file of files) {
      if (OPTIONAL_EITHER_OR.has(file)) continue;
      const code = read(`src/tools/${file}`)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      const lines = code.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.includes("insufficientInput(")) continue;
        // The guard is the `if (...)` IMMEDIATELY enclosing this return, so
        // walk back only to the end of the previous block. A fixed lookback
        // window spans the preceding guard, and once these are correctly split
        // the line above is the caller-error branch — which would make a
        // correct file look like an offender.
        const start = (() => {
          for (let j = i - 1; j >= 0 && j > i - 12; j--) {
            const t = lines[j]!.trim();
            if (t === "}" || t.startsWith("} else") || t.endsWith(";"))
              return j + 1;
          }
          return Math.max(0, i - 6);
        })();
        const guard = lines.slice(start, i).join(" ");
        const testsPresenceOrType =
          /!\s*Array\.isArray|!\s*\w+\s*\|\||typeof \w+ !==|=== undefined|== null/.test(
            guard,
          );
        const testsLength = /\.length\s*[<=]|Object\.keys/.test(guard);
        if (testsPresenceOrType && testsLength) {
          offenders.push(`${file}:${i + 1}`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these guards merge a CALLER error (absent / wrong type) with thin data ` +
        `into one insufficientInput, so a malformed call is reported to the ` +
        `model as insufficient data:\n  ${offenders.join("\n  ")}\n` +
        `Split each: fail for the absent/wrong-type half, insufficientInput ` +
        `for the too-short half.`,
    );
  });

  it("no converted guard lost its message", () => {
    // The reason text is what the model reads. A conversion that dropped it
    // would leave `available: false` with nothing explaining why.
    for (const tool of CONVERTED) {
      const src = read(`src/tools/${tool}.ts`);
      assert.match(
        src,
        /insufficientInput\(\s*\n?\s*"[^"]{10,}/,
        `${tool} calls insufficientInput without a usable reason string`,
      );
    }
  });
});
