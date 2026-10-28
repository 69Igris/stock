/**
 * Synthetic-actionId contract for ChatContext.executeToolDirect (MONEY-200).
 *
 * Why this exists:
 *   /api/chat/execute-tool requires { tool, params, actionId } where actionId
 *   matches `confirm-<uuid-or-prefix>` and length >= 40. The chat /api route
 *   normally mints these for write-tool confirmation flows. Slash-command
 *   direct dispatch (e.g. /portfolio) bypasses the chat route, so the client
 *   has to mint an actionId itself or the API returns 400.
 *
 *   ChatContext.executeToolDirect builds the id with:
 *     `confirm-slash-${crypto.randomUUID() ?? fallback}`
 *
 * This test pins the format invariants so the API's validator (which lives
 * in apps/web/app/api/chat/execute-tool/route.ts:46-55) can never be
 * tightened without a corresponding test failure here.
 *
 * Backfilled in Wave 0.5 of the MONEY-196 bundle.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): import the REAL synthesizer + validator. Both now
// live in execute-tool/route-logic.ts — the synthesizer is CALLED by
// ChatContext.executeToolDirect and the validator by the execute-tool route, so
// the client-minted id and the server gate provably agree.
import {
  synthesizeSlashActionId,
  isValidConfirmActionId as isValidActionId,
} from "@/app/api/chat/execute-tool/route-logic";

describe("Synthetic actionId for slash dispatch", () => {
  it("starts with the `confirm-` prefix expected by the route", () => {
    const id = synthesizeSlashActionId();
    assert.ok(id.startsWith("confirm-"), `bad prefix: ${id}`);
  });

  it("is at least 40 chars (route validator's length floor)", () => {
    const id = synthesizeSlashActionId();
    assert.ok(id.length >= 40, `length ${id.length} too short: ${id}`);
  });

  it("passes the route validator end-to-end", () => {
    const id = synthesizeSlashActionId();
    assert.strictEqual(isValidActionId(id), true);
  });

  it("uses a `slash` discriminator so backend logs can distinguish source", () => {
    const id = synthesizeSlashActionId();
    assert.ok(id.startsWith("confirm-slash-"), `discriminator missing: ${id}`);
  });

  it("generates unique ids across calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(synthesizeSlashActionId());
    assert.strictEqual(ids.size, 50, "expected 50 unique ids out of 50 calls");
  });

  it("survives the route's negative-case rejections", () => {
    // Stale formats the validator should reject. If anyone drops the
    // "confirm-" prefix or a debug short id sneaks in, this test fires.
    assert.strictEqual(isValidActionId(""), false);
    assert.strictEqual(isValidActionId("slash-abc"), false);
    assert.strictEqual(isValidActionId("confirm-short"), false);
    assert.strictEqual(isValidActionId(undefined), false);
    assert.strictEqual(isValidActionId(null), false);
    assert.strictEqual(isValidActionId(12345), false);
  });
});
