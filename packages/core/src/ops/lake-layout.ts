/**
 * Which bucket does a GCS prefix belong to? — the lake contract, as code.
 *
 * The human contract is `docs/reference/lake-layout.md`; this is the one
 * decision in it that code has to make at run time.
 *
 * ## Why this exists while there is only one region
 *
 * Today every prefix resolves to a bucket in `asia-south1`, so this function
 * looks like indirection with nothing behind it. That is exactly the point.
 * Region was decided 14-Sep-2026 as SINGLE (`asia-south1`, plan v2.3 §2), and
 * the escape hatch in the contract is that a US footprint later must be an
 * ADDITION rather than a redesign:
 *
 *   1. a new bucket,
 *   2. a config entry here,
 *   3. a BigQuery dataset copy for the few tables both regions need.
 *
 * A seam that exists costs one function call. A seam that does not exist costs
 * a search for every `stockbook-content-` literal in the repo, and the one that
 * is missed is the one that silently writes to the wrong continent.
 *
 * ## Two buckets, split by LIFETIME rather than by market
 *
 *   `stockbook-content-{env}`  raw bytes, unchanged. Feeds, EDGAR filings,
 *                              Databento vendor files, candle cold shards,
 *                              stock documents. `databento/` is bought once and
 *                              its lifecycle has no Delete rule at all.
 *   `stockbook-lake-{env}`     what the lake PRODUCES. Staged files, tiles,
 *                              releases, rollback pointers — disposable, with
 *                              delete rules measured in days.
 *
 * Splitting by market instead would put `edgar/` and `candles/US/` in one place
 * and `feeds/` in another, which is a boundary nothing in the pipeline observes.
 *
 * ## UNKNOWN IS A REFUSAL, NOT A DEFAULT
 *
 * An unrecognised prefix THROWS. The tempting alternative — fall back to the
 * content bucket — is how a new prefix silently lands in the wrong place and is
 * found months later by a bill, which is the shape this repo keeps paying for:
 * a value that looks answered because the code had an answer ready.
 */

/** The two buckets, before the environment suffix. */
export const CONTENT_BUCKET_BASE = "stockbook-content";
export const LAKE_BUCKET_BASE = "stockbook-lake";

/** Every bucket this repo writes to lives here. See the contract, §2. */
export const LAKE_REGION = "asia-south1";

export type LakeEnv = "qa" | "prod";

/**
 * The four BigQuery datasets, before the environment suffix. MONEY-1472 (B1).
 *
 * ## WHY THIS IS HERE AND NOT A THIRD SPELLING
 *
 * These names already existed TWICE — a bash array in `setup-lake.sh` and a
 * table in `lake-layout.md` — held in agreement by
 * `lake-infra-coverage.test.ts`. B1 needs them from TYPESCRIPT, at runtime, on
 * every ledger write, and declaring them in `packages/lake` would have made a
 * third copy that the existing test cannot see. That is the one-fact-many-
 * spellings defect this repo has paid for repeatedly; the test now holds all
 * THREE in agreement instead.
 *
 * ORDER IS THE CONTRACT'S ORDER, and the test compares sorted sets in both
 * directions, so a rename in any one place fails rather than drifts.
 */
export const LAKE_DATASETS = [
  "lake_bronze",
  "lake_silver",
  "lake_gold",
  "lake_private",
] as const;

export type LakeLayer = (typeof LAKE_DATASETS)[number];

/**
 * The fully-qualified dataset id for one layer in one environment.
 *
 * Market is a COLUMN, never a second dataset — the region rule settled that on
 * 14-Sep, and a `lake_silver_us` created "just for now" is how a single-region
 * plane quietly becomes two.
 */
export function datasetFor(layer: LakeLayer, env: LakeEnv): string {
  return `${layer}_${env}`;
}

/**
 * Top-level prefixes that belong to the LAKE bucket.
 *
 * Listed rather than inferred: "anything the lake wrote" is not a property a
 * key carries, and a rule like "not one of the raw ones" makes every new raw
 * prefix silently a lake prefix.
 */
export const LAKE_PREFIXES = [
  "lake/stage/",
  "tiles/",
  "releases/",
  "rollback/",
] as const;

/**
 * Top-level prefixes that belong to the CONTENT bucket — the raw side.
 *
 * MEASURED IN BOTH BUCKETS, 2026-09-15, which the first version was not:
 *
 *   prod  candles/ databento/ edgar/ feeds/ stocks/
 *   qa    content/ documents/ feeds/ stocks/
 *
 * The first list came from `gcs-prefix-sizes` against PROD and its comment
 * claimed it was "the live bucket … and nothing else". QA holds `content/`
 * (learning content, written by `apps/content/.../upload-logic.ts`) and
 * `documents/`, neither of which is in prod's top level — so the union is the
 * only correct list, and because an unknown prefix REFUSES rather than
 * defaulting, the first caller routing a learning-content key would have thrown.
 *
 * ## AND MEASURING OBJECTS CANNOT FIND A WRITER THAT HAS NOT RUN
 *
 * `studio/` was still missing after both buckets were listed, because
 * `workers/src/processors/studio-render.ts:107` uploads to
 * `studio/videos/{userId}` and no video had been rendered in either
 * environment yet. A prefix with no objects is invisible to a bucket listing
 * and perfectly reachable by the next job that runs.
 *
 * So the list is derived from the WRITERS as well as the objects. `folder:`
 * has exactly two roots repo-wide — `content/` and `studio/` — and the first
 * pass caught one of them. Anything added here should be checked against
 * `grep -rn "folder:" ` and the uploaders in `@usemoney/storage`, not only
 * against `gcloud storage ls`.
 *
 * Measuring one environment and generalising is the same mistake in miniature
 * that this repo has paid for repeatedly; the fix is to name both, and then to
 * ask what writes rather than only what exists.
 */
export const CONTENT_PREFIXES = [
  "feeds/",
  "edgar/",
  "databento/",
  "candles/",
  "stocks/",
  "content/",
  "documents/",
  "studio/",
] as const;

export class UnknownPrefixError extends Error {
  constructor(key: string) {
    super(
      `bucketForPrefix: no bucket is declared for "${key}". Add it to LAKE_PREFIXES or ` +
        `CONTENT_PREFIXES in packages/core/src/ops/lake-layout.ts and to ` +
        `docs/reference/lake-layout.md §1 — refusing rather than guessing, because a ` +
        `guessed bucket is found by a bill months later.`,
    );
    this.name = "UnknownPrefixError";
  }
}

/**
 * The bucket a GCS object key belongs in.
 *
 * Takes a KEY, not a prefix name, so callers pass what they already have and no
 * caller has to know how deep the deciding segment is. Matching is on a path
 * boundary: `candles/` must not claim a hypothetical `candlesticks/…`.
 *
 * @throws {UnknownPrefixError} when no declared prefix matches.
 */
export function bucketForPrefix(key: string, env: LakeEnv): string {
  // `env` is REFUSED too, not merely typed. The type vanishes at run time, and
  // `NODE_ENV` / `APP_ENV` in this repo carry `development`, `staging` and
  // `test` — any of which would yield a well-formed bucket name like
  // `stockbook-lake-development` that never throws here and fails at the GCS
  // call as a 404, reading like a missing object rather than a wrong
  // environment. Same ethos as the prefix side: unknown is a refusal.
  if (env !== "qa" && env !== "prod") {
    throw new UnknownPrefixError(
      `environment "${String(env)}" is not qa|prod (asked about key "${key}")`,
    );
  }
  const k = key.replace(/^\/+/, "");

  for (const p of LAKE_PREFIXES) {
    if (matches(k, p)) return `${LAKE_BUCKET_BASE}-${env}`;
  }
  for (const p of CONTENT_PREFIXES) {
    if (matches(k, p)) return `${CONTENT_BUCKET_BASE}-${env}`;
  }
  throw new UnknownPrefixError(key);
}

/**
 * Does `key` sit under `prefix`?
 *
 * `prefix` always ends in `/`, so a plain `startsWith` is already a path-
 * boundary test — `"candlesticks/x".startsWith("candles/")` is false. The bare
 * form (the prefix itself, no trailing key) is accepted too, so `bucketForPrefix`
 * can be asked about a directory as well as an object.
 */
function matches(key: string, prefix: string): boolean {
  return key.startsWith(prefix) || key === prefix.replace(/\/$/, "");
}

/** Every prefix the contract declares, lake first. For exhaustiveness tests. */
export function declaredPrefixes(): string[] {
  return [...LAKE_PREFIXES, ...CONTENT_PREFIXES];
}
