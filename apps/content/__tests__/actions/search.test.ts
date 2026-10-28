/**
 * Atlas Search Logic Tests
 *
 * Exercises the REAL exported helpers from
 * `apps/content/lib/actions/search-logic.ts` (which `search.ts` imports and
 * calls) — NOT inline copies.
 * - isAtlasError pattern matching
 * - Atlas availability flag logic
 * - Atlas retry interval constant
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ATLAS_RETRY_MS,
  isAtlasError,
  createAtlasAvailability,
  isAtlasEnvironmentCheck,
} from "@/lib/actions/search-logic";

// ── Tests ────────────────────────────────────────────────

describe("isAtlasError", () => {
  it("should match 'index not found'", () => {
    assert.strictEqual(isAtlasError("index not found for query"), true);
  });

  it("should match '$search'", () => {
    assert.strictEqual(isAtlasError("$search pipeline stage error"), true);
  });

  it("should match 'Atlas Search'", () => {
    assert.strictEqual(isAtlasError("Atlas Search is not available"), true);
  });

  it("should match 'SearchNotEnabled'", () => {
    assert.strictEqual(isAtlasError("SearchNotEnabled for this cluster"), true);
  });

  it("should match 'PlanExecutor'", () => {
    assert.strictEqual(isAtlasError("PlanExecutor error in aggregation"), true);
  });

  it("should not match generic MongoDB errors", () => {
    assert.strictEqual(isAtlasError("Connection timeout"), false);
  });

  it("should not match empty string", () => {
    assert.strictEqual(isAtlasError(""), false);
  });

  it("should not match unrelated errors", () => {
    assert.strictEqual(isAtlasError("duplicate key error"), false);
  });

  it("should handle case-sensitive matching", () => {
    // "atlas search" (lowercase) should NOT match "Atlas Search"
    assert.strictEqual(isAtlasError("atlas search"), false);
  });

  it("should match when error message contains pattern within longer text", () => {
    assert.strictEqual(
      isAtlasError(
        "Error: PlanExecutor error during aggregation :: caused by :: index not found",
      ),
      true,
    );
  });
});

describe("Atlas availability flag", () => {
  it("should be available initially in Atlas environment", () => {
    const atlas = createAtlasAvailability(true);
    assert.strictEqual(atlas.isAvailable(), true);
  });

  it("should never be available in non-Atlas environment", () => {
    const atlas = createAtlasAvailability(false);
    assert.strictEqual(atlas.isAvailable(), false);
  });

  it("should become unavailable after marking", () => {
    const atlas = createAtlasAvailability(true);
    atlas.markUnavailable();
    assert.strictEqual(atlas.isAvailable(), false);
  });

  it("should set unavailableUntil to now + ATLAS_RETRY_MS", () => {
    const atlas = createAtlasAvailability(true);
    const before = Date.now();
    atlas.markUnavailable();
    const after = Date.now();
    const until = atlas.getUnavailableUntil();
    assert.ok(until >= before + ATLAS_RETRY_MS);
    assert.ok(until <= after + ATLAS_RETRY_MS);
  });
});

describe("ATLAS_RETRY_MS constant", () => {
  it("should be 5 minutes in milliseconds", () => {
    assert.strictEqual(ATLAS_RETRY_MS, 300_000);
  });
});

describe("isAtlasEnvironmentCheck", () => {
  it("should return true for mongodb.net URL", () => {
    assert.strictEqual(
      isAtlasEnvironmentCheck("mongodb+srv://user:pass@cluster.mongodb.net/db"),
      true,
    );
  });

  it("should return false for DigitalOcean URL", () => {
    assert.strictEqual(
      isAtlasEnvironmentCheck(
        "mongodb+srv://user:pass@cluster.mongo.ondigitalocean.com/db",
      ),
      false,
    );
  });

  it("should return false for localhost", () => {
    assert.strictEqual(
      isAtlasEnvironmentCheck("mongodb://localhost:27017/db"),
      false,
    );
  });

  it("should return false for empty string", () => {
    assert.strictEqual(isAtlasEnvironmentCheck(""), false);
  });
});
