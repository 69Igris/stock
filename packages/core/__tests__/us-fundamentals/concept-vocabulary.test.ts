/**
 * MONEY-979 — `US_CONCEPT_TO_STATEMENT_FIELD` must be spelled in the vocabulary
 * the Python writer actually STORES.
 *
 * ## The defect this exists to catch
 *
 * edgartools carries three vocabularies. The Python writer keys the stored
 * `standardized` blob on `standard_concept`, which is the `standard_tags`
 * vocabulary from `gaap_mappings.json` (`CostOfGoodsAndServicesSold`). The
 * table was originally written in the `display_name` / `concept_mappings.json`
 * vocabulary (`Cost of Revenue`) — a real file, genuinely verified against, and
 * the wrong one.
 *
 * The two overlap in exactly ONE string, `Revenue`. So every US statement
 * rendered as revenue and nothing else, and no test caught it: the fixtures
 * were written in the READER's spelling, so both halves of each fixture-based
 * test were wrong in the same direction and agreed with each other.
 *
 * That is why this file asserts against a GENERATED fixture extracted from the
 * pinned library rather than against a hand-written expectation. A hand-written
 * expectation would have been written in the same wrong vocabulary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  US_CONCEPT_TO_STATEMENT_FIELD,
  US_TOTAL_DEBT_CONCEPTS,
} from "../../src/us-fundamentals/repository-logic";
import {
  US_EDGARTOOLS_STANDARD_TAGS,
  US_EDGARTOOLS_VERSION,
} from "../../src/us-fundamentals/edgartools-standard-tags";

describe("the concept table is spelled in edgartools' STORED vocabulary", () => {
  const universe = new Set(US_EDGARTOOLS_STANDARD_TAGS);

  it("PREMISE: the generated universe is populated", () => {
    // Without this, an empty or truncated fixture would make every membership
    // assertion below trivially... fail — but a fixture that is merely SMALL
    // would let a wrong table slip through on the few tags that survived.
    // 235 tags in edgartools 5.53.0; the floor is deliberately close to it.
    assert.ok(
      US_EDGARTOOLS_STANDARD_TAGS.length > 200,
      `expected >200 standard tags, got ${US_EDGARTOOLS_STANDARD_TAGS.length}`,
    );
    assert.equal(
      universe.size,
      US_EDGARTOOLS_STANDARD_TAGS.length,
      "duplicates in fixture",
    );
    assert.match(US_EDGARTOOLS_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("PREMISE: the check discriminates — display-vocabulary spellings are NOT members", () => {
    // The exact strings the original table used. If any of these were members,
    // the membership assertion would be satisfiable by the broken table and
    // would prove nothing.
    for (const displaySpelling of [
      "Gross Profit",
      "Total Assets",
      "Cost of Revenue",
      "Net Income",
      "Cash and Cash Equivalents",
      "Long Term Debt",
    ]) {
      assert.ok(
        !universe.has(displaySpelling),
        `"${displaySpelling}" is a display name, not a standard tag — the guard is not discriminating`,
      );
    }
  });

  it("every mapped concept is a real standard tag", () => {
    const strays = US_CONCEPT_TO_STATEMENT_FIELD.map(
      ([concept]) => concept,
    ).filter((concept) => !universe.has(concept));
    assert.deepEqual(
      strays,
      [],
      `these keys cannot ever appear in a stored \`standardized\` blob: ${strays.join(", ")}`,
    );
  });

  it("every total-debt component is a real standard tag", () => {
    const strays = US_TOTAL_DEBT_CONCEPTS.filter(
      (concept) => !universe.has(concept),
    );
    assert.deepEqual(
      strays,
      [],
      `unreachable debt concepts: ${strays.join(", ")}`,
    );
  });

  it("the table still covers every field the statement shape promises", () => {
    const fields = new Set(
      US_CONCEPT_TO_STATEMENT_FIELD.map(([, field]) => field),
    );
    for (const required of [
      "revenue",
      "costOfRevenue",
      "grossProfit",
      "operatingIncome",
      "netIncome",
      "totalAssets",
      "totalLiabilities",
      "totalEquity",
      "totalCash",
      "currentAssets",
      "currentLiabilities",
      "inventory",
      "receivables",
      "payables",
      "retainedEarnings",
      "propertyPlantEquipment",
      "depreciation",
      "operatingCashFlow",
      "capitalExpenditure",
    ]) {
      assert.ok(fields.has(required), `no concept maps to \`${required}\``);
    }
  });
});
