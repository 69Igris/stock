/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@usemoney/database", "@usemoney/ui"],
  // Next 15+ : moved out of `experimental` to the stable top-level option.
  serverExternalPackages: [
    "pino",
    "pino-pretty",
    "thread-stream",
    // MONEY-1384 — the parquet cold-shard codec, reached through the root
    // `@usemoney/core` barrel. THESE TWO LINES ARE WHAT KEEPS IT OUT OF THE
    // BUNDLE; the `await import("hyparquet")` in `candle-logic.ts` does not — a
    // dynamic import changes WHEN a chunk evaluates, never whether the bytes
    // ship. `@usemoney/core` is not in `transpilePackages`, but webpack still
    // compiles its source through the workspace symlink, so the codec was
    // inlined into local chunks for a branch this app can never execute (admin
    // registers no cold store). Do NOT delete these believing the dynamic
    // import covers it.
    "hyparquet",
    "hyparquet-writer",
  ],
  // Next 16 removed the `eslint` config option; `next build` no longer runs
  // ESLint. Lint is run separately via the ESLint CLI.
  typescript: {
    ignoreBuildErrors: false,
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-XSS-Protection", value: "1; mode=block" },
      ],
    },
  ],
};

module.exports = nextConfig;
