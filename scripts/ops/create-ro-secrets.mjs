#!/usr/bin/env node
/**
 * Create MONGODB_URI_RO_PROD and ALGO_MONGODB_URI_RO_PROD from the EXISTING,
 * VERIFIED read-only `datadog_monitor` Atlas user.
 *
 * Verified 2026-09-14 against both clusters: authenticates, reads dbStats +
 * listCollections + $indexStats, and an attempted insert is refused
 * `Unauthorized`. Roles are clusterMonitor@admin + readAnyDatabase@admin.
 *
 * No credential is printed. Run:  node create-ro-secrets.mjs
 */
import { execFileSync } from "node:child_process";
const P = "stock-book-483718";
const sh = (a, input) => execFileSync("gcloud", [...a, `--project=${P}`],
  { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
// Returns null on ANY failure, which is fine here only because every caller
// treats null as fatal-for-that-target and the run exits non-zero if nothing
// was written. A `catch { return null }` that let the script report success is
// the exact anti-pattern `@usemoney/core/ops/gcp-secrets` was extracted to kill.
const sec = (n) => { try { return sh(["secrets", "versions", "access", "latest", `--secret=${n}`]); } catch { return null; } };

const pw = sec("DD_MONGO_MONITOR_PASSWORD_PROD");
if (!pw || /\n/.test(pw)) {
  console.error("REFUSING: DD_MONGO_MONITOR_PASSWORD_PROD is unreadable or contains a newline.");
  process.exit(1);
}

let written = 0;
let skipped = 0;
for (const [label, target, source, db] of [
  ["stockbook",   "MONGODB_URI_RO_PROD",      "DATABASE_URL_PROD",     "tradebook"],
  ["claude-algo", "ALGO_MONGODB_URI_RO_PROD", "ALGO_MONGODB_URI_PROD", "algo"],
]) {
  const src = sec(source);
  const m = src && src.match(/^(mongodb(?:\+srv)?:\/\/)(?:[^?]*@)?([A-Za-z0-9.\-:,]+)/);
  if (!m) { console.log(`${label}: cannot derive host from ${source} — SKIPPED`); skipped++; continue; }
  const uri = `${m[1]}${encodeURIComponent("datadog_monitor")}:${encodeURIComponent(pw)}@${m[2]}/${db}?authSource=admin&retryWrites=false`;

  let exists = true;
  try { sh(["secrets", "describe", target, "--format=value(name)"]); } catch { exists = false; }
  if (!exists) {
    sh(["secrets", "create", target, "--replication-policy=automatic", "--data-file=-"], uri);
    console.log(`${label}: CREATED ${target} with its first version`); written++;
  } else {
    sh(["secrets", "versions", "add", target, "--data-file=-"], uri);
    console.log(`${label}: ADDED a version to the existing (empty) ${target}`); written++;
  }
}
// A run that wrote NOTHING must not print a success footer and exit 0. Both
// targets can be skipped — an unreadable source secret, a host that will not
// parse — and the old shape reported that identically to a full success.
if (written === 0) {
  console.error(`\nNOTHING WAS WRITTEN (${skipped} target(s) skipped). The secrets are unchanged.`);
  process.exit(1);
}
if (skipped > 0) {
  console.error(`\nPARTIAL: ${written} written, ${skipped} skipped — the skipped target(s) are unchanged.`);
  process.exit(1);
}
console.log("\nVerify:  npx tsx scripts/ops/atlas-heatmap.ts     # no --allow-rw needed now");
