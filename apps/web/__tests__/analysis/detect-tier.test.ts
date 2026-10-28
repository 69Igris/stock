/**
 * Analysis - detectTier tests
 *
 * De-shadowed: imports the REAL detectTier from app/analysis/analysis-tier-logic.ts,
 * which client.tsx uses for the /analysis filter pills (Quick / Deep Dive /
 * Comprehensive / Advanced). Default tier is L2 when the skill is missing/unknown.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectTier } from "../../app/analysis/analysis-tier-logic";

describe("detectTier", () => {
  it("undefined skill → L2 (Deep Dive default)", () => {
    assert.equal(detectTier(undefined), "L2");
  });

  it("empty string → L2", () => {
    assert.equal(detectTier(""), "L2");
  });

  it("'advanced' → L4", () => {
    assert.equal(detectTier("advanced"), "L4");
  });

  it("'advanced-research' → L4", () => {
    assert.equal(detectTier("advanced-research"), "L4");
  });

  it("'l4' → L4", () => {
    assert.equal(detectTier("l4"), "L4");
  });

  it("'comprehensive' → L3", () => {
    assert.equal(detectTier("comprehensive"), "L3");
  });

  it("'peer-comparison' → L3 (comparisons are comprehensive)", () => {
    assert.equal(detectTier("peer-comparison"), "L3");
  });

  it("'l3' → L3", () => {
    assert.equal(detectTier("l3"), "L3");
  });

  it("'quick' → L1", () => {
    assert.equal(detectTier("quick"), "L1");
  });

  it("'quick-analysis' → L1", () => {
    assert.equal(detectTier("quick-analysis"), "L1");
  });

  it("'l1' → L1", () => {
    assert.equal(detectTier("l1"), "L1");
  });

  it("unknown skill → L2", () => {
    assert.equal(detectTier("standard"), "L2");
  });

  it("mf-analysis → L2 (default tier for MF analysis)", () => {
    assert.equal(detectTier("mf-analysis"), "L2");
  });

  it("global-fund-comparison → L2 (no comprehensive marker)", () => {
    // Note: comparisons via this skill go through L2; the comparison badge
    // signals comparison, not the tier
    assert.equal(detectTier("global-fund-comparison"), "L2");
  });
});
