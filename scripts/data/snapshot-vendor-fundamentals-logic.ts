/**
 * The pure decisions behind `scripts/data/snapshot-vendor-fundamentals.ts` —
 * MONEY-1401 B3.
 *
 * ## Why this exists at all
 *
 * Read the two `@@unique` lines this module hard-codes, straight out of
 * `packages/database/prisma/schema.prisma`:
 *
 *   model StockFinancials  @@unique([symbol, exchange, statementType, periodType, period])
 *   model StockRatios      @@unique([symbol, exchange])
 *
 * Cited by MODEL, not by line. Both citations here read `:4882` / `:4988` until
 * 2026-09-14 and the real declarations were at `:4929` / `:5035` — a line number
 * into a 5,000-line schema rots on every edit above it, and a stale one reads
 * exactly like a checked one. `vendor-fundamentals-wiring.test.ts` parses the
 * live schema and fails if either list drifts, which is the check a comment
 * cannot be.
 *
 * That parser requires a trimmed line to START with `@@unique(` rather than
 * merely contain it: `StockRatios` carries a COMMENT reading "... @@unique([symbol,
 * exchange]) means ..." ten lines above its real declaration, and a substring
 * match finds the sentence first — passing today, and still passing after the
 * declaration it was supposed to be watching changed.
 *
 * NEITHER carries `source`. So two sources describing one period are ONE row:
 * the first XBRL write does not duplicate the incumbent Tickertape value, it
 * ERASES it, and there is then nothing left to reconcile against. That one-way
 * door is why `XBRL_PROJECTION_APPLY` has been blocked since 2026-08-30 — every
 * decision has to be provably right in advance instead of being a one-night
 * experiment.
 *
 * A snapshot of the vendor rows turns the door back into a door. Prod counts
 * measured 2026-09-13: `stock_ratios` 2,135 rows (100% `source: "TICKERTAPE"`),
 * `stock_financials` 32,359 rows.
 *
 * ## Why the decisions are HERE and not in the script
 *
 * The script's `main()` cannot be imported — it resolves `--env` and then
 * constructs a Prisma client, so importing it to test a classification would
 * open a database connection. Same split as `series-readiness.ts` out of
 * `reclassify-instruments.ts` (MONEY-1196) and `instrument-name-repair.ts` out
 * of `repair-instrument-names.ts` (MONEY-1205).
 *
 * ZERO imports. No prisma, no mongodb, no fs, no clock — `snapshotAt` is a
 * PARAMETER. The restore plan is the half that decides what gets overwritten in
 * production, and it must be assertable without a connection.
 */

/** The two vendor tables whose incumbent rows an XBRL write would destroy. */
export type VendorCollection = "stock_ratios" | "stock_financials";

/**
 * The natural key, per collection — a VERBATIM transcription of the `@@unique`
 * lines quoted in the header.
 *
 * This is the load-bearing constant in the file. Every classification in
 * `planRestore` is "same key?", so a field missing here silently CONFLATES rows
 * that are different rows: drop `exchange` and one symbol's NSE and BSE ratios
 * become one; drop `period` and every fiscal year of one statement collapses
 * into whichever the iteration reached last. Both directions are wrong in the
 * same quiet way — the plan looks smaller and reports success.
 */
export const NATURAL_KEY_FIELDS: Readonly<
  Record<VendorCollection, readonly string[]>
> = {
  // model StockRatios — @@unique([symbol, exchange])
  stock_ratios: ["symbol", "exchange"],
  // model StockFinancials — @@unique([symbol, exchange, statementType, periodType, period])
  stock_financials: [
    "symbol",
    "exchange",
    "statementType",
    "periodType",
    "period",
  ],
};

/** Where each collection's snapshot lands. */
export const SNAPSHOT_COLLECTION: Readonly<Record<VendorCollection, string>> = {
  stock_ratios: "stock_ratios_vendor_snapshot",
  stock_financials: "stock_financials_vendor_snapshot",
};

/**
 * Sources THIS PLATFORM writes. A row carrying one is not a vendor row —
 * MONEY-1401 F7.
 *
 * Spelled out rather than imported, because this module's whole contract is
 * ZERO imports (see the header). Both strings are literals at their write
 * sites: `XBRL_SOURCE` in `packages/core/src/market-data/xbrl-projection.ts`
 * and the `SOURCE` constant in `workers/src/processors/xbrl-ratios.ts`'s
 * document-extract arm.
 *
 * Named for the PROPERTY — "we wrote it" — rather than listed as vendors to
 * keep, so a NEW vendor is automatically kept and a new arm OF OURS is the
 * thing that has to be added here. The other polarity fails open: an unlisted
 * source would be snapshotted as though it were the vendor's, which is how a
 * restore silently puts our own rows back and reports success.
 */
export const OUR_SOURCES: ReadonlySet<string> = new Set([
  "NSE_XBRL",
  "DOC_PDF",
]);

/**
 * Split the current rows into the ones a VENDOR snapshot is of, and ours.
 *
 * The script reads every row of both tables with no `where` and filters HERE,
 * in JavaScript, deliberately. A Prisma `{ source: { not: "NSE_XBRL" } }`
 * matches ZERO rows wherever the attribute is ABSENT rather than null — a
 * Mongo `db push` creates indexes, not fields — and that single rule has caused
 * MONEY-1050, MONEY-1205, MONEY-1234 and MONEY-1235 in this repo. Measured on
 * prod 2026-09-13 the attribute is present on 2,135 of 2,135 `stock_ratios` and
 * 32,359 of 32,359 `stock_financials` rows, all `"TICKERTAPE"` — so the query
 * would work TODAY, which is exactly the reading that makes the trap survive.
 *
 * An ABSENT or non-string `source` counts as a VENDOR row: this is a backup,
 * and the failure mode of keeping one row too many is a slightly larger
 * snapshot, while the failure mode of dropping one is a vendor value that no
 * restore can bring back.
 */
export function partitionVendorRows(rows: readonly Row[]): {
  vendor: Row[];
  ours: Row[];
} {
  const vendor: Row[] = [];
  const ours: Row[] = [];
  for (const row of rows) {
    const source = row["source"];
    if (typeof source === "string" && OUR_SOURCES.has(source)) ours.push(row);
    else vendor.push(row);
  }
  return { vendor, ours };
}

/** One key whose stored snapshot and current row disagree on `source`. */
export interface ResnapshotConflict {
  readonly key: string;
  readonly stored: string;
  readonly current: string;
}

/**
 * May a same-day re-snapshot REPLACE the one already stored? — MONEY-1401 F7.
 *
 * ## The hazard this closes, which the file header used to call a safety property
 *
 * `snapshotDay` is a UTC day, and IST 05:30–00:00 is ONE UTC day. So the
 * NORMAL shape of an Indian working session is:
 *
 *     11:00 IST  snapshot          -> 2,135 TICKERTAPE rows stored under day D
 *     15:00 IST  arm + run the job -> N of those rows become NSE_XBRL
 *     16:00 IST  re-snapshot "to check"
 *
 * and that third step is the same UTC day, so it DELETED day D's vendor
 * documents and re-inserted the XBRL rows in their place. The only copy of the
 * values the whole switchover is reversible against, destroyed by the command
 * whose entire purpose is to preserve them — and then `runRestore` would have
 * restored XBRL over XBRL, refusing nothing, because its only guard is
 * `days.size > 1` and there is still exactly one day.
 *
 * ## Why this rather than "never replace"
 *
 * Same-day idempotency is a real property worth keeping: a snapshot that
 * crashed half-way through its inserts must be re-runnable, and a re-run that
 * APPENDED would silently double the collection. What must not be replaceable
 * is a snapshot whose rows have since been overwritten by a DIFFERENT source —
 * which is not "the same snapshot again", it is a different one wearing the
 * same day.
 *
 * A key present in the store and absent from the new plan is ALSO a conflict:
 * that is a vendor row the current read no longer classifies as a vendor row,
 * which is the same event seen from the other side.
 *
 * Content changes alone are NOT a conflict. A vendor row whose numbers moved is
 * still a vendor row, and refusing on that would make the script unusable the
 * first time anything legitimately re-fetched.
 */
export function planResnapshotGuard(
  stored: readonly SnapshotDoc[],
  planned: readonly SnapshotDoc[],
): { refuse: boolean; conflicts: ResnapshotConflict[] } {
  if (stored.length === 0) return { refuse: false, conflicts: [] };

  const sourceOf = (doc: SnapshotDoc): string => {
    const v = doc.row["source"];
    return typeof v === "string" ? v : "(absent)";
  };
  const plannedByKey = new Map<string, SnapshotDoc>();
  for (const doc of planned) plannedByKey.set(doc._id, doc);

  const conflicts: ResnapshotConflict[] = [];
  for (const doc of stored) {
    const now = plannedByKey.get(doc._id);
    const storedSource = sourceOf(doc);
    // GONE from the plan. Either the row was deleted, or `partitionVendorRows`
    // has moved it to `ours` — and the second is exactly the destroy-the-only-
    // copy case, so it must not be silently written away.
    if (now === undefined) {
      conflicts.push({
        key: doc._id,
        stored: storedSource,
        current: "(not in the new snapshot)",
      });
      continue;
    }
    const currentSource = sourceOf(now);
    if (currentSource !== storedSource) {
      conflicts.push({
        key: doc._id,
        stored: storedSource,
        current: currentSource,
      });
    }
  }
  return { refuse: conflicts.length > 0, conflicts };
}

/** A row as Prisma hands it back: scalars, `Date`s, and a `rawData` JSON blob. */
export type Row = Readonly<Record<string, unknown>>;

/** The same row with every top-level `Date` flattened to an ISO string. */
export type JsonSafeRow = Record<string, unknown>;

/** A snapshot document, exactly as it is stored. */
export interface SnapshotDoc {
  /**
   * DETERMINISTIC, and a string rather than an ObjectId.
   *
   * It buys three things for free: a same-day re-run collides instead of
   * silently storing a second copy; the restore read can keyset-page on `_id`
   * (`$runCommandRaw` returns only `cursor.firstBatch` and issues no `getMore`,
   * so 32,359 rows cannot come back in one command); and the page cursor is a
   * plain string, not an extended-JSON `{$oid}` that has to survive a round
   * trip through the raw command interface.
   */
  readonly _id: string;
  readonly snapshotAt: string;
  /** UTC day of `snapshotAt`. The unit a re-run REPLACES. */
  readonly snapshotDay: string;
  readonly sourceCollection: VendorCollection;
  readonly key: Readonly<Record<string, string>>;
  /**
   * Which of `row`'s fields were `Date`s before serialisation.
   *
   * Self-describing rather than a hard-coded list of column names, so a new
   * `DateTime` column on either model is carried and revived without an edit
   * here. Nested dates are out of scope by construction — Prisma hands back
   * `rawData` as plain JSON.
   */
  readonly dateFields: readonly string[];
  /** The row, verbatim apart from the date flattening `dateFields` records. */
  readonly row: JsonSafeRow;
}

export interface PlanSnapshotOptions {
  readonly collection: VendorCollection;
  /** Injected — this module never reads a clock. */
  readonly snapshotAt: Date | string;
}

export interface RestorePlan {
  /** Key present in current, content differs. */
  readonly replace: readonly SnapshotDoc[];
  /** Key absent from current — the row was deleted since the snapshot. */
  readonly insert: readonly SnapshotDoc[];
  /** Key present, content byte-identical. Nothing to do. */
  readonly unchanged: number;
}

/** The key fields' values, as an object. Throws rather than guessing. */
export function naturalKey(
  collection: VendorCollection,
  row: Row,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of NATURAL_KEY_FIELDS[collection]) {
    const value = row[field];
    // Every field in both @@unique lines is a non-nullable `String` in the
    // schema. A missing one means the caller handed us something that is not a
    // row of this collection, and a key built around `undefined` would match
    // every other malformed row — one bucket, silently.
    if (typeof value !== "string") {
      throw new Error(
        `${collection}: natural-key field "${field}" is ${
          value === undefined ? "absent" : typeof value
        }, expected a string. Refusing to build a key that would conflate rows.`,
      );
    }
    out[field] = value;
  }
  return out;
}

/**
 * The key as one comparable string.
 *
 * `JSON.stringify` of the ORDERED values, not a join on a separator character:
 * `period` is free text ("2024", "Q3-2024", "TTM") and any separator anyone
 * would pick can appear inside it, which would make two different keys equal.
 */
export function naturalKeyString(
  collection: VendorCollection,
  row: Row,
): string {
  const key = naturalKey(collection, row);
  return JSON.stringify(NATURAL_KEY_FIELDS[collection].map((f) => key[f]));
}

/** UTC day (`YYYY-MM-DD`) of an instant. */
export function snapshotDayOf(snapshotAt: Date | string): string {
  const iso =
    snapshotAt instanceof Date ? snapshotAt.toISOString() : String(snapshotAt);
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(
      `snapshotAt is not an ISO instant: "${String(snapshotAt)}"`,
    );
  }
  return day;
}

/** The deterministic `_id`. Same day + same key => same document. */
export function snapshotDocId(snapshotDay: string, keyString: string): string {
  return `${snapshotDay}|${keyString}`;
}

/** Top-level `Date`s to ISO strings; everything else verbatim. */
function toJsonSafe(row: Row): {
  row: JsonSafeRow;
  dateFields: string[];
} {
  const out: JsonSafeRow = {};
  const dateFields: string[] = [];
  for (const [field, value] of Object.entries(row)) {
    if (value instanceof Date) {
      dateFields.push(field);
      out[field] = value.toISOString();
    } else {
      out[field] = value;
    }
  }
  return { row: out, dateFields };
}

/**
 * Wrap each row for storage. Nothing is dropped, summarised or normalised — a
 * snapshot that reshapes what it stores is not a snapshot.
 */
export function planSnapshot(
  rows: readonly Row[],
  opts: PlanSnapshotOptions,
): SnapshotDoc[] {
  const snapshotAt =
    opts.snapshotAt instanceof Date
      ? opts.snapshotAt.toISOString()
      : String(opts.snapshotAt);
  const snapshotDay = snapshotDayOf(snapshotAt);

  const seen = new Set<string>();
  return rows.map((source) => {
    const keyString = naturalKeyString(opts.collection, source);
    if (seen.has(keyString)) {
      // The unique index makes this impossible in the source collection, so it
      // means the caller paged badly and handed us a row twice. Two copies of
      // one row would collide on `_id` at insert time anyway; failing here says
      // which row rather than "duplicate key".
      throw new Error(
        `${opts.collection}: duplicate natural key ${keyString} in the rows to ` +
          `snapshot — the read paged wrong, or the unique index is gone.`,
      );
    }
    seen.add(keyString);
    const { row, dateFields } = toJsonSafe(source);
    return {
      _id: snapshotDocId(snapshotDay, keyString),
      snapshotAt,
      snapshotDay,
      sourceCollection: opts.collection,
      key: naturalKey(opts.collection, source),
      dateFields,
      row,
    };
  });
}

/** The stored row with its `Date` columns revived, ready for a Prisma write. */
export function reviveSnapshotRow(doc: SnapshotDoc): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc.row };
  for (const field of doc.dateFields) {
    const value = out[field];
    if (typeof value === "string") out[field] = new Date(value);
  }
  return out;
}

/**
 * Key-order-independent JSON, so a driver that hands the same document back
 * with its fields in a different order does not read as a change.
 */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = walk(src[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/**
 * Classify every snapshotted row against what is in the table now.
 *
 * A current row whose key is NOT in the snapshot is deliberately left alone and
 * not counted: restore puts back what was taken, it does not delete rows that
 * appeared afterwards. Deleting them would make "restore the vendor rows" also
 * mean "discard everything written since", which is a different and much larger
 * promise than this script makes.
 */
export function planRestore(
  snapshotDocs: readonly SnapshotDoc[],
  currentRows: readonly Row[],
): RestorePlan {
  if (snapshotDocs.length === 0) {
    return { replace: [], insert: [], unchanged: 0 };
  }
  const collection = snapshotDocs[0]!.sourceCollection;
  for (const doc of snapshotDocs) {
    if (doc.sourceCollection !== collection) {
      throw new Error(
        `planRestore was given a mixed batch (${collection} and ` +
          `${doc.sourceCollection}). The natural key differs per collection, ` +
          `so one batch can only ever be one collection.`,
      );
    }
  }

  const current = new Map<string, string>();
  for (const row of currentRows) {
    current.set(
      naturalKeyString(collection, row),
      canonical(toJsonSafe(row).row),
    );
  }

  const replace: SnapshotDoc[] = [];
  const insert: SnapshotDoc[] = [];
  let unchanged = 0;

  for (const doc of snapshotDocs) {
    const keyString = naturalKeyString(collection, doc.row);
    const live = current.get(keyString);
    if (live === undefined) insert.push(doc);
    else if (live === canonical(doc.row)) unchanged += 1;
    else replace.push(doc);
  }

  return { replace, insert, unchanged };
}
