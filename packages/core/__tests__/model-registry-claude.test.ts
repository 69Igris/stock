/**
 * Claude in the model registry (MONEY-626) — founder-gated routing.
 *
 * Asserts the SERVER-authoritative gate that governs which model id chat +
 * research resolve to: an allowlisted user's Claude pick is honored (in both
 * lanes, no Flash downgrade); everyone else stays Gemini-default even if they
 * forge a Claude pick. Also the picker lists (Claude hidden from non-founders).
 *
 * Source: packages/core/src/gemini/model-registry.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveChatModel,
  resolveResearchModel,
  isModelAvailable,
  getAvailableModelsForUser,
  getPickerModelsForUser,
  isClaudeEntitled,
  getModelDefinition,
} from "../src/gemini/model-registry";

const FOUNDER = "deepshaswat@gmail.com";
const OPUS = "claude-opus-4-8";
const HAIKU = "claude-haiku-4-5-20251001";

const realKey = process.env.ANTHROPIC_API_KEY;
const realAllow = process.env.CLAUDE_ALLOWED_EMAILS;
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.CLAUDE_ALLOWED_EMAILS;
});
afterEach(() => {
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
  if (realAllow === undefined) delete process.env.CLAUDE_ALLOWED_EMAILS;
  else process.env.CLAUDE_ALLOWED_EMAILS = realAllow;
});

describe("registry — Claude model entries", () => {
  it("registers the 5 Claude models as founder-only anthropic models", () => {
    for (const id of [
      OPUS,
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      HAIKU,
    ]) {
      const def = getModelDefinition(id);
      assert.ok(def, `missing ${id}`);
      assert.equal(def?.provider, "anthropic");
      assert.equal(def?.founderOnly, true);
    }
  });

  it("isModelAvailable(claude) tracks isClaudeConfigured()", () => {
    assert.equal(isModelAvailable(OPUS), true);
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isModelAvailable(OPUS), false);
    // Gemini is always available regardless of the Claude key.
    assert.equal(isModelAvailable("gemini-2.5-flash"), true);
  });
});

describe("resolveChatModel — founder gate (no Flash downgrade)", () => {
  it("honors a founder's Claude pick verbatim (even Opus, an L3)", () => {
    assert.equal(
      resolveChatModel("PREMIUM", { userPick: OPUS, claudeAllowed: true }),
      OPUS,
    );
    assert.equal(
      resolveChatModel("FREE", { userPick: HAIKU, claudeAllowed: true }),
      HAIKU,
    );
  });

  it("IGNORES a Claude pick when not allowlisted → Gemini default", () => {
    const got = resolveChatModel("PREMIUM", {
      userPick: OPUS,
      claudeAllowed: false,
    });
    assert.notEqual(got, OPUS);
    assert.match(got, /^gemini-/);
  });

  it("ignores a Claude pick when the key is absent even if allowed", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const got = resolveChatModel("PREMIUM", {
      userPick: OPUS,
      claudeAllowed: true,
    });
    assert.match(got, /^gemini-/);
  });

  it("non-Claude behavior is unchanged (Pro pick downgrades to Flash)", () => {
    const got = resolveChatModel("PRO", {
      userPick: "gemini-3.1-pro-preview",
      claudeAllowed: true,
    });
    assert.match(got, /flash/);
  });
});

describe("resolveResearchModel — founder gate", () => {
  it("honors a founder's Claude pick", () => {
    assert.equal(resolveResearchModel("PREMIUM", OPUS, true), OPUS);
  });
  it("ignores a Claude pick for non-allowlisted → Gemini default", () => {
    const got = resolveResearchModel("PREMIUM", OPUS, false);
    assert.notEqual(got, OPUS);
    assert.match(got, /^gemini-/);
  });
  it("still honors a Gemini Pro pick (existing behavior)", () => {
    assert.equal(
      resolveResearchModel("PRO", "gemini-3.1-pro-preview", false),
      "gemini-3.1-pro-preview",
    );
  });
});

describe("picker / available model lists", () => {
  // MONEY-1274 (MONEY-1155 #27) — these took EMAIL only, because Claude was
  // allowlist-only and a paying subscriber could not reach it at all. They now
  // take the plan too, and the assertions changed from "only the founder" to
  // "the founder OR a plan that reaches the model's own requiresPlan".
  //
  // Note these tests PASSED at runtime after the signature changed, because a
  // missing argument became `undefined` -> FREE -> Claude hidden, which
  // happened to match the old expectation for a non-founder. Only the
  // packages/core TEST type-check caught it. That is the gate MONEY-1118
  // added, and it is the reason the arity change was not silently absorbed.

  it("getAvailableModelsForUser: Claude for the founder on ANY plan", () => {
    const founder = getAvailableModelsForUser(FOUNDER, "FREE").map((m) => m.id);
    // The allowlist is an override, not a plan: the founder keeps access even
    // on FREE, which is what makes it usable for interns via env.
    assert.ok(founder.includes(OPUS));
    assert.ok(founder.includes("gemini-2.5-flash"));
  });

  it("[regression] getAvailableModelsForUser: a PAID plan now reaches Claude", () => {
    // #27, as one assertion. Claude models declare requiresPlan "PRO", so PRO
    // and PREMIUM both satisfy it; FREE does not.
    const free = getAvailableModelsForUser("intern@x.com", "FREE").map(
      (m) => m.id,
    );
    const pro = getAvailableModelsForUser("intern@x.com", "PRO").map(
      (m) => m.id,
    );
    const premium = getAvailableModelsForUser("intern@x.com", "PREMIUM").map(
      (m) => m.id,
    );

    assert.ok(!free.includes(OPUS), "FREE must not reach a paid model");
    assert.ok(pro.includes(OPUS), "PRO satisfies the model's requiresPlan");
    assert.ok(premium.includes(OPUS), "PREMIUM outranks PRO");
    // Gemini unaffected for everyone.
    for (const list of [free, pro, premium]) {
      assert.ok(list.includes("gemini-2.5-flash"));
    }
  });

  it("getPickerModelsForUser: shows Claude without the key (client-safe)", () => {
    // The browser bundle has no ANTHROPIC_API_KEY, so the picker deliberately
    // skips the env check for restricted models — otherwise Claude would be
    // invisible to everyone, entitled or not. Cosmetic: the server resolver
    // re-checks and degrades to Gemini.
    delete process.env.ANTHROPIC_API_KEY;
    const founder = getPickerModelsForUser(FOUNDER, "FREE").map((m) => m.id);
    const paid = getPickerModelsForUser("intern@x.com", "PREMIUM").map(
      (m) => m.id,
    );
    const free = getPickerModelsForUser("intern@x.com", "FREE").map(
      (m) => m.id,
    );

    assert.ok(founder.includes(OPUS), "founder should still see Claude");
    assert.ok(paid.includes(OPUS), "an entitled plan should see Claude");
    assert.ok(!free.includes(OPUS), "FREE must never see Claude");
    assert.ok(free.includes("gemini-2.5-flash"));
  });
});

describe("isClaudeEntitled — the server gate the picker must agree with", () => {
  it("[security] no key means no Claude, whatever the plan", () => {
    // isClaudeConfigured() is the floor. A PREMIUM subscriber on an env with
    // no key must not have a Claude pick honoured — the resolver would have
    // nothing to call.
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isClaudeEntitled(FOUNDER, "PREMIUM"), false);
    assert.equal(isClaudeEntitled("intern@x.com", "PREMIUM"), false);
  });

  it("the kill switch beats both the allowlist and the plan", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.CLAUDE_PORTFOLIO_AGENT = "off";
    assert.equal(isClaudeEntitled(FOUNDER, "PREMIUM"), false);
    delete process.env.CLAUDE_PORTFOLIO_AGENT;
  });

  it("[regression] a paid plan is entitled; FREE is not", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    assert.equal(isClaudeEntitled("intern@x.com", "FREE"), false);
    assert.equal(isClaudeEntitled("intern@x.com", "PRO"), true);
    assert.equal(isClaudeEntitled("intern@x.com", "PREMIUM"), true);
  });

  it("the allowlist still overrides the plan", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    assert.equal(isClaudeEntitled(FOUNDER, "FREE"), true);
  });

  it("agrees with the picker — the two must not drift", () => {
    // The picker decides what is SHOWN and this decides what is HONOURED.
    // Showing a model the server refuses is worse than not offering it: the
    // user believes they got Claude and silently got Gemini.
    process.env.ANTHROPIC_API_KEY = "sk-test";
    for (const plan of ["FREE", "PRO", "PREMIUM"] as const) {
      const shown = getPickerModelsForUser("intern@x.com", plan).some(
        (m) => m.provider === "anthropic",
      );
      assert.equal(
        shown,
        isClaudeEntitled("intern@x.com", plan),
        `picker and server gate disagree on ${plan}`,
      );
    }
  });
});
