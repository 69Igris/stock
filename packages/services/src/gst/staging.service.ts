/**
 * Stage parsed Dodo CSV rows into `DodoPayoutStaging` for the engine in MONEY-214.
 *
 * Idempotency:
 *   - csvHash short-circuit: if the same hash is already in the table, skip.
 *   - transaction_id uniqueness: even on hash mismatch (e.g. user re-exports
 *     with newer rows appended), existing rows are NOT duplicated; only the
 *     new transactionIds are inserted.
 */

import { prisma } from "@usemoney/database";
import { dbLogger as logger } from "@usemoney/logger";
import { getBillingPeriod } from "./billing-period";
import type { ParsedDodoRow } from "./dodo-csv-parser";

export interface StageResult {
  csvHash: string;
  alreadyIngested: boolean;
  inserted: number;
  skippedDuplicates: number;
  totalParsed: number;
}

export async function stageDodoRows(args: {
  rows: ParsedDodoRow[];
  csvHash: string;
  uploadedBy?: string;
  sourceFileKey?: string;
}): Promise<StageResult> {
  const { rows, csvHash, uploadedBy, sourceFileKey } = args;

  if (rows.length === 0) {
    return {
      csvHash,
      alreadyIngested: false,
      inserted: 0,
      skippedDuplicates: 0,
      totalParsed: 0,
    };
  }

  // Hash short-circuit
  const existingHashCount = await prisma.dodoPayoutStaging.count({
    where: { csvHash },
  });
  if (existingHashCount > 0) {
    logger.info(
      { csvHash, existingHashCount },
      "CSV already ingested (csvHash match) - short-circuit",
    );
    return {
      csvHash,
      alreadyIngested: true,
      inserted: 0,
      skippedDuplicates: existingHashCount,
      totalParsed: rows.length,
    };
  }

  // Find which transactionIds are already known so we don't double-insert.
  const txIds = rows.map((r) => r.transactionId);
  const existing = await prisma.dodoPayoutStaging.findMany({
    where: { transactionId: { in: txIds } },
    select: { transactionId: true },
  });
  const knownIds = new Set(existing.map((e) => e.transactionId));
  const newRows = rows.filter((r) => !knownIds.has(r.transactionId));

  if (newRows.length === 0) {
    return {
      csvHash,
      alreadyIngested: false,
      inserted: 0,
      skippedDuplicates: rows.length,
      totalParsed: rows.length,
    };
  }

  // Bulk insert. createMany is fine for MongoDB Prisma; we don't need per-row
  // upserts since the unique index on transactionId guards duplicates.
  const data = newRows.map((r) => {
    const period = getBillingPeriod(r.transactionDate);
    return {
      csvHash,
      uploadedBy,
      sourceFileKey,
      transactionId: r.transactionId,
      payoutId: r.payoutId,
      customerEmail: r.customerEmail,
      customerCountry: r.customerCountry,
      currency: r.currency,
      grossAmount: r.grossAmount,
      feesAmount: r.feesAmount,
      netAmount: r.netAmount,
      transactionDate: r.transactionDate,
      rawRow: r.rawRow as unknown as object,
      billingPeriodStart: period.start,
      billingPeriodEnd: period.end,
      // MONEY-1236 — MATERIALISE the lifecycle field instead of letting Mongo
      // omit it.
      //
      // `consumedByInvoiceId String? @db.ObjectId` has no `@default`, and this
      // row build did not mention it, so every staged document was written with
      // the key ABSENT. Prisma's MongoDB connector does not treat an absent
      // field as null: the invoice engine's `{consumedByInvoiceId: null}`
      // filters matched ZERO of these rows, so `generateGstInvoice` threw
      // `NoPendingPayoutsError` against a full staging table.
      //
      // The read side is fixed independently (`UNCONSUMED_STAGING_OR` in
      // invoice-engine.service.ts covers null OR absent), so this line is NOT
      // required for correctness today. It is deliberate DEFENCE IN DEPTH, and
      // the two halves fix different populations:
      //   - the OR handles rows ALREADY WRITTEN by an older build of this file
      //     (and any row a future writer forgets again) — it is the only half
      //     that can repair history, since `db push` never backfills fields;
      //   - this explicit null makes every NEW row match the plain
      //     `{consumedByInvoiceId: null}` spelling too, so the next reader who
      //     writes the naive filter — in an admin action, a GSTR-1 export, a
      //     one-off script — is not silently wrong, and the query planner gets
      //     a value it can use the `@@index([consumedByInvoiceId])` for.
      //
      // NOT done for the sibling `consumedAt`: no query in the repo filters on
      // it (grep: only reads/writes, never a where-clause), so materialising it
      // would be noise. If one ever does, it needs this same treatment — the
      // absence of the key is the bug, not the value.
      consumedByInvoiceId: null,
    };
  });

  // Race protection: between our existence check and this insert, a
  // concurrent upload could insert the same transactionId. Wrap in
  // individual create-or-skip so a duplicate doesn't abort the whole batch.
  // Prisma's MongoDB connector does NOT support `skipDuplicates`, so we
  // fall back to per-row inserts that swallow P2002 unique-constraint errors.
  let actualInserted = 0;
  for (const row of data) {
    try {
      await prisma.dodoPayoutStaging.create({ data: row });
      actualInserted++;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "P2002") {
        // Concurrent insert won - that row is already staged, no-op.
        continue;
      }
      throw err;
    }
  }

  logger.info(
    {
      csvHash,
      inserted: actualInserted,
      skipped: rows.length - actualInserted,
    },
    "Staged Dodo CSV rows",
  );

  return {
    csvHash,
    alreadyIngested: false,
    inserted: actualInserted,
    skippedDuplicates: rows.length - actualInserted,
    totalParsed: rows.length,
  };
}
