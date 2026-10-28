/**
 * User people-picker Atlas Search pipeline (MONEY-1050).
 *
 * Pure/deterministic: buildUserSearchPipeline() constructs the $search
 * aggregation with NO I/O. Guards the regression where an
 * `equals(isActive=true)` FILTER silently dropped legacy users whose document
 * is physically missing the `isActive` field (added after they were created).
 * The fix excludes ONLY explicit soft-deletes via `mustNot equals(false)`.
 *
 * Source under test: apps/content/lib/atlas-user-search.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildUserSearchPipeline } from "@/lib/atlas-user-search";

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("buildUserSearchPipeline", () => {
  test("targets the user_search index with the query threaded through", () => {
    const [searchStage] = buildUserSearchPipeline("deepshaswat", 50) as any[];
    assert.strictEqual(searchStage.$search.index, "user_search");
    const should = searchStage.$search.compound.should;
    // query is threaded into every should clause (2 autocomplete + 1 text)
    assert.strictEqual(should.length, 3);
    assert.strictEqual(should[0].autocomplete.query, "deepshaswat");
    assert.strictEqual(should[1].autocomplete.query, "deepshaswat");
    assert.deepStrictEqual(should[2].text.query, "deepshaswat");
  });

  test("excludes ONLY explicit soft-deletes via mustNot (not a positive filter)", () => {
    const [searchStage] = buildUserSearchPipeline("x", 10) as any[];
    const compound = searchStage.$search.compound;

    // The fix: mustNot equals(isActive=false) — missing field counts as active.
    assert.deepStrictEqual(compound.mustNot, [
      { equals: { path: "isActive", value: false } },
    ]);

    // Regression guard: the old positive `filter: equals(isActive=true)` — which
    // dropped legacy users missing the field — must be GONE.
    assert.strictEqual(
      compound.filter,
      undefined,
      "positive isActive=true filter must not return",
    );
    assert.strictEqual(compound.minimumShouldMatch, 1);
  });

  test("honors the limit and projects only email + name", () => {
    const pipeline = buildUserSearchPipeline("x", 7) as any[];
    const limitStage = pipeline.find((s) => "$limit" in s);
    const projectStage = pipeline.find((s) => "$project" in s);
    assert.strictEqual(limitStage.$limit, 7);
    assert.deepStrictEqual(projectStage.$project, {
      email: 1,
      name: 1,
      _id: 0,
    });
  });
});
