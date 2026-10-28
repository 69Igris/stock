/**
 * The Databento inventory's classification and rendering — the pure half.
 *
 * The I/O shell is `scripts/ops/databento-inventory.ts`. Everything here is a
 * pure function over already-gathered facts, so the test exercises it with no
 * database, no bucket and no vendor.
 *
 * ## What this exists to prevent
 *
 * MONEY-1373 decided what each manifest entry is FOR. This establishes what
 * EXISTS — and the gap between those two is expensive in one specific way:
 * **Databento files expire 30 days after SUBMISSION**, not after completion,
 * which is the reading that leaves a job less time than it appears to have.
 * Past the expiry the only remedy is to buy the range again at usage prices,
 * after the Standard subscription has lapsed. An entry that is near expiry and
 * not fully present in GCS is therefore a re-purchase risk, and nothing
 * reported that before this.
 *
 * ## THREE presence states, never two
 *
 * `getFileMetadata` returns `null` for an absent OBJECT and THROWS for an
 * unreachable bucket or a bad credential. That is not a distinction worth
 * preserving in the abstract — it was measured on the first run of this very
 * script, where an expired ADC token threw on every key. Collapsing throw into
 * "absent" would have reported all 66,046 files missing and raised a
 * re-purchase alarm over a laptop login.
 *
 * So: PRESENT, ABSENT, MISMATCH, UNKNOWN. `UNKNOWN` still blocks the "fully
 * present" claim — you cannot bank a file you could not see — but it is
 * reported as *not verified* rather than *verified missing*, because those are
 * different facts and only one of them means the bytes are gone.
 */

/** Exactly what a `files[]` entry carries; mirrors `DatabentoFileRecord`. */
export interface InventoryFile {
  filename: string;
  archiveKey: string;
  /** Size the LEDGER recorded at download time. */
  size: number;
  kind: "data" | "support";
  verified?: boolean;
  loadedRows?: number;
}

export type PresenceState = "PRESENT" | "ABSENT" | "MISMATCH" | "UNKNOWN";

export interface PresenceResult {
  archiveKey: string;
  state: PresenceState;
  /** Size GCS reported. Absent when the object is not there or unreadable. */
  gcsSize?: number;
  ledgerSize: number;
  detail?: string;
  /**
   * What the LEDGER says about this file, which a GCS HEAD cannot see.
   *
   * `downloadToArchive` writes to GCS BEFORE it digests, and its cleanup delete
   * on a checksum mismatch is `.catch(() => {})` — so a CORRUPT object can
   * outlive the failure that produced it, stamped `verified: false` with a
   * detail naming the mismatch. That object exists, HEADs fine, and can carry
   * the recorded byte count. Presence decided on the HEAD alone would report it
   * PRESENT and the entry complete, about bytes the harvest itself knows are
   * bad, while the re-downloadable vendor copy ages out at 30 days.
   */
  ledgerVerified: boolean;
}

export interface InventoryJob {
  rowId: string;
  env: string;
  entryId: string;
  schema: string;
  dataset: string;
  purpose: string;
  state: string;
  jobId: string | null;
  costUsd: number | null;
  costUsdQuoted: number;
  submittedAt: Date | null;
  /** The VENDOR's own expiry, when the response carried one. */
  tsExpiration: Date | null;
  symbolCount: number;
  start: Date | null;
  end: Date | null;
  loadedRows: number;
  files: InventoryFile[];
}

/** Vendor retention. 30 days from SUBMISSION — see the module header. */
export const VENDOR_RETENTION_DAYS = 30;
/** Inside this many days of expiry, an incomplete entry is a re-purchase risk. */
export const EXPIRY_ALARM_DAYS = 7;

/** Rollup key separator — entry ids are kebab-case, so this cannot collide. */
const KEY_SEP = "|";

/**
 * When do this job's vendor-side files disappear?
 *
 * TWO sources disagree in principle: the vendor's own `tsExpiration`, and
 * `submittedAt + 30d` derived from the documented policy. Take the EARLIER.
 *
 * A re-purchase risk must never be UNDER-stated, and the two failure modes are
 * not symmetric: believing a file lives longer than it does loses the bytes
 * permanently, while believing it dies sooner costs one unnecessary look. The
 * disagreement itself is reported rather than silently resolved — if the vendor
 * starts returning something other than submitted+30d, that is a policy change
 * we need to see, not smooth over.
 */
export function resolveExpiry(job: InventoryJob): {
  expiry: Date | null;
  derived: Date | null;
  disagreementHours: number | null;
} {
  const derived = job.submittedAt
    ? new Date(job.submittedAt.getTime() + VENDOR_RETENTION_DAYS * 86_400_000)
    : null;
  const vendor = job.tsExpiration;

  if (!derived && !vendor)
    return { expiry: null, derived: null, disagreementHours: null };
  if (!derived)
    return { expiry: vendor, derived: null, disagreementHours: null };
  if (!vendor) return { expiry: derived, derived, disagreementHours: null };

  const disagreementHours =
    Math.abs(vendor.getTime() - derived.getTime()) / 3_600_000;
  return {
    expiry: new Date(Math.min(vendor.getTime(), derived.getTime())),
    derived,
    // Under an hour is clock noise, not a policy change.
    disagreementHours: disagreementHours >= 1 ? disagreementHours : null,
  };
}

export function daysUntil(when: Date | null, now: Date): number | null {
  if (!when) return null;
  return (when.getTime() - now.getTime()) / 86_400_000;
}

/**
 * Is every file this job claims actually sitting in the bucket?
 *
 * `UNKNOWN` counts against completeness for the reason in the header: a file
 * you could not look at is not a file you have. It is kept as its own count so
 * the report can say "could not verify" instead of "missing".
 */
export function summarisePresence(results: readonly PresenceResult[]): {
  present: number;
  absent: number;
  mismatch: number;
  unknown: number;
  /** In GCS, but the ledger itself says the bytes failed verification. */
  ledgerUnverified: number;
  total: number;
  fullyPresent: boolean;
  gcsBytes: number;
} {
  let present = 0;
  let absent = 0;
  let mismatch = 0;
  let unknown = 0;
  let ledgerUnverified = 0;
  let gcsBytes = 0;
  for (const r of results) {
    if (r.state === "PRESENT") present++;
    else if (r.state === "ABSENT") absent++;
    else if (r.state === "MISMATCH") mismatch++;
    else unknown++;
    if (r.state === "PRESENT" && !r.ledgerVerified) ledgerUnverified++;
    if (r.gcsSize !== undefined) gcsBytes += r.gcsSize;
  }
  return {
    present,
    absent,
    mismatch,
    unknown,
    total: results.length,
    // An EMPTY file list is NOT "fully present". A job that names no files has
    // nothing archived, and `every()` over an empty array is `true` — which
    // would quietly certify the ohlcv-1s row (21,365 vendor files, state DONE,
    // zero recorded) as complete. Emptiness is the state this report exists to
    // surface, so it must not be the state that passes.
    // Complete means BOTH: every file is in the bucket, and the harvest's own
    // ledger vouches for every one of them. A file the ledger marks unverified
    // is not made good by existing.
    fullyPresent:
      results.length > 0 &&
      present === results.length &&
      ledgerUnverified === 0,
    ledgerUnverified,
    gcsBytes,
  };
}

/**
 * Plan v2.1 §3 — what each entry is FOR.
 *
 * Keyed by SCHEMA, not by entry id: the consumer is a property of the data
 * shape, so a second entry on the same schema inherits it instead of silently
 * falling through to "unassigned".
 */
export const CONSUMER_BY_SCHEMA: Readonly<Record<string, string>> = {
  "ohlcv-1m": "`trade_bar_m1` + backtest release",
  "ohlcv-1h": "`trade_bar_h1`",
  "bbo-1m": "archive + `spread_cost_daily`",
  tbbo: "archive + `spread_cost_daily`",
  "ohlcv-1s": "archive-only",
  statistics: "archive-only",
  definition: "archive-only",
};

export function consumerFor(schema: string): string {
  return CONSUMER_BY_SCHEMA[schema] ?? "**unassigned — not in plan v2.1 §3**";
}

export interface EntryRollup {
  entryId: string;
  env: string;
  schema: string;
  dataset: string;
  jobCount: number;
  states: Record<string, number>;
  /** Jobs that were actually submitted — the population that can lose bytes. */
  submittedJobs: number;
  costUsd: number;
  costQuoted: number;
  ledgerFiles: number;
  ledgerBytes: number;
  gcsBytes: number;
  present: number;
  absent: number;
  mismatch: number;
  unknown: number;
  ledgerUnverified: number;
  fullyPresent: boolean;
  loadedRows: number;
  earliestExpiry: Date | null;
  daysToExpiry: number | null;
  atRisk: boolean;
  /** Inside EXPIRY_ALARM_DAYS of the vendor deadline — urgency, not the alarm. */
  urgent: boolean;
  riskReason: string | null;
  expiryDisagreements: number;
}

/**
 * Fold jobs into one row per (env, entry).
 *
 * The key carries `env` because the ledger deliberately holds both
 * environments' purchases and they must never sum together — the column exists
 * for exactly that reason.
 */
export function rollupEntries(
  jobs: readonly InventoryJob[],
  presenceByRow: ReadonlyMap<string, readonly PresenceResult[]>,
  now: Date,
): EntryRollup[] {
  const byKey = new Map<string, EntryRollup>();

  for (const job of jobs) {
    const key = `${job.env}${KEY_SEP}${job.entryId}`;
    let r = byKey.get(key);
    if (!r) {
      r = {
        entryId: job.entryId,
        env: job.env,
        schema: job.schema,
        dataset: job.dataset,
        jobCount: 0,
        states: {},
        submittedJobs: 0,
        costUsd: 0,
        costQuoted: 0,
        ledgerFiles: 0,
        ledgerBytes: 0,
        gcsBytes: 0,
        present: 0,
        absent: 0,
        mismatch: 0,
        unknown: 0,
        ledgerUnverified: 0,
        fullyPresent: true,
        loadedRows: 0,
        earliestExpiry: null,
        daysToExpiry: null,
        atRisk: false,
        urgent: false,
        riskReason: null,
        expiryDisagreements: 0,
      };
      byKey.set(key, r);
    }

    r.jobCount++;
    r.states[job.state] = (r.states[job.state] ?? 0) + 1;
    if (job.state !== "QUOTED") r.submittedJobs++;
    r.costUsd += job.costUsd ?? 0;
    r.costQuoted += job.costUsdQuoted;
    r.ledgerFiles += job.files.length;
    r.ledgerBytes += job.files.reduce(
      (n, f) => n + (Number.isFinite(f.size) ? f.size : 0),
      0,
    );
    r.loadedRows += job.loadedRows;

    const { expiry, disagreementHours } = resolveExpiry(job);
    if (disagreementHours !== null) r.expiryDisagreements++;
    if (expiry && (!r.earliestExpiry || expiry < r.earliestExpiry))
      r.earliestExpiry = expiry;

    const p = summarisePresence(presenceByRow.get(job.rowId) ?? []);
    r.present += p.present;
    r.absent += p.absent;
    r.mismatch += p.mismatch;
    r.unknown += p.unknown;
    r.ledgerUnverified += p.ledgerUnverified;
    r.gcsBytes += p.gcsBytes;
    // A QUOTED row was never submitted, so it has nothing to be missing. Judging
    // it incomplete would paint every entry red for a row that cost nothing and
    // holds nothing.
    if (job.state !== "QUOTED" && !p.fullyPresent) r.fullyPresent = false;
  }

  for (const r of byKey.values()) {
    r.daysToExpiry = daysUntil(r.earliestExpiry, now);
    r.urgent = r.daysToExpiry !== null && r.daysToExpiry <= EXPIRY_ALARM_DAYS;
    // INCOMPLETENESS is the alarm. Expiry proximity sets URGENCY; it does not
    // gate the alarm, and gating it was a defect this script proved on its own
    // first run: three purchased files were absent with 25 days of vendor
    // retention left, and the report printed "no entry is at re-purchase risk".
    // Nothing schedules this script — it is hand-invoked — so a window-gated
    // alarm can be missed on every run that ever happens: run it monthly on the
    // 1st against an entry expiring on the 20th and it never once fires.
    r.atRisk = r.submittedJobs > 0 && !r.fullyPresent;
    if (r.atRisk) {
      const what =
        r.absent > 0 || r.mismatch > 0
          ? `${r.absent} absent + ${r.mismatch} size-mismatched`
          : r.ledgerUnverified > 0
            ? `${r.ledgerUnverified} present in GCS but UNVERIFIED by the ledger (possible corrupt object)`
            : r.unknown > 0
              ? `${r.unknown} could NOT be verified`
              : "nothing archived at all";
      const when =
        r.daysToExpiry === null
          ? "no expiry recorded"
          : r.daysToExpiry < 0
            ? `EXPIRED ${Math.abs(r.daysToExpiry).toFixed(1)} d ago`
            : `${r.daysToExpiry.toFixed(1)} d of vendor retention left`;
      r.riskReason = `${what} — ${when}`;
    }
  }

  return [...byKey.values()].sort((a, b) => a.entryId.localeCompare(b.entryId));
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
  );
  const n = bytes / 1024 ** i;
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

/** `harvested?` / `verified?` as words, never a bare tick that hides a state. */
export function harvestedVerdict(r: EntryRollup): string {
  if (r.ledgerFiles === 0) {
    const submitted = r.jobCount - (r.states.QUOTED ?? 0);
    return submitted === 0
      ? "**NO** — quoted, never submitted"
      : "**NO** — no files recorded";
  }
  return `yes — ${formatCount(r.ledgerFiles)} files`;
}

export function verifiedVerdict(r: EntryRollup): string {
  if (r.ledgerFiles === 0) return "n/a";
  if (r.ledgerUnverified > 0)
    return `**NO** — ${formatCount(r.ledgerUnverified)} present but ledger-unverified`;
  if (r.unknown > 0 && r.absent === 0 && r.mismatch === 0)
    return `**UNVERIFIED** — ${formatCount(r.unknown)} unreadable`;
  if (r.absent > 0 || r.mismatch > 0)
    return `**NO** — ${formatCount(r.absent)} absent, ${formatCount(r.mismatch)} mismatch`;
  return `yes — ${formatCount(r.present)}/${formatCount(r.ledgerFiles)} in GCS`;
}

export interface CandleRollup {
  timeframe: string;
  rows: number;
  symbols: number;
  /** Year span of the rows RESIDENT IN MONGO — the hot window, not the load. */
  minYear: number | null;
  maxYear: number | null;
}

export interface InventoryReport {
  generatedAt: string;
  commit: string;
  month: string;
  bucket: string;
  database: string;
  rollups: EntryRollup[];
  candles: CandleRollup[] | null;
  candlesNote: string | null;
  manifestOnlyEntries: string[];
  /** Every file that is not PRESENT, so "3 absent" is actionable. */
  problems: PresenceResult[];
  /** Ledger records with no usable `archiveKey`; never silently dropped. */
  droppedRecords: number;
  now: Date;
}

/** How many problem keys the report names before it summarises the rest. */
export const MAX_PROBLEM_KEYS = 25;

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [header, header.map(() => "---"), ...rows]
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n");
}

export function renderInventory(rep: InventoryReport): string {
  const out: string[] = [];
  const risky = rep.rollups.filter((r) => r.atRisk);

  out.push(`# Databento inventory — ${rep.month}`);
  out.push("");
  out.push(
    `> What EXISTS, as against what plan v2.1 §3 says each entry is FOR. Generated by \`scripts/ops/databento-inventory.ts\` (read-only) at ${rep.generatedAt} from commit \`${rep.commit}\`. Bucket \`${rep.bucket}\`, database \`${rep.database}\`.`,
  );
  out.push("");

  out.push("## Re-purchase risk");
  out.push("");
  // The policy renders in BOTH branches. It used to sit only in the all-clear
  // arm, so the one reader who most needed it — someone looking at a red entry
  // — was the one reader who never saw why it was red.
  out.push(
    `**Vendor files expire ${VENDOR_RETENTION_DAYS} days after SUBMISSION** — not after completion, which is the reading that leaves a job less time than it appears to have. Past that the only remedy is to buy the range again at usage prices, after the Standard subscription has lapsed.`,
  );
  out.push("");
  if (risky.length === 0) {
    out.push(
      "Every submitted entry is fully present in GCS and vouched for by the ledger.",
    );
  } else {
    const urgent = risky.filter((r) => r.urgent).length;
    out.push(
      `🔴 **${risky.length} entr${risky.length === 1 ? "y is" : "ies are"} incomplete**, of which **${urgent}** ${urgent === 1 ? "is" : "are"} inside the ${EXPIRY_ALARM_DAYS}-day vendor window.`,
    );
    out.push("");
    out.push(
      "Incompleteness is the alarm; expiry proximity only ranks it. Gating the alarm on the window would be unsound here — nothing schedules this script, so an entry can go from comfortable to expired between two hand-invoked runs and never once be flagged.",
    );
    out.push("");
    out.push(
      table(
        ["", "Entry", "env", "Expiry", "Reason"],
        risky
          .slice()
          .sort((a, b) => (a.daysToExpiry ?? 1e9) - (b.daysToExpiry ?? 1e9))
          .map((r) => [
            r.urgent ? "🔴" : "⚠️",
            `\`${r.entryId}\``,
            r.env,
            r.earliestExpiry
              ? r.earliestExpiry.toISOString().slice(0, 10)
              : "—",
            r.riskReason ?? "",
          ]),
      ),
    );
  }
  out.push("");

  out.push("## Entries");
  out.push("");
  out.push(
    table(
      [
        "Entry",
        "env",
        "Schema",
        "Jobs",
        "Harvested?",
        "Verified?",
        "Loaded rows",
        "GCS bytes",
        "Expiry",
        "Consumer (plan v2.1 §3)",
      ],
      rep.rollups.map((r) => [
        `${r.atRisk ? "🔴 " : ""}\`${r.entryId}\``,
        r.env,
        `\`${r.schema}\``,
        `${r.jobCount} (${Object.entries(r.states)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ")})`,
        harvestedVerdict(r),
        verifiedVerdict(r),
        r.loadedRows > 0 ? formatCount(r.loadedRows) : "— (archive-only)",
        formatBytes(r.gcsBytes),
        r.earliestExpiry
          ? `${r.earliestExpiry.toISOString().slice(0, 10)} (${r.daysToExpiry !== null ? `${r.daysToExpiry.toFixed(0)} d` : "—"})`
          : "—",
        consumerFor(r.schema),
      ]),
    ),
  );
  out.push("");
  out.push(
    "`Loaded rows` is the ledger's own `loadedRows`, summed. It reads `— (archive-only)` where the manifest sets `load:false`; that is the intended state for those entries, not a gap.",
  );

  const disagree = rep.rollups.filter((r) => r.expiryDisagreements > 0);
  if (disagree.length > 0) {
    out.push("");
    out.push(
      `⚠️ **Expiry disagreement** on ${disagree.map((r) => `\`${r.entryId}\` (${r.expiryDisagreements})`).join(", ")} — the vendor's \`tsExpiration\` and \`submittedAt + ${VENDOR_RETENTION_DAYS}d\` differ by an hour or more. The EARLIER is used throughout, because a re-purchase risk must never be under-stated; but a systematic difference is a vendor policy change worth reading, not smoothing over.`,
    );
  }

  if (rep.droppedRecords > 0) {
    out.push("");
    out.push(
      `⚠️ **${formatCount(rep.droppedRecords)} ledger file record(s) carried no usable \`archiveKey\`** and could not be checked at all. They are excluded from every count above, so the "N/N in GCS" figures are over a DENOMINATOR that is short by this much.`,
    );
  }

  if (rep.manifestOnlyEntries.length > 0) {
    out.push("");
    out.push(
      `⚠️ **In the manifest, absent from the ledger:** ${rep.manifestOnlyEntries.map((e) => `\`${e}\``).join(", ")}. Never quoted, never submitted — so there is nothing to expire and nothing to lose, but also nothing harvested.`,
    );
  }

  out.push("");
  out.push("## Cost and file ledger");
  out.push("");
  out.push(
    table(
      [
        "Entry",
        "env",
        "Cost USD (actual)",
        "Quoted",
        "Files in ledger",
        "Ledger bytes",
        "GCS bytes",
        "Present",
        "Absent",
        "Mismatch",
        "Unreadable",
        "Ledger-unverified",
      ],
      rep.rollups.map((r) => [
        `\`${r.entryId}\``,
        r.env,
        r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : "$0.00",
        `$${r.costQuoted.toFixed(2)}`,
        formatCount(r.ledgerFiles),
        formatBytes(r.ledgerBytes),
        formatBytes(r.gcsBytes),
        formatCount(r.present),
        r.absent > 0 ? `**${formatCount(r.absent)}**` : "0",
        r.mismatch > 0 ? `**${formatCount(r.mismatch)}**` : "0",
        r.unknown > 0 ? `**${formatCount(r.unknown)}**` : "0",
        r.ledgerUnverified > 0 ? `**${formatCount(r.ledgerUnverified)}**` : "0",
      ]),
    ),
  );
  out.push("");
  out.push(
    "`Ledger-unverified` counts files that ARE in the bucket and that the harvest's own ledger marks `verified: false`. `downloadToArchive` writes to GCS before it digests and its cleanup delete is `.catch(() => {})`, so a corrupt object can outlive the checksum failure that produced it — present, correctly sized, and bad. A GCS HEAD cannot see that; only the ledger can.",
  );
  out.push("");
  out.push(
    "`cost_usd` is NULL at submission and only appears once the vendor has processed the job, so a $0.00 actual against a non-zero quote means the row has not been priced yet — never that it was free. A window included in the Standard subscription genuinely quotes $0.00.",
  );

  if (rep.problems.length > 0) {
    out.push("");
    out.push("## Files that are NOT present");
    out.push("");
    out.push(
      `${formatCount(rep.problems.length)} of the ledger's file records did not verify. A count alone is not actionable — these are the keys.`,
    );
    out.push("");
    out.push(
      table(
        ["State", "Archive key", "Ledger size", "GCS size"],
        rep.problems
          .slice(0, MAX_PROBLEM_KEYS)
          .map((p) => [
            `**${p.state}**`,
            `\`${p.archiveKey}\``,
            formatBytes(p.ledgerSize),
            p.gcsSize === undefined ? "—" : formatBytes(p.gcsSize),
          ]),
      ),
    );
    if (rep.problems.length > MAX_PROBLEM_KEYS) {
      out.push("");
      out.push(
        `…and ${formatCount(rep.problems.length - MAX_PROBLEM_KEYS)} more.`,
      );
    }
  }

  out.push("");
  out.push("## Loaded into Mongo `candles`");
  out.push("");
  if (!rep.candles) {
    out.push(`> NOT COUNTED — ${rep.candlesNote ?? "no reason recorded"}.`);
  } else if (rep.candles.length === 0) {
    out.push(
      "**Zero rows** carry the Databento source. Every `load:true` entry above is unloaded.",
    );
  } else {
    out.push(
      table(
        ["Timeframe", "Rows in Mongo", "Distinct symbols", "Year span"],
        rep.candles.map((c) => [
          `\`${c.timeframe}\``,
          formatCount(c.rows),
          formatCount(c.symbols),
          c.minYear === null
            ? "—"
            : c.minYear === c.maxYear
              ? String(c.minYear)
              : `${c.minYear}–${c.maxYear}`,
        ]),
      ),
    );
    out.push("");
    out.push(
      `Total **${formatCount(rep.candles.reduce((n, c) => n + c.rows, 0))}** rows. Counted by \`source\`, which is the only column that says where a bar came from — \`D1\` must never appear here, because Databento may not displace a daily bar and the counter for that is required to read zero forever.`,
    );
    out.push("");
    out.push(
      [
        "### These rows do NOT reconcile with `Loaded rows` above, and must not",
        "",
        "The two columns measure different things and the gap looks like catastrophic data loss if they are read as one:",
        "",
        "- **`Loaded rows`** is the LEDGER's cumulative count — every row the loader wrote, across the entry's whole range back to the 2023-03-28 history floor.",
        "- **`Rows in Mongo`** is what is RESIDENT NOW, which for intraday is only the hot window. Everything older lives in the GCS cold shards at `candles/{market}/{timeframe}/{symbol}/{year}`, and `CandleRepository` merges the two on read.",
        "",
        "The year span column is the evidence: every Databento row in Mongo carries `tier: WINDOW` and falls inside the current window, with nothing from the earlier years the loader certainly wrote. A reader comparing 151,481,533 against 6,118,096 would conclude 96 % of the load vanished; what actually happened is that it was evicted to cold storage exactly as designed.",
        "",
        "So a shrinking `Rows in Mongo` is not by itself a defect — but `Rows in Mongo` reaching ZERO for a `load:true` entry would be, and so would a year span that stops advancing.",
      ].join("\n"),
    );
  }

  out.push("");
  out.push("## How to re-run");
  out.push("");
  out.push(
    [
      "```bash",
      "npx tsx scripts/ops/databento-inventory.ts            # read-only, ~66k GCS HEADs",
      "npx tsx scripts/ops/databento-inventory.ts --month=2026-10",
      "```",
      "",
      'It reads `MONGODB_URI_RO_PROD` and `GCP_SERVICE_ACCOUNT_KEY_BASE64` from Secret Manager and issues no write of any kind. It never calls `listFiles`: that fails open to `[]`, so a listing can never be the basis of an "it is missing" verdict — every key checked here comes from the ledger\'s own `archiveKey`.',
    ].join("\n"),
  );
  out.push("");
  return out.join("\n");
}
