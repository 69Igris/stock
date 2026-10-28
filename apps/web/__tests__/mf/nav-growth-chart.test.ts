/**
 * MONEY-393 §9 - NavGrowthChart benchmark synthesis math + source contract.
 *
 * The component lives in `components/mf/NavGrowthChart.tsx`. It originally
 * shipped an internal `synthesizeBenchmark` helper that anchored a fake
 * "benchmark" line to ~70% of the fund's own CAGR (with a 6% floor). The
 * synth-math cases below mirror that algorithm inline and pin its invariants
 * (start point shared, monotonic growth, 6% floor) so the formula is on
 * record should a real benchmark feed ever reinstate it.
 *
 * MONEY-610 then REMOVED that fabricated benchmark from the source — it was a
 * placeholder, not a real Nifty TRI series, so shipping it was misleading. The
 * source-contract cases assert the current truth: the chart renders only the
 * fund line, the removal is documented, and no synthesized benchmark Area is
 * drawn. That guards against silently re-shipping a placeholder as production
 * truth (the original intent of this file), now matched to the post-MONEY-610
 * source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface NavPoint {
  time: string;
  nav: number;
  benchmark: number;
}

/** In-source algorithm mirrored. */
function synthesizeBenchmark(
  points: Array<{ time: string; nav: number }>
): NavPoint[] {
  if (points.length < 2) {
    return points.map((p) => ({ ...p, benchmark: p.nav }));
  }
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const years = Math.max(
    0.5,
    (new Date(end.time).getTime() - new Date(start.time).getTime()) /
      (365 * 24 * 60 * 60 * 1000)
  );
  const fundCagr = Math.pow(end.nav / start.nav, 1 / years) - 1;
  const benchCagr = Math.max(0.06, fundCagr * 0.7 - 0.005);
  const dailyRate = Math.pow(1 + benchCagr, 1 / 365) - 1;
  return points.map((p, i) => {
    const days =
      i === 0
        ? 0
        : (new Date(p.time).getTime() - new Date(start.time).getTime()) /
          (24 * 60 * 60 * 1000);
    return { ...p, benchmark: start.nav * Math.pow(1 + dailyRate, days) };
  });
}

const SRC = readFileSync(
  join(__dirname, "..", "..", "components", "mf", "NavGrowthChart.tsx"),
  "utf8"
);

/**
 * MONEY-290 split this component in two: `NavGrowthChart.tsx` keeps the card
 * chrome + data fetching, and the plotted recharts canvas moved to
 * `NavGrowthChartCanvas.tsx` behind a `next/dynamic` boundary so recharts is
 * no longer in the /mf entry chunk.
 *
 * The series contract below is therefore checked against BOTH files
 * concatenated. That is deliberately stronger than scanning either one: a
 * fabricated benchmark series can be reinstated in whichever file, and moving
 * chart code across the boundary can no longer make the guard stop looking.
 */
const CANVAS_SRC = readFileSync(
  join(__dirname, "..", "..", "components", "mf", "NavGrowthChartCanvas.tsx"),
  "utf8"
);
const CHART_SRC = `${SRC}\n${CANVAS_SRC}`;

describe("MONEY-393 §9 - NavGrowthChart benchmark synthesis + contract", () => {
  it("[synth] empty input → empty output", () => {
    assert.deepEqual(synthesizeBenchmark([]), []);
  });

  it("[synth] single point: benchmark === nav (no growth to extrapolate)", () => {
    const out = synthesizeBenchmark([{ time: "2024-01-01", nav: 100 }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.benchmark, 100);
  });

  it("[synth] benchmark starts at the same nav as the fund", () => {
    const out = synthesizeBenchmark([
      { time: "2024-01-01", nav: 100 },
      { time: "2026-01-01", nav: 200 },
    ]);
    assert.equal(out[0]!.benchmark, 100, "benchmark[0] must equal nav[0]");
  });

  it("[synth] benchmark is monotonically increasing for a growing fund", () => {
    const out = synthesizeBenchmark([
      { time: "2024-01-01", nav: 100 },
      { time: "2024-07-01", nav: 110 },
      { time: "2025-01-01", nav: 125 },
      { time: "2026-01-01", nav: 145 },
    ]);
    for (let i = 1; i < out.length; i++) {
      assert.ok(
        out[i]!.benchmark >= out[i - 1]!.benchmark,
        `benchmark must be non-decreasing for a growing fund (broke at i=${i})`
      );
    }
  });

  it("[synth] benchmark grows slower than the fund (the 70% CAGR rule)", () => {
    const out = synthesizeBenchmark([
      { time: "2024-01-01", nav: 100 },
      { time: "2026-01-01", nav: 200 }, // 100% over 2 years → ~41% CAGR
    ]);
    // End benchmark < end nav by construction of benchCagr = fundCagr*0.7 - 0.005.
    const endBenchmark = out[out.length - 1]!.benchmark;
    assert.ok(
      endBenchmark < 200,
      `benchmark end should be < fund end; got ${endBenchmark}`
    );
  });

  it("[synth] 6% CAGR floor protects against negative fund returns", () => {
    // Fund went from 100 to 90 over 2 years (negative CAGR). The
    // benchmark still grows at 6% because of the Math.max(0.06, …)
    // floor - this is intentional (a benchmark line below the fund
    // looks visually wrong on a "vs benchmark" chart).
    const out = synthesizeBenchmark([
      { time: "2024-01-01", nav: 100 },
      { time: "2026-01-01", nav: 90 },
    ]);
    const endBenchmark = out[out.length - 1]!.benchmark;
    assert.ok(
      endBenchmark > 100,
      `6% floor should make benchmark grow even when fund declines; got ${endBenchmark}`
    );
  });

  it("[synth] years floor of 0.5 protects against same-day input", () => {
    // Both points on the same day - without the 0.5 floor, division
    // by zero years would produce Infinity.
    const out = synthesizeBenchmark([
      { time: "2024-01-01", nav: 100 },
      { time: "2024-01-01", nav: 100 },
    ]);
    for (const p of out) {
      assert.ok(
        Number.isFinite(p.benchmark),
        `benchmark must be finite, got ${p.benchmark}`
      );
    }
  });

  // ── Source-text contract guards ────────────────────────────────

  it("[src] NavPeriod exports the 7 canonical buckets (1M/3M/6M/1Y/3Y/5Y/ALL)", () => {
    assert.match(
      SRC,
      /export\s+type\s+NavPeriod\s*=\s*["']1M["']\s*\|\s*["']3M["']\s*\|\s*["']6M["']\s*\|\s*["']1Y["']\s*\|\s*["']3Y["']\s*\|\s*["']5Y["']\s*\|\s*["']ALL["']/
    );
  });

  it("[src] PERIODS table maps each NavPeriod to its month count", () => {
    // 1M=1, 3M=3, 6M=6, 1Y=12, 3Y=36, 5Y=60, ALL=0
    assert.match(SRC, /id:\s*["']1M["'],\s*months:\s*1\b/);
    assert.match(SRC, /id:\s*["']3M["'],\s*months:\s*3\b/);
    assert.match(SRC, /id:\s*["']6M["'],\s*months:\s*6\b/);
    assert.match(SRC, /id:\s*["']1Y["'],\s*months:\s*12\b/);
    assert.match(SRC, /id:\s*["']3Y["'],\s*months:\s*36\b/);
    assert.match(SRC, /id:\s*["']5Y["'],\s*months:\s*60\b/);
    assert.match(SRC, /id:\s*["']ALL["'],\s*months:\s*0\b/);
  });

  it("[src] fabricated benchmark is removed and the removal is documented (MONEY-610)", () => {
    // MONEY-610 removed the synthesized "benchmark" overlay because it was a
    // placeholder anchored to the fund's own CAGR, NOT a real Nifty TRI
    // series. The source must (a) document that removal so a future reader
    // doesn't reinstate the placeholder as production-truth, and (b) no
    // longer ship a synthesizeBenchmark helper.
    assert.match(
      SRC,
      /(synthesi[sz]ed?[\s\S]{0,400}(removed|placeholder)|(removed|placeholder)[\s\S]{0,400}synthesi[sz]ed?|real[\s\S]{0,80}(TRI|benchmark)[\s\S]{0,80}(feed|history))/i,
      "removal of the fabricated/synthesized benchmark must be documented"
    );
    assert.ok(
      !/function\s+synthesizeBenchmark/.test(CHART_SRC),
      "synthesizeBenchmark helper must no longer exist in the source"
    );
  });

  it("[src] only the fund NAV Area is rendered — no synthesized benchmark series", () => {
    // Exactly one <Area> bound to the fund nav; a second Area bound to a
    // `benchmark` dataKey would mean the fabricated overlay is back.
    // Counted across the component + its lazy canvas (MONEY-290 split).
    const areaCount = (CHART_SRC.match(/<Area\b/g) ?? []).length;
    assert.equal(areaCount, 1, "expected a single (fund) Area series");
    assert.ok(
      !/dataKey=["']benchmark["']/.test(CHART_SRC),
      "no Area/series may be bound to a synthesized `benchmark` dataKey"
    );
  });

  it("[src] formatInr is rupee-prefixed", () => {
    // Lives in the canvas since MONEY-290 (it is the y-axis tick formatter).
    assert.match(CHART_SRC, /\$\{n\.toFixed\(\s*0\s*\)\}/);
  });
});
