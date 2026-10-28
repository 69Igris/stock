/**
 * MONEY-1274 / MONEY-1155 #28 — "starting an advanced research still shows
 * deep - comprehensive".
 *
 * ## The defect
 *
 * The mode badge is built from `block.mode`, threaded onto the block at
 * creation from the confirm action's `params.mode`. That is CLIENT-ONLY state:
 * `ResearchSession` persists `skill` and has no mode/depth column (checked
 * against the schema, 2026-09-05). So any block rebuilt from the DB — after a
 * reload, or navigating back to a run — arrives with no mode.
 *
 * The old code answered that unknown with a fabricated default:
 *
 *     deep:  block.mode ? block.mode !== "fast" : true
 *     depth: block.mode ? capitalize(block.mode) : "Comprehensive"
 *
 * so an ADVANCED run reloaded as "DEEP - Comprehensive" — the reported bug —
 * and a FAST run reloaded as "DEEP", which is worse: the invented default
 * directly contradicts the run the user started.
 *
 * ## Why the fix is "show less" rather than "remember it"
 *
 * Persisting mode would need a schema column, which is out of scope here. The
 * available honest move is to stop asserting what is not known — the same
 * correction as the failed-run stepper in this ticket, which drew every failure
 * at SYNTHESIZING because that was a plausible-looking constant.
 *
 * Source under test: apps/web/components/stocksage/research-run.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { modeBadge } from "../../components/stocksage/research-run";

describe("modeBadge — only what the block actually knows", () => {
  it("[regression] an unknown mode claims NOTHING", () => {
    // THE BUG. Both halves used to be invented here.
    for (const unknown of [undefined, null, ""]) {
      const b = modeBadge(unknown);
      assert.equal(b.depth, undefined, `depth invented for ${String(unknown)}`);
      assert.equal(b.deep, undefined, `deep invented for ${String(unknown)}`);
    }
  });

  it("[regression] an unknown mode never yields the string 'Comprehensive'", () => {
    // Named explicitly because that literal IS the reported symptom.
    assert.notEqual(modeBadge(undefined).depth, "Comprehensive");
  });

  it("an advanced run reads Advanced, not Comprehensive", () => {
    assert.deepEqual(modeBadge("advanced"), {
      deep: true,
      depth: "Advanced",
    });
  });

  it("a fast run is NOT deep", () => {
    // The old default would have called this one "DEEP" after a reload —
    // contradicting the mode the user picked.
    assert.deepEqual(modeBadge("fast"), { deep: false, depth: "Fast" });
  });

  it("passes any other mode through capitalized", () => {
    assert.deepEqual(modeBadge("comprehensive"), {
      deep: true,
      depth: "Comprehensive",
    });
  });

  it("deep and depth are always both known or both unknown", () => {
    // The pill reads them together; a half-known badge would be a new way to
    // render a confident half-truth.
    for (const m of [undefined, null, "", "fast", "advanced", "custom"]) {
      const b = modeBadge(m);
      assert.equal(
        b.deep === undefined,
        b.depth === undefined,
        `mode ${String(m)} produced a half-known badge`
      );
    }
  });
});

describe("the fabricated defaults are gone from the render path", () => {
  const strip = (p: string) =>
    readFileSync(join(process.cwd(), p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  it('[regression] no `|| "Comprehensive"` default survives', () => {
    // Comments stripped first: both files now EXPLAIN the old default in prose,
    // and matching the explanation would fail a corrected file.
    for (const p of [
      "components/stocksage/research-run.tsx",
      "components/stocksage/ResearchRunBlock.tsx",
      "components/chat/blocks/ResearchStreamRenderer.tsx",
    ]) {
      assert.doesNotMatch(
        strip(p),
        /\|\|\s*"Comprehensive"|\?\?\s*"Comprehensive"/,
        `${p} still defaults depth to "Comprehensive"`
      );
    }
  });

  it("[regression] the block no longer defaults deep to true", () => {
    assert.doesNotMatch(
      strip("components/stocksage/ResearchRunBlock.tsx"),
      /data\.deep\s*\?\?\s*true/,
      "a run of unknown mode is being called DEEP again"
    );
  });

  it("the renderer derives the badge from the shared rule", () => {
    assert.match(
      strip("components/chat/blocks/ResearchStreamRenderer.tsx"),
      /modeBadge\(block\.mode\)/
    );
  });
});
