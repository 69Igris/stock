/**
 * MONEY-1238 item 12 — a NEW StockFlagKind must not vanish from the header.
 *
 * `FLAG_KIND_POLICY` is an exhaustive `Record<StockFlagKind, …>`, so adding a
 * kind to the union breaks the build until somebody gives it a disposition.
 * That mechanism protects the POLICY TABLE and nothing else.
 *
 * `isHeadlineWorthy` (stock-section-logic.ts) switches on `badge.kind` and ends
 * with `default: return !isStockFlagKind(badge.kind)`. The default is correct
 * for a kind the table has never seen — it returns TRUE, which is the module's
 * documented rule ("a new NSE family shows up as an unstyled badge rather than
 * vanishing"). It is exactly WRONG for a kind that has just been ADDED to the
 * table: `isStockFlagKind` is now true, so the new kind returns FALSE and
 * disappears from the header — the opposite of the rule, produced by obeying it.
 *
 * TypeScript cannot catch that: a `switch` with a `default` is exhaustive by
 * construction, so no compiler error is ever raised. Hence a scan.
 *
 * This guard PASSES today (all seven kinds carry an explicit `case`) and fails
 * on the day an eighth lands without one. It reads the file rather than
 * exercising it because the failure only exists for a kind that does not exist
 * yet, and no behavioural test can construct one without editing the source.
 *
 * Comments are stripped LINE-BEFORE-BLOCK (MONEY-1143). Pure string work: no
 * I/O beyond one `readFileSync`, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALL_STOCK_FLAG_KINDS,
  FLAG_KIND_POLICY,
} from "../../src/market-data/stock-flags";

const HERE = dirname(fileURLToPath(import.meta.url));
const SECTION_LOGIC = join(
  HERE,
  "..",
  "..",
  "src",
  "market-data",
  "stock-section-logic.ts",
);

const spaces = (s: string): string => s.replace(/[^\n]/g, " ");

/** Blank comment BODIES, preserving offsets. LINE first, then BLOCK. */
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, (m, p1: string) =>
      p1 === undefined ? spaces(m) : p1 + spaces(m.slice(p1.length)),
    )
    .replace(/\/\*[\s\S]*?\*\//g, (m) => spaces(m));
}

/** The brace-matched body of the function whose signature starts at `header`. */
function bodyOf(code: string, header: string): string {
  const start = code.indexOf(header);
  assert.notEqual(start, -1, `signature not found: ${header}`);
  const open = code.indexOf("{", start + header.length - 1);
  assert.notEqual(open, -1, `no body brace after: ${header}`);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after: ${header}`);
}

const SRC = stripComments(readFileSync(SECTION_LOGIC, "utf8"));
const HEADLINE_BODY = bodyOf(
  SRC,
  "export function isHeadlineWorthy(badge: StockFlagBadge): boolean",
);

describe("MONEY-1238 · every StockFlagKind has an explicit isHeadlineWorthy case", () => {
  it("[meta] the scan is live — the body was found and is not empty", () => {
    // A scan that silently matches nothing PASSES (MONEY-1093). Floors first.
    assert.ok(
      HEADLINE_BODY.length > 200,
      `isHeadlineWorthy body looks truncated (${HEADLINE_BODY.length} chars) — ` +
        `the extractor is broken and every assertion below is vacuous`,
    );
    assert.ok(
      ALL_STOCK_FLAG_KINDS.length >= 7,
      `expected 7+ kinds, found ${ALL_STOCK_FLAG_KINDS.length}`,
    );
    assert.match(HEADLINE_BODY, /switch \(badge\.kind\)/);
    assert.match(HEADLINE_BODY, /default:/);
  });

  it("[meta] the stripper strips, and strips LINE before BLOCK", () => {
    // If the order inverted, the `/*` inside the line comment would open a
    // block that swallows the case below it, and the kind would read as
    // "missing a case" — a guard that fails for a reason that is not real is
    // deleted just as fast as one that never fails.
    const src = [
      "// a line comment mentioning /* an unterminated block",
      'case "REAL_KIND":',
      '/* a block mentioning case "FAKE_KIND": */',
    ].join("\n");
    const out = stripComments(src);
    assert.equal(out.split("\n").length, src.split("\n").length);
    assert.match(out, /case "REAL_KIND":/);
    assert.ok(!/FAKE_KIND/.test(out));
  });

  it("no kind in FLAG_KIND_POLICY falls through to `default`", () => {
    const missing = ALL_STOCK_FLAG_KINDS.filter(
      (kind) => !HEADLINE_BODY.includes(`case "${kind}":`),
    );
    assert.deepEqual(
      missing,
      [],
      "These kinds are in FLAG_KIND_POLICY but have no explicit case in " +
        "`isHeadlineWorthy`, so they reach `default: return " +
        "!isStockFlagKind(badge.kind)` — which is FALSE for a known kind. They " +
        "are silently dropped from the header strip, contradicting the " +
        "module's own rule that a new family surfaces rather than vanishes. " +
        "Fix: add a `case` with the kind's disposition (and consider " +
        "`FLAG_KIND_POLICY[kind].wholeUniverseDaily` as the default answer — " +
        "a family every stock carries every session says nothing about THIS " +
        "stock). Missing:\n" +
        missing.join("\n"),
    );
  });

  it("the default branch is still the UNKNOWN-kind rule, unchanged", () => {
    // The `default` is right for a kind the table has never seen: TRUE, so a
    // brand-new NSE family renders as an unstyled badge. This pins that it has
    // not been "simplified" to a bare `return false`, which would make the next
    // family invisible — the failure the rule exists to prevent.
    assert.match(
      HEADLINE_BODY,
      /default:\s*return !isStockFlagKind\(badge\.kind\);/,
    );
  });

  it("PRICE_BAND shows why wholeUniverseDaily is NOT a blanket 'never headline'", () => {
    // The field's own doc says "a whole-universe kind can never be an
    // exception". PRICE_BAND is `wholeUniverseDaily: true` AND is headline-
    // worthy at a narrowed band — the VALUE is the exception, not the row's
    // presence. Anyone wiring `wholeUniverseDaily` straight into
    // `isHeadlineWorthy` would break the one flag retail most needs to see.
    assert.equal(FLAG_KIND_POLICY.PRICE_BAND.wholeUniverseDaily, true);
    assert.match(HEADLINE_BODY, /case "PRICE_BAND":/);
    assert.match(HEADLINE_BODY, /pct !== null && pct < 20/);
  });
});
