/**
 * `only` must not fail OPEN — MONEY-1198 (code-review finding 1).
 *
 * ## The defect
 *
 * `KNOWN_AMCS` was a HAND-TYPED list of 12 ids. The `AmcId` union grew to 17 in
 * the same branch that documented the paired-edit invariant, and the list was
 * not updated — because `readonly AmcId[]` constrains members to be VALID ids
 * and says NOTHING about completeness. TypeScript can never flag the omission.
 *
 * The consequence was not a rejection but an INVERSION. `{"only":["MIRAE"]}`
 * filtered MIRAE out as unrecognised, leaving `only` empty; the caller then
 * dropped the key entirely via an `only.length` guard; the processor saw
 * `undefined` and ran EVERY AMC. An operator asking for one house silently got
 * seventeen — and a typo'd id did the same thing.
 *
 * "Filtered to nothing" and "not filtered" are different states that shared one
 * representation. That is the fail-open shape this repo already has a standing
 * rule against for caches, applied to an operator argument.
 *
 * ## What is asserted here
 *
 * The derivation (so the drift cannot recur) and the rejection (so an unknown id
 * is loud). The route body is exercised structurally rather than over HTTP —
 * importing it pulls in Prisma and the whole processor graph.
 *
 * ## CORRECTION — MONEY-1490
 *
 * This header used to end "...and what failed here was never the request
 * plumbing." The request plumbing was, later, the entire bug: the route read
 * `only` off the Pub/Sub push ENVELOPE rather than the decoded payload, so
 * every assertion below held perfectly while the validated `only` never
 * reached the processor on a real push. The logic was right and well covered;
 * it simply never ran on the transport that matters, and the self-chain it
 * feeds ran for seven days.
 *
 * The sentence is kept, struck, rather than quietly deleted: the reasoning was
 * plausible and the omission it justified was the defect. Transport coverage
 * lives in `route-pubsub-envelope-unwrap.test.ts`; keep the two together.
 *
 * Source: workers/src/routes/mf-portfolio-sync.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./_support/repo-root";

import {
  AMC_SOURCES,
  AMC_PAGE_SCRAPERS,
} from "../../packages/core/src/market-data";

const SRC = readFileSync(
  join(repoRoot(), "workers", "src", "routes", "mf-portfolio-sync.ts"),
  "utf8",
);

describe("mf-portfolio-sync route: the `only` filter (MONEY-1198)", () => {
  it("resolves the source it reasons over", () => {
    assert.ok(SRC.length > 500, "route source did not load");
  });

  it("REGRESSION: KNOWN_AMCS is DERIVED, not hand-typed", () => {
    // A literal list is what drifted. Deriving it means a new entry in either
    // source table is a new allowed id automatically, with no paired edit to
    // forget — and no way for the two to disagree.
    assert.match(SRC, /AMC_SOURCES\.map\(/);
    assert.match(SRC, /AMC_PAGE_SCRAPERS\.map\(/);

    // And the literal form must NOT come back: a quoted AmcId inside the
    // KNOWN_AMCS declaration means someone re-typed it.
    const decl = SRC.slice(
      SRC.indexOf("const KNOWN_AMCS"),
      SRC.indexOf("];", SRC.indexOf("const KNOWN_AMCS")),
    );
    assert.doesNotMatch(
      decl,
      /"(SBI|NIPPON|HDFC|KOTAK|DSP|PPFAS|TATA|ZERODHA|MIRAE)"/,
      "KNOWN_AMCS must not hard-code ids — derive them from the source tables",
    );
  });

  it("the derived set actually covers the ids that were missing", () => {
    // The bug by name. MIRAE and the four other additions must be reachable.
    const derived = new Set<string>([
      ...AMC_SOURCES.map((s) => s.id as string),
      ...AMC_PAGE_SCRAPERS.map((s) => s.id as string),
    ]);
    for (const id of ["MIRAE", "BARODA_BNP", "SHRIRAM", "HELIOS", "IIFL"]) {
      // Only assert on ids that genuinely exist in the tables today — the point
      // is that derivation TRACKS the tables, not that any specific id is
      // present forever.
      if (
        AMC_SOURCES.some((s) => (s.id as string) === id) ||
        AMC_PAGE_SCRAPERS.some((s) => (s.id as string) === id)
      ) {
        assert.ok(derived.has(id), `${id} must be an allowed \`only\` value`);
      }
    }
    // Guards the guard: a derivation that produced nothing would pass every
    // membership check above vacuously.
    assert.ok(derived.size >= 12, `derived only ${derived.size} AMC ids`);
  });

  it("REGRESSION: an unknown id is REJECTED, never filtered away", () => {
    // The inversion: dropping unknown ids left `only` empty, which then read as
    // "no filter" and ran everything.
    assert.match(
      SRC,
      /unknown AMC id/,
      "an unrecognised id must produce an error, not be silently dropped",
    );
    assert.match(SRC, /400/);
  });

  it("REGRESSION: an EMPTY `only` is rejected rather than meaning 'run everything'", () => {
    assert.match(
      SRC,
      /only must not be empty/,
      "an empty `only` must not collapse into the unfiltered case",
    );
  });

  it("a non-array `only` is rejected too", () => {
    assert.match(SRC, /only must be an array/);
  });

  it("omitting `only` still runs every AMC", () => {
    // The guard must not break the cron, which passes no `only` at all.
    assert.match(
      SRC,
      /raw\.only !== undefined/,
      "the validation must be gated on `only` being PRESENT, not truthy",
    );
  });
});
