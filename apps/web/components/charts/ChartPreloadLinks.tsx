/**
 * MONEY-1383 (L2) — start the TradingView download at navigation, not after auth.
 *
 * `TradingViewAdvancedChart` renders its `<Script>` tags for the charting
 * library, but the component sits inside `<PageGuard>`, which blocks on
 * `/api/subscription/access` (~0.6s measured on prod) before mounting its
 * children. So a 2.5 MB / 480 KB-brotli download that could have begun with the
 * document instead begins after an auth round-trip — and the library alone
 * costs ~1.5s cold.
 *
 * This renders the preload links from the SERVER component, outside the guard,
 * so the fetch starts with the HTML.
 *
 * WHAT THE PRELOAD ACTUALLY BUYS. The widget builds its own same-origin IFRAME
 * and writes `<script defer crossorigin="anonymous" src="bundles/...">` into
 * it, so these responses are consumed by a DIFFERENT document than the one
 * issuing the preload. The win is therefore the shared HTTP/memory cache, not a
 * preload-cache match — and the cost is Chrome's "preloaded but not used"
 * console warning, which is why the manifest carries only the JS chunks that
 * are always fetched and materially large (see the generator for the two
 * deliberate exclusions).
 *
 * `crossOrigin` mirrors what the iframe requests with, so the two requests do
 * not differ in CORS mode; the loader entry omits it because the PARENT
 * document fetches that one through `next/script`, which sets no crossorigin.
 *
 * The hrefs are GENERATED, never hand-written — `bundles/library.<contenthash>.js`
 * moves on every library upgrade and a stale href 404s silently. Regenerate
 * with `yarn sync:chart` (or `npx tsx scripts/gen-chart-preload-manifest.ts`);
 * `__tests__/charts/chart-preload-manifest.test.ts` fails the build if a listed
 * file is not on disk.
 */

import manifest from "@/lib/charts/preload-manifest.json";

export default function ChartPreloadLinks() {
  return (
    <>
      {manifest.map((entry) => (
        <link
          key={entry.href}
          rel="preload"
          as={entry.as}
          href={entry.href}
          crossOrigin={
            entry.crossOrigin === "anonymous" ? "anonymous" : undefined
          }
        />
      ))}
    </>
  );
}
