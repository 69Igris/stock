/**
 * MONEY-290 — recharts stays behind a lazy boundary.
 *
 * ## The defect this pins
 *
 * `next/dynamic` was used ZERO times across 159 routes. recharts (~400 KB of
 * JS) was statically imported by five page-level components, so /fire,
 * /compare, /risk, /mf, /etf and /stock all shipped the whole charting library
 * in their entry chunk — on every visit, including the majority where no chart
 * ever paints (no NAV history, no extracted composition, no projection).
 *
 * The fix splits each consumer in two: an ENTRY file that renders chrome
 * immediately and declares a `next/dynamic` boundary, and a CANVAS leaf that
 * is the only module importing recharts.
 *
 * ## Why a source scan rather than a behavioural test
 *
 * The boundary is invisible at runtime — the app renders identically whether
 * recharts arrives in the entry chunk or a lazy one. Undoing it is a one-line
 * edit (`import { PieChart } from "recharts"` back at the top of the entry
 * file) that type-checks, builds, and passes every other test. Only a scan of
 * the import graph refuses it.
 *
 * ## The rules
 *
 * 1. Every entry file uses `next/dynamic` and does NOT import recharts.
 * 2. Every canvas leaf exists and DOES import recharts.
 * 3. The set of files importing recharts is a closed allowlist — a sixth
 *    static consumer cannot appear without editing this file.
 *
 * Sources: the five entry files and their canvas leaves, listed below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// CWD is apps/web (the package's test script runs from there).
const SCAN_ROOTS = ["app", "components", "lib", "hooks"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__tests__", "datafeeds"]);
const SOURCE_EXT = /\.(ts|tsx)$/;

/** entry file -> the canvas leaf it lazily loads */
const BOUNDARIES: ReadonlyArray<{ entry: string; canvas: string }> = [
  {
    entry: "app/fire/components/CorpusChartRecharts.tsx",
    canvas: "app/fire/components/CorpusChartCanvas.tsx",
  },
  {
    entry: "app/compare/client.tsx",
    canvas: "app/compare/CompareChartsCanvas.tsx",
  },
  {
    entry: "app/risk/components/ConcentrationCard.tsx",
    canvas: "app/risk/components/ConcentrationPieCanvas.tsx",
  },
  {
    entry: "components/FundCompositionSection.tsx",
    canvas: "components/FundCompositionDonutCanvas.tsx",
  },
  {
    entry: "components/mf/NavGrowthChart.tsx",
    canvas: "components/mf/NavGrowthChartCanvas.tsx",
  },
];

/**
 * The ONLY files allowed to import recharts. Each is reached exclusively
 * through a lazy boundary; adding an entry here means proving the same.
 */
const ALLOWED_RECHARTS_IMPORTERS = new Set<string>([
  ...BOUNDARIES.map((b) => b.canvas),
  // Already behind a React.lazy() in ChartBlockRenderer.tsx (pre-existing).
  "components/chat/blocks/ChartBlockInner.tsx",
]);

const STATIC_RECHARTS = /^\s*import\s[^;]*?\sfrom\s+["']recharts["']/m;
const NAMESPACE_RECHARTS = /import\s+\*\s+as\s+\w+\s+from\s+["']recharts["']/;
const DYNAMIC_IMPORT = /from\s+["']next\/dynamic["']/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

const allSources = SCAN_ROOTS.flatMap((r) => walk(r));

describe("MONEY-290 — recharts lazy boundaries", () => {
  for (const { entry, canvas } of BOUNDARIES) {
    it(`[${entry}] does not statically import recharts`, () => {
      const src = readFileSync(entry, "utf8");
      assert.ok(
        !STATIC_RECHARTS.test(src),
        `${entry} imports recharts at the top level again. That puts the ` +
          `whole library back into this route's entry chunk — move the chart ` +
          `JSX into ${canvas} and keep the next/dynamic boundary.`
      );
    });

    it(`[${entry}] declares a next/dynamic boundary`, () => {
      const src = readFileSync(entry, "utf8");
      assert.ok(
        DYNAMIC_IMPORT.test(src),
        `${entry} must import next/dynamic — a plain import of ${canvas} ` +
          `would defeat the split entirely`
      );
      assert.match(
        src,
        /dynamic[<(][\s\S]{0,400}?import\(/,
        `${entry} must call dynamic(() => import(...)) — importing the canvas ` +
          `statically and only *rendering* it lazily still bundles recharts`
      );
    });

    it(`[${entry}] loads its canvas with ssr:false`, () => {
      // recharts' <ResponsiveContainer> measures the DOM and renders nothing
      // server-side, so SSR of these charts is pure payload with no output.
      const src = readFileSync(entry, "utf8");
      assert.match(
        src,
        /ssr:\s*false/,
        `${entry} must pass { ssr: false } to next/dynamic`
      );
    });

    it(`[${entry}] supplies a loading fallback (CLS guard)`, () => {
      // Without `loading`, the chart slot is empty until the chunk lands and
      // the surrounding layout jumps when it arrives.
      const src = readFileSync(entry, "utf8");
      assert.match(
        src,
        /loading:/,
        `${entry} must pass a sized \`loading\` fallback to next/dynamic so ` +
          `the chart arriving does not shift layout`
      );
    });

    it(`[${canvas}] exists and is the module that imports recharts`, () => {
      const src = readFileSync(canvas, "utf8");
      assert.ok(
        STATIC_RECHARTS.test(src),
        `${canvas} is the lazy leaf — it is supposed to import recharts`
      );
    });
  }

  it("recharts importers are a closed allowlist", () => {
    const importers = allSources
      .filter((f) => STATIC_RECHARTS.test(readFileSync(f, "utf8")))
      .sort();
    const unexpected = importers.filter(
      (f) => !ALLOWED_RECHARTS_IMPORTERS.has(f)
    );
    assert.deepEqual(
      unexpected,
      [],
      `New static recharts importer(s). Every module that imports recharts ` +
        `must be reachable ONLY through a lazy boundary; if that is true here, ` +
        `add the file to ALLOWED_RECHARTS_IMPORTERS with the reason.`
    );
  });

  it("no module uses a recharts NAMESPACE import", () => {
    // `import * as RechartsPrimitive from "recharts"` defeats tree-shaking
    // outright — it is why the two dead shadcn chart.tsx barrels
    // (apps/web/components/ui/chart.tsx, packages/ui/src/chart.tsx) were
    // deleted in MONEY-290 rather than left alone.
    const offenders = allSources.filter((f) =>
      NAMESPACE_RECHARTS.test(readFileSync(f, "utf8"))
    );
    assert.deepEqual(
      offenders,
      [],
      "a namespace import pulls in the ENTIRE recharts package and cannot be " +
        "tree-shaken — import the named components you actually use"
    );
  });
});
