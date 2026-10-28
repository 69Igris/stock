/**
 * lake-smoke.ts — prove the lake writer can actually run a BigQuery job, in the
 * right region, for a known cost. READ-ONLY (`SELECT 1` reads no table).
 *
 *   npx tsx scripts/ops/lake-smoke.ts qa
 *   npx tsx scripts/ops/lake-smoke.ts prod
 *
 * ## IT RUNS AS THE SERVICE ACCOUNT, WHICH IS THE ENTIRE POINT
 *
 * Authenticating as the operator would prove that the OPERATOR can query
 * BigQuery, which was true before `setup-lake.sh` ran and will be true if every
 * grant it made is wrong. The only thing worth checking is whether
 * `lake-writer-{env}@` can run a job, so the token is minted by impersonating
 * it. A service account nobody can act as is one whose grants stay unverified
 * until the first real pipeline fails at 2am.
 *
 * ## IT ASSERTS THE JOB'S LOCATION, NOT JUST ITS SUCCESS
 *
 * The one-region decision (`asia-south1`, plan v2.3 §2) is only real if jobs
 * actually run there. BigQuery will happily run `SELECT 1` in the US — it reads
 * no dataset, so nothing forces a location — and a green smoke test that ran in
 * the wrong region would certify exactly the thing it exists to check. So the
 * request pins the location and the response's `jobReference.location` is
 * asserted against it.
 *
 * ## WHY REST RATHER THAN THE `bq` CLI
 *
 * `bq` 2.1.27 has no `--impersonate_service_account` flag, and its output would
 * have to be parsed back out of a human-readable table. The REST response
 * carries `jobReference.location` and `totalBytesBilled` as fields. No new
 * dependency either: `gcloud` mints the token, `fetch` makes the call.
 */
import { execFileSync } from "node:child_process";

const PROJECT_ID = "stock-book-483718";
const LOCATION = "asia-south1";

// REQUIRED, never defaulted. PRODUCTION-CHECKLIST.md runs this as the proof
// step for PROD; a dropped argument would print "OK — lake-writer-qa@ can run
// jobs in asia-south1" and read as a green prod verification.
const env = process.argv[2];
if (env !== "qa" && env !== "prod") {
  console.error(
    `Usage: npx tsx scripts/ops/lake-smoke.ts {qa|prod}  (got ${env === undefined ? "no argument" : `"${env}"`})\n` +
      "  The environment is required: defaulting would let a dropped argument certify prod with a QA run.",
  );
  process.exit(1);
}

const writer = `lake-writer-${env}@${PROJECT_ID}.iam.gserviceaccount.com`;

function accessTokenAs(serviceAccount: string): string {
  try {
    return execFileSync(
      "gcloud",
      ["auth", "print-access-token", `--impersonate-service-account=${serviceAccount}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    // A denial here is a MISSING GRANT, not a broken script, and the remedy is
    // one command — so print it rather than a stack trace.
    if (/PERMISSION_DENIED|iam\.serviceAccounts\.getAccessToken/.test(stderr)) {
      console.error(
        `[lake-smoke] cannot impersonate ${serviceAccount}.\n` +
          `  The operator needs roles/iam.serviceAccountTokenCreator ON THAT SA:\n\n` +
          `    gcloud iam service-accounts add-iam-policy-binding ${serviceAccount} \\\n` +
          `      --project=${PROJECT_ID} --member="user:$(gcloud config get-value account)" \\\n` +
          `      --role=roles/iam.serviceAccountTokenCreator\n\n` +
          `  ./scripts/ops/setup-lake.sh ${env} grants this; re-run it if the SA predates that step.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  console.log(`[lake-smoke] impersonating ${writer}`);
  const token = accessTokenAs(writer);

  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/queries`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "SELECT 1 AS ok",
        useLegacySql: false,
        // PINNED. Without it BigQuery picks a location for a query that reads
        // no dataset, and the smoke test would pass having proved nothing about
        // the region this whole plan turns on.
        location: LOCATION,
      }),
    },
  );

  // TEXT first, then parse. A 502 HTML page from the Google front end, or an
  // auth-challenge page, makes `res.json()` throw a SyntaxError that lands in
  // the outer catch — printing a JSON parse error and never the HTTP status,
  // which is the one diagnostic that matters when the checklist runs this as
  // the prod proof step.
  const raw = await res.text();
  let body: {
    error?: { message?: string };
    jobComplete?: boolean;
    jobReference?: { jobId?: string; location?: string };
    totalBytesBilled?: string;
    totalBytesProcessed?: string;
    rows?: Array<{ f: Array<{ v: string }> }>;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    console.error(
      `[lake-smoke] FAILED ${res.status} ${res.statusText} — the response was not JSON:\n` +
        raw.slice(0, 300),
    );
    process.exit(1);
  }

  if (!res.ok || body.error) {
    console.error(`[lake-smoke] FAILED ${res.status}: ${body.error?.message ?? "(no message)"}`);
    process.exit(1);
  }

  const jobLocation = body.jobReference?.location ?? "(absent)";
  const billed = body.totalBytesBilled ?? "(absent)";
  const value = body.rows?.[0]?.f?.[0]?.v ?? "(no rows)";

  console.log(`[lake-smoke] job          ${body.jobReference?.jobId ?? "(absent)"}`);
  console.log(`[lake-smoke] location     ${jobLocation}`);
  console.log(`[lake-smoke] bytesBilled  ${billed}`);
  console.log(`[lake-smoke] result       SELECT 1 -> ${value}`);

  if (jobLocation !== LOCATION) {
    console.error(
      `[lake-smoke] WRONG REGION: job ran in ${jobLocation}, expected ${LOCATION}. ` +
        `The single-region decision is only real if jobs actually run there.`,
    );
    process.exit(1);
  }
  if (body.jobComplete !== true || value !== "1") {
    console.error("[lake-smoke] the query did not complete with the expected result.");
    process.exit(1);
  }

  console.log(`[lake-smoke] OK — ${writer} can run jobs in ${LOCATION}`);
}

main().catch((err) => {
  console.error("[lake-smoke]", err);
  process.exit(1);
});
