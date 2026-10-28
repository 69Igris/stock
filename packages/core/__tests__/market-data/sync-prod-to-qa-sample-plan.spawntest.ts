/**
 * `sync-prod-to-qa --tier=sample` — WHAT THE SCRIPT BUILDS AND FORWARDS.
 *
 * Split out of `sync-prod-to-qa-sample-tier.test.ts` by MONEY-1316; see the
 * sibling `sync-prod-to-qa-sample-refusals.spawntest.ts` for why. This half is
 * the expensive one (12.2 s standalone, and it EXCEEDED the 30 s file wall under
 * parallel load), which is what the `.spawntest.ts` suffix is for: it routes
 * the file into the second `node --test` lane at `--test-timeout=180000`.
 *
 * These are the cases where the script is expected to PRODUCE something and
 * hand it on intact: the plan covering exactly what the run iterates, a
 * dry-run building the identical plan with no side effects, `--universe`
 * reaching the plan builder rather than being echoed and dropped, and the
 * emitted query being Extended JSON rather than something that merely looks
 * like it.
 *
 * A new case belongs here if the expected outcome is a plan or a forwarded
 * value, and in the sibling if it is a refusal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  SPAWNING_SUITE,
  STUBS,
  runSync,
  dumps,
  restores,
  REF,
  PLAN,
  PLAN_FILE,
  planLines,
  planFileWithout,
  type Run,
} from "./sync-prod-to-qa-sample-harness";

describe(
  "premise: the plan covers exactly what the script iterates",
  SPAWNING_SUITE,
  () => {
    it("every REFERENCE_COLLECTIONS entry has a SAMPLE_PLAN line, and vice versa", () => {
      // Not a behaviour under test — a premise the tests below depend on. If it
      // drifts, the "not in the plan" test is testing a real gap rather than a
      // simulated one and every other test in this file goes red confusingly.
      const planned = planLines().map(([c]) => c);
      assert.deepEqual([...planned].sort(), [...REF].sort());
      assert.ok(
        REF.length > 30,
        `expected the full allowlist, got ${REF.length}`,
      );
    });
  },
);

describe(
  "--tier=sample --dry-run: same plan, no side effects",
  SPAWNING_SUITE,
  () => {
    it("executes nothing", () => {
      const r = runSync({ STUB_PLAN_FILE: PLAN_FILE }, [
        "--tier=sample",
        "--dry-run",
      ]);
      assert.equal(r.status, 0, r.out.slice(-2000));
      assert.deepEqual(dumps(r.log), []);
      assert.deepEqual(restores(r.log), []);
      assert.doesNotMatch(r.log, /RELINK_RAN/);
      assert.match(
        r.log,
        /^NPX /m,
        "the dry run must still build the plan — that is what it is previewing",
      );
    });

    it("prints a --query for EVERY collection and never a full-collection dump", () => {
      const r = runSync({ STUB_PLAN_FILE: PLAN_FILE }, [
        "--tier=sample",
        "--dry-run",
      ]);
      const printed = (r.out.match(/--query='/g) ?? []).length;
      assert.equal(
        printed,
        REF.length,
        `expected ${REF.length} --query lines, got ${printed}`,
      );
      // `# else skip (empty-guard)` is the tail of the FULL-collection form. Its
      // presence under --tier=sample is the exact regression this pins: the first
      // cut of the dry run had never heard of the tier and printed full dumps.
      assert.doesNotMatch(
        r.out,
        /# else skip \(empty-guard\)/,
        "the dry run printed a FULL-collection dump under --tier=sample",
      );
      assert.equal(
        (r.out.match(/else skip \(0 sampled/g) ?? []).length,
        REF.length,
      );
    });

    it("prints the SAME queries the real run passes to mongodump", () => {
      // Parity by VALUE, not by both paths mentioning the tier. One
      // `build_sample_plan` serves both; two descriptions of one rule drift, and
      // the copy that drifts is the one nobody runs interactively.
      const dry = runSync({ STUB_PLAN_FILE: PLAN_FILE }, [
        "--tier=sample",
        "--dry-run",
      ]);
      const real = runSync({ STUB_PLAN_FILE: PLAN_FILE });

      const dryQueries = new Map<string, string>();
      const lines = dry.out.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const c = /--collection="([a-z0-9_]+)"/.exec(lines[i]!);
        if (!c) continue;
        const q = /--query='(.*)' \\$/.exec(lines[i + 1] ?? "");
        assert.ok(q, `no --query printed under ${c[1]}`);
        dryQueries.set(c[1]!, q[1]!);
      }

      const realQueries = new Map(
        dumps(real.log).map((d) => [d.collection, d.query]),
      );
      assert.equal(dryQueries.size, REF.length);
      assert.deepEqual(
        [...dryQueries.entries()].sort(),
        [...realQueries.entries()].sort(),
        "the dry run and the real run disagree about what would be copied",
      );

      // MONEY-1488, piggy-backed on a run this case already pays for rather
      // than costing another: the sample tier writes NO freshness rows. A
      // sampled restore is 500 symbols x N years, not prod's copy — stamping it
      // RESTORED would tell a future delta bound that QA holds the collection,
      // and would reset the clock the SCHEDULED reference job rotates on, so
      // whatever a laptop happened to touch would sink to the back of the real
      // queue.
      assert.doesNotMatch(
        real.log,
        /^OUTCOME /m,
        "--tier=sample wrote a freshness row; only --tier=reference may",
      );
    });

    it("previews the refusal of an unplanned collection instead of a copy", () => {
      const missing = planFileWithout("stock_news");
      const dry = runSync({ STUB_PLAN_FILE: missing }, [
        "--tier=sample",
        "--dry-run",
      ]);
      assert.equal(dry.status, 0);
      assert.match(
        dry.out,
        /stock_news: NOT IN THE SAMPLE PLAN — the real run would skip it and mark it failed/,
      );
      assert.doesNotMatch(dry.out, /--collection="stock_news"/);

      // …and that preview is true.
      const real = runSync({ STUB_PLAN_FILE: missing });
      assert.equal(real.status, 1);
      assert.match(real.out, /1 step\(s\) failed: stock_news/);
    });
  },
);

describe(
  "--universe is validated and forwarded, not echoed and dropped",
  SPAWNING_SUITE,
  () => {
    for (const bad of ["abc", "0", "-1", "1.5", ""]) {
      it(`rejects --universe=${JSON.stringify(bad)} before anything runs`, () => {
        const r = runSync({ STUB_PLAN_FILE: PLAN_FILE }, [
          "--yes",
          "--tier=sample",
          `--universe=${bad}`,
        ]);
        assert.equal(r.status, 1, r.out.slice(-2000));
        assert.match(r.out, /--universe must be/);
        assert.deepEqual(dumps(r.log), []);
        // Rejected in the argument loop — before the banner, so the value can
        // never be echoed as if it had been accepted.
        assert.doesNotMatch(r.out, /Mode: /);
        assert.doesNotMatch(
          r.log,
          /^NPX /m,
          "the plan generator ran on an invalid universe",
        );
      });
    }

    it("forwards the accepted value to the plan generator", () => {
      // The defect this replaced: `--universe` was parsed, echoed into the banner
      // and documented in --help while being forwarded NOWHERE, so it printed a
      // confident "universe=100" and copied the full manifest.
      const r = runSync({ STUB_PLAN_FILE: PLAN_FILE }, [
        "--yes",
        "--tier=sample",
        "--universe=7",
        "--years=3",
      ]);
      assert.equal(r.status, 0, r.out.slice(-2000));
      assert.match(r.log, /^NPX .*--universe=7\b/m);
      assert.match(r.log, /^NPX .*--years=3\b/m);
    });

    it("a smaller universe really does narrow the emitted query", () => {
      // Forwarding an argument is only worth something if the generator acts on
      // it. Run the REAL generator at two sizes and compare the query it emits.
      const wide = runSync({}, ["--yes", "--tier=sample", "--universe=500"]);
      const narrow = runSync({}, ["--yes", "--tier=sample", "--universe=1"]);
      const q = (r: Run): string =>
        dumps(r.log).find((d) => d.collection === "stock_flags")?.query ?? "";
      assert.match(q(wide), /"RELIANCE","TCS"/);
      assert.match(q(narrow), /\{"\$in":\["RELIANCE"\]\}/);
      assert.doesNotMatch(q(narrow), /TCS/);
    });
  },
);

describe(
  "--tier=sample: the emitted query is Extended JSON",
  SPAWNING_SUITE,
  () => {
    it('every date bound is {"$date": …}, never a bare ISO string', () => {
      // mongodump parses --query as Extended JSON. A bare ISO string compares as
      // a STRING against a BSON date and matches NOTHING — and with --drop that
      // is not "fewer rows", it is an emptied QA collection. Silently: an empty
      // result is indistinguishable from "no rows in the window".
      //
      // Run against the REAL generator (no canned plan) so this covers the whole
      // chain: buildQuery -> the CLI's TSV -> awk -> mongodump's argv.
      const r = runSync({});
      assert.equal(r.status, 0, r.out.slice(-2000));

      const d = dumps(r.log);
      assert.equal(d.length, REF.length);

      const expectDated = planLines()
        .filter(([, q]) => q.includes("$date"))
        .map(([c]) => c);
      assert.ok(
        expectDated.length > 15,
        `expected many time-bounded collections, got ${expectDated.length}`,
      );

      for (const { collection, query } of d) {
        JSON.parse(query); // it must be parseable JSON at all
        assert.doesNotMatch(
          query,
          /"\$(gte|gt|lte|lt)"\s*:\s*"/,
          `${collection}: a date bound is a bare string — it would match nothing`,
        );
        if (expectDated.includes(collection)) {
          assert.match(
            query,
            /\{"\$date":"/,
            `${collection}: lost its Extended JSON date wrapper`,
          );
        }
      }
    });

    it("the window is the one the operator asked for", () => {
      const r = runSync({}, ["--yes", "--tier=sample", "--years=5"]);
      const q =
        dumps(r.log).find((d) => d.collection === "stock_flags")?.query ?? "";
      const m = /\{"\$date":"([^"]+)"\}/.exec(q);
      assert.ok(m, `no $date in stock_flags' query: ${q}`);
      const years =
        (Date.now() - Date.parse(m[1]!)) / (365.25 * 24 * 3600 * 1000);
      assert.ok(
        years > 4.9 && years < 5.1,
        `--years=5 produced a ${years.toFixed(2)}-year window`,
      );
    });
  },
);
