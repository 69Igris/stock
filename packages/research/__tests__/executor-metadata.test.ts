/**
 * MONEY-1060 (fix 2a) — executor carries ToolOutput.metadata onto the task.
 *
 * Pre-fix, `ResearchExecutor.execute` kept only `result.data` (success) /
 * `result.error` (failure) and DISCARDED `result.metadata` — so the
 * `sourceError` / `source` / `stale` signals the MONEY-1060 tools emit never
 * reached the synthesizer. This test drives the REAL executor with stub tools
 * registered over a real `ResearchToolRegistry` (no network, no DB, no LLM)
 * and asserts `task.metadata` lands on BOTH the success and the failure path,
 * and stays absent when the tool emits none.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ResearchExecutor } from "../src/executor";
import { ResearchToolRegistry } from "../src/tools/registry";
import { Scratchpad } from "../src/scratchpad";
import { DEFAULT_AGENT_CONFIG } from "../src/types";
import type { ResearchTask } from "../src/types";

function stubTask(id: string, tool: string): ResearchTask {
  return {
    id,
    type: "data_fetch",
    tool,
    params: {},
    dependsOn: [],
    status: "pending",
  };
}

describe("ResearchExecutor — ToolOutput.metadata propagation (MONEY-1060)", () => {
  it("carries metadata on success, on failure, and omits it when absent", async () => {
    const registry = new ResearchToolRegistry();
    registry.register({
      name: "stub_meta_success",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({
        success: true,
        data: { rows: 1 },
        metadata: { source: "db", partial: true },
      }),
    });
    registry.register({
      name: "stub_meta_failure",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({
        success: false,
        error: "No price data found for TCS.NS: Yahoo 429",
        metadata: { sourceError: "Yahoo 429" },
      }),
    });
    registry.register({
      name: "stub_no_meta",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({ success: true, data: [1, 2] }),
    });

    const executor = new ResearchExecutor(registry, DEFAULT_AGENT_CONFIG);
    const tasks = [
      stubTask("t1", "stub_meta_success"),
      stubTask("t2", "stub_meta_failure"),
      stubTask("t3", "stub_no_meta"),
    ];

    const out = await executor.execute(tasks, new Scratchpad());

    const t1 = out.find((t) => t.id === "t1")!;
    assert.equal(t1.status, "completed");
    assert.deepEqual(t1.result, { rows: 1 });
    assert.deepEqual(t1.metadata, { source: "db", partial: true });

    const t2 = out.find((t) => t.id === "t2")!;
    assert.equal(t2.status, "failed");
    assert.match(t2.error ?? "", /Yahoo 429/);
    assert.deepEqual(
      t2.metadata,
      { sourceError: "Yahoo 429" },
      "failure metadata must survive for the synthesizer's outage section",
    );

    const t3 = out.find((t) => t.id === "t3")!;
    assert.equal(t3.status, "completed");
    assert.equal(t3.metadata, undefined, "no metadata emitted → none stamped");
    assert.equal(
      Object.prototype.hasOwnProperty.call(t3, "metadata"),
      false,
      "the key itself must not be created (JSON persistence stays clean)",
    );
  });
});
