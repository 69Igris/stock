import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * MONEY-1205 — central search could not find an exactly-matching ETF.
 *
 * The `instrument_search` Atlas index maps `symbol` TWICE: as an edgeGram
 * `autocomplete` field and as a `string` with `lucene.keyword`
 * (docs/setup/atlas-search-setup.md). `lucene.keyword` emits the whole field as
 * ONE unmodified token, so the `text` leg over `["symbol","name"]` only matches
 * an exactly-cased symbol. A lower-cased query forfeits that scoring
 * contribution: measured on prod, "sbin" ranked SBIN 5th behind
 * SBINMID150/SBINEQWETF while "SBIN" ranked it 1st. Nothing errors — the right
 * row simply sinks, possibly past the caller's limit.
 *
 * What must hold is an ASYMMETRY, and that is what this file pins:
 *   - the ATLAS instrument query is uppercased,
 *   - the PRISMA fallback keeps the raw query (it is genuinely case-insensitive
 *     via `mode:"insensitive"`, and uppercasing it would break nothing but says
 *     something false about the backend),
 *   - the MF Atlas query is NOT uppercased — that index uses `lucene.standard`
 *     for `schemeName`/`amcName` and keyword-maps only the numeric
 *     `schemeCode`, so there is no casing bug there to fix.
 *
 * Asserting only "the file contains .toUpperCase()" would pass on any of the
 * three being wrong, so each is located and checked at its own call site.
 */

function repoRoot(): string {
  // Anchor on the workspace lockfile, never turbo.json — Turborepo supports
  // per-package configs, so a turbo.json walk stops inside packages/services
  // and every read returns "" (a source guard that silently checks nothing).
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(process.cwd());
}

const SRC = (() => {
  const p = join(
    repoRoot(),
    "packages",
    "services",
    "src",
    "discover.service.ts",
  );
  return existsSync(p) ? readFileSync(p, "utf8") : "";
})();

/** The argument list of the first call to `fn`, brace/paren matched. */
function callArgs(src: string, fn: string): string | null {
  const at = src.indexOf(`${fn}(`);
  if (at < 0) return null;
  let depth = 0;
  const start = at + fn.length;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return null;
}

describe("discover search casing — the Atlas/Prisma asymmetry (MONEY-1205)", () => {
  it("the source is readable at all", () => {
    // Guards the guard: every assertion below is vacuously true on "".
    assert.ok(SRC.length > 1000, "could not read discover.service.ts");
  });

  it("the Atlas INSTRUMENT query is uppercased", () => {
    const args = callArgs(SRC, "await atlasSearchInstruments");
    assert.ok(args !== null, "no call to atlasSearchInstruments found");
    const first = args.split(",")[0]!.trim();
    assert.match(
      first,
      /\.toUpperCase\(\)\s*$/,
      `atlasSearchInstruments receives ${JSON.stringify(first)} — it must be ` +
        `uppercased, or the lucene.keyword leg on "symbol" cannot match.`,
    );
  });

  it("the Atlas MF query is NOT uppercased — that index has no keyword symbol", () => {
    const args = callArgs(SRC, "await atlasSearchMfs");
    assert.ok(args !== null, "no call to atlasSearchMfs found");
    const first = args.split(",")[0]!.trim();
    assert.doesNotMatch(
      first,
      /\.toUpperCase\(\)/,
      "atlasSearchMfs was uppercased. The MF index analyses schemeName/amcName " +
        "with lucene.standard, so this fixes nothing and misstates the backend.",
    );
  });

  it("the Prisma fallback still matches case-insensitively on symbol and name", () => {
    // If someone 'simplifies' by uppercasing `trimmed` once at the top, these
    // insensitive matches keep working but `contains` starts comparing an
    // uppercased needle — fine — while `name` lookups lose nothing. The real
    // risk is the reverse: dropping mode:"insensitive" because "we uppercase
    // now". Pin both.
    assert.match(
      SRC,
      /symbol:\s*\{\s*contains:\s*trimmed,\s*mode:\s*"insensitive"\s*\}/,
    );
    assert.match(
      SRC,
      /name:\s*\{\s*contains:\s*trimmed,\s*mode:\s*"insensitive"\s*\}/,
    );
  });

  it("previousSymbols is compared uppercased — stored that way", () => {
    assert.match(
      SRC,
      /previousSymbols:\s*\{\s*has:\s*trimmed\.toUpperCase\(\)\s*\}/,
    );
  });
});
