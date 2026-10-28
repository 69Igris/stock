/**
 * MONEY-1383 (L2) — generate the TradingView chart preload manifest.
 *
 * WHY THIS EXISTS
 * ---------------
 * The chart's `<Script>` tags live inside `<PageGuard>`, which blocks on
 * `/api/subscription/access` (~0.6s) before its children mount. So a 2.5 MB
 * (480 KB brotli) download that could have started with the document instead
 * starts after an auth round-trip. `<link rel="preload">` in the SERVER page
 * moves the fetch to navigation time.
 *
 * The hrefs cannot be hardcoded: `charting_library.standalone.js` is unhashed
 * (and served `immutable`), but everything it loads is
 * `bundles/<name>.<contenthash>.js` and every hash moves on a library upgrade.
 * A stale hardcoded preload 404s SILENTLY — a warning in the console and a
 * wasted request, with the chart still working, which is exactly the kind of
 * regression nobody notices.
 *
 * So the list is READ OUT OF THE LOADER ITSELF. `charting_library.standalone.js`
 * carries the chunk list as a single-quoted JSON array literal that it feeds to
 * the widget iframe's document:
 *
 *   JSON.parse('["bundles/runtime.<hash>.js","bundles/__LANG__.500.<hash>.js",
 *               "bundles/2116.<hash>.css","bundles/8224.<hash>.js",
 *               "bundles/library.<hash>.js"]')
 *
 * Run it via `yarn sync:chart` (the library-upgrade workflow), or directly:
 *   npx tsx scripts/gen-chart-preload-manifest.ts
 *
 * `apps/web/__tests__/charts/chart-preload-manifest.test.ts` asserts every
 * href in the emitted manifest EXISTS on disk — that is the guard that turns a
 * forgotten regeneration from a silent 404 into a failing build.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE_REL =
  "apps/web/public/charting_library/charting_library.standalone.js";
const MANIFEST_REL = "apps/web/lib/charts/preload-manifest.json";

/** The public URL prefix the bundle paths are relative to. */
const PUBLIC_PREFIX = "/charting_library/";

export interface PreloadEntry {
  href: string;
  as: "script";
  /**
   * The widget iframe requests its bundles with `crossorigin="anonymous"`
   * (see the `<script defer crossorigin="anonymous" ...>` it writes). A
   * preload only matches the later request when the CORS mode matches, so the
   * bundle entries carry it and the loader entry — which the parent document
   * fetches through `next/script`, with no crossorigin — does not.
   */
  crossOrigin?: "anonymous";
}

/**
 * Pull the chunk list out of the loader source. Exported so the test can run
 * it against the real file without shelling out.
 */
export function parsePreloadEntries(standaloneSource: string): PreloadEntry[] {
  const match = standaloneSource.match(/'(\["bundles\/[^']*\])'/);
  // `match[1]` is `string | undefined` even inside the truthiness check —
  // TypeScript cannot know the group participated. Bound here rather than
  // asserted, so a pattern edited to lose its capture group fails LOUDLY with
  // the same message instead of throwing `JSON.parse(undefined)` two lines on.
  const captured = match?.[1];
  if (captured === undefined) {
    throw new Error(
      "could not find the bundle list in charting_library.standalone.js — " +
        "the loader's shape changed; re-derive the pattern before trusting this manifest",
    );
  }

  const chunks = JSON.parse(captured) as string[];

  const entries: PreloadEntry[] = [
    // The loader itself. Unhashed, so this href is stable across upgrades —
    // it is listed anyway because it is the FIRST thing PageGuard delays.
    { href: `${PUBLIC_PREFIX}charting_library.standalone.js`, as: "script" },
  ];

  for (const chunk of chunks) {
    // TWO DELIBERATE EXCLUSIONS, both because a preload the issuing document
    // never consumes earns a Chrome console warning (these are fetched by the
    // widget's IFRAME, so nothing here is "used" by the page itself — the win
    // is the shared HTTP/memory cache, not a preload-cache match):
    //
    //   `__LANG__`  substituted with the widget's locale at runtime. Pinning
    //               "en" would put a claim in the manifest that is false for
    //               any other locale.
    //   `.css`      158 KB against library.js's 2.5 MB, and `as: "style"` in a
    //               document that never applies the sheet is the noisiest of
    //               the two warnings for the least payload.
    if (chunk.includes("__LANG__")) continue;
    if (!chunk.endsWith(".js")) continue;
    entries.push({
      href: `${PUBLIC_PREFIX}${chunk}`,
      as: "script",
      crossOrigin: "anonymous",
    });
  }

  return entries;
}

function main(): void {
  const standalonePath = resolve(REPO_ROOT, STANDALONE_REL);
  if (!existsSync(standalonePath)) {
    console.error(`[gen-chart-preload-manifest] missing ${STANDALONE_REL}`);
    process.exit(1);
  }

  const entries = parsePreloadEntries(readFileSync(standalonePath, "utf8"));
  const manifestPath = resolve(REPO_ROOT, MANIFEST_REL);
  writeFileSync(manifestPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");

  console.log(
    `[gen-chart-preload-manifest] wrote ${entries.length} entries → ${MANIFEST_REL}`,
  );
  for (const e of entries) console.log(`  ${e.as.padEnd(6)} ${e.href}`);
}

// Only run when invoked directly (the test imports `parsePreloadEntries`).
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
