/**
 * The shared strict argv parser — MONEY-1373.
 *
 * Every rule here was paid for by a real run. MONEY-1252 is the headline: a
 * wrapper that rewrote `--apply` as `--apply=true` had it silently ignored, and
 * a 54-minute "apply" run wrote nothing and exited 0. The common thread in all
 * of them is that the failure mode was a BIGGER or EMPTIER run rather than an
 * error — which is why every case below asserts a THROW rather than a value.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CliError, parseCliArgs } from "../../src/ops/cli-args";

const SPEC = {
  bare: ["apply", "dry-run"],
  valued: ["entry", "limit", "from"],
  numeric: ["limit"],
  repeatable: ["entry"],
};

describe("the SPACE form is refused", () => {
  it("rejects a positional argument", () => {
    // `--limit 500` arrives as two tokens, and the old parser read the second
    // as a positional and the flag as absent — i.e. NO limit, the whole
    // population.
    assert.throws(() => parseCliArgs(["--limit=5", "500"], SPEC), CliError);
  });

  it("rejects a valued flag given with no value", () => {
    assert.throws(() => parseCliArgs(["--limit"], SPEC), /requires a value/);
  });
});

describe("a BARE flag is spelled exactly", () => {
  it("accepts --apply", () => {
    assert.equal(parseCliArgs(["--apply"], SPEC).has("apply"), true);
  });

  it("REJECTS --apply=true (MONEY-1252)", () => {
    // The exact shape: a wrapper forwarded `--flag=value` uniformly, the bare
    // flag was swallowed, and the run exited 0 having written nothing.
    assert.throws(() => parseCliArgs(["--apply=true"], SPEC), /BARE flag/);
  });

  it("REJECTS --apply=false too — it is not a boolean", () => {
    assert.throws(() => parseCliArgs(["--apply=false"], SPEC), /BARE flag/);
  });
});

describe("unknown and repeated flags are fatal", () => {
  it("refuses an unknown flag rather than ignoring it", () => {
    assert.throws(() => parseCliArgs(["--aply"], SPEC), /Unknown flag/);
  });

  it("refuses a repeated NON-repeatable flag rather than guessing", () => {
    assert.throws(
      () => parseCliArgs(["--limit=5", "--limit=9"], SPEC),
      /more than once/,
    );
  });

  it("refuses a repeated bare flag", () => {
    assert.throws(
      () => parseCliArgs(["--apply", "--apply"], SPEC),
      /more than once/,
    );
  });
});

describe("repeatable flags", () => {
  it("collects every occurrence in order", () => {
    // The harvest needs this: a manifest entry is a unit of purchase, and an
    // operator legitimately runs two in one execution.
    const a = parseCliArgs(["--entry=one", "--entry=two"], SPEC);
    assert.deepEqual(a.all("entry"), ["one", "two"]);
  });

  it("value() returns the FIRST, so a single-value caller is unsurprised", () => {
    const a = parseCliArgs(["--entry=one", "--entry=two"], SPEC);
    assert.equal(a.value("entry"), "one");
  });

  it("all() is empty, not undefined, for an absent flag", () => {
    assert.deepEqual(parseCliArgs([], SPEC).all("entry"), []);
  });
});

describe("empty values and numbers", () => {
  it("refuses an EMPTY value rather than treating it as absent", () => {
    // Absent means the whole population. "" must not quietly become that.
    assert.throws(() => parseCliArgs(["--entry="], SPEC), /EMPTY value/);
    assert.throws(() => parseCliArgs(["--entry=   "], SPEC), /EMPTY value/);
  });

  it("accepts a positive integer", () => {
    assert.equal(parseCliArgs(["--limit=500"], SPEC).number("limit", 0), 500);
  });

  it("returns the fallback when a numeric flag is absent", () => {
    assert.equal(parseCliArgs([], SPEC).number("limit", 42), 42);
  });

  it("REFUSES the forms Number() would silently accept", () => {
    // `Number(x) || 0` turned each of these into 0 — the sentinel for NO
    // LIMIT — so a typo widened the run to everything.
    for (const bad of ["1e3", "0x10", "Infinity", "abc", "0", "-5", "1.5"]) {
      assert.throws(
        () => parseCliArgs([`--limit=${bad}`], SPEC),
        /positive integer/,
        `--limit=${bad} was accepted`,
      );
    }
  });

  it("tolerates surrounding whitespace on a number", () => {
    assert.equal(parseCliArgs(["--limit= 12 "], SPEC).number("limit", 0), 12);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */

describe("no NEW script starts a copy of the inlined Tiingo parser", () => {
  /**
   * The three files that legitimately carry the inlined region.
   *
   * `tiingo-script-decisions.test.ts` asserts those three are byte-identical to
   * each other — but over a HARDCODED three-entry map, so a FOURTH copy drifts
   * silently: nothing compares it to anything. This scan closes that, without
   * migrating the three (a change to three production argv contracts belongs in
   * its own ticket, not in one about a new vendor).
   */
  const ALLOWED = new Set([
    join("scripts", "jobs", "tiingo-us-backfill.ts"),
    join("scripts", "jobs", "tiingo-us-corp-actions-backfill.ts"),
    join("scripts", "jobs", "tiingo-us-news-seed.ts"),
  ]);

  // CWD is `packages/core`.
  const ROOT = join("..", "..");
  const MARKER = "tiingo-cli-args:begin";

  function* walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(join(ROOT, dir));
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(join(ROOT, rel)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) yield* walk(rel);
      else if (rel.endsWith(".ts")) yield rel;
    }
  }

  const scanned = [...walk("scripts")];
  const carriers = scanned.filter((f) =>
    readFileSync(join(ROOT, f), "utf8").includes(MARKER),
  );

  it("[premise] the scan actually walked scripts/", () => {
    // A scan whose root resolves to nothing passes forever and reads as
    // coverage.
    assert.ok(
      scanned.length > 20,
      `walked ${scanned.length} files under scripts/`,
    );
  });

  it("[premise] it FOUND the three known carriers", () => {
    // If the marker is ever renamed this fails loudly, instead of the scan
    // quietly policing a string that no longer exists.
    assert.equal(
      carriers.length >= 3,
      true,
      `found ${carriers.length} files carrying ${MARKER}: ${carriers.join(", ")}`,
    );
  });

  it("only the three legacy Tiingo scripts inline it", () => {
    const unexpected = carriers.filter((f) => !ALLOWED.has(f)).sort();
    assert.deepEqual(
      unexpected,
      [],
      "these scripts inline a copy of the Tiingo argv parser. " +
        "`tiingo-script-decisions.test.ts` compares only the three known " +
        "copies to each other, so a new one drifts with nothing watching. " +
        "Import `@usemoney/core/ops/cli-args` instead.",
    );
  });
});
