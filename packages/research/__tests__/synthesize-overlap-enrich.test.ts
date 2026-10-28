/**
 * MONEY-778 (Track B): enrichOverlapFromTasks deterministically attaches the
 * fund-overlap heatmap + observation flags to the report's overlap section from
 * the compute_holdings_overlap task result. These tests pin the matrix math,
 * the flag→observation mapping, the create-section-if-absent behaviour, and the
 * no-op guards that keep non-overlap reports untouched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { enrichOverlapFromTasks } from "../src/tools/synthesize-report";

type Rec = Record<string, unknown>;

function overlapTask(result: unknown) {
  return [
    { tool: "compute_holdings_overlap", status: "completed", result },
  ] as Array<{ tool: string; status?: string; result?: unknown }>;
}

const OVERLAP_RESULT = {
  available: true,
  fundIds: ["PPFAS", "QUANT", "HDFC"],
  pairwise: [
    { fundA: "PPFAS", fundB: "QUANT", jaccard: 22 },
    { fundA: "PPFAS", fundB: "HDFC", jaccard: 31 },
    { fundA: "QUANT", fundB: "HDFC", jaccard: 28 },
  ],
  flags: ["HDFC Bank held by all 3 funds", "PPFAS adds international exposure"],
};

describe("enrichOverlapFromTasks (MONEY-778)", () => {
  it("builds a symmetric pairwise heatmap with diagonal 100", () => {
    const report: Rec = {
      sections: [{ title: "Holdings overlap", type: "text" }],
    };
    enrichOverlapFromTasks(report, overlapTask(OVERLAP_RESULT));

    const section = (report.sections as Rec[])[0]!;
    const hm = section.heatmap as Rec;
    assert.ok(hm, "heatmap attached");
    assert.deepEqual(hm.rows, ["PPFAS", "QUANT", "HDFC"]);
    assert.deepEqual(hm.data, [
      [100, 22, 31],
      [22, 100, 28],
      [31, 28, 100],
    ]);
  });

  it("maps flags[] to neutral observation chips", () => {
    const report: Rec = {
      sections: [{ title: "Common holdings", type: "text" }],
    };
    enrichOverlapFromTasks(report, overlapTask(OVERLAP_RESULT));
    const section = (report.sections as Rec[])[0]!;
    assert.deepEqual(section.flags, [
      { tone: "blue", text: "HDFC Bank held by all 3 funds" },
      { tone: "blue", text: "PPFAS adds international exposure" },
    ]);
  });

  it("creates an overlap section when the report has none", () => {
    const report: Rec = { sections: [{ title: "Top holdings", type: "text" }] };
    enrichOverlapFromTasks(report, overlapTask(OVERLAP_RESULT));
    const sections = report.sections as Rec[];
    assert.equal(sections.length, 2, "a new overlap section was appended");
    const created = sections.find((s) => /overlap/i.test(String(s.title)));
    assert.ok(created, "overlap section exists");
    assert.ok(created!.heatmap, "heatmap on the created section");
  });

  it("does not clobber an existing section heatmap", () => {
    const existing = { rows: ["X"], cols: ["X"], data: [[1]] };
    const report: Rec = {
      sections: [
        { title: "Holdings overlap", type: "text", heatmap: existing },
      ],
    };
    enrichOverlapFromTasks(report, overlapTask(OVERLAP_RESULT));
    assert.equal((report.sections as Rec[])[0]!.heatmap, existing);
  });

  it("is a no-op when no completed overlap task is present", () => {
    const report: Rec = { sections: [{ title: "Key metrics", type: "text" }] };
    enrichOverlapFromTasks(report, [
      {
        tool: "compute_dcf",
        status: "completed",
        result: { intrinsicValue: 1 },
      },
    ]);
    assert.equal((report.sections as Rec[]).length, 1);
    assert.equal((report.sections as Rec[])[0]!.heatmap, undefined);
  });

  it("is a no-op when the overlap result is unavailable", () => {
    const report: Rec = {
      sections: [{ title: "Holdings overlap", type: "text" }],
    };
    enrichOverlapFromTasks(
      report,
      overlapTask({ available: false, fundIds: [], pairwise: [], flags: [] }),
    );
    assert.equal((report.sections as Rec[])[0]!.heatmap, undefined);
    assert.equal((report.sections as Rec[])[0]!.flags, undefined);
  });

  it("ignores non-numeric jaccard (no NaN cells)", () => {
    const report: Rec = {
      sections: [{ title: "Holdings overlap", type: "text" }],
    };
    enrichOverlapFromTasks(
      report,
      overlapTask({
        available: true,
        fundIds: ["A", "B"],
        pairwise: [{ fundA: "A", fundB: "B", jaccard: "n/a" }],
        flags: [],
      }),
    );
    const hm = (report.sections as Rec[])[0]!.heatmap as Rec;
    assert.deepEqual(hm.data, [
      [100, 0],
      [0, 100],
    ]);
  });
});
