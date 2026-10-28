/**
 * The Atlas heat map's arithmetic and rendering — the pure half of the G0 gate.
 *
 * The I/O shell is `scripts/ops/atlas-heatmap.ts`; it connects, gathers and
 * writes the files. Everything here is a pure function over already-gathered
 * numbers, so `packages/core/__tests__/ops/atlas-heatmap.test.ts` exercises it
 * without a cluster.
 *
 * ## Why this is a SEPARATE module from the script, and not exported from it
 *
 * Not style. The repo root `package.json` declares no `"type"`, so it is
 * CommonJS, and every `.ts` under `scripts/` is loaded as CJS. `packages/core`
 * and `workers` declare `"type": "module"`. An ESM test importing a CJS module
 * gets whatever `cjs-module-lexer` can statically detect from the transpiled
 * output, which for these functions is nothing but `default` — the named
 * imports fail at instantiation with "does not provide an export named …",
 * which reads like a missing export rather than a module-system boundary.
 *
 * That boundary is why `packages/core/src/ops/qa-sample-plan.ts` exists beside
 * the thin `scripts/ops/qa-sample-plan.ts` CLI, and why the workers' script
 * logic files are spelled `.mjs`. `apps/web` can import a script directly only
 * because it is CommonJS too.
 *
 * ## The traps these functions exist to avoid
 *
 * Each is a defect that would render as a clean, plausible report:
 *
 *   - a DB-wide index ranking implemented as a per-collection top-N, which is
 *     indistinguishable from the correct answer on any fixture where one
 *     collection does not dominate — and `candles` dominates;
 *   - a `$collStats` fold that reads `docs[0]`, under-counting a sharded
 *     cluster by the shard count;
 *   - an `avgObjSize` taken as the mean of per-shard averages, which is only
 *     correct when every shard holds the same number of documents;
 *   - a cube fold that FILTERS rows whose `source` attribute is absent. A Mongo
 *     `db push` creates indexes and not fields, so a column added later is
 *     ABSENT on every pre-existing row; that class has caused MONEY-1050,
 *     MONEY-1205, MONEY-1234 and MONEY-1235. Absent is a NAMED bucket here.
 */

/** How many collections get an `$indexStats` capture. */
export const INDEX_STATS_COLLECTIONS = 15;
/** How many indexes the "largest indexes" table lists, DB-wide. */
export const TOP_INDEXES = 10;

// ---------------------------------------------------------------------------
// Types — also the shape of the emitted JSON, so B6 reads these names.
// ---------------------------------------------------------------------------

export interface CollectionStats {
  name: string;
  /** "collection" | "timeseries" — a timeseries `count` counts BUCKETS. */
  type: string;
  count: number;
  avgObjSize: number;
  storageSize: number;
  totalIndexSize: number;
  indexCount: number;
  indexSizes: Record<string, number>;
}

export interface IndexEntry {
  collection: string;
  index: string;
  sizeBytes: number;
}

/** One row of the `candles` cube: the compound group, un-nested. */
export interface CubeRow {
  timeframe: string;
  source: string;
  year: number | null;
  docs: number;
}

export interface Breakdowns {
  byTimeframe: Array<{ key: string; docs: number }>;
  bySource: Array<{ key: string; docs: number }>;
  byYear: Array<{ key: string; docs: number }>;
}

export interface IndexStatsDoc {
  collection: string;
  index: string;
  /** WHICH MEMBER served this. Index counters are per-node. */
  host: string;
  ops: number;
  /** Counter epoch. Moves forward on a mongod restart — see the header. */
  since: string;
}

export interface ClusterReport {
  label: string;
  /** Connection host with every credential stripped. */
  hostRedacted: string;
  /** Which credential produced these numbers — stamped into the markdown. */
  credential: string;
  dbName: string;
  serverVersion: string;
  dbStats: {
    collections: number;
    objects: number;
    dataSize: number;
    storageSize: number;
    indexes: number;
    indexSize: number;
  };
  collections: CollectionStats[];
  candles: { cube: CubeRow[]; breakdowns: Breakdowns } | null;
  candlesNote: string | null;
  indexStats: IndexStatsDoc[];
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so `atlas-heatmap-readonly.test.ts` can exercise them
// without a cluster.
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
  );
  const scaled = bytes / 1024 ** i;
  return `${scaled.toFixed(i === 0 ? 0 : scaled >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

/**
 * Fold one `$collStats` result into a row.
 *
 * The array is one document PER SHARD. Atlas M40 is a replica set, so today it
 * is always length 1 — but summing a one-element array is the same code as
 * summing four, and taking `docs[0]` is a silent 4x under-count on the day the
 * cluster is sharded. `avgObjSize` is RECOMPUTED from the summed dataSize
 * rather than averaged, because an average of per-shard averages is only
 * correct when every shard holds the same number of documents.
 */
export function summariseCollStats(
  name: string,
  type: string,
  docs: ReadonlyArray<Record<string, unknown>>,
): CollectionStats {
  let count = 0;
  let dataSize = 0;
  let storageSize = 0;
  let totalIndexSize = 0;
  let indexCount = 0;
  const indexSizes: Record<string, number> = {};

  for (const doc of docs) {
    const s = (doc.storageStats ?? {}) as Record<string, unknown>;
    count += num(s.count);
    dataSize += num(s.size);
    storageSize += num(s.storageSize);
    totalIndexSize += num(s.totalIndexSize);
    indexCount = Math.max(indexCount, num(s.nindexes));
    for (const [idx, size] of Object.entries(
      (s.indexSizes ?? {}) as Record<string, number>,
    )) {
      indexSizes[idx] = (indexSizes[idx] ?? 0) + num(size);
    }
  }

  return {
    name,
    type,
    count,
    avgObjSize: count > 0 ? dataSize / count : 0,
    storageSize,
    totalIndexSize,
    indexCount,
    indexSizes,
  };
}

function num(v: unknown): number {
  const n = typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Footprint = what deleting the collection would actually give back. */
export function footprint(c: CollectionStats): number {
  return c.storageSize + c.totalIndexSize;
}

/**
 * The N largest indexes ACROSS THE DATABASE.
 *
 * Deliberately a flatten-then-sort over every collection's `indexSizes`, not a
 * top-N per collection concatenated: the latter reads identically on a
 * two-collection fixture and is wrong the moment one collection owns six of the
 * ten biggest indexes — which is precisely the shape `candles` is expected to
 * have, and precisely the question this table exists to answer.
 */
export function rankIndexes(
  collections: readonly CollectionStats[],
  n: number,
): IndexEntry[] {
  return collections
    .flatMap((c) =>
      Object.entries(c.indexSizes).map(([index, sizeBytes]) => ({
        collection: c.name,
        index,
        sizeBytes,
      })),
    )
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, n);
}

/**
 * Fold the compound cube into the three requested breakdowns.
 *
 * Every row is counted once into EACH breakdown — the totals of all three are
 * equal to each other and to the collection count. A fold that iterated the
 * cube once per breakdown over a filtered subset would silently drop rows whose
 * `source` is absent (a `db push` creates indexes, not fields), which is the
 * MONEY-1050 / 1234 / 1235 class; hence the `?? "(absent)"` naming rather than
 * a filter.
 */
export function foldCube(cube: readonly CubeRow[]): Breakdowns {
  const tf = new Map<string, number>();
  const src = new Map<string, number>();
  const yr = new Map<string, number>();

  for (const row of cube) {
    add(tf, row.timeframe ?? "(absent)", row.docs);
    add(src, row.source ?? "(absent)", row.docs);
    add(
      yr,
      row.year === null || row.year === undefined
        ? "(no ts)"
        : String(row.year),
      row.docs,
    );
  }

  return {
    byTimeframe: sortDesc(tf),
    bySource: sortDesc(src),
    byYear: [...yr.entries()]
      .map(([key, docs]) => ({ key, docs }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function add(m: Map<string, number>, key: string, docs: number): void {
  m.set(key, (m.get(key) ?? 0) + docs);
}

/**
 * How long the index-usage counters have actually been counting.
 *
 * Without it, "25 of 73 indexes at zero ops" reads as evidence of 25 dead
 * indexes whatever the window — and the window here was THREE DAYS, because the
 * mongod serving the workload restarted. A count with no denominator is the
 * shape MONEY-1401's own gate shipped and had to be corrected for: a ratio that
 * looks measured and is not.
 */
export function observedWindowDays(since: string, generatedAt: string): number {
  const from = Date.parse(since);
  const to = Date.parse(generatedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return (to - from) / 86_400_000;
}

function sortDesc(
  m: Map<string, number>,
): Array<{ key: string; docs: number }> {
  return [...m.entries()]
    .map(([key, docs]) => ({ key, docs }))
    .sort((a, b) => b.docs - a.docs);
}

/**
 * First value that is present AND not blank.
 *
 * Deliberately not `??`. A `.env` line written as `MONGODB_URI_RO=` — the
 * placeholder shape every example file ships — is an empty STRING, which `??`
 * accepts as an answer and then opens a connection to "". claude-algo was bitten
 * by exactly this on 31 Jul 2026 and now documents it in three places
 * (`packages/db/src/prisma.ts`, `apps/dashboard/lib/db.ts`, `lib/control.ts`);
 * the trap is copied here rather than rediscovered. Whitespace-only is blank
 * too, which a bare `||` would let through.
 */
export function firstNonBlank(
  ...values: ReadonlyArray<string | undefined>
): string | undefined {
  for (const v of values) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * Strip every credential from a connection string. FAILS CLOSED.
 *
 * The first version was `/\/\/[^@/]*@/` — userinfo matched as "anything but a
 * slash or an at-sign". A MongoDB password may legally contain an UNENCODED
 * `/`, and on one the pattern simply did not match, so `.replace` returned the
 * string UNCHANGED and the full credential was printed. Measured, not
 * theorised: `mongodb+srv://user:pa/ss@h.mongodb.net/db` came back verbatim.
 *
 * That is exactly the defect `run-market-data-job.sh` already carries a note
 * about — "The redactor fails CLOSED — the first version matched only
 * `mongodb+srv://` and printed the string unchanged when it missed, so its
 * first real run against a plain-`mongodb://` QA cluster echoed full
 * credentials". A redactor whose failure mode is DISCLOSURE is worse than no
 * redactor, because the caller believes it worked.
 *
 * So the parse runs right-to-left and anything unrecognised is reduced to the
 * scheme rather than passed through: userinfo ends at the LAST `@` before the
 * path, because a host cannot contain one while a password can.
 */
export function redactUri(uri: string): string {
  const schemeEnd = uri.indexOf("://");
  if (schemeEnd < 0) return "<unparseable connection string>";
  const scheme = uri.slice(0, schemeEnd + 3);
  const rest = uri.slice(schemeEnd + 3);

  // Query first: it can hold its own secrets, and a `@` inside it is not userinfo.
  const authorityAndPath = rest.split("?")[0] ?? "";
  const at = authorityAndPath.lastIndexOf("@");
  const afterCreds = at < 0 ? authorityAndPath : authorityAndPath.slice(at + 1);

  const slash = afterCreds.indexOf("/");
  const host = slash < 0 ? afterCreds : afterCreds.slice(0, slash);
  const path = slash < 0 ? "" : afterCreds.slice(slash);

  // A host is letters, digits, dots, dashes, colons and commas (seed lists).
  // Anything else means the parse is not understood — say so, print nothing.
  if (!host || !/^[A-Za-z0-9.\-:,]+$/.test(host))
    return `${scheme}<redacted — unparseable>`;
  if (/[^A-Za-z0-9._\-/~]/.test(path))
    return `${scheme}${at < 0 ? "" : "<credentials>@"}${host}/<redacted>`;

  return `${scheme}${at < 0 ? "" : "<credentials>@"}${host}${path}`;
}

// ---------------------------------------------------------------------------
// Rendering — pure.
// ---------------------------------------------------------------------------

/**
 * The invoice cannot be fetched. Atlas bills through the Cloud console and
 * exposes it only to an Admin-API key pair we deliberately do not hold, so the
 * numbers that decide whether M40 -> M30 is worth doing are pasted by hand.
 * The table ships EMPTY rather than pre-filled with a guess: a plausible
 * placeholder that nobody replaces is indistinguishable from a measurement,
 * which is the defect this whole gate exists to prevent.
 */
export const INVOICE_ROWS = [
  "Instance (tier-hours)",
  "Storage (GB-month)",
  "Backup — continuous / snapshot",
  "Data transfer — same region",
  "Data transfer — cross region / internet",
  "Other (BI Connector, Search, Charts)",
] as const;

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const sep = header.map(() => "---");
  return [header, sep, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

export function renderCluster(r: ClusterReport, generatedAt: string): string {
  const sorted = [...r.collections].sort((a, b) => footprint(b) - footprint(a));
  const out: string[] = [];

  out.push(`## ${r.label}`);
  out.push("");
  out.push(
    table(
      ["Field", "Value"],
      [
        ["Host", `\`${r.hostRedacted}\``],
        ["Database", `\`${r.dbName}\``],
        ["Server version", r.serverVersion],
        ["Credential", r.credential],
        ["Collections", formatCount(r.dbStats.collections)],
        ["Documents", formatCount(r.dbStats.objects)],
        ["Data size (uncompressed)", formatBytes(r.dbStats.dataSize)],
        ["Storage size (on disk)", formatBytes(r.dbStats.storageSize)],
        ["Indexes", formatCount(r.dbStats.indexes)],
        ["Index size", formatBytes(r.dbStats.indexSize)],
        [
          "**Total footprint**",
          `**${formatBytes(r.dbStats.storageSize + r.dbStats.indexSize)}**`,
        ],
      ],
    ),
  );

  out.push("");
  out.push(`### Collections — every one, by footprint (storage + indexes)`);
  out.push("");
  out.push(
    table(
      [
        "#",
        "Collection",
        "Docs",
        "avgObjSize",
        "Storage",
        "Index total",
        "Indexes",
        "Footprint",
      ],
      sorted.map((c, i) => [
        String(i + 1),
        `\`${c.name}\`${c.type === "timeseries" ? " ⏱" : ""}`,
        formatCount(c.count),
        formatBytes(c.avgObjSize),
        formatBytes(c.storageSize),
        formatBytes(c.totalIndexSize),
        String(c.indexCount),
        formatBytes(footprint(c)),
      ]),
    ),
  );
  if (sorted.some((c) => c.type === "timeseries")) {
    out.push("");
    out.push(
      "⏱ = time-series collection; its `Docs` counts BUCKETS, not measurements.",
    );
  }

  out.push("");
  out.push(`### The ${TOP_INDEXES} largest indexes in the database`);
  out.push("");
  out.push(
    table(
      ["#", "Collection", "Index", "Size"],
      rankIndexes(r.collections, TOP_INDEXES).map((e, i) => [
        String(i + 1),
        `\`${e.collection}\``,
        `\`${e.index}\``,
        formatBytes(e.sizeBytes),
      ]),
    ),
  );

  out.push("");
  out.push("### `candles` breakdown");
  out.push("");
  if (!r.candles) {
    out.push(`> NOT CAPTURED — ${r.candlesNote ?? "no reason recorded"}.`);
    out.push(">");
    out.push(
      "> This is a named absence, not an empty result: an unmeasured breakdown and a breakdown that is genuinely zero must never render the same.",
    );
  } else {
    const b = r.candles.breakdowns;
    const total = b.byTimeframe.reduce((s, x) => s + x.docs, 0);
    out.push(
      `Single \`$group\` pass, compound \`_id\`, \`allowDiskUse\`. Cube rows: ${r.candles.cube.length}. Documents: ${formatCount(total)}.`,
    );
    for (const [title, rows] of [
      ["By `timeframe`", b.byTimeframe],
      ["By `source`", b.bySource],
      ["By year of `ts`", b.byYear],
    ] as const) {
      out.push("");
      out.push(`#### ${title}`);
      out.push("");
      out.push(
        table(
          ["Key", "Docs", "% of collection"],
          rows.map((x) => [
            `\`${x.key}\``,
            formatCount(x.docs),
            total > 0 ? `${((x.docs / total) * 100).toFixed(1)}%` : "—",
          ]),
        ),
      );
    }
  }

  out.push("");
  out.push("### `$indexStats` capture");
  out.push("");
  if (r.indexStats.length === 0) {
    out.push("> NOT CAPTURED — see the run log.");
  } else {
    const hosts = [...new Set(r.indexStats.map((d) => d.host))];
    const sinces = [...new Set(r.indexStats.map((d) => d.since))].sort();
    out.push(
      `${r.indexStats.length} indexes across ${new Set(r.indexStats.map((d) => d.collection)).size} of the ${INDEX_STATS_COLLECTIONS} largest collections, read from **${hosts.join(", ")}** (pinned to the PRIMARY — the counters are per-node). A collection whose \`$indexStats\` call failed contributes nothing here, so this is the coverage ACHIEVED rather than the coverage attempted.`,
    );
    out.push("");
    // The LATEST epoch, not the earliest. `sinces` is sorted ascending, so
    // `[0]` is the OLDEST — and grading against it gives the LONGEST window,
    // which suppresses the disclaimer exactly when it is most needed: an
    // index created yesterday would be judged over 62 days and its zero ops
    // read as evidence. The shortest observed window is the only one every
    // index in the capture has actually been counted for.
    const windowDays = observedWindowDays(
      sinces[sinces.length - 1]!,
      generatedAt,
    );
    out.push(
      `Counter epoch \`accesses.since\`: ${sinces[0]}${sinces.length > 1 ? ` … ${sinces[sinces.length - 1]}` : ""}. **A later capture whose \`since\` has moved forward means that mongod restarted and the usage comparison is VOID, not clean.**`,
    );
    out.push("");
    const zero = r.indexStats.filter((d) => d.ops === 0 && d.index !== "_id_");
    out.push(
      `Indexes at **zero ops** (excluding \`_id_\`): **${zero.length}** of ${r.indexStats.length}.`,
    );
    out.push("");
    out.push(
      `**OBSERVED WINDOW: ${windowDays.toFixed(1)} DAYS** — from the epoch above to this capture. ` +
        (windowDays >= 30
          ? "Long enough that a weekly job has had several chances to run; a monthly one has had one."
          : `**That is the number to read the zero-op count against, and it is short.** ${zero.length} of ${r.indexStats.length} indexes unused over ${windowDays.toFixed(1)} days is not evidence that they are unused — a weekly job has had ${Math.floor(windowDays / 7)} chance(s) to run and a monthly one has had none. The counters are per-node and reset when that mongod restarted, so this capture is a BASELINE, not a verdict.`),
    );
    out.push("");
    out.push(
      "Full per-index detail is in the companion JSON; the zero-op tail is what B6 reads.",
    );
  }

  return out.join("\n");
}

export function renderMarkdown(
  month: string,
  generatedAt: string,
  commit: string,
  clusters: readonly ClusterReport[],
  skipped: readonly string[],
): string {
  const out: string[] = [];
  out.push(`# Atlas heat map — ${month}`);
  out.push("");
  out.push(
    `> **The G0 gate.** Nothing is deleted from Mongo before this document exists. Generated by \`scripts/ops/atlas-heatmap.ts\` (read-only) at ${generatedAt} from commit \`${commit}\`. Re-run with \`--month=YYYY-MM\` for the 30-day comparison B6 needs.`,
  );
  out.push("");
  out.push("Companion capture: `atlas-indexstats-" + month + ".json`.");
  out.push("");
  for (const s of skipped) out.push(`> ⚠️ ${s}`);
  if (skipped.length) out.push("");

  out.push("---");
  out.push("");
  for (const c of clusters) {
    out.push(renderCluster(c, generatedAt));
    out.push("");
    out.push("---");
    out.push("");
  }

  out.push("## Invoice");
  out.push("");
  out.push(
    "**The script cannot fetch this.** Atlas bills through the Cloud console and exposes the invoice only to an Admin-API key pair this project deliberately does not hold, so these cells are pasted by hand from the Atlas invoice (Organization → Billing → Invoices → the month above → *View Invoice* / *Download CSV*).",
  );
  out.push("");
  out.push(
    "The rows ship EMPTY on purpose. A plausible placeholder nobody replaces is indistinguishable from a measurement, and the M40 → M30 decision is the one thing this file exists to inform.",
  );
  out.push("");
  out.push(
    table(
      ["Line item", "Quantity", "Unit", "USD", "Notes"],
      [
        ...INVOICE_ROWS.map((r) => [r, "", "", "", ""]),
        ["**Total**", "", "", "", ""],
      ],
    ),
  );
  out.push("");
  out.push(
    "Cross-check against the footprint tables above: `Storage (GB-month)` should track the summed **Total footprint**, and a large gap between them is itself a finding (oplog, snapshot retention, or an unmeasured database).",
  );
  out.push("");

  out.push("## The read-only credential");
  out.push("");
  // DERIVED from what this run actually used. The hardcoded sentence that used
  // to sit here claimed both clusters held a verified read-only URI even on a
  // run whose own banner said the algo cluster was NOT MEASURED, and even when
  // `--allow-rw` had stamped a read-WRITE credential two sections above.
  const roCount = clusters.filter((c) => /read-only/.test(c.credential)).length;
  const rwClusters = clusters.filter((c) => !/read-only/.test(c.credential));
  out.push(
    `${roCount} of ${clusters.length} measured cluster${clusters.length === 1 ? "" : "s"} used a **read-only** credential${
      rwClusters.length > 0
        ? `; ${rwClusters.map((c) => `\`${c.label}\``).join(", ")} did NOT — see the Credential row in each section above`
        : ""
    }. The read-only path needs no new Atlas user: it points at \`datadog_monitor\`, which MONEY-1377 already provisioned with \`clusterMonitor@admin\` + \`readAnyDatabase@admin\` — exactly the pair this capture needs (\`clusterMonitor\` authorises dbStats / collStats / indexStats, \`readAnyDatabase\` authorises the \`candles\` aggregation).`,
  );
  out.push("");
  out.push(
    "Verified 2026-09-14 against **both** clusters rather than assumed: authenticates, reads `dbStats`, `listCollections` and `$indexStats`, and an attempted `insertOne` is refused `Unauthorized`. The refusal is the half that matters — a user that merely *has not* written is not a user that *cannot*.",
  );
  out.push("");
  out.push(
    [
      "The two secrets this script reads are `MONGODB_URI_RO_PROD` (stockbook) and `ALGO_MONGODB_URI_RO_PROD` (claude-algo); the algo ladder mirrors that repo's own `MONGODB_URI_RO ?? MONGODB_URI` rule.",
      "",
      "**THE COUPLING, stated because it is invisible otherwise.** Both secrets embed the `datadog_monitor` PASSWORD, so they are a second consumer of `DD_MONGO_MONITOR_PASSWORD_PROD`. Rotate that password and the Datadog agent config is re-rendered by `setup-dbm-host.sh` while these two secrets keep the OLD value and start failing to authenticate.",
      "",
      "That is a loud failure, not a silent one — this script refuses and names the secret — but the fix is to add a new version to both, and there is nothing in the rotation path that says so. Re-run the creator after any rotation:",
      "",
      "```bash",
      "node scripts/ops/create-ro-secrets.mjs   # re-derives both from the current password",
      "```",
      "",
      "If a dedicated user is ever preferred over the shared one, create `heatmap_ro` in Atlas → Database Access with the same two built-in roles and add its SRV string as a new version of `MONGODB_URI_RO_PROD`. Nothing in this script changes — the ladder reads whatever that secret holds.",
    ].join("\n"),
  );
  out.push("");
  out.push("## What B6 does with the JSON");
  out.push("");
  out.push(
    [
      "`atlas-indexstats-" +
        month +
        ".json` is a capture, not a verdict. Thirty days later, `--month=` a fresh one and diff:",
      "",
      "- An index whose `ops` did not move **and** whose `since` did not move is a genuine zero-use candidate for the window.",
      "- An index whose `since` moved forward was counted from a reset — that mongod restarted, and the window is void for every index on that host.",
      "- A zero-op index is still not automatically droppable: weekly and monthly jobs may not have run inside the window, so each candidate needs its query shape grepped and its owning job's schedule checked before the `dropIndex`, with the rollback `createIndex` in the PR body.",
    ].join("\n"),
  );
  out.push("");
  return out.join("\n");
}
