/**
 * Every Databento SUBMISSION goes through the budget guard — MONEY-1373.
 *
 * ## Why this is a scan and not a review note
 *
 * MONEY-1309 is the precedent and it is exact: `withTiingoBudget` was wired at
 * ONE of five legs, which under-reported spend by roughly 80%. That is worse
 * than having no guard at all, because a guard reporting headroom is a guard
 * people plan against — and the four unguarded legs looked identical to the
 * guarded one at every call site.
 *
 * `submitBatchJob` is the only call in this repo that spends money at Databento.
 * `metadata.get_cost` is free, `batch.list_files` is free, the download is free
 * (it is re-downloading data already billed). So there is exactly one call to
 * police, and policing it by reading the source is the only check that cannot
 * be satisfied by a well-meaning new caller.
 *
 * ## What "inside the guard" means
 *
 * `withDatabentoBudget(spec, deps, quote, submit)` takes the submission as a
 * CALLBACK, so a guarded call site is lexically inside that call's parentheses.
 * The scanner below tracks paren depth and remembers which open paren belonged
 * to a `withDatabentoBudget` call, exactly as the Tiingo one does — a regex
 * cannot answer this, because `withDatabentoBudget(...)` and the
 * `submitBatchJob(...)` inside it are on different lines with arbitrary nesting
 * between them.
 *
 * Comments and string literals are skipped, so neither this file's own prose
 * nor a doc comment naming the function can make the scan pass or fail.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The call that spends. */
const SPEND_FN = "submitBatchJob";
/** The frame it must sit inside. */
const GUARD_FN = "withDatabentoBudget";

/**
 * Where a Databento submission could plausibly live.
 *
 * CWD is `packages/core`. `scripts/` is included even though the two job entry
 * points are not written yet — a root that walks nothing is a hole that reads
 * as coverage, so the walker reports what it found and the premise case fails
 * on a root that has silently stopped resolving.
 */
const SCAN_ROOTS = [
  { label: "packages/core/src", dir: join("src") },
  { label: "scripts/jobs", dir: join("..", "..", "scripts", "jobs") },
  { label: "scripts/data", dir: join("..", "..", "scripts", "data") },
  { label: "workers/src", dir: join("..", "..", "workers", "src") },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", ".turbo"]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) yield* walk(full);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) yield full;
  }
}

interface SpendSite {
  file: string;
  line: number;
  guarded: boolean;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Find every `submitBatchJob(` call and say whether a `withDatabentoBudget(`
 * frame is open around it.
 *
 * Hand-rolled rather than regexed, for the reason the Tiingo scanner gives: the
 * question is structural. It skips `//` and block comments and all three string
 * forms, so a mention in prose counts for nothing in either direction.
 */
export function scanSpendSites(file: string, src: string): SpendSite[] {
  const sites: SpendSite[] = [];
  /** One entry per open paren; true when `withDatabentoBudget` opened it. */
  const parens: boolean[] = [];
  let line = 1;
  let prevIdent = "";

  for (let i = 0; i < src.length; ) {
    const c = src[i]!;

    // Whitespace does NOT clear `prevIdent`. It used to, and that broke the
    // declaration check: in `function submitBatchJob(`, the space between the
    // keyword and the name reset the context, so the declaration counted as an
    // unguarded call and the scan indicted its own source of truth.
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // Comments.
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // Strings and templates.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") line++;
        i++;
      }
      i++;
      prevIdent = "";
      continue;
    }
    if (c === "(") {
      parens.push(prevIdent === GUARD_FN);
      prevIdent = "";
      i++;
      continue;
    }
    if (c === ")") {
      parens.pop();
      prevIdent = "";
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j]!)) j++;
      const ident = src.slice(i, j);
      // Is this identifier immediately followed by a call?
      let k = j;
      while (k < src.length && /\s/.test(src[k]!)) k++;
      if (ident === SPEND_FN && src[k] === "(" && prevIdent !== "function") {
        sites.push({ file, line, guarded: parens.some(Boolean) });
      }
      i = j;
      prevIdent = ident;
      continue;
    }
    prevIdent = "";
    i++;
  }
  return sites;
}

/**
 * The files allowed to name `submitBatchJob` without a guard frame around it.
 *
 * The DECLARATION itself, and nothing else. An entry here is a hole, so each one
 * carries a reason and the test asserts the map is exactly what it claims.
 */
const DECLARATION_FILES: Record<string, string> = {
  [join("src", "market-data", "databento", "databento-client.ts")]:
    "This IS the declaration. The exported function has to exist somewhere.",
};

const scanned: Array<{ label: string; files: number }> = [];
const allSites: SpendSite[] = [];
/** Files that so much as NAME the spending function. Proves the walk arrives. */
const filesNamingSpendFn: string[] = [];
for (const root of SCAN_ROOTS) {
  const files = [...walk(root.dir)];
  scanned.push({ label: root.label, files: files.length });
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!src.includes(SPEND_FN)) continue;
    filesNamingSpendFn.push(file);
    allSites.push(...scanSpendSites(file, src));
  }
}

describe("MONEY-1373 — every Databento submission is inside the budget guard", () => {
  it("[premise] the scan actually walked source trees", () => {
    // A scan whose roots resolve to nothing passes forever and reads as
    // coverage. Both package roots must be real; the scripts roots may be
    // legitimately small, so they are reported rather than floored.
    const core = scanned.find((s) => s.label === "packages/core/src");
    const workers = scanned.find((s) => s.label === "workers/src");
    assert.ok(
      (core?.files ?? 0) > 50,
      `walked ${core?.files ?? 0} files under packages/core/src`,
    );
    assert.ok(
      (workers?.files ?? 0) > 20,
      `walked ${workers?.files ?? 0} files under workers/src`,
    );
  });

  it("[premise] the walk REACHES the module that declares the spending call", () => {
    // The anti-vacuity pin, and it is deliberately about the DECLARATION rather
    // than about call sites. A rename of `submitBatchJob` fails here loudly,
    // instead of the suite quietly policing a function that no longer exists —
    // which is how a guard becomes decorative.
    //
    // Note what this does NOT assert: that any call site exists. Today there is
    // exactly ONE mention in the tree, the declaration, because the two job
    // entry points that submit are lane B of this ticket. A premise demanding a
    // call site would have to be weakened the moment it was written, and a
    // weakened premise is the thing this comment exists to prevent.
    assert.ok(
      filesNamingSpendFn.length >= 1,
      `no file under ${SCAN_ROOTS.map((r) => r.label).join(", ")} mentions ` +
        `${SPEND_FN} — either the walk is broken or the function was renamed`,
    );
    assert.ok(
      filesNamingSpendFn.some((f) => f in DECLARATION_FILES),
      `the walk did not reach the declaration. Saw: ${filesNamingSpendFn.join(", ")}`,
    );
  });

  it("no UNGUARDED call site outside the declaration", () => {
    const offenders = allSites
      .filter((s) => !s.guarded)
      .filter((s) => !(s.file in DECLARATION_FILES))
      .map((s) => `${s.file}:${s.line}`);
    assert.deepEqual(
      offenders,
      [],
      `these ${SPEND_FN}( call sites are not inside a ${GUARD_FN}( frame. ` +
        "MONEY-1309: a budget guard wired at one of five legs under-reported " +
        "spend by ~80%, which is worse than no guard because it manufactures " +
        "headroom nobody checks.",
    );
  });

  it("every declaration exemption still exists and is still the declaration", () => {
    // An exemption for a file that has moved is an exemption covering nothing,
    // and the list rots into an allowlist.
    for (const [file, why] of Object.entries(DECLARATION_FILES)) {
      const src = readFileSync(file, "utf8");
      assert.ok(
        src.includes(`export async function ${SPEND_FN}`),
        `${file} is exempt (${why}) but no longer declares ${SPEND_FN}`,
      );
    }
  });
});

describe("the scanner itself — positive and negative controls", () => {
  const G = GUARD_FN;
  const S = SPEND_FN;

  it("flags a bare call", () => {
    const sites = scanSpendSites("x.ts", `const j = await ${S}(req, opts);`);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]!.guarded, false);
  });

  it("accepts a call inside the guard's callback", () => {
    const src = `await ${G}(spec, deps, quote, async () => ${S}(req, opts));`;
    assert.equal(scanSpendSites("x.ts", src)[0]!.guarded, true);
  });

  it("accepts it nested arbitrarily deep inside the frame", () => {
    const src = `await ${G}(spec, deps, q, async () => {\n  if (x) {\n    return await ${S}(req);\n  }\n  return await ${S}(req2);\n});`;
    const sites = scanSpendSites("x.ts", src);
    assert.equal(sites.length, 2);
    assert.ok(sites.every((s) => s.guarded));
  });

  it("REJECTS a call after the frame has closed", () => {
    // The shape that matters: a caller who wrapped ONE submission and then
    // added a second beside it.
    const src = `await ${G}(spec, deps, q, async () => ${S}(a));\nawait ${S}(b);`;
    const sites = scanSpendSites("x.ts", src);
    assert.equal(sites.length, 2);
    assert.equal(sites[0]!.guarded, true);
    assert.equal(sites[1]!.guarded, false);
  });

  it("ignores a mention in a line comment", () => {
    assert.deepEqual(
      scanSpendSites("x.ts", `// call ${S}(req) here later`),
      [],
    );
  });

  it("ignores a mention in a block comment", () => {
    assert.deepEqual(scanSpendSites("x.ts", `/**\n * ${S}(req)\n */`), []);
  });

  it("ignores a mention inside a string or template", () => {
    assert.deepEqual(scanSpendSites("x.ts", `const s = "${S}(req)";`), []);
    assert.deepEqual(scanSpendSites("x.ts", "const s = `" + S + "(req)`;"), []);
  });

  it("does not count the DECLARATION as a call", () => {
    const src = `export async function ${S}(req: X): Promise<Y> { return z; }`;
    assert.deepEqual(scanSpendSites("x.ts", src), []);
  });

  it("reports the line number so an offender can be found", () => {
    const src = `const a = 1;\n\n// note\nawait ${S}(req);`;
    assert.equal(scanSpendSites("x.ts", src)[0]!.line, 4);
  });
});
