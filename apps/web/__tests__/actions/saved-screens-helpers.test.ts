/**
 * Saved Screens - pure helper coverage (MONEY-201).
 *
 * The action file (`lib/actions/saved-screens.ts`) wraps Prisma + Clerk
 * auth, neither of which we boot in unit tests. The pure helpers
 * (countFilters + the Zod input schemas) are extracted into
 * `lib/actions/saved-screens-logic.ts`, which the action imports and uses
 * directly. We import those REAL exports here — no inline copy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countFilters,
  SaveSchema,
  RenameSchema,
} from "@/lib/actions/saved-screens-logic";

// ── Tests ──────────────────────────────────────────────────────────

describe("countFilters", () => {
  it("returns 0 when nothing is set", () => {
    assert.strictEqual(countFilters({}), 0);
  });

  it("ignores the `limit` key", () => {
    assert.strictEqual(countFilters({ limit: 200 }), 0);
  });

  it("ignores null and undefined values", () => {
    assert.strictEqual(
      countFilters({ exchange: null, sector: undefined, plan: "DIRECT" }),
      1
    );
  });

  it("ignores empty strings + whitespace strings", () => {
    assert.strictEqual(countFilters({ theme: "", category: "  " }), 0);
  });

  it("ignores empty arrays but counts non-empty arrays", () => {
    assert.strictEqual(
      countFilters({ amcAny: [], plan: "DIRECT", riskLevel: "High" }),
      2
    );
    assert.strictEqual(countFilters({ amcAny: ["SBI", "HDFC"] }), 1);
  });

  it("counts numeric zero as a real filter", () => {
    // 0 is a valid filter value - minReturns1Y: 0 means "≥ 0%".
    assert.strictEqual(countFilters({ minReturns1Y: 0 }), 1);
  });

  it("composite filter set", () => {
    assert.strictEqual(
      countFilters({
        category: "Large Cap",
        plan: "DIRECT",
        riskLevel: "High",
        amcAny: ["SBI"],
        minAum: 1000,
        maxAum: 50_000,
        limit: 200, // ignored
      }),
      6
    );
  });
});

describe("SaveSchema input validation", () => {
  it("accepts a well-formed save payload", () => {
    const res = SaveSchema.safeParse({
      name: "High ROE compounders",
      mode: "stocks",
      filters: { minRoe: 18, maxPe: 25 },
    });
    assert.strictEqual(res.success, true);
  });

  it("trims the name before validation", () => {
    const res = SaveSchema.safeParse({
      name: "  trimmed  ",
      mode: "stocks",
      filters: {},
    });
    assert.strictEqual(res.success, true);
    if (res.success) {
      assert.strictEqual(res.data.name, "trimmed");
    }
  });

  it("rejects an empty name (post-trim)", () => {
    const res = SaveSchema.safeParse({
      name: "   ",
      mode: "stocks",
      filters: {},
    });
    assert.strictEqual(res.success, false);
  });

  it("rejects names longer than 60 chars", () => {
    const res = SaveSchema.safeParse({
      name: "x".repeat(61),
      mode: "stocks",
      filters: {},
    });
    assert.strictEqual(res.success, false);
  });

  it("rejects unknown modes", () => {
    const res = SaveSchema.safeParse({
      name: "test",
      mode: "futures" as never,
      filters: {},
    });
    assert.strictEqual(res.success, false);
  });

  it("rejects queries longer than 200 chars", () => {
    const res = SaveSchema.safeParse({
      name: "test",
      mode: "stocks",
      filters: {},
      query: "x".repeat(201),
    });
    assert.strictEqual(res.success, false);
  });

  it("optional query may be omitted entirely", () => {
    const res = SaveSchema.safeParse({
      name: "test",
      mode: "mf",
      filters: { category: "Large Cap" },
    });
    assert.strictEqual(res.success, true);
  });

  it("filters must be an object (not a string)", () => {
    const res = SaveSchema.safeParse({
      name: "test",
      mode: "stocks",
      filters: "not-an-object" as never,
    });
    assert.strictEqual(res.success, false);
  });
});

describe("RenameSchema input validation", () => {
  it("accepts a valid rename", () => {
    const res = RenameSchema.safeParse({ id: "abc123", name: "New name" });
    assert.strictEqual(res.success, true);
  });

  it("rejects empty id", () => {
    const res = RenameSchema.safeParse({ id: "", name: "Anything" });
    assert.strictEqual(res.success, false);
  });

  it("rejects empty name", () => {
    const res = RenameSchema.safeParse({ id: "abc", name: "" });
    assert.strictEqual(res.success, false);
  });
});
