/**
 * UNIT TEST — Atlas query operators match the documented index mappings
 * (MONEY-1141).
 *
 * ## The defect
 *
 * `content-search.ts` filtered `content_search` with the `text` operator on
 * three fields the index maps as `token`:
 *
 *   | field             | mapping | was queried with |
 *   | ----------------- | ------- | ---------------- |
 *   | `contentType`     | token   | text             |
 *   | `contentPlatform` | token   | text             |
 *   | `status`          | token   | text             |
 *
 * A `text` operator against a token-mapped field matches NOTHING. All three sat
 * in `compound.filter`, so every Atlas content search returned zero rows in
 * production.
 *
 * It surfaced as "no results" rather than an error because `actions/content.ts`
 * treats an empty Atlas result as a legitimate answer and falls through to the
 * service path — so content search ran on the non-Atlas path in prod with no
 * log, no error and no metric. Nobody could have noticed from the outside.
 *
 * ## Why this test exists
 *
 * This was the SECOND occurrence. MONEY-1128 found the same mistake on the
 * instrument `exchange` filter (`atlas-search.ts`), which happened to be
 * unreachable because no caller passed `exchange`; this one was live on every
 * query. Two instances of one mistake, neither caught by a test, a type, or a
 * log.
 *
 * The root cause is that the index mappings live in a markdown doc and nothing
 * connects them to the query code. This test makes that connection: it reads
 * the documented mappings and fails if a token-mapped field is ever queried
 * with `text`. Fixing the two instances without this leaves the third free to
 * land the same way.
 *
 * Pure file parsing: no Atlas, no Mongo, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..", "..", "..");

const MAPPINGS_DOC = join(REPO, "docs", "setup", "atlas-search-setup.md");

/** Every file that builds an Atlas `$search` stage. */
const QUERY_BUILDERS = [
  join(REPO, "apps", "web", "lib", "market", "atlas-search.ts"),
  join(REPO, "apps", "web", "lib", "market", "content-search.ts"),
  // MONEY-980 — `us_instrument_search` maps THREE token fields (`exchange`,
  // `assetType`, `listingStatus`), so the US builder joins the guard the day it
  // lands rather than after the third occurrence of the same mistake.
  join(REPO, "apps", "web", "lib", "market", "us-instrument-search.ts"),
];

const doc = readFileSync(MAPPINGS_DOC, "utf8");

/**
 * Fields the doc maps as token and ONLY token.
 *
 * Dual-mapped fields (`string + token`, e.g. `category`) are deliberately
 * excluded: `text` is legitimate against those, so flagging them would make
 * this guard reject correct code — the one outcome it must not produce.
 */
function tokenOnlyFields(): Set<string> {
  return new Set(
    [...doc.matchAll(/^\|\s*`([a-zA-Z]+)`\s*\|\s*token\s*\|/gm)].map(
      (m) => m[1]!
    )
  );
}

/**
 * Remove comments so quoted examples are not mistaken for live queries.
 *
 * Necessary, not defensive: `atlas-search.ts` documents the MONEY-1128 fix by
 * quoting the BROKEN code it replaced —
 * `// MONEY-1128: this used to be \`text: { query: exchange, path: "exchange" }\``
 * — and the first run of this guard duly failed on that comment while the real
 * query three lines below was already correct. A guard that cannot tell code
 * from prose about code would force people to stop explaining their fixes.
 *
 * LINE comments are stripped BEFORE block comments, and only whole-line ones.
 * The opposite order is an open defect elsewhere in this repo (MONEY-1143):
 * strip blocks first and a `//` containing `/*` swallows every line after it,
 * silently removing the code under assertion. Restricting to whole-line `//`
 * also avoids the mirror-image hazard, a block comment containing `//`.
 */
function stripComments(source: string): string {
  return source
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Every `path` referenced by a `text` operator in a source file.
 *
 * Brace-counting rather than a lazy `[^}]*`, because `text` blocks nest
 * (`fuzzy: { maxEdits: 1 }`) and a naive match stops at the inner brace and
 * misses the `path` that follows it.
 */
function textOperatorPaths(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const paths: string[] = [];
  const marker = /text:\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = marker.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    const block = source.slice(match.index, i);
    // `path: "x"` and `path: ["x", "y"]` both appear in this codebase.
    for (const p of block.matchAll(/path:\s*(?:\[([^\]]*)\]|"([^"]+)")/g)) {
      if (p[2]) paths.push(p[2]);
      if (p[1]) {
        for (const q of p[1].matchAll(/"([^"]+)"/g)) paths.push(q[1]!);
      }
    }
  }
  return paths;
}

describe("MONEY-1141 — token-mapped fields are never queried with `text`", () => {
  it("sanity: the mappings doc and the query builders both parse", () => {
    // Without this, a moved doc or a reshaped table makes every assertion
    // below vacuously true — the failure mode this whole class suffers from.
    const fields = tokenOnlyFields();
    assert.ok(
      fields.size >= 5,
      `parsed only ${fields.size} token-mapped fields from ` +
        `docs/setup/atlas-search-setup.md — the doc's shape changed and this ` +
        `guard is no longer reading it`
    );
    for (const expected of ["contentType", "contentPlatform", "status"]) {
      assert.ok(
        fields.has(expected),
        `"${expected}" should be documented as token-mapped`
      );
    }

    const totalTextClauses = QUERY_BUILDERS.reduce(
      (n, f) => n + textOperatorPaths(readFileSync(f, "utf8")).length,
      0
    );
    assert.ok(
      totalTextClauses >= 5,
      `found only ${totalTextClauses} \`text\` clauses across the query ` +
        `builders — the parser is not seeing the queries`
    );
  });

  it("no query builder uses `text` against a token-mapped field", () => {
    const tokenFields = tokenOnlyFields();

    for (const file of QUERY_BUILDERS) {
      const source = readFileSync(file, "utf8");
      const rel = file.slice(REPO.length + 1);

      for (const path of textOperatorPaths(source)) {
        assert.ok(
          !tokenFields.has(path),
          `${rel} queries "${path}" with the \`text\` operator, but ` +
            `docs/setup/atlas-search-setup.md maps it as \`token\`. A text ` +
            `operator against a token field matches NOTHING — and because an ` +
            `empty Atlas result is treated as a legitimate answer, the query ` +
            `silently returns zero rows with no error and no log. Use ` +
            `\`equals\` (or \`in\` for a set).`
        );
      }
    }
  });

  it("the three MONEY-1141 filters use `equals`", () => {
    // The specific regression. Pinned by name so a refactor cannot quietly
    // reintroduce the operator that broke prod.
    const source = readFileSync(QUERY_BUILDERS[1]!, "utf8");
    for (const field of ["status", "contentPlatform", "contentType"]) {
      assert.match(
        source,
        new RegExp(`equals:\\s*\\{\\s*path:\\s*"${field}"`),
        `content-search.ts must filter "${field}" with \`equals\``
      );
    }
  });

  it("the US filters use `in` on all three token fields (MONEY-980)", () => {
    // `listingStatus` is the one that would hurt most: it is what separates a
    // delisted listing from a live one, and `text` against it matches nothing
    // — so a "show only active" narrowing would return an EMPTY page rather
    // than an unfiltered one, and look exactly like "no such ticker".
    const source = readFileSync(QUERY_BUILDERS[2]!, "utf8");
    for (const field of ["assetType", "exchange", "listingStatus"]) {
      assert.match(
        source,
        new RegExp(`in:\\s*\\{[\\s\\S]{0,80}?path:\\s*"${field}"`),
        `us-instrument-search.ts must filter "${field}" with \`in\``
      );
    }
  });

  it("the detector CATCHES the original broken query", () => {
    // Without this, every assertion above could be passing because the parser
    // finds nothing at all — a green test over a blind detector, which is the
    // shadow test this repo forbids. The fixture is the code as it stood when
    // prod returned zero rows.
    const broken = `
      const filterClauses = [
        { text: { query: "PUBLISHED", path: "status" } },
        { text: { query: "STOCKBOOK", path: "contentPlatform" } },
      ];
    `;
    const flagged = textOperatorPaths(broken).filter((p) =>
      tokenOnlyFields().has(p)
    );
    assert.deepEqual(
      flagged.sort(),
      ["contentPlatform", "status"],
      "the detector must flag token fields queried with `text`"
    );
  });

  it("the detector does NOT flag legitimate text-field queries", () => {
    // The other half: `title`/`content` are analysed string fields, and `text`
    // is exactly right for them. A guard that flagged those would push people
    // toward `equals` on full-text fields, which breaks search properly.
    const fine = `
      { text: { query, path: "title", fuzzy: { maxEdits: 1 } } },
      { text: { query, path: ["symbol", "name"] } },
    `;
    const flagged = textOperatorPaths(fine).filter((p) =>
      tokenOnlyFields().has(p)
    );
    assert.deepEqual(flagged, [], "no false positives on text-mapped fields");
  });

  it("the MONEY-1128 instrument `exchange` filter uses `equals` too", () => {
    // The first occurrence of this same mistake. It was unreachable at the
    // time (no caller passed `exchange`), which is exactly why it survived —
    // pin it so reachability is not what keeps it correct.
    assert.match(
      readFileSync(QUERY_BUILDERS[0]!, "utf8"),
      /equals:\s*\{\s*path:\s*"exchange"/,
      "atlas-search.ts must filter `exchange` with `equals`"
    );
  });
});
