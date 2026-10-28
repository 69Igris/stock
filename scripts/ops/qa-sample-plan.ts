/**
 * CLI for the QA sample plan. The logic lives in
 * `@usemoney/core/ops/qa-sample-plan`; this file is only the entry point.
 *
 *   npx tsx scripts/ops/qa-sample-plan.ts --emit [--years=N] [--manifest=PATH]
 *
 * Consumed by `sync-prod-to-qa.sh --tier=sample`.
 */
import {
  SAMPLE_PLAN,
  buildQuery,
  assertPlanIsDeliberate,
  capUniverse,
  type SampleUniverse,
  type SampleWindow,
} from "@usemoney/core/ops/qa-sample-plan";

// // Emits one "collection<TAB>queryJSON" line per collection for
// sync-prod-to-qa.sh to consume. TSV rather than JSON because the consumer is
// bash: `jq` is not guaranteed on every machine that runs the sync, and a
// Mongo query object never contains a tab.
// ---------------------------------------------------------------------------

interface ManifestList {
  method: string;
  source: string;
  symbols: string[];
}
interface Manifest {
  version?: number;
  generatedAt?: string;
  us?: {
    equities?: ManifestList;
    etfs?: ManifestList;
    delisted?: ManifestList;
    funds?: ManifestList;
  };
  in?: { equities?: ManifestList; etfs?: ManifestList; schemes?: ManifestList };
  isins?: string[];
  schemeCodes?: string[];
}

/** Flatten whatever lists the manifest carries into the four vectors the plan needs. */
export function universeFromManifest(m: Manifest): SampleUniverse {
  const pick = (l?: ManifestList): string[] =>
    Array.isArray(l?.symbols) ? l.symbols : [];
  return {
    usSymbols: [
      ...new Set([
        ...pick(m.us?.equities),
        ...pick(m.us?.etfs),
        ...pick(m.us?.delisted),
      ]),
    ],
    // Separate vector, NOT folded into usSymbols: `us_fund_nav`'s writer
    // selects `assetType === "Mutual Fund"`, and the equity manifest holds no
    // fund, so a merged list would sample that table against symbols it can
    // never match — zero rows, guard skips, run reports success.
    usFundSymbols: [...new Set(pick(m.us?.funds))],
    inSymbols: [...new Set([...pick(m.in?.equities), ...pick(m.in?.etfs)])],
    isins: [...new Set(m.isins ?? [])],
    schemeCodes: [...new Set(m.schemeCodes ?? pick(m.in?.schemes))],
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.includes("--emit")) {
    console.error(
      "usage: qa-sample-plan.ts --emit [--years=N] [--universe=N] [--manifest=PATH]",
    );
    process.exit(2);
  }
  const arg = (k: string): string | undefined =>
    argv
      .find((a) => a.startsWith(`--${k}=`))
      ?.split("=")
      .slice(1)
      .join("=");

  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = arg("manifest") ?? join(here, "qa-sample-universe.json");

  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (e) {
    // FAIL LOUD. A missing manifest must never degrade to "sample everything"
    // or to an empty plan - the first silently copies 12.75M rows, the second
    // silently drops QA tables. Both look like a successful run.
    console.error(`FATAL: cannot read the sample manifest at ${manifestPath}`);
    console.error(`  ${(e as Error).message}`);
    // `--env=prod` is NOT optional here, and omitting it was the whole bug in
    // this hint: with no `--env` the generator falls back to whatever the local
    // `.env` holds, which in this repo is QA — and a manifest built from QA's
    // 1.07M-row `daily_prices` instead of prod's 10.66M would be a different,
    // smaller, silently wrong universe.
    console.error(
      `  Generate it: node --import tsx scripts/ops/build-qa-sample-universe.ts --env=prod --apply`,
    );
    process.exit(1);
    return;
  }

  const capRaw = Number(arg("universe") ?? 0);
  const universe = capUniverse(universeFromManifest(manifest), capRaw);
  const problems = assertPlanIsDeliberate(SAMPLE_PLAN, universe);
  if (problems.length > 0) {
    console.error(
      "FATAL: the sample plan would copy nothing for these collections:",
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
    return;
  }

  const win: SampleWindow = {
    years: Number(arg("years") ?? 2) || 2,
    now: new Date(),
  };
  for (const d of SAMPLE_PLAN) {
    process.stdout.write(
      d.collection + "\t" + JSON.stringify(buildQuery(d, universe, win)) + "\n",
    );
  }
}

// Run only when invoked directly, never on import - the test imports this file.
const invoked = process.argv[1] ?? "";
if (invoked.endsWith("qa-sample-plan.ts")) {
  void main();
}
