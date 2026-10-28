/**
 * Founder gate for the ZERODHA_CONNECT connector (MONEY-837) — REAL logic test.
 *
 * Security-critical: this allowlist is the ONLY thing keeping the paid Connect
 * app's OAuth (and the saved token) founder-only. Asserts the real exported
 * functions, not a copy.
 *
 * Source: apps/web/lib/brokers/connect-gate.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isConnectFounder,
  getConnectFounderEmails,
} from "@/lib/brokers/connect-gate";

describe("connect-gate — founder allowlist", () => {
  it("allows the default founder", () => {
    assert.equal(isConnectFounder("deepshaswat@gmail.com"), true);
  });

  it("is case-insensitive and trims whitespace", () => {
    assert.equal(isConnectFounder("  DeepShaswat@Gmail.com "), true);
  });

  it("rejects a non-founder", () => {
    assert.equal(isConnectFounder("attacker@example.com"), false);
  });

  it("rejects null / undefined / empty / non-string", () => {
    assert.equal(isConnectFounder(null), false);
    assert.equal(isConnectFounder(undefined), false);
    assert.equal(isConnectFounder(""), false);
  });

  it("CONNECT_FOUNDER_EMAILS env overrides the default (CSV, lowercased, trimmed)", () => {
    const saved = process.env.CONNECT_FOUNDER_EMAILS;
    process.env.CONNECT_FOUNDER_EMAILS = "a@x.com, B@Y.com";
    try {
      assert.deepEqual(getConnectFounderEmails(), ["a@x.com", "b@y.com"]);
      assert.equal(isConnectFounder("b@y.com"), true);
      // default founder is REPLACED, not merged, once the env is set
      assert.equal(isConnectFounder("deepshaswat@gmail.com"), false);
    } finally {
      if (saved === undefined) delete process.env.CONNECT_FOUNDER_EMAILS;
      else process.env.CONNECT_FOUNDER_EMAILS = saved;
    }
  });

  it("falls back to the default founder when the env is empty/unset", () => {
    const saved = process.env.CONNECT_FOUNDER_EMAILS;
    delete process.env.CONNECT_FOUNDER_EMAILS;
    try {
      assert.deepEqual(getConnectFounderEmails(), ["deepshaswat@gmail.com"]);
    } finally {
      if (saved !== undefined) process.env.CONNECT_FOUNDER_EMAILS = saved;
    }
  });
});
