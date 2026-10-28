/**
 * AMC disclosure registry — coverage against AMFI's own list (MONEY-1405 D2)
 * ==========================================================================
 *
 * Reads AMFI's portfolio-disclosure page, prints every AMC it lists with the
 * monthly-disclosure URL AMFI publishes and what that URL actually answers, and
 * diffs the whole industry against `amc-portfolio-sources.ts` +
 * `amc-page-scrape.ts`.
 *
 * It reads. It writes NOTHING — no Prisma, no DB, no files, and no archive:
 * `setFeedArchiveStore` is never called here, so `getFeedAsset` degrades to
 * passthrough and this run can neither write to a bucket nor replay from one.
 * That is the right posture for a discovery command. It also means `--env` is a
 * LABEL on the report, not a switch — see its entry below.
 *
 * ## The question it exists to answer
 *
 * `AMC_SOURCES` can only ever say "how many did we write down", which is a
 * statement about our effort. `resolverCoverage` joins it to AMFI's 57-AMC
 * registry on `amfiMfId` and NAMES the remainder instead of leaving it an
 * unquantified gap — "we cover 3" and "we cover 3 of 57" are very different
 * reports, and only the second is actionable. That function has existed and
 * been unit-tested since MONEY-1105; it had no way to run against the live
 * registry until this script, because nothing fetched the page.
 *
 * ## A registry URL is NOT a source entry, and this script never promotes one
 *
 * 52 of the 57 AMCs publish a monthly link. Measured 2026-08-14, exactly ONE of
 * those links is a portfolio file; the other 51 are landing pages a resolver
 * has to read. So the diff below is TRIAGE — "these AMCs have a published
 * starting point and no resolver" — never a to-do list of URLs to paste into
 * `AMC_SOURCES`. A guessed template 404s identically to "not published yet",
 * which is why `provenance` exists and why it is only ever set by a human who
 * fetched the current month and opened the file.
 *
 * The probe's HTTP status is part of the same triage and carries the same
 * caveat in the other direction: **200 does not mean "a portfolio file"**. NJ
 * and IL&FS both answer 200 with 137 KB and 716 KB of HTML from a `.php`
 * handler. A green column here means "AMFI's link resolves", nothing more.
 *
 * ## Usage
 *
 *   npx tsx scripts/data/amc-disclosure-registry.ts --env prod
 *   npx tsx scripts/data/amc-disclosure-registry.ts --env qa --no-probe
 *   npx tsx scripts/data/amc-disclosure-registry.ts --env prod --json
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import dotenv from "dotenv";

/**
 * Resolved from THIS FILE, never from the cwd — a run from a worktree must read
 * the same `.env` as one from the repo root. `dotenv.config` does not override
 * an already-exported variable, which is the behaviour to keep.
 *
 * `quiet` because `--json` writes the machine-readable report to stdout and
 * dotenv v17 otherwise prefixes it with an injection banner.
 */
dotenv.config({
  path: path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ".env",
  ),
  quiet: true,
});

/**
 * Static, not a post-dotenv dynamic import. `feed-archive.ts` reads its mode
 * PER CALL and holds no module-scope env, so import order cannot capture a
 * stale value here — the hazard that forces the dynamic form in the scripts
 * that construct a Prisma client at import.
 */
import {
  fetchAmfiAmcRegistry,
  AmfiAmcRegistryError,
  classifyMonthlyLink,
  resolverCoverage,
  scrapableAmcs,
  AMC_SOURCES,
  type AmfiAmcRecord,
} from "@usemoney/core/market-data";

// ─── CLI ─────────────────────────────────────────────────────────────

const USAGE = `amc-disclosure-registry — AMC coverage vs AMFI's own registry (MONEY-1405)

  --env <qa|prod>   REQUIRED, and a LABEL only. This script registers no
                    archive store, so it never reads or writes a bucket in
                    either environment. It is required because the report is
                    evidence pasted into a ticket, and ~53 outbound requests
                    leave from whichever egress ran it — which of the two that
                    was belongs in the output, not in the operator's memory.
  --no-probe        Skip the per-AMC HTTP probe; print the registry + diff only.
  --json            Machine-readable report on stdout.
  --help

Both argv forms are accepted (\`--env prod\` and \`--env=prod\`); anything
unparseable is a hard error rather than a fallback to a default.`;

function readArg(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq !== undefined) return eq.slice(`--${name}=`.length);
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return undefined;
  const next = argv[at + 1];
  // A bare `--env` followed by another flag is a typo, not an empty value.
  return next === undefined || next.startsWith("--") ? "" : next;
}

const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const ENV = readArg(argv, "env");
if (ENV !== "qa" && ENV !== "prod") {
  console.error(
    `--env must be "qa" or "prod" (got ${ENV === undefined ? "nothing" : `"${ENV}"`}).\n\n${USAGE}`,
  );
  process.exit(2);
}

const PROBE = !argv.includes("--no-probe");
const JSON_OUT = argv.includes("--json");

/** One request per second, globally. 52 AMCs is ~1 minute and no host sees two. */
const PROBE_INTERVAL_MS = 1_000;
/** Generous: these are AMC CDNs, not an exchange, and we ask each once. */
const PROBE_TIMEOUT_MS = 20_000;

interface ProbeResult {
  status: number | null;
  bytes: number | null;
  contentType: string | null;
  error: string | null;
}

/**
 * GET, not HEAD.
 *
 * Several of these hosts answer HEAD with 405 or with a status that disagrees
 * with the GET — and the byte count is half the signal anyway, because a 200
 * carrying 700 KB of HTML from a `.php` handler is the outcome this report has
 * to be able to show. The body is read and discarded; nothing is stored.
 */
async function probe(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "*/*",
      },
    });
    const body = await res.arrayBuffer();
    return {
      status: res.status,
      bytes: body.byteLength,
      contentType: res.headers.get("content-type"),
      error: null,
    };
  } catch (error: unknown) {
    return {
      status: null,
      bytes: null,
      contentType: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─── run ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!JSON_OUT) {
    console.log(`\n=== AMC disclosure registry (${ENV}) ===\n`);
    console.log(
      "feed archive: passthrough (this script registers no store, so nothing " +
        "is archived or replayed)\n",
    );
  }

  let registry;
  try {
    registry = await fetchAmfiAmcRegistry();
  } catch (error: unknown) {
    // The distinct error type is the point: "AMFI moved the page" must not be
    // reported as "AMFI lists no AMCs", which is the shape that let the NAV
    // feed report success for 26 nights.
    const moved = error instanceof AmfiAmcRegistryError;
    console.error(
      `${moved ? "REGISTRY UNREADABLE" : "FETCH FAILED"}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  const amcs = registry.amcs;
  const withMonthly = amcs.filter((a) => a.monthlyPortfolioUrl !== null);

  const scrapedMfIds = scrapableAmcs().map((s) => s.amfiMfId);
  const coverage = resolverCoverage(amcs, scrapedMfIds);

  // "Has a published starting point and no resolver" — the actionable slice.
  const resolvedNames = new Set([
    ...coverage.resolved,
    ...coverage.knownButNotFetchable,
  ]);
  const triage = withMonthly.filter((a) => !resolvedNames.has(a.fundName));

  const probes = new Map<string, ProbeResult>();
  if (PROBE) {
    if (!JSON_OUT) {
      console.log(
        `probing ${withMonthly.length} monthly URLs at 1/s (~${Math.ceil(
          withMonthly.length / 60,
        )} min)…\n`,
      );
    }
    for (const [i, amc] of withMonthly.entries()) {
      if (i > 0) await sleep(PROBE_INTERVAL_MS);
      probes.set(amc.mfId, await probe(amc.monthlyPortfolioUrl!));
    }
  }

  const describe = (a: AmfiAmcRecord): string => {
    const p = probes.get(a.mfId);
    if (p === undefined) return "not probed";
    if (p.error !== null) return `ERR ${p.error}`;
    const kb = p.bytes === null ? "?" : `${Math.round(p.bytes / 1024)}KB`;
    return `${p.status} ${kb} ${p.contentType ?? "(no content-type)"}`;
  };

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          env: ENV,
          total: amcs.length,
          withMonthlyLink: withMonthly.length,
          coverage,
          amcs: amcs.map((a) => ({
            mfId: a.mfId,
            fundName: a.fundName,
            monthlyPortfolioUrl: a.monthlyPortfolioUrl,
            linkKind: classifyMonthlyLink(a),
            probe: probes.get(a.mfId) ?? null,
          })),
          triage: triage.map((a) => a.fundName),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`AMFI lists ${amcs.length} AMCs; ${withMonthly.length} publish a monthly link.\n`);
  for (const a of amcs) {
    const url = a.monthlyPortfolioUrl;
    const kind = classifyMonthlyLink(a);
    console.log(`  [${a.mfId.padStart(3)}] ${a.fundName}`);
    console.log(`        ${kind.padEnd(4)}  ${url ?? "(AMFI publishes none)"}`);
    if (url !== null) console.log(`        ->    ${describe(a)}`);
  }

  console.log(`\n--- coverage against ${coverage.total} registry AMCs ---`);
  console.log(
    `  resolved (fetchable)      ${coverage.resolved.length}: ${coverage.resolved.join(", ") || "-"}`,
  );
  console.log(
    `  known but NOT fetchable   ${coverage.knownButNotFetchable.length}: ${
      coverage.knownButNotFetchable.join(", ") || "-"
    }`,
  );
  console.log(`  no source entry at all    ${coverage.missing.length}`);
  console.log(
    `\n  AMC_SOURCES rows ${AMC_SOURCES.length} + page scrapers ${scrapedMfIds.length}`,
  );

  console.log(
    `\n--- TRIAGE: ${triage.length} AMCs with a published monthly link and no resolver ---`,
  );
  console.log(
    `  (a published link is a STARTING POINT, not a URL to paste into ` +
      `AMC_SOURCES —\n   51 of 52 are landing pages, and provenance is only ` +
      `ever set by a human who\n   fetched the current month and opened the file.)\n`,
  );
  for (const a of triage) {
    console.log(`  ${a.fundName}  [${classifyMonthlyLink(a)}]  ${describe(a)}`);
    console.log(`      ${a.monthlyPortfolioUrl}`);
  }
  console.log("");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `amc-disclosure-registry failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  });
}
