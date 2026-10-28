/**
 * MONEY-1204 — every provenance source code must decode to a human label.
 *
 * `SectionShell.sourceLabel` turns a stored source code into the text of the
 * provenance chip. It had a table for known codes plus ONE graceful fallback,
 * for lowercase-hyphen registry family ids ("nse-fii-stats"), whose comment
 * said it existed "so a new feed does not show up as a raw slug the day it
 * ships".
 *
 * But this codebase mints source codes in TWO conventions, and the fallback
 * only knew one. The six discover-lane codes are UPPER_SNAKE, so four of them
 * matched neither the table nor the regex and reached the screen verbatim:
 * a user on /discover/markets read the literal string `NSE_FII_DII_CASH`.
 *
 * The bug is not the four missing table rows — those are a one-line fix. It is
 * that nothing connected the place codes are MINTED (the service layer) to the
 * place they are RENDERED (this component), so the two drifted silently and
 * the failure was invisible to every type check. That seam is what this file
 * guards: it reads the real constants out of the service sources and proves
 * each one decodes.
 *
 * Source: apps/web/components/stock/SectionShell.tsx
 *         packages/services/src/discover-sections.service.ts
 *         packages/services/src/stock-sections-docs.service.ts
 *         packages/core/src/market-data/mf-portfolio-section-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..");
const REPO = join(WEB, "..", "..");

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}

/** LINE before BLOCK — MONEY-1143. */
function stripComments(s: string): string {
  return s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const shellSrc = read(join(WEB, "components", "stock", "SectionShell.tsx"));

// ── What the renderer knows ──────────────────────────────────────────────────

/** Keys of the `KNOWN` table, both bare (`NSE_XBRL:`) and quoted forms. */
function knownKeys(src: string): Set<string> {
  const start = src.indexOf("const KNOWN: Record<string, string> = {");
  assert.notEqual(start, -1, "the KNOWN decode table was renamed or removed");
  const end = src.indexOf("\n  };", start);
  assert.notEqual(end, -1, "could not find the end of the KNOWN table");
  const body = stripComments(src.slice(start, end));
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s*"([^"]+)":/gm)) keys.add(m[1]!);
  for (const m of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm))
    keys.add(m[1]!);
  return keys;
}

/**
 * The fallback regexes, READ OUT OF the component rather than restated here.
 *
 * The first draft of this file hardcoded copies of both patterns. That is a
 * shadow test: deleting a branch from `sourceLabel` left the copies intact, so
 * the coverage assertion below went on passing against a contract the
 * implementation no longer honoured. Parsing them out means a removed or
 * narrowed branch fails coverage directly, which is the behaviour under test.
 */
function fallbackPatterns(src: string): RegExp[] {
  const start = src.indexOf("export function sourceLabel");
  assert.notEqual(start, -1, "sourceLabel was renamed or removed");
  const end = src.indexOf("\n}", start);
  assert.notEqual(end, -1, "could not find the end of sourceLabel");
  const body = src.slice(start, end);
  return [...body.matchAll(/if \(\/(.+?)\/\.test\(source\)\)/g)].map(
    (m) => new RegExp(m[1]!)
  );
}

const FALLBACKS = fallbackPatterns(shellSrc);

/** The two shapes this codebase actually mints. */
const LOWER_SLUG_SHAPE = "nse-fii-stats";
const UPPER_SNAKE_SHAPE = "NSE_FII_DII_CASH";

function decodes(code: string, known: Set<string>): boolean {
  return known.has(code) || FALLBACKS.some((re) => re.test(code));
}

// ── What the services mint ───────────────────────────────────────────────────

/**
 * `const SRC_* = "..."` / `const *_SOURCE = "..."` is the house convention for
 * a provenance code. Scanning for it (rather than listing today's six) is the
 * whole point — the next one is caught the day it is written.
 */
function mintedConstants(files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const src = stripComments(read(f));
    const re =
      /^\s*const\s+(SRC_[A-Z0-9_]+|[A-Z0-9_]+_SOURCE)\s*=\s*"([^"]+)"/gm;
    for (const m of src.matchAll(re)) out.set(m[1]!, m[2]!);
  }
  return out;
}

const SERVICE_FILES = [
  join(REPO, "packages", "services", "src", "discover-sections.service.ts"),
  join(REPO, "packages", "services", "src", "stock-sections-docs.service.ts"),
];

/** The MF section names its two sources in a type union, not a constant. */
function mfUnionMembers(): string[] {
  const src = read(
    join(
      REPO,
      "packages",
      "core",
      "src",
      "market-data",
      "mf-portfolio-section-logic.ts"
    )
  );
  const m = src.match(
    /source:\s*((?:"[A-Z_]+"\s*\|\s*)+"[A-Z_]+")\s*\|\s*null;/
  );
  assert.ok(m, "the MF portfolio source union was renamed or removed");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

// ── The guards ───────────────────────────────────────────────────────────────

describe("sourceLabel covers every minted provenance code", () => {
  const known = knownKeys(shellSrc);

  it("finds the constants it is meant to be scanning", () => {
    // A scan that silently matches nothing would pass every assertion below
    // while proving nothing — the wrong-granularity failure of MONEY-1189.
    const minted = mintedConstants(SERVICE_FILES);
    assert.ok(
      minted.size >= 7,
      `expected >= 7 minted source constants, found ${minted.size}. ` +
        "If the naming convention changed, this scan is now blind — fix the " +
        "regex rather than lowering this floor."
    );
    assert.ok(minted.has("SRC_FLOWS"), "SRC_FLOWS vanished from the scan");
    assert.equal(mfUnionMembers().length, 2);
  });

  it("every SRC_*/*_SOURCE constant decodes to a human label", () => {
    const offenders: string[] = [];
    for (const [name, code] of mintedConstants(SERVICE_FILES)) {
      if (!decodes(code, known)) offenders.push(`${name} = "${code}"`);
    }
    assert.deepEqual(
      offenders,
      [],
      "these codes would render RAW in the provenance chip. Add a KNOWN " +
        "entry in SectionShell.tsx (preferred — the fallbacks are a safety " +
        "net, not a label):\n  " +
        offenders.join("\n  ")
    );
  });

  it("every MF portfolio source decodes", () => {
    for (const code of mfUnionMembers()) {
      assert.ok(decodes(code, known), `MF source "${code}" renders raw`);
    }
  });

  it("the four codes that shipped raw are now named, not just regex-covered", () => {
    // UPPER_SNAKE would "cover" these by turning underscores into spaces, but
    // "NSE FII DII CASH" is not a label anyone wrote — it is the slug with the
    // punctuation swapped. These four earned real entries.
    for (const code of [
      "NSE_FII_DII_CASH",
      "RBI_MOSPI_OEA",
      "NSE_IPO",
      "NSE_CIRCULARS",
    ]) {
      assert.ok(known.has(code), `${code} needs an explicit KNOWN entry`);
    }
  });

  it("both naming conventions still have a working fallback", () => {
    // Asserted by BEHAVIOUR, against the patterns parsed out of the component
    // — not by grepping for a regex source string, which would pass on a
    // branch that had been narrowed to match nothing.
    assert.equal(
      FALLBACKS.length,
      2,
      `expected 2 fallback branches in sourceLabel, parsed ${FALLBACKS.length}`
    );
    assert.ok(
      FALLBACKS.some((re) => re.test(LOWER_SLUG_SHAPE)),
      "no fallback matches a lowercase-hyphen registry id — a new feed family " +
        "would render as a raw slug"
    );
    assert.ok(
      FALLBACKS.some((re) => re.test(UPPER_SNAKE_SHAPE)),
      "no fallback matches an UPPER_SNAKE source code — this is the exact gap " +
        "that put NSE_FII_DII_CASH on screen"
    );
  });

  it("a null/absent source is an em dash, never the string 'null'", () => {
    assert.match(shellSrc, /if \(!source\) return "—";/);
  });
});
