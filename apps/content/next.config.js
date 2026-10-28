/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@usemoney/database",
    "@usemoney/ui",
    "@usemoney/video-studio",
  ],
  // MONEY-1128 — `lib/atlas-user-search.ts` now imports the shared search gate
  // (`@usemoney/core/search/atlas-gate`), which pulls in `@usemoney/logger`
  // (pino, pino-pretty) and `@usemoney/datadog` (datadog-metrics). These are
  // Node-native and must not be bundled; both sibling apps already externalize
  // exactly this set (apps/web and apps/admin, the latter also listing
  // thread-stream — pino's worker transport).
  //
  // Worth stating why this needed catching by eye: CI never builds this app
  // (`test.yml` is install → db:generate → test), so a bundling failure here
  // surfaces for the first time at deploy.
  serverExternalPackages: [
    "pino",
    "pino-pretty",
    "thread-stream",
    "datadog-metrics",
  ],
  // @usemoney/video-studio is NodeNext ESM (imports use explicit `.js` extensions
  // over `.ts` source). Map those `.js` specifiers to the real `.ts` files so
  // webpack can resolve them; falls back to `.js` for genuine JS imports.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  // Next 16 removed the `eslint` config option; `next build` no longer runs
  // ESLint. Lint is run separately via the ESLint CLI.
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "storage.googleapis.com" },
      { protocol: "https", hostname: "img.clerk.com" },
    ],
  },
  skipTrailingSlashRedirect: true,
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
};

module.exports = nextConfig;
