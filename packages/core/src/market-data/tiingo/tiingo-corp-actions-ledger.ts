/**
 * Tiingo corp-action archives -> lake ledger rows. MONEY-1474 (was MONEY-1472).
 *
 * PURE — no GCS, no BigQuery, no Prisma. The job lists the objects and writes
 * the rows; this decides what a listed object MEANS.
 *
 * ## THIS MODULE USED TO READ `BackfillCheckpoint`, AND THAT WAS WRONG
 *
 * B1 said to compute keys "from the registry, never by listing". There is no
 * registry for these feeds — `REPORT_REGISTRY` is NSE/BSE only — so the first
 * cut substituted `BackfillCheckpoint` for one. Its first prod dry run
 * (2026-09-17) showed why that substitution cannot work:
 *
 *     19,308 checkpoints -> 93 candidates -> 22 PRESENT, 71 MISSING
 *         28 objects actually in the bucket
 *
 * Both halves were wrong, in opposite directions, from one cause:
 *
 *   - 63 of the 71 MISSING were ex-dates in the FUTURE (up to 2026-12-31). A
 *     date that has not happened cannot have an archived object, and `MISSING`
 *     in `source_object` means "the archive PUT did not land" — in a table
 *     CLUSTERED ON `state`, so a coverage query would have read 71 losses that
 *     never happened.
 *   - 6 REAL objects were missed. Splits for 2026-09-04, -07, -11, -15, -16 and
 *     -17 sit in the bucket and were never candidates.
 *
 * Because every one of those 19,308 checkpoints was written on ONE day,
 * 2026-08-29, by a historical walk over ex-dates 1990-01-02 .. 2026-12-31 —
 * while every archived object was written 2026-08-31 onward by the NIGHTLY
 * corp-actions leg, which writes no checkpoints at all. For those 6 dates the
 * checkpoint honestly said "< 32 bytes, nothing there", which was TRUE on
 * 2026-08-29 when the date was still in the future; the object arrived days
 * later from a different producer. The two sources are causally unrelated, so
 * no bound derived from one can describe the other. `--archiving-since` bounded
 * the damage and could never have fixed it.
 *
 * ## SO THE LEDGER RECORDS WHAT THE ARCHIVE HAS
 *
 * The job lists the prefix FAIL-CLOSED (`listObjects` THROWS rather than
 * returning `[]`) and every listed object becomes one `PRESENT` row. "Never
 * list" was a rule about `listFiles` failing open, which is a property of that
 * function rather than of listing — so a lister that throws removes the
 * objection instead of working around it.
 *
 * ## AND `MISSING` IS NOT DERIVABLE HERE, SO IT IS NEVER CLAIMED
 *
 * An absent object is either "no corporate actions on that ex-date, so the
 * shape guard correctly stored nothing" or "the PUT failed", and NOTHING on
 * either side distinguishes them. The Databento leg may write MISSING because a
 * vendor MANIFEST proves the file was delivered; this leg has no manifest.
 * Same table, different evidence, different vocabulary.
 */

/** The two corp-action feeds, as the archive key spells them. */
export const CORP_ACTION_FEEDS = ["distributions", "splits"] as const;
export type CorpActionFeed = (typeof CORP_ACTION_FEEDS)[number];

/**
 * The archive prefix a feed lives under.
 *
 * The trailing slash is load-bearing: GCS prefix matching is a string prefix,
 * so `feeds/TIINGO/splits` would also match a future `feeds/TIINGO/splits-v2/`.
 */
export function prefixFor(feed: CorpActionFeed): string {
  return `feeds/TIINGO/${feed}/`;
}

/**
 * `FEED_SHAPES` refuses a body below this, so nothing smaller was ever stored
 * by the archive writer. An object at or under it is a placeholder, a
 * finalized-but-empty resumable upload, or something that bypassed the shape
 * guard — and `PRESENT` asserts that BYTES EXIST at that key, so recording one
 * would be a claim the object cannot support.
 */
export const MIN_ARCHIVED_BYTES = 32;

/** What the job hands over: one listed GCS object. */
export interface ListedObject {
  name: string;
  generation: number | null;
  size: number | null;
  contentType: string | null;
  /** When GCS created it. The ARRIVAL instant — see the job's `acquiredAt`. */
  timeCreated: Date | null;
}

export interface ParsedKey {
  feed: CorpActionFeed;
  /** The ex-date the object covers, `YYYY-MM-DD`. */
  exDate: string;
}

/**
 * Why an object under a pinned prefix was not recorded.
 *
 * `unknown-feed` is GONE. The job lists `feeds/TIINGO/<feed>/` per feed, so the
 * key's feed segment can only ever be the one whose prefix was listed — the
 * check could not fire on production input, and its only test hand-built a key
 * the job cannot produce. Keeping it would have been a guard that reads as
 * protection and is structurally unreachable.
 *
 * The real consequence is the opposite one, and it is NOT in this list because
 * this module cannot see it: if the archive writer adds a THIRD corp-action
 * route, the job never lists that prefix, so its objects are invisible rather
 * than rejected. That is held instead by `CORP_ACTION_FEEDS` being asserted
 * against the writer's own route table in the test.
 *
 * Everything left is a DEFECT — an object inside a prefix we pinned whose key
 * this reader cannot parse — except `below-min-bytes`, which is routine.
 */
export type RejectReason =
  | "unparsable-key"
  | "no-ex-date"
  | "path-date-disagrees"
  | "below-min-bytes";

export interface KeyScan {
  rows: (ParsedKey & { object: ListedObject })[];
  /** Why each rejected object was rejected. NAMED, never a bare count. */
  rejected: Record<RejectReason, number>;
}

/**
 * The key grammar, and the ex-date comes from the STEM.
 *
 * `buildFeedArchiveKey` composes `{stem}__{queryLabel}-{digest}.{ext}` where
 * the STEM is `corpActionsDescriptor`'s own basename — measured,
 * `splits-2026-09-04.csv` -> stem `splits-2026-09-04`.
 *
 * An earlier cut read `exDate-(\d{4}-\d{2}-\d{2})` out of the part AFTER the
 * `__`, with a comment claiming the basename carried it. It does not: that
 * token comes from `queryDiscriminator` sanitising `?exDate=…&format=csv`,
 * sorted alphabetically and SLICED at `QUERY_LABEL_MAX`. It is a debug label,
 * 28 characters today. One extra query param sorting before `exDate`
 * (`assetType`, `columns`, `endDate`, a token) pushes the date past the cap and
 * cuts it — every object becomes unparsable at once. Worse silently: if the
 * descriptor and the URL ever disagreed, the label's date would win and land
 * the wrong ex-date in the PARTITION column.
 */
const KEY = /^feeds\/TIINGO\/([^/]+)\/(\d{4})\/(\d{2})\/([^/]+)$/;
/** The stem is everything before the `__` the archive inserts. */
const STEM_EX_DATE = /^[a-z-]+-(\d{4}-\d{2}-\d{2})(?:__|\.)/;

/**
 * Turn listed objects into the rows a ledger write needs.
 *
 * Every rejection is counted BY REASON rather than summed, because they mean
 * different things and only one is routine. `unknown-feed` and
 * `path-date-disagrees` are DEFECTS — this reader and the archive key builder
 * disagreeing — and folded into a total they would look like a quiet day for
 * ever.
 */
export function scanArchiveKeys(objects: readonly ListedObject[]): KeyScan {
  const rows: (ParsedKey & { object: ListedObject })[] = [];
  const rejected: Record<RejectReason, number> = {
    "unparsable-key": 0,
    "no-ex-date": 0,
    "path-date-disagrees": 0,
    "below-min-bytes": 0,
  };

  for (const object of objects) {
    const m = KEY.exec(object.name);
    if (!m) {
      // Inside a prefix we pinned, and unreadable. A DEFECT, not a quiet day.
      rejected["unparsable-key"]++;
      continue;
    }
    const feed = m[1]!;
    const year = m[2]!;
    const month = m[3]!;
    const basename = m[4]!;
    if (!(CORP_ACTION_FEEDS as readonly string[]).includes(feed)) {
      // Structurally unreachable — the job lists one feed prefix at a time — so
      // it is folded into the DEFECT bucket rather than given a reason of its
      // own that could never be non-zero. See `RejectReason`.
      rejected["unparsable-key"]++;
      continue;
    }
    const d = STEM_EX_DATE.exec(basename);
    if (!d) {
      rejected["no-ex-date"]++;
      continue;
    }
    const exDate = d[1]!;
    if (!exDate.startsWith(`${year}-${month}`)) {
      // `buildFeedArchiveKey` files an object under the {YYYY}/{MM} of its own
      // date, so these must agree. If they ever do not, the grammar has changed
      // and reading either would be a guess that lands a row on the wrong
      // partition.
      rejected["path-date-disagrees"]++;
      continue;
    }
    if (object.size === null || object.size < MIN_ARCHIVED_BYTES) {
      // `PRESENT` asserts bytes exist at the key. A zero-byte or unsized object
      // cannot support that claim, and this leg writes no other state — so the
      // honest outcome is no row. Unsized is counted here too: "we did not
      // learn the size" is not evidence of a healthy object.
      rejected["below-min-bytes"]++;
      continue;
    }
    rows.push({ feed: feed as CorpActionFeed, exDate, object });
  }

  // Deterministic, so two runs produce the same log and a diff of them reads.
  rows.sort((a, b) =>
    a.exDate === b.exDate
      ? a.feed.localeCompare(b.feed)
      : a.exDate.localeCompare(b.exDate),
  );
  return { rows, rejected };
}

/**
 * The name an operator reads in the ledger.
 *
 * NOT the GCS basename: that carries a query-string digest
 * (`…_format-csv-5d77803d.csv`) which identifies the REQUEST rather than the
 * day, and means nothing to someone reading `vendor_file_name` in a coverage
 * query.
 */
export function vendorFileNameFor(
  feed: CorpActionFeed,
  exDate: string,
): string {
  return `${feed}-${exDate}.csv`;
}
