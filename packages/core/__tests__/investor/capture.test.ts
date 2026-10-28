/**
 * Behaviour-signal capture seam — never-throw + bounded-write contract
 * (MONEY-788, B3).
 *
 * The capture helpers touch Prisma, so we exercise only the two unit-testable
 * guarantees here:
 *
 *   1. `boundSymbols` (the pure symbol sanitizer/cap) — proves a hostile or
 *      oversized `symbols` array can never amplify storage on the `UserEvent`
 *      row it lands in.
 *   2. The three `capture*Signal` entry points NEVER throw and NO-OP when
 *      `DATABASE_URL` is unset — a capture failure must never break the
 *      user-facing request (research / chat / roast) that fired it.
 *
 * The actual DB writes are integration-shaped and not unit-tested here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boundSymbols,
  captureChatSignal,
  captureResearchSignal,
  captureRoastSignal,
} from "../../src/investor/capture";

describe("boundSymbols — sanitize + cap", () => {
  it("caps the count at 25 even for a huge array", () => {
    const many = Array.from({ length: 500 }, (_, i) => `SYM${i}`);
    const out = boundSymbols(many);
    assert.ok(out.length <= 25, `expected <=25, got ${out.length}`);
  });

  it("truncates oversized symbol strings", () => {
    const out = boundSymbols(["X".repeat(1000)]);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.length <= 32, `symbol not truncated: ${out[0]!.length}`);
  });

  it("drops non-string, empty, and whitespace-only entries", () => {
    const out = boundSymbols([
      "INFY",
      "",
      "   ",
      // hostile non-string entries (cast through unknown)
      ...([null, undefined, 42, {}] as unknown as string[]),
      "TCS",
    ]);
    assert.deepEqual(out, ["INFY", "TCS"]);
  });

  it("dedupes while preserving first-seen order", () => {
    const out = boundSymbols(["A", "B", "A", "C", "B"]);
    assert.deepEqual(out, ["A", "B", "C"]);
  });

  it("returns [] for a non-array input", () => {
    assert.deepEqual(boundSymbols(undefined as unknown as string[]), []);
    assert.deepEqual(boundSymbols(null as unknown as string[]), []);
  });
});

describe("capture*Signal — never-throw + no-DB no-op contract", () => {
  async function withoutDb<T>(fn: () => Promise<T>): Promise<T> {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      return await fn();
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  }

  it("captureResearchSignal resolves (no throw) with DATABASE_URL unset", async () => {
    await withoutDb(async () => {
      await assert.doesNotReject(
        captureResearchSignal({
          userId: "u1",
          sessionId: "s1",
          skill: "stock-analysis",
          symbols: Array.from({ length: 500 }, (_, i) => `SYM${i}`),
          mode: "advanced",
          qualityScore: 0.9,
        }),
      );
    });
  });

  it("captureChatSignal resolves (no throw) with DATABASE_URL unset", async () => {
    await withoutDb(async () => {
      await assert.doesNotReject(
        captureChatSignal({
          userId: "u1",
          messageId: "m1",
          tool: "run_roast",
          symbols: ["INFY", "TCS"],
        }),
      );
    });
  });

  it("captureRoastSignal resolves (no throw) with DATABASE_URL unset", async () => {
    await withoutDb(async () => {
      await assert.doesNotReject(
        captureRoastSignal({ userId: "u1", sessionId: "s1", score: 7 }),
      );
    });
  });

  it("tolerates hostile inputs (unknown skill / missing fields) without throwing", async () => {
    await withoutDb(async () => {
      await assert.doesNotReject(
        captureResearchSignal({
          userId: "",
          sessionId: "",
          skill: "not-a-real-skill",
          symbols: [],
        }),
      );
      await assert.doesNotReject(
        captureChatSignal({ userId: "u1", symbols: [] }),
      );
    });
  });
});
