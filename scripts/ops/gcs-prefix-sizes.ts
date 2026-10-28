/**
 * gcs-prefix-sizes.ts — what each Mumbai prefix weighs before the US move.
 * READ-ONLY.
 *
 * Data-platform S0c. Emits `docs/reference/us-prefix-sizes-{YYYY-MM}.md`.
 *
 * ## THE MOVE THIS SIZED WAS CANCELLED, AND THAT IS WHY THE FILE STAYS
 *
 * Commissioned to price moving the US prefixes to a `us-east4` bucket (D6).
 * The measurement landed on 14-Sep-2026 and the region split was cancelled the
 * same evening: plan v2.3 locks SINGLE REGION, asia-south1, and removes D6.
 *
 * The script is NOT deleted and its cost columns are NOT stripped, because the
 * numbers are what the decision rests on — plan v2.3 §1 cites this document by
 * name for "553 GiB in scope, `edgar/filings` 490 GiB LEAVE, 63 GiB MOVE,
 * bucket total 977 GiB" and concludes "cost was never the issue". A record that
 * dropped the costs would leave that conclusion unevidenced, and the `MOVE` /
 * `LEAVE-HISTORY` column is the thing the plan quotes. What makes the document
 * honest is the banner saying the move is off, not the removal of its
 * arithmetic.
 *
 * It also remains the only inventory of this bucket, which is a live concern in
 * one region too: 1.4M objects, 977 GiB, and lifecycle rules covering four
 * prefixes out of the five that hold data.
 *
 * Usage:
 *   npx tsx scripts/ops/gcs-prefix-sizes.ts \
 *     --transfer-usd-per-gib=0.08 \
 *     --rate-source="https://cloud.google.com/storage/pricing — Data transfer within Google Cloud, Asia→North America, read 2026-09-15"
 *
 *   npx tsx scripts/ops/gcs-prefix-sizes.ts        # sizes only; cost cells blank
 *
 * ~10 minutes for a full pass: 1.4M objects at 1,000 per page.
 *
 * ## A LISTING IS THE RIGHT TOOL HERE, AND ONLY HERE
 *
 * The standing rule in this repo is that `listFiles` must never decide
 * anything: it fails open to `[]`, so an empty result is indistinguishable from
 * an outage, and `databento-inventory.ts` is forbidden from calling it — a
 * missing-file verdict there rests on the ledger's own `archiveKey` and a `get`.
 *
 * This script is the documented exception, because the OUTPUT IS A SIZE REPORT
 * AND NOT A DECISION ABOUT PRESENCE. "How many bytes are under `edgar/`" has no
 * answer other than enumerating them; there is no ledger of every object and
 * `du -s` is itself a listing. The exception is bounded two ways:
 *
 *   1. it uses `streamObjectSummaries`, which THROWS rather than failing open,
 *      so a truncated listing kills the run instead of rendering as a smaller
 *      prefix — and a smaller prefix reads as a smaller bill and a MOVE
 *      recommendation for data that should have stayed;
 *   2. nothing here concludes that any particular object is absent. Presence
 *      questions stay with the ledger.
 *
 * ## ONE PASS OVER THE BUCKET, NOT ONE PER PREFIX
 *
 * Every configured root is grouped out of a SINGLE walk of the whole bucket.
 * That is cheaper than five listings, and it makes the bucket total a measured
 * denominator rather than a sum of the parts we happened to look at — so a key
 * that matches no root is still counted, under `(other)`.
 *
 * ## THE RATE IS NEVER IN THE CODE
 *
 * No transfer price appears in this file or in
 * `@usemoney/core/ops/gcs-prefix-sizes`. It is supplied per run and recorded in
 * the document with the page it was read from and the date. A test asserts no
 * price literal creeps in.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgsOrExit } from "@usemoney/core/ops/cli-args";
import { GCP_PROJECT_ID, secret } from "@usemoney/core/ops/gcp-secrets";
import {
  type LifecycleRule,
  type PrefixGroup,
  ROOTS,
  accumulate,
  renderSizes,
} from "@usemoney/core/ops/gcs-prefix-sizes";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(REPO_ROOT, "docs", "reference");
const PROD_BUCKET = "stockbook-content-prod";

async function main(): Promise<void> {
  const args = parseCliArgsOrExit(
    process.argv.slice(2),
    {
      bare: [],
      valued: ["month", "bucket", "transfer-usd-per-gib", "rate-source"],
      numeric: [],
    },
    "gcs-prefix-sizes",
  );

  const month = args.value("month") ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.error(`[gcs-prefix-sizes] --month=${month} is not YYYY-MM.`);
    process.exit(1);
  }
  const bucket = args.value("bucket") ?? PROD_BUCKET;

  // The rate is a STRING flag, not `numeric`: the CLI's numeric rule is
  // positive INTEGERS and a per-GiB price is a decimal. Parsed and validated
  // here instead, and an unparseable value is fatal rather than silently 0 —
  // a rate of 0 renders every prefix as free.
  const rawRate = args.value("transfer-usd-per-gib");
  let usdPerGib: number | null = null;
  if (rawRate !== undefined) {
    const n = Number(rawRate);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(
        `[gcs-prefix-sizes] --transfer-usd-per-gib=${rawRate} is not a positive number. ` +
          "Refusing rather than treating it as 0, which would render every prefix free.",
      );
      process.exit(1);
    }
    usdPerGib = n;
  }
  const rateSource = args.value("rate-source") ?? null;
  if (usdPerGib !== null && rateSource === null) {
    console.warn(
      "[gcs-prefix-sizes] --transfer-usd-per-gib was given without --rate-source. " +
        "The document will say the provenance was not recorded — a rate with no citation is a number nobody can re-check.",
    );
  }
  if (usdPerGib === null) {
    console.warn(
      "[gcs-prefix-sizes] no --transfer-usd-per-gib; cost columns will render blank rather than zero.",
    );
  }

  const key = secret("GCP_SERVICE_ACCOUNT_KEY_BASE64");
  if (!("value" in key)) {
    console.error(`[gcs-prefix-sizes] no GCS credential: ${key.reason}`);
    process.exit(1);
  }
  process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 = key.value;
  process.env.GCP_PROJECT_ID = GCP_PROJECT_ID;
  process.env.GCP_STORAGE_BUCKET = bucket;

  const { getBucketMetadata, streamObjectSummaries } = await import("@usemoney/storage");

  // The bucket's OWN lifecycle rules, through the storage package's credentialed
  // client. `null` means COULD NOT READ and is rendered as UNKNOWN — never as
  // an empty rule set, because "this prefix has no rule" is a finding and "I
  // could not ask" is not, and they look identical once flattened to [].
  let lifecycle: LifecycleRule[] | null = null;
  let softDeletePolicy: { retentionDurationSeconds?: string | number } | undefined;
  try {
    const meta = await getBucketMetadata();
    lifecycle = ((meta.lifecycle as { rule?: unknown[] } | undefined)?.rule ?? []) as LifecycleRule[];
    softDeletePolicy = meta.softDeletePolicy as typeof softDeletePolicy;
  } catch (err) {
    console.error(
      `[gcs-prefix-sizes] could not read the lifecycle config: ${String(err).slice(0, 160)}\n` +
        "  The report will say UNKNOWN rather than claiming these prefixes have no rules.",
    );
  }
  console.log(
    `[gcs-prefix-sizes] ${lifecycle === null ? "UNKNOWN" : lifecycle.length} lifecycle rule(s) on gs://${bucket}`,
  );

  console.log(`[gcs-prefix-sizes] walking gs://${bucket} …`);
  const groups = new Map<string, PrefixGroup>();
  let totalObjects = 0;
  let totalBytes = 0;

  // ONE walk of the whole bucket. `streamObjectSummaries` throws on a listing
  // error, so a partial walk never becomes a smaller report.
  for await (const obj of streamObjectSummaries("")) {
    totalObjects++;
    totalBytes += obj.size;
    accumulate(groups, obj.name, obj.size, obj.storageClass, ROOTS);
    if (totalObjects % 100_000 === 0) {
      console.log(`[gcs-prefix-sizes]   ${totalObjects.toLocaleString("en-US")} objects …`);
    }
  }

  // SECOND PASS, disjoint from the first: `softDeleted: true` returns only
  // soft-deleted objects. GCS bills for them throughout the retention window,
  // and a live-only listing omits them — which under-reports the storage line
  // in exactly the direction this whole script exists to avoid.
  let softDeletedObjects = 0;
  let softDeletedBytes = 0;
  let softDeleteRetentionDays: number | null = null;
  try {
    for await (const obj of streamObjectSummaries("", 1000, { softDeleted: true })) {
      softDeletedObjects++;
      softDeletedBytes += obj.size;
    }
    const secs = Number(softDeletePolicy?.retentionDurationSeconds);
    softDeleteRetentionDays = Number.isFinite(secs) ? secs / 86_400 : null;
    console.log(
      `[gcs-prefix-sizes] soft-deleted: ${softDeletedObjects.toLocaleString("en-US")} objects, ` +
        `${(softDeletedBytes / 1024 ** 3).toFixed(1)} GiB (retention ${softDeleteRetentionDays ?? "?"} d)`,
    );
  } catch (err) {
    // Reported, never silently zero: "no soft-deleted objects" and "could not
    // ask" are the same number and opposite facts.
    console.error(
      `[gcs-prefix-sizes] could not list soft-deleted objects: ${String(err).slice(0, 140)}`,
    );
  }

  const rows = [...groups.values()];
  const grouped = rows.reduce((n, g) => n + g.objects, 0);
  console.log(
    `[gcs-prefix-sizes] ${totalObjects.toLocaleString("en-US")} objects, ${rows.length} groups, ` +
      `${(totalBytes / 1024 ** 3).toFixed(1)} GiB`,
  );
  if (grouped !== totalObjects) {
    // Not a warning to skim past: the grouping and the walk disagree, so one of
    // the two numbers in the Totals table is wrong and there is no way to tell
    // which from the document alone.
    console.error(
      `[gcs-prefix-sizes] GROUPING LOST OBJECTS: walked ${totalObjects}, grouped ${grouped}. Refusing to write a report whose totals disagree.`,
    );
    process.exit(1);
  }

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    /* provenance degrades; the measurement does not */
  }

  // The framing travels WITH the numbers. Without it the table reads as a live
  // migration plan, which is exactly what it is not any more.
  const context = [
    "> ⚠️ **The move this sized was CANCELLED.** This document was commissioned to price relocating the US prefixes to a `us-east4` bucket (D6). The measurement landed 14-Sep-2026 and the region split was cancelled the same evening — plan v2.3 locks **single region, asia-south1**, and removes D6.",
    ">",
    "> It is **retained as the record**, not as a plan. The costs and the MOVE / LEAVE-HISTORY column are kept deliberately: plan v2.3 §1 cites this file for \"553 GiB in scope … cost was never the issue\", and a record stripped of its arithmetic would leave that conclusion unevidenced. **Nothing here is scheduled to move.**",
    ">",
    "> What outlives the decision is the inventory: this is still the only measurement of what the bucket holds, and the lifecycle gaps at the end apply in one region exactly as they would have in two.",
  ].join("\n");

  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `us-prefix-sizes-${month}.md`);
  writeFileSync(
    path,
    renderSizes({
      context,
      generatedAt: new Date().toISOString(),
      commit,
      month,
      bucket,
      groups: rows,
      usdPerGib,
      rateSource,
      totalObjects,
      totalBytes,
      softDeletedObjects,
      softDeletedBytes,
      softDeleteRetentionDays,
      lifecycle,
    }),
    "utf8",
  );
  console.log(`[gcs-prefix-sizes] wrote ${path}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[gcs-prefix-sizes]", err);
    process.exit(1);
  });
}
