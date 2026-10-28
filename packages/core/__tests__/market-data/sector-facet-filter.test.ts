/**
 * MONEY-1157 — the screener sector FILTER, and its agreement with the FACETS.
 *
 * The prior fix taught `buildSectorFacets` to fold non-canonical stored values
 * onto canonical NSE sectors, but left the filter comparing the RAW string. The
 * two then disagreed by construction:
 *
 *   - `Construction` (40 rows on prod) was COUNTED under Industrials, and
 *     `sectorMatches("Construction", "Industrials")` was false;
 *   - `Other` (228), `Media & Entertainment` (9) and `Agriculture` were counted
 *     under "Not Categorised", and failed its
 *     `!rowSector || rowSector === "N/A"` test;
 *   - `Textiles` (8) was counted under Consumer Discretionary and returned by
 *     nothing.
 *
 * ~285 rows were reported by a chip and then not returned by it. Because
 * `instrumentsFirstPath` screens the SAME array `buildSectorFacets` counted, the
 * discrepancy is exact and user-visible: "Industrials 42" that lists 2.
 *
 * The property under test is therefore CONSERVATION, not per-value equality: a
 * stored value must land in exactly ONE chip, and the chip that counts it must
 * be the chip that returns it. Per-value assertions alone stayed green through
 * the original bug.
 *
 * This file binds the REAL exports. The service-level twin
 * (`packages/services/__tests__/discover-sector-facets.test.ts`) drives
 * `buildSectorFacets` and `screenStocks` against each other; the web twin
 * (`apps/web/__tests__/screener/sector-facet-conservation.test.ts`) drives the
 * server action. Pure + mocked: no DB, no timers.
 *
 * Source: packages/core/src/market-data/instruments/sector-taxonomy.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  KNOWN_SECTOR_VALUES,
  UNCATEGORISED_SECTOR_FACET,
  canonicalSectorFacetFor,
  getAllSectorNames,
  isUncategorisedSectorFilter,
  matchesSectorFacet,
  resolveCanonicalSector,
  sectorFacetInstrumentWhere,
  sectorFacetRawValues,
} from "../../src/market-data/instruments/sector-taxonomy";

// ── Fixtures ────────────────────────────────────────────────────────────

/** Every chip the screener can render: the canonical taxonomy + the catch-all.
 *  This is exactly what `buildSectorFacets` emits. */
const ALL_CHIPS: readonly string[] = [
  ...getAllSectorNames(),
  UNCATEGORISED_SECTOR_FACET,
];

/** The four values measured on prod that the facets counted and the filter
 *  could not reach, plus the states the chip was originally written for and a
 *  couple of adversarial ones. `undefined` models a row whose `sector` key was
 *  never created. */
const STORED_VALUES: ReadonlyArray<string | null | undefined> = [
  "Other",
  "Construction",
  "Media & Entertainment",
  "Textiles",
  "Agriculture",
  "N/A",
  null,
  undefined,
  "",
  "energy",
  "REALTY",
  ...KNOWN_SECTOR_VALUES,
];

function chipsMatching(value: string | null | undefined): string[] {
  return ALL_CHIPS.filter((chip) => matchesSectorFacet(value, chip));
}

// ── The four prod values ────────────────────────────────────────────────

describe("MONEY-1157 — the four prod values are each reachable by exactly one chip", () => {
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    // `Other` has no mapping at all, so the catch-all is where it belongs — and
    // where `buildSectorFacets` puts it. The filter used to reject it from
    // BOTH: not equal to any canonical name, and not `null`/`"N/A"`.
    ["Other", UNCATEGORISED_SECTOR_FACET],
    // `Construction` → Industrials via YAHOO_TO_NSE_MAP. Counted there all
    // along; the filter compared the raw string and returned nothing.
    ["Construction", "Industrials"],
    // MONEY-1302 CHANGED THIS ROW, deliberately. It used to expect the
    // catch-all, because only the BARE token `Media` was in the map — and the
    // comment here said "pinned so a future fix cannot quietly move it".
    // The move is not quiet: all 9 prod rows behind this value are real media
    // companies (Zee Entertainment and Zee Media on both exchanges, Zinema,
    // 7Seas, Encash, P.B. Films, 3B Films), so the catch-all was wrong for
    // every one of them. The alias now exists, with the reasoning recorded in
    // sector-taxonomy.ts. What this file actually guards — that a stored value
    // reaches EXACTLY ONE chip, and that the chip counting it is the chip
    // returning it — is unchanged and still asserted below.
    ["Media & Entertainment", "Telecommunication"],
    ["Textiles", "Consumer Discretionary"],
  ];

  for (const [stored, chip] of EXPECTED) {
    it(`[regression] "${stored}" is reachable, and only under "${chip}"`, () => {
      assert.deepEqual(
        chipsMatching(stored),
        [chip],
        `"${stored}" must match exactly one chip — it used to match none`,
      );
    });
  }

  it("[regression] both media spellings fold onto Telecommunication (MONEY-1302)", () => {
    // Inverted from the original assertion, which pinned the compound string to
    // the catch-all. Both halves are still asserted TOGETHER, for the reason
    // the original gave: the two spellings are one decision, and nobody should
    // be able to move one without seeing the other. `Other` takes over the
    // "deliberately unmapped" role this case used to play — see below.
    assert.equal(matchesSectorFacet("Media", "Telecommunication"), true);
    assert.equal(
      matchesSectorFacet("Media & Entertainment", "Telecommunication"),
      true,
    );
    assert.equal(
      resolveCanonicalSector("Media & Entertainment"),
      "Telecommunication",
    );
  });

  it("[regression] `Other` is STILL deliberately unmapped (MONEY-1302)", () => {
    // The replacement tripwire. `Other` is the one value it would be actively
    // harmful to alias: 26 of its 29 prod rows are debt (a Gujarat SDL,
    // market-linked debentures, preference shares) wearing instrumentType
    // EQUITY. `Diversified` is empty and looks like an inviting home for it;
    // filling it that way would hand 26 bonds a sector chip, which is the state
    // MONEY-1093 built sector-write-guard.ts to prevent.
    assert.equal(resolveCanonicalSector("Other"), null);
    assert.equal(matchesSectorFacet("Other", UNCATEGORISED_SECTOR_FACET), true);
    assert.equal(matchesSectorFacet("Other", "Diversified"), false);
  });
});

// ── The partition ───────────────────────────────────────────────────────

describe("MONEY-1157 — the chips partition the universe of stored values", () => {
  it("[regression] every stored value matches EXACTLY one chip", () => {
    // Not "at least one": a value matching two chips double-counts, which is the
    // same conservation failure pointing the other way.
    for (const value of STORED_VALUES) {
      const chips = chipsMatching(value);
      assert.equal(
        chips.length,
        1,
        `${JSON.stringify(value)} matched ${chips.length} chips (${chips.join(", ")}) — must be exactly 1`,
      );
    }
  });

  it("the chip a value matches is the chip the facet builder counts it under", () => {
    // `resolveCanonicalSector` IS the facet bucketing (`buildSectorFacets` calls
    // it), so this pins that the filter's answer is derived from it and not from
    // a second opinion that can drift.
    for (const value of STORED_VALUES) {
      const canonical = resolveCanonicalSector(value);
      assert.deepEqual(chipsMatching(value), [
        canonical ?? UNCATEGORISED_SECTOR_FACET,
      ]);
    }
  });

  it("an absent sector key behaves exactly like an explicit null", () => {
    assert.deepEqual(
      chipsMatching(undefined),
      chipsMatching(null),
      "rows minted by the nightly sync have no `sector` key until enrichment " +
        "reaches them — they are the population the catch-all chip exists for",
    );
  });

  it("no sector filter matches everything (an unfiltered screen is untouched)", () => {
    for (const value of STORED_VALUES) {
      assert.equal(matchesSectorFacet(value, undefined), true);
    }
  });
});

// ── The named branch ────────────────────────────────────────────────────

describe("MONEY-1157 — a canonical chip reaches every value that folds onto it", () => {
  it("folds the aliases the facets already counted", () => {
    assert.equal(matchesSectorFacet("Construction", "Industrials"), true);
    assert.equal(matchesSectorFacet("Infrastructure", "Industrials"), true);
    assert.equal(
      matchesSectorFacet("Textiles", "Consumer Discretionary"),
      true,
    );
    assert.equal(matchesSectorFacet("Realty", "Real Estate"), true);
    assert.equal(matchesSectorFacet("Pharma", "Healthcare"), true);
    assert.equal(matchesSectorFacet("Oil & Gas", "Energy"), true);
  });

  it("stays case-insensitive on BOTH sides", () => {
    // The filter value arrives from `?stocks.sector=` and is not guaranteed to
    // be canonically cased; the stored value is written by several pipelines.
    // This is a widening — no value that resolved before stops resolving.
    assert.equal(matchesSectorFacet("Energy", "energy"), true);
    assert.equal(matchesSectorFacet("energy", "Energy"), true);
    assert.equal(matchesSectorFacet("REALTY", "Real Estate"), true);
  });

  it("does not leak across sectors", () => {
    assert.equal(matchesSectorFacet("Construction", "Commodities"), false);
    assert.equal(matchesSectorFacet("Textiles", "Industrials"), false);
    assert.equal(matchesSectorFacet("Other", "Industrials"), false);
  });

  it("[regression] a non-canonical filter value still reaches its raw rows", () => {
    // `SectorDeepDive` links `/discover/screener?stocks.sector=<bucket>` with
    // the RAW heatmap bucket name, and the heatmap deliberately keeps
    // non-canonical values visible. Narrowing the named branch to "canonical
    // folds only" would turn those links into empty screens — the fix for
    // unreachable rows must not create newly unreachable rows.
    assert.equal(matchesSectorFacet("Other", "Other"), true);
    assert.equal(matchesSectorFacet("Agriculture", "agriculture"), true);
    assert.equal(
      matchesSectorFacet("Construction", "Construction"),
      true,
      "a raw bucket link must keep meaning the rows literally stored that way",
    );
    assert.equal(
      matchesSectorFacet("Industrials", "Construction"),
      false,
      "...and must NOT quietly widen to the whole Industrials chip",
    );
  });

  it("both spellings of the catch-all label are honoured", () => {
    assert.equal(isUncategorisedSectorFilter("Not Categorised"), true);
    assert.equal(isUncategorisedSectorFilter("not categorized"), true);
    assert.equal(isUncategorisedSectorFilter("Industrials"), false);
    assert.equal(matchesSectorFacet("Other", "Not Categorized"), true);
  });

  it("the catch-all label is never mistaken for a canonical sector", () => {
    assert.equal(canonicalSectorFacetFor(UNCATEGORISED_SECTOR_FACET), null);
    assert.equal(canonicalSectorFacetFor("industrials"), "Industrials");
    assert.equal(canonicalSectorFacetFor("Construction"), null);
  });
});

// ── The DB-side twin ────────────────────────────────────────────────────

/** Every `sector` condition the where-builder can emit. */
type SectorCondition =
  | string
  | null
  | {
      isSet?: boolean;
      equals?: string;
      mode?: string;
      notIn?: readonly string[];
    };

interface EvalOptions {
  /** Model the PESSIMISTIC reading of `$nin` — one that does NOT match a
   *  document whose field is absent or null. Used to prove the clause never
   *  depends on that behaviour. */
  readonly strictNotIn?: boolean;
}

/**
 * PRISMA-on-Mongo semantics for one condition. A test double for the DATABASE,
 * not a copy of the where-builder:
 *   - `{ sector: null }` is an explicit-null equality. It does NOT match a
 *     document missing the key, even though raw Mongo's `{f: null}` would.
 *     (`scripts/data/fix-missing-sectors.ts` exists because of exactly this.)
 *   - `{ sector: { isSet: false } }` is the missing-key case, and only that.
 *   - `$nin` matches absent/null in raw Mongo; `strictNotIn` models the worst
 *     case where it does not.
 */
function evalCondition(
  want: SectorCondition,
  sector: string | null | undefined,
  keyPresent: boolean,
  opts: EvalOptions = {},
): boolean {
  if (want === null) return keyPresent && sector === null;
  if (typeof want === "string") return keyPresent && sector === want;
  if (want.isSet !== undefined) {
    return want.isSet === false ? !keyPresent : keyPresent;
  }
  if (want.notIn) {
    if (!keyPresent || sector == null) return !opts.strictNotIn;
    return !want.notIn.includes(sector);
  }
  if (want.equals !== undefined) {
    if (!keyPresent || sector == null) return false;
    return want.mode === "insensitive"
      ? sector.toLowerCase() === want.equals.toLowerCase()
      : sector === want.equals;
  }
  return false;
}

function evalWhere(
  where: Record<string, unknown> | null,
  value: string | null | undefined,
  opts: EvalOptions = {},
): boolean {
  if (!where) return true;
  const keyPresent = value !== undefined;
  const sector = value ?? null;
  const branches = (where as { OR?: Array<{ sector: SectorCondition }> }).OR;
  if (branches) {
    return branches.some((b) =>
      evalCondition(b.sector, sector, keyPresent, opts),
    );
  }
  return evalCondition(
    (where as { sector: SectorCondition }).sector,
    sector,
    keyPresent,
    opts,
  );
}

describe("MONEY-1157 — the Mongo twin agrees with the JS predicate", () => {
  it("[regression] a canonical chip's clause returns EXACTLY the rows the predicate accepts", () => {
    // A per-row JS function cannot run inside a Mongo filter, so the canonical
    // target is expanded into the set of stored values that fold onto it. If
    // that expansion drifts from the predicate the failure is silent: the JS
    // pass downstream cannot rescue a row the database never returned.
    for (const chip of getAllSectorNames()) {
      const where = sectorFacetInstrumentWhere(chip);
      for (const value of STORED_VALUES) {
        assert.equal(
          evalWhere(where, value),
          matchesSectorFacet(value, chip),
          `chip "${chip}" disagrees with the query for ${JSON.stringify(value)}`,
        );
      }
    }
  });

  it("[regression] the catch-all clause never DROPS a row the predicate accepts", () => {
    // The clause is allowed to be looser than the predicate (the retained JS
    // pass is the authority and runs after), but never tighter — a tighter
    // clause under-reports the chip AND the "Showing 1-25 of N" total, with no
    // error anywhere.
    const where = sectorFacetInstrumentWhere(UNCATEGORISED_SECTOR_FACET);
    for (const value of STORED_VALUES) {
      if (!matchesSectorFacet(value, UNCATEGORISED_SECTOR_FACET)) continue;
      assert.equal(
        evalWhere(where, value),
        true,
        `the query dropped ${JSON.stringify(value)}, which the chip claims`,
      );
    }
  });

  it("[regression] the absent-field case is carried by isSet, NOT by $nin", () => {
    // Mongo's `{sector: null}` matches an absent field; Prisma's does not, and
    // `$nin`'s behaviour on absent fields is not something a silent row-loss
    // should be bet on. Evaluated with a `$nin` that refuses absent/null, the
    // clause must STILL match both — i.e. the explicit branches carry them.
    const where = sectorFacetInstrumentWhere(UNCATEGORISED_SECTOR_FACET);
    assert.equal(
      evalWhere(where, undefined, { strictNotIn: true }),
      true,
      "an instrument whose `sector` key was never created must reach the chip",
    );
    assert.equal(evalWhere(where, null, { strictNotIn: true }), true);
    assert.equal(evalWhere(where, "", { strictNotIn: true }), true);
    assert.equal(evalWhere(where, "N/A", { strictNotIn: true }), true);
  });

  it("[regression] the catch-all clause reaches the non-canonical values too", () => {
    const where = sectorFacetInstrumentWhere(UNCATEGORISED_SECTOR_FACET);
    // MONEY-1302 shortened this list: `Agriculture` and `Media & Entertainment`
    // are aliases now, so they belong to FMCG and Telecommunication rather than
    // to the catch-all. `Other` remains the live example of a genuinely
    // unmapped value, and is asserted here for the property that matters —
    // an unmapped string must still be RETURNED by the chip that counts it.
    for (const value of ["Other", "Unmapped Future GICS Label"]) {
      assert.equal(
        evalWhere(where, value),
        true,
        `"${value}" is counted under the chip, so the query must return it`,
      );
    }
    for (const value of ["Agriculture", "Media & Entertainment"]) {
      assert.equal(
        evalWhere(where, value),
        false,
        `"${value}" now folds onto a canonical sector, so it must LEAVE the catch-all`,
      );
    }
    assert.equal(
      evalWhere(where, "Energy"),
      false,
      "a value that folds onto a canonical sector must NOT be in the bucket",
    );
  });

  it("no sector filter emits no clause at all", () => {
    assert.equal(sectorFacetInstrumentWhere(undefined), null);
    assert.equal(sectorFacetInstrumentWhere(""), null);
  });

  it("a non-canonical filter value pushes down its raw equality", () => {
    assert.deepEqual(sectorFacetInstrumentWhere("Other"), {
      sector: { equals: "Other", mode: "insensitive" },
    });
  });

  it("the expansion is exactly the taxonomy's own fold", () => {
    // Derived from the same index the predicate reads, so it cannot list a value
    // the predicate rejects or omit one it accepts.
    for (const canonical of getAllSectorNames()) {
      for (const raw of sectorFacetRawValues(canonical)) {
        assert.equal(resolveCanonicalSector(raw), canonical);
      }
      assert.ok(
        sectorFacetRawValues(canonical).includes(canonical),
        `${canonical} must at least fold onto itself`,
      );
    }
    assert.deepEqual(sectorFacetRawValues("Other"), []);
  });

  it("KNOWN_SECTOR_VALUES is precisely the set that folds somewhere", () => {
    // This set is the `notIn` list, so an entry that does NOT fold would evict a
    // row from the catch-all without giving it another chip — unreachable.
    for (const value of KNOWN_SECTOR_VALUES) {
      assert.notEqual(
        resolveCanonicalSector(value),
        null,
        `"${value}" is excluded from the catch-all but folds nowhere`,
      );
    }
    // MONEY-1302: `Agriculture` and `Media & Entertainment` are aliases now, so
    // they moved INTO KNOWN_SECTOR_VALUES — asserted in the loop above, which
    // requires every member to fold somewhere. What must stay OUT is anything
    // that folds nowhere.
    for (const value of ["Other", "N/A", "Unmapped Future GICS Label"]) {
      assert.equal(KNOWN_SECTOR_VALUES.includes(value), false);
    }
    for (const value of ["Agriculture", "Media & Entertainment"]) {
      assert.equal(
        KNOWN_SECTOR_VALUES.includes(value),
        true,
        `"${value}" folds onto a canonical sector, so it must be excluded from ` +
          `the catch-all's notIn clause — otherwise it is counted under a chip ` +
          `AND returned by the catch-all, i.e. double-counted`,
      );
    }
  });
});
