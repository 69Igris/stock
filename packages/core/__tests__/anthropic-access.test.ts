/**
 * Claude access gate (MONEY-626) — the founder allowlist.
 *
 * SECURITY-critical: this is the server-authoritative check that keeps Claude
 * founder-only and Gemini the default for everyone else. Pure (env-only, no
 * SDK), so it's also safe in the client bundle.
 *
 * Source: packages/core/src/anthropic/access.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isClaudeConfigured,
  isClaudeAllowedForEmail,
  isClaudeAvailableForEmail,
  getClaudeAllowedEmails,
} from "../src/anthropic/access";

const realKey = process.env.ANTHROPIC_API_KEY;
const realFlag = process.env.CLAUDE_PORTFOLIO_AGENT;
const realAllow = process.env.CLAUDE_ALLOWED_EMAILS;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.CLAUDE_PORTFOLIO_AGENT;
  delete process.env.CLAUDE_ALLOWED_EMAILS;
});
afterEach(() => {
  for (const [k, v] of [
    ["ANTHROPIC_API_KEY", realKey],
    ["CLAUDE_PORTFOLIO_AGENT", realFlag],
    ["CLAUDE_ALLOWED_EMAILS", realAllow],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("isClaudeConfigured", () => {
  it("true with key + no kill switch; false when killed or keyless", () => {
    assert.equal(isClaudeConfigured(), true);
    process.env.CLAUDE_PORTFOLIO_AGENT = "off";
    assert.equal(isClaudeConfigured(), false);
    delete process.env.CLAUDE_PORTFOLIO_AGENT;
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isClaudeConfigured(), false);
  });
});

describe("isClaudeAllowedForEmail — the allowlist", () => {
  it("allows the founder, denies everyone else (case-insensitive)", () => {
    assert.equal(isClaudeAllowedForEmail("deepshaswat@gmail.com"), true);
    assert.equal(isClaudeAllowedForEmail("DeepShaswat@Gmail.com"), true);
    assert.equal(isClaudeAllowedForEmail("intern@usemoney.ai"), false);
    assert.equal(isClaudeAllowedForEmail("attacker@evil.com"), false);
  });

  it("denies null / undefined / empty", () => {
    assert.equal(isClaudeAllowedForEmail(null), false);
    assert.equal(isClaudeAllowedForEmail(undefined), false);
    assert.equal(isClaudeAllowedForEmail(""), false);
  });

  it("env CLAUDE_ALLOWED_EMAILS overrides + extends (interns later)", () => {
    process.env.CLAUDE_ALLOWED_EMAILS =
      "deepshaswat@gmail.com, intern1@usemoney.ai ,Intern2@UseMoney.ai";
    assert.equal(isClaudeAllowedForEmail("intern1@usemoney.ai"), true);
    assert.equal(isClaudeAllowedForEmail("intern2@usemoney.ai"), true);
    assert.equal(isClaudeAllowedForEmail("deepshaswat@gmail.com"), true);
    assert.equal(isClaudeAllowedForEmail("nope@x.com"), false);
  });

  it("empty/whitespace env never opens Claude to everyone (founder floor)", () => {
    process.env.CLAUDE_ALLOWED_EMAILS = "   ,  ";
    assert.deepEqual(getClaudeAllowedEmails(), ["deepshaswat@gmail.com"]);
    assert.equal(isClaudeAllowedForEmail("random@x.com"), false);
    assert.equal(isClaudeAllowedForEmail("deepshaswat@gmail.com"), true);
  });
});

describe("isClaudeAvailableForEmail — gate AND config", () => {
  it("requires BOTH allowlist and configuration", () => {
    assert.equal(isClaudeAvailableForEmail("deepshaswat@gmail.com"), true);
    // allowlisted but not configured → false
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(isClaudeAvailableForEmail("deepshaswat@gmail.com"), false);
    // configured but not allowlisted → false
    process.env.ANTHROPIC_API_KEY = "test-key";
    assert.equal(isClaudeAvailableForEmail("intern@usemoney.ai"), false);
  });
});
