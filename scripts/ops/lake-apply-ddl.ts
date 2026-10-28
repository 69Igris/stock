/**
 * Apply the lake DDL. MONEY-1472 (data-platform B1).
 *
 * Reads `packages/lake/ddl/*.sql` in FILENAME ORDER, substitutes the dataset
 * for the target environment, and runs each statement.
 *
 * ## IDEMPOTENT BY CONSTRUCTION, NOT BY CHECKING
 *
 * Every statement is `CREATE TABLE IF NOT EXISTS`,
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, `ALTER TABLE ... ALTER COLUMN
 * ... SET OPTIONS(...)` (MONEY-1522 — the only way a live column's description
 * changes, since CREATE IF NOT EXISTS never touches an existing table), or a
 * `CREATE OR REPLACE VIEW` (005 — a view holds no rows, so replacing it with
 * itself is the no-op; MONEY-1602 changed its SELECT), so a
 * re-run is a no-op and a new column is a migration rather than a rewrite. The script does not read the
 * current schema and diff it: a differ has to decide what to do about a column
 * whose TYPE changed, and the only safe answer there is a human.
 *
 * ## FILENAME ORDER IS THE MIGRATION ORDER
 *
 * `001_`, `002_` … A later file may ALTER what an earlier one created, so the
 * sort is load-bearing. It is a plain lexicographic sort on the basename, which
 * is why the prefix is zero-padded.
 *
 * ## THE FILENAME ALSO CARRIES THE LAYER — MONEY-1496
 *
 * `002_silver_price_bars.sql` applies to `lake_silver_{env}`. The dataset used
 * to be hardcoded `lake_bronze_${env}`, which was correct while the ledger was
 * the only DDL and silently wrong the moment anything else existed: a silver
 * table would have been created in the BRONZE dataset, and `CREATE TABLE IF NOT
 * EXISTS` would then report success on every subsequent run because the table
 * it found was the one in the wrong place.
 *
 * The layer is read from the basename (`<nnn>_<layer>_<name>.sql`) and REFUSED
 * if it is not one of bronze/silver/gold/private — an unrecognised layer must
 * not fall back to a default, because the default is what caused this.
 *
 * ## Usage
 *
 *     npx tsx scripts/ops/lake-apply-ddl.ts --env qa            # dry run
 *     npx tsx scripts/ops/lake-apply-ddl.ts --env qa --apply
 *     npx tsx scripts/ops/lake-apply-ddl.ts --env prod --apply
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BigQuery } from "@google-cloud/bigquery";
import { LAKE_REGION } from "@usemoney/core/ops/lake-layout";
import { renderDdl, splitStatements } from "@usemoney/lake/ddl";

const GCP_PROJECT = "stock-book-483718";

/** `import.meta.dirname` is undefined under tsx's CJS output — the repo idiom. */
const HERE = dirname(fileURLToPath(import.meta.url));
const DDL_DIR = join(HERE, "..", "..", "packages", "lake", "ddl");

function parseArgs(): { env: "qa" | "prod"; apply: boolean } {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--env");
  const env = i >= 0 ? argv[i + 1] : undefined;
  if (env !== "qa" && env !== "prod") {
    throw new Error("--env must be qa or prod");
  }
  return { env, apply: argv.includes("--apply") };
}

/** The four layers a DDL file may target. Closed on purpose — see the header. */
const LAYERS = ["bronze", "silver", "gold", "private"] as const;
type Layer = (typeof LAYERS)[number];

/**
 * `002_silver_price_bars.sql` -> "silver".
 *
 * Throws on anything else. A DDL file whose layer cannot be read is a file
 * whose target dataset is a guess, and guessing here writes a table into the
 * wrong dataset where `IF NOT EXISTS` will then hide it for ever.
 */
export function layerOf(basename: string): Layer {
  const m = /^\d{3}_([a-z]+)_/.exec(basename);
  const found = m?.[1];
  if (!found || !(LAYERS as readonly string[]).includes(found)) {
    throw new Error(
      `cannot read a lake layer from ${JSON.stringify(basename)}: expected ` +
        `<nnn>_<layer>_<name>.sql with layer one of ${LAYERS.join(" | ")}. ` +
        `Refusing rather than defaulting — a default is how a silver table ` +
        `ends up created in the bronze dataset.`,
    );
  }
  return found as Layer;
}

async function main(): Promise<void> {
  const { env, apply } = parseArgs();

  const files = readdirSync(DDL_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`no .sql files in ${DDL_DIR}`);

  // Read every layer BEFORE running anything, so a malformed filename fails
  // the whole run rather than after half the statements have applied.
  const targets = files.map((f) => ({ file: f, layer: layerOf(f) }));

  console.log(`\nlake DDL — ${env} (${GCP_PROJECT})`);
  for (const { file, layer } of targets) {
    console.log(`  ${file}  ->  lake_${layer}_${env}`);
  }
  console.log("");

  // LOCATION IS REQUIRED. A BigQuery job runs in ONE location and defaults to
  // the US multi-region, while `setup-lake.sh` creates these datasets with
  // --location=asia-south1. Without it every statement fails with
  // "Not found: Dataset ... was not found in location US" — which reads as an
  // un-provisioned dataset rather than a wrong region, and sends the operator
  // to re-run the provisioning script that already worked.
  const bq = apply
    ? new BigQuery({ projectId: GCP_PROJECT, location: LAKE_REGION })
    : null;
  let statements = 0;

  for (const { file, layer } of targets) {
    const dataset = `lake_${layer}_${env}`;
    const raw = readFileSync(join(DDL_DIR, file), "utf8");
    // `{{DATASET}}` is the file's OWN layer; the four named keys let a gold
    // projection spell its silver source without hardcoding an env into SQL.
    const parts = splitStatements(
      renderDdl(raw, {
        DATASET: dataset,
        BRONZE: `lake_bronze_${env}`,
        SILVER: `lake_silver_${env}`,
        GOLD: `lake_gold_${env}`,
        PRIVATE: `lake_private_${env}`,
      }),
    );
    console.log(`── ${file} -> ${dataset} — ${parts.length} statement(s)`);

    for (const stmt of parts) {
      statements++;
      const head = stmt.split("\n")[0]?.slice(0, 78) ?? "";
      if (!bq) {
        console.log(`   DRY-RUN  ${head}`);
        continue;
      }
      await bq.query({ query: stmt });
      console.log(`   applied  ${head}`);
    }
  }

  const datasets = [...new Set(targets.map((t) => `lake_${t.layer}_${env}`))];
  console.log(
    apply
      ? `\nApplied ${statements} statement(s) across ${datasets.join(", ")}.`
      : `\nDRY RUN — ${statements} statement(s) would run. Re-run with --apply.`,
  );
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
