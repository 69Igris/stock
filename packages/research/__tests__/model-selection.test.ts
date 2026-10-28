/**
 * MONEY-626 — research model selection is MODEL-DRIVEN (was skill-driven in
 * the MONEY-506 slice).
 *
 * The founder gate is enforced at PUBLISH time via the registry's
 * `resolveResearchModel(plan, pick, claudeAllowed)` (the string decision a
 * non-allowlisted user can never get a Claude id from); the worker's
 * `getResearchModel` then just turns the resolved id into a model instance —
 * a Claude id yields the Claude compat model (generateContent + streaming),
 * anything else is Gemini.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveResearchModel } from "@usemoney/core/gemini/model-registry";
import { getResearchModel } from "../src/model-selection";

const OPUS = "claude-opus-4-8";
const realKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
});
afterEach(() => {
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

describe("research model gate (publish-time)", () => {
  it("honors a founder's Claude pick", () => {
    assert.equal(resolveResearchModel("PREMIUM", OPUS, true), OPUS);
  });
  it("ignores a Claude pick for a non-allowlisted user → Gemini default", () => {
    assert.match(resolveResearchModel("PREMIUM", OPUS, false), /^gemini-/);
  });
  it("still honors a Gemini Pro pick", () => {
    assert.equal(
      resolveResearchModel("PRO", "gemini-3.1-pro-preview", false),
      "gemini-3.1-pro-preview",
    );
  });
});

describe("getResearchModel — model-driven instance routing", () => {
  it("a Claude id resolves to the Claude compat model (no construction/network)", () => {
    const model = getResearchModel(OPUS);
    assert.equal(typeof model.generateContent, "function");
    assert.equal(typeof model.generateContentStream, "function");
  });
});
