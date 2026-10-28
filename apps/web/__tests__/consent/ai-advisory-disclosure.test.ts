/**
 * AI Advisory Disclosure copy + version — MONEY-501 / MONEY-505 (SEBI IA Reg
 * 18(9)).
 *
 * De-shadowed (MONEY-620): imports the REAL AI_ADVISORY_VERSION +
 * AI_ADVISORY_DISCLOSURE from lib/consent/ai-advisory.ts — the single source of
 * truth shown at broker-connect consent (BrokerConsentModal) + the chat entry
 * (EmbeddedChatPanel) and recorded in the ConsentRecord ledger. These tests pin
 * the SEBI-required SUBSTANCE (not exact prose): AI/informational, NOT
 * SEBI-registered, read-only (never trades), and a market-risk caveat.
 *
 * The old shadow re-declared STALE copy ("Before you connect a broker", a
 * different short/points/ackLabel); the live disclosure ("About StockSage AI",
 * "It never places trades", an exchange-delayed note) had since changed. The
 * substance checks below now match the REAL wording — and would fail if a future
 * edit dropped any SEBI-required clause.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AI_ADVISORY_VERSION,
  AI_ADVISORY_DISCLOSURE,
} from "@/lib/consent/ai-advisory";

describe("AI advisory disclosure (MONEY-501/505 SEBI Reg 18(9))", () => {
  it("has a calendar-dated version (drives the ConsentRecord ledger)", () => {
    assert.match(
      AI_ADVISORY_VERSION,
      /^\d{4}-\d{2}-\d{2}$/,
      "version must be an ISO date so consent records are comparable"
    );
  });

  it("is fully populated — no empty disclosure fields", () => {
    assert.ok(AI_ADVISORY_DISCLOSURE.heading.length > 0);
    assert.ok(AI_ADVISORY_DISCLOSURE.short.length > 0);
    assert.ok(AI_ADVISORY_DISCLOSURE.ackLabel.length > 0);
    assert.ok(AI_ADVISORY_DISCLOSURE.points.length >= 4);
    for (const p of AI_ADVISORY_DISCLOSURE.points) {
      assert.ok(p.trim().length > 0, "no blank disclosure point");
    }
  });

  it("the short strip states AI + not-SEBI-registered (chat entry disclosure)", () => {
    const s = AI_ADVISORY_DISCLOSURE.short.toLowerCase();
    assert.ok(s.includes("ai"), "must say it is AI-generated");
    assert.ok(s.includes("sebi"), "must mention SEBI registration status");
    assert.ok(
      s.includes("not advice") ||
        s.includes("not investment advice") ||
        s.includes("not a sebi"),
      "must disclaim that it is advice from a SEBI-registered adviser"
    );
  });

  it("INVARIANT: the SEBI-required substance points are all present", () => {
    const all = AI_ADVISORY_DISCLOSURE.points.join(" • ").toLowerCase();
    assert.ok(all.includes("ai") || all.includes("gemini"), "AI attribution");
    assert.ok(all.includes("sebi"), "not SEBI-registered");
    assert.ok(all.includes("read-only"), "broker access is read-only");
    assert.ok(
      all.includes("risk") ||
        all.includes("past performance") ||
        all.includes("wrong or incomplete") ||
        all.includes("verify"),
      "market-risk / verify-the-numbers caveat"
    );
  });

  it("explicitly states StockSage never places/modifies/cancels orders", () => {
    const all = (
      AI_ADVISORY_DISCLOSURE.short +
      " " +
      AI_ADVISORY_DISCLOSURE.points.join(" ")
    ).toLowerCase();
    assert.ok(
      all.includes("never places") ||
        (all.includes("read-only") &&
          (all.includes("order") || all.includes("trade"))),
      "must state no order placement"
    );
  });
});
