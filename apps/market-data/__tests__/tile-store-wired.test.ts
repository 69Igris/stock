/**
 * The SERVICE must register a tile store on its real boot path. MONEY-1467.
 *
 * This exists because `history.test.ts` could not catch its absence. That file
 * calls `setTileStore(fakeStore(...))` itself, so it passed green against a
 * service that, in production, had no store at all — every request taking the
 * empty-bars path and answering `{s:"no_data"}`, which renders as a blank chart
 * with no error and is indistinguishable from a delisted instrument.
 *
 * A test that supplies the very dependency production is missing cannot see
 * that production is missing it. So this one asserts the WIRING, on the module
 * that actually boots, and never registers anything of its own.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lakeBucketName } from "../src/tile-store-init";

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

test("createApp() registers the tile store", () => {
  const app = read("app.ts");
  assert.match(
    app,
    /import \{ initTileStore \} from "\.\/tile-store-init"/,
    "app.ts does not import the store initialiser",
  );
  assert.match(
    app,
    /\n\s*initTileStore\(\);/,
    "app.ts imports initTileStore but never CALLS it — /udf/history would answer " +
      "no_data for every symbol, in production, with no error anywhere",
  );
});

test("the initialiser resolves the LAKE bucket, not the content bucket", () => {
  // `tiles/` routes to the lake bucket. Reading the content bucket would 404
  // every key and report the lake as empty — which looks exactly like "the
  // nightly build has not run yet".
  assert.equal(lakeBucketName("production"), "stockbook-lake-prod");
  assert.equal(lakeBucketName("prod"), "stockbook-lake-prod");
  assert.equal(lakeBucketName("qa"), "stockbook-lake-qa");
});

test("an unrecognised environment resolves to NOTHING, loudly", () => {
  // Returning a default bucket here would read one environment's tiles from
  // another's, which is worse than serving none.
  assert.equal(lakeBucketName(""), null);
  assert.equal(lakeBucketName(undefined), null);
  assert.equal(lakeBucketName("staging"), null);
});

test("the service's store is READ-ONLY", () => {
  // A request path that can write to the lake is a request path that can
  // corrupt it, and nothing in this service has any reason to.
  const src = read("tile-store-init.ts");
  assert.match(src, /async put\(\): Promise<void> \{\s*throw new Error\(/);
});

test("both specs give the service GCP_PROJECT_ID", () => {
  // `getStorageClient()` THROWS without it, and the tile reader reports that
  // as "tile store unavailable" for every symbol — a fully-registered store
  // that can never read. Found by curling a real chart AFTER the boot log said
  // "tile store enabled": registered and credentialed are different states,
  // and only the second one looks like a working deploy from the inside.
  //
  // Deliberately NOT GCP_SERVICE_ACCOUNT_KEY_BASE64: credentials fall through
  // to ADC, which resolves the attached SA on Cloud Run, and that SA already
  // holds objectViewer on the lake bucket.
  const specs = join(import.meta.dirname, "..");
  for (const spec of ["cloudbuild.qa.yaml", "cloudbuild.prod.yaml"]) {
    const src = readFileSync(join(specs, spec), "utf8");
    assert.match(
      src,
      /name:\s*GCP_PROJECT_ID\s*\n\s*value:\s*"stock-book-483718"/,
      `${spec} does not set GCP_PROJECT_ID — the tile store would register and then fail every read`,
    );
  }
});
