import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

/**
 * Externalize every bare import EXCEPT @usemoney/* workspace packages.
 *
 * Workspace packages export raw .ts files that Vercel's serverless
 * compiler won't process. tsup bundles them into a single dist/app.js
 * so the Vercel entry point (api/[[...route]].ts) can import the
 * pre-compiled bundle.
 *
 * npm packages (hono, @clerk/backend, @prisma/client, etc.) stay
 * external and are resolved from node_modules at runtime.
 */
const externalizeNonWorkspace: Plugin = {
  name: "externalize-non-workspace",
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@usemoney/")) {
        return undefined; // let esbuild resolve and bundle
      }
      return { path: args.path, external: true };
    });
  },
};

export default defineConfig({
  entry: ["src/app.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  noExternal: [/@usemoney\/.*/],
  esbuildPlugins: [externalizeNonWorkspace],
});
