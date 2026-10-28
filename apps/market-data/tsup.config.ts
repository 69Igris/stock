import { defineConfig } from "tsup";
import type { Plugin } from "esbuild";

/**
 * Externalize every bare import EXCEPT @usemoney/* workspace packages.
 *
 * Workspace packages export raw `.ts`, so they must be bundled — the same
 * reason `apps/api` and `workers` do it. npm packages stay external and resolve
 * from node_modules in the image, which keeps the bundle small and lets
 * dd-trace patch them: a dependency inlined into the bundle is never `import`ed
 * by name, so the loader hook never fires and the call is untraced with no
 * error anywhere (MONEY-1380).
 *
 * THE PLUGIN IS REQUIRED AND `noExternal` ALONE IS NOT ENOUGH. `noExternal`
 * only removes packages from tsup's AUTO-external list, which is built from
 * this package's DIRECT dependencies. A transitive dep of a bundled workspace
 * package is not on that list, so esbuild tries to bundle it. Measured here:
 * `@usemoney/datadog` -> `dd-trace` -> `@datadog/openfeature-node-server` ->
 * `@openfeature/server-sdk`, which is an OPTIONAL peer nobody installed, so the
 * build died with three `Could not resolve` errors — against a config whose
 * comment said npm packages were external. The same plugin, with the same
 * comment, is in `workers/tsup.config.ts` and `apps/api/tsup.config.ts`.
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
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: [/^@usemoney\//],
  esbuildPlugins: [externalizeNonWorkspace],
});
