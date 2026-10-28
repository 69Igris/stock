const nextConfig = {
  output: "standalone",
  images: {
    unoptimized: true,
  },
  experimental: {
    // Trade-import server actions receive the whole file inline as an argument
    // (CSV up to 5 MB, XLSX up to 10 MB — base64-inflated ~13.4 MB). The Next
    // default Server Action body limit is 1 MB, which silently rejected most
    // real broker tradebooks before the action ran ("cannot upload CSV",
    // MONEY-1074). Raise the ceiling to cover the client-side max.
    serverActions: {
      bodySizeLimit: "16mb",
    },
    // MONEY-1136 — restores the client Router Cache that the Next 14→16 upgrade
    // silently switched off, and with it the "navigate away, get yanked back to
    // the page you left" bug.
    //
    // Next 14 defaulted `staleTimes.dynamic` to 30s. Next 15 changed it to 0
    // ("the Client Router Cache no longer caches Page components by default"),
    // and the upgrade (71a3c3e1, 2026-06-02) inherited that without setting it,
    // reasoning: "every data route/page is already `export const dynamic =
    // 'force-dynamic'`, so the Next 15 cache-default changes are inert here."
    //
    // That is right about the SERVER caches (fetch / Full Route Cache — those
    // were already opted out) and exactly backwards about this one.
    // `force-dynamic` does NOT exempt a route from the client Router Cache; it
    // CLASSIFIES the route as `dynamic`, which is precisely the bucket whose
    // default went 30 → 0. So having 61 of 93 pages on `force-dynamic` did not
    // make the change inert — it made every one of them maximally affected.
    //
    // The consequence is a latency bug that reads as a navigation bug. With no
    // client cache, EVERY in-app navigation refetches the route's RSC payload
    // from the server. App Router keeps the outgoing page mounted for the whole
    // of that transition, so on a `force-dynamic` page that takes seconds the
    // page you just left keeps running its effects and firing server actions —
    // and its late work lands on top of the navigation you actually asked for.
    // Before June that window was ~0ms for any route visited in the last 30s.
    //
    // 30 is not a tuning choice; it is the Next 14 value, restoring the
    // behaviour this app was built and tested against for its entire life
    // before the upgrade. The accepted tradeoff is the same one it always had:
    // a repeat or back/forward navigation within 30s renders a client-cached
    // payload, so that data can be up to 30s old. Live prices do not ride on
    // it — quotes poll on their own interval and `useIDBCache` revalidates.
    //
    // This shrinks the race window; it does not close it (a first, uncached
    // navigation still waits on the server). The rest of the fix is making
    // those pages fast and resolving their data server-side — see MONEY-1136.
    staleTimes: {
      dynamic: 30,
    },
    // MONEY-290 — barrel-import optimization. Next rewrites
    // `import { X } from "pkg"` into a deep import of just X's module, so a
    // barrel with 300 re-exports no longer drags its whole graph into the
    // chunk. `components/Sidebar.tsx` alone pulls ~50 lucide icons this way.
    //
    // Semantics that matter when editing this list (next/dist/server/config.js):
    //   result.experimental.optimizePackageImports =
    //     [...new Set([...userProvided, ...NEXT_DEFAULTS])]
    // i.e. this is UNIONed with Next's built-in list, never replaces it. As of
    // Next 16.2.7 the built-in list already contains `lucide-react`,
    // `date-fns`, `recharts` and `@tabler/icons-react`. They are repeated here
    // deliberately: the entries our bundle depends on are pinned in our own
    // config so a change to Next's defaults on a future upgrade is a no-op
    // instead of a silent regression.
    //
    // `@usemoney/ui` is the only entry that is NOT a Next default, and it is
    // the one that actually changes output today: its root barrel
    // (packages/ui/src/index.ts) re-exports ~50 components, and five files
    // still import `{ cn }` from it.
    //
    // Do NOT add a package that is not a real dependency imported through a
    // barrel — a bogus entry is silent dead config. `@radix-ui/react-icons` was
    // considered and rejected: it is not in this app's dependencies and has
    // zero imports repo-wide.
    optimizePackageImports: [
      "@usemoney/ui",
      "lucide-react",
      "recharts",
      "date-fns",
    ],
  },
  // Next 15+ : `experimental.serverComponentsExternalPackages` is now the
  // stable top-level `serverExternalPackages`.
  serverExternalPackages: [
    "mongodb",
    "pino",
    "pino-pretty",
    "dd-trace",
    "datadog-metrics",
    // MONEY-1380 — THESE TWO LINES ARE WHAT MAKES LLM OBSERVABILITY WORK HERE.
    //
    // dd-trace instruments the LLM SDKs by intercepting the module loader:
    // `require-in-the-middle` for CommonJS, `import-in-the-middle` for ESM.
    // Neither can see a module webpack has inlined into the server bundle — the
    // require never happens, so the hook never fires and every Gemini/Claude
    // call from a route or server action is invisible. Externalised, Next
    // `require()`s them at runtime and both resolve to their CJS builds, which
    // ritm patches with no loader flag at all (the workers image needs
    // `--import dd-trace/register.js` precisely because its bundle is ESM).
    //
    // The failure mode if these are removed is silence, not an error: an empty
    // LLM Observability page, which is indistinguishable from a feature nobody
    // used.
    "@google/genai",
    "@anthropic-ai/sdk",
    // Node-native gRPC client, pulled into some pages via the lib/actions barrel
    // (documents → pubsub). Externalize so webpack never bundles it or its
    // protobufjs dep — silences the "@protobufjs/inquire Critical dependency:
    // the request of a dependency is an expression" warning and keeps it
    // server-only. (Root cause is the barrel import; this is the targeted fix.)
    "@google-cloud/pubsub",
    // MONEY-1384 — the parquet cold-shard codec. THESE TWO LINES ARE THE THING
    // THAT KEEPS IT OUT OF THE BUNDLE; the `await import("hyparquet")` in
    // `packages/core/src/market-data/candles/candle-logic.ts` does NOT.
    //
    // Measured against built output before this entry existed: a dynamic import
    // changes WHEN a chunk evaluates, never whether the bytes ship. This app has
    // no `transpilePackages`, so webpack compiles `packages/core` FROM SOURCE
    // and inlined the codec into local chunks — 2975.js/3311.js (reader, 54,418 B
    // each) and 4713.js/5474.js (writer, ~55,841 B each), pulled by 133 route
    // traces. `apps/web` never registers a cold store, so every one of those
    // bytes served a branch that cannot execute here.
    //
    // Externalizing turns both into a runtime `require` inside the branch, which
    // is reached only where a cold store IS registered (the workers image and
    // the Cloud Run jobs). Do NOT delete these believing the dynamic import
    // covers it.
    "hyparquet",
    "hyparquet-writer",
  ],
  // Next 15+ : `experimental.outputFileTracingExcludes` is now the stable
  // top-level `outputFileTracingExcludes`. Keep the 26 MB TradingView Advanced
  // Charts static assets out of every serverless function bundle. Vercel serves
  // /public/* directly from the CDN, so functions never need to read these
  // files. Without this exclude, output file tracing can pull them into a
  // function bundle and blow the size budget.
  outputFileTracingExcludes: {
    "*": ["./public/charting_library/**", "./public/datafeeds/**"],
  },
  // NOTE (Next 16): `instrumentationHook` was removed — instrumentation.ts is
  // picked up automatically, so the experimental flag is no longer needed.
  webpack(config, { dev }) {
    if (dev) {
      // Reduce CPU/memory from file watching
      config.watchOptions = {
        poll: 2000, // check every 2 seconds
        aggregateTimeout: 300, // wait before rebuilding
        ignored: ["**/node_modules"],
      };
    }
    return config;
  },
  onDemandEntries: {
    maxInactiveAge: 10000,
    pagesBufferLength: 2,
  },
  async headers() {
    // Comma-separated explicit origin allowlist for the few routes that are
    // intentionally consumed cross-origin (none today). NEVER "*" — a wildcard
    // here would re-introduce the open-CORS finding (MONEY-595 A05). When a
    // route genuinely needs cross-origin access, add a scoped `source:` block
    // below that emits `Access-Control-Allow-Origin` from this allowlist.
    const corsAllowlist = (process.env.CORS_ALLOWED_ORIGINS || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const corsHeaders =
      corsAllowlist.length > 0
        ? [
            // Single allowed origin → echo it directly. Multiple → the route
            // handler must perform Origin-based reflection; we expose only the
            // first as a safe static default so we never emit a bare wildcard.
            {
              key: "Access-Control-Allow-Origin",
              value: corsAllowlist[0],
            },
            { key: "Vary", value: "Origin" },
            {
              key: "Access-Control-Allow-Methods",
              value: "GET, POST, OPTIONS",
            },
            {
              key: "Access-Control-Allow-Headers",
              value: "Content-Type, Authorization",
            },
          ]
        : [];

    return [
      // TradingView Advanced Charts static assets - content-hashed bundle
      // filenames make `immutable` safe and turn the chart's first load from
      // ~1700 revalidation requests on every navigation into zero. Without
      // this, every page nav re-validates the entire bundles/ folder.
      {
        source: "/charting_library/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/datafeeds/(.*)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          // Secure-by-default framing: only our own origin may frame the app
          // (MONEY-595 A05). The legacy `ALLOWALL` / `frame-ancestors *` let
          // any site iframe the authenticated app (clickjacking surface).
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Content-Security-Policy",
            // MONEY-594 (A05): safe, framework-compatible additions only.
            // `object-src 'none'` kills <object>/<embed> plugin vectors and
            // `base-uri 'self'` blocks <base href> hijacking of relative URLs.
            // Neither needs nonces, so Next.js inline scripts / 3rd-party are
            // unaffected.
            // TODO(MONEY-594 backlog): add a full nonce-based `script-src`
            // (and `style-src`) CSP. Deferred because Next.js emits inline
            // bootstrap scripts and several 3rd-party widgets lack nonces — a
            // restrictive policy without nonce plumbing would break the app.
            value:
              "frame-ancestors 'self'; object-src 'none'; base-uri 'self';",
          },
          // Defense-in-depth HSTS (MONEY-595 hardening). Vercel terminates TLS
          // and already sends this at the edge for the apex domain, but setting
          // it in-app guarantees the header on every response path / preview
          // host and pins subdomains. 2-year max-age with preload.
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          // CORS is OFF by default. Only emitted when CORS_ALLOWED_ORIGINS is
          // set to an explicit (non-wildcard) origin list — see above.
          ...corsHeaders,
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  // This is required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

// MONEY-290 — bundle analyzer, opt-in via `ANALYZE=true`.
//
// The chunks in this app grew to ~7.3 MB raw with no way to see what was in
// them, which is exactly how the regression this ticket fixes went unnoticed.
// `yarn workspace @usemoney/web analyze` writes client/edge/nodejs treemaps to
// .next/analyze/*.html.
//
// The `require` is deliberately INSIDE the branch: a normal `yarn build` never
// loads @next/bundle-analyzer, so the analyzer stays off the default build path
// and off the Vercel runtime.
module.exports = (() => {
  if (process.env.ANALYZE !== "true") return nextConfig;
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const withBundleAnalyzer = require("@next/bundle-analyzer")({
    enabled: true,
    // Write the reports to disk instead of spawning a browser — this has to
    // work in CI and over SSH, not just on a laptop.
    openAnalyzer: false,
  });
  return withBundleAnalyzer(nextConfig);
})();
