/**
 * Sizing the Mumbai bucket before the US data moves to `us-east4` — pure half.
 *
 * The I/O shell is `scripts/ops/gcs-prefix-sizes.ts`. Inter-continental transfer
 * is billed per GiB, so D6 needs to know what each prefix actually weighs before
 * anything is copied.
 *
 * ## THE RATE IS AN INPUT, NEVER A CONSTANT
 *
 * No transfer price appears anywhere in this module or the script. It is
 * supplied per run and recorded in the emitted document beside the URL it was
 * read from and the date it was read. A hardcoded rate is a number that looks
 * measured, ages silently, and is wrong in whichever direction nobody checks —
 * and Google reprices without touching this repo. `formatUsd` will happily
 * render a cost from whatever rate it is handed; the provenance is what makes
 * the number mean anything.
 *
 * ## HALF THE RECOMMENDATION IS DECLARED, NOT MEASURED
 *
 * MOVE-vs-LEAVE-HISTORY needs two facts. Size is MEASURED from the bucket.
 * "Do US jobs read this daily?" cannot be — it is a property of the schedule,
 * not of the objects — so it is DECLARED in `DAILY_READ` with a reason per
 * entry, and the rendered table prints both inputs in their own columns. A
 * recommendation whose measured and assumed halves are indistinguishable is the
 * shape that gets acted on without anyone noticing which half was a guess.
 */

/** One measured group: a root prefix plus `groupDepth` path segments. */
export interface PrefixGroup {
  /** e.g. `edgar/filings` or `databento/EQUS.MINI/ohlcv-1m`. */
  prefix: string;
  /** The configured root this group fell under, e.g. `edgar/`. */
  root: string;
  objects: number;
  bytes: number;
  /** Bytes and counts per storage class: STANDARD, NEARLINE, … */
  byClass: Record<string, { objects: number; bytes: number }>;
}

export interface RootSpec {
  /** Trailing slash, always. */
  root: string;
  /** How many path segments BELOW the root to group by. */
  groupDepth: number;
  /** Why this root is in scope for the US move. */
  note: string;
}

/**
 * What to group, and how deep.
 *
 * DISCOVERED, not enumerated. The sub-prefixes are derived from the keys the
 * bucket actually returns rather than from a hand-written list, and that is not
 * fastidiousness: the S0c brief named `edgar/13f` (which does not exist) and
 * four children of `feeds/TIINGO/` when the bucket has seven — `eod`, `search`
 * and `supported-tickers` were missing from it. A hardcoded list would have
 * silently under-reported the transfer bill by whatever those weigh.
 */
export const ROOTS: readonly RootSpec[] = [
  {
    root: "edgar/",
    groupDepth: 1,
    note: "SEC filings archive (`edgar/filings` transitions to Nearline at 30 d)",
  },
  {
    root: "databento/",
    groupDepth: 2,
    note: "vendor bytes, bought once — `{dataset}/{schema}`",
  },
  { root: "feeds/TIINGO/", groupDepth: 1, note: "US feed archive" },
  {
    root: "candles/",
    groupDepth: 2,
    note: "cold shards — `{market}/{timeframe}`",
  },
];

/**
 * Which groups US jobs read on a DAILY cadence. DECLARED, not measured.
 *
 * Keys are matched as prefixes of the group name. Each entry carries the reason
 * so the document can print it and a reader can disagree with the premise
 * rather than only with the conclusion.
 */
export const DAILY_READ: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: "feeds/TIINGO/eod", reason: "`us-eod-sync` runs 11:00 IST daily" },
  {
    prefix: "feeds/TIINGO/news",
    reason: "the news poller runs every 2 minutes, 24x7",
  },
  {
    prefix: "feeds/TIINGO/ws",
    reason: "the realtime tick archive is written continuously",
  },
  {
    prefix: "feeds/TIINGO/supported-tickers",
    reason: "`us-instrument-master-sync` runs daily",
  },
  {
    prefix: "candles/US",
    reason:
      "`CandleRepository` merges cold shards on read, on the request path",
  },
];

export type Recommendation = "MOVE" | "LEAVE-HISTORY";

/**
 * Below this, transfer is cheap enough that splitting the data across two
 * buckets costs more in confusion than the copy costs in dollars.
 *
 * A SIZE threshold rather than a cost one, deliberately: cost moves with the
 * rate (an input), and a recommendation that flips when Google reprices is not
 * a recommendation. The cost column sits beside it so a reader can overrule.
 */
export const MOVE_CEILING_BYTES = 50 * 1024 ** 3; // 50 GiB

export function dailyReadReason(prefix: string): string | null {
  for (const d of DAILY_READ)
    if (prefix === d.prefix || prefix.startsWith(`${d.prefix}/`))
      return d.reason;
  return null;
}

export function recommend(g: PrefixGroup): {
  verdict: Recommendation;
  why: string;
} {
  const daily = dailyReadReason(g.prefix);
  if (daily) return { verdict: "MOVE", why: `read daily — ${daily}` };
  if (g.bytes <= MOVE_CEILING_BYTES)
    return {
      verdict: "MOVE",
      why: `under ${formatBytes(MOVE_CEILING_BYTES)}; splitting it costs more than copying it`,
    };
  return {
    verdict: "LEAVE-HISTORY",
    why: "large and not on a daily read path — new writes go to the US bucket from D6a, these objects stay and the ledger records both locations",
  };
}

/**
 * The group a key belongs to, or null when no configured root matches.
 *
 * Longest root wins, so `feeds/TIINGO/` claims a key before a hypothetical
 * `feeds/` root could. A key with FEWER segments than `groupDepth` groups at
 * the depth it has rather than being dropped — an object sitting directly under
 * a root is still bytes that must cross the ocean.
 */
export function groupFor(
  key: string,
  roots: readonly RootSpec[] = ROOTS,
): { prefix: string; root: string } | null {
  const matches = roots
    .filter((r) => key.startsWith(r.root))
    .sort((a, b) => b.root.length - a.root.length);
  const spec = matches[0];
  if (!spec) return null;

  const rest = key.slice(spec.root.length);
  const segments = rest.split("/");
  // The final segment is the object name, never a directory — grouping on it
  // would make one group per file.
  const dirs = segments.slice(0, -1);
  const take = dirs.slice(0, spec.groupDepth);
  const prefix =
    spec.root.replace(/\/$/, "") +
    (take.length > 0 ? `/${take.join("/")}` : "");
  return { prefix, root: spec.root };
}

/** Fold one object into its group, creating it on first sight. */
export function accumulate(
  groups: Map<string, PrefixGroup>,
  key: string,
  size: number,
  storageClass: string,
  roots: readonly RootSpec[] = ROOTS,
): void {
  const g = groupFor(key, roots);
  // Everything outside the configured roots still counts toward the bucket
  // total, bucketed by its first segment. Dropping it would make the total a
  // sum of the interesting parts rather than a total.
  //
  // THE NAME STAYS A REAL KEY PREFIX. It used to read `(other) stocks`, and
  // that decorative label made the group structurally unmatchable against a
  // lifecycle rule on `stocks/` — so 424 of the 428 GiB reported as "no
  // lifecycle rule at all" was a verdict the code could not compute, rendered
  // in red. Scope belongs in `root`, which is what the renderer already filters
  // on; encoding it in the identifier corrupts every join that identifier
  // participates in.
  const prefix = g?.prefix ?? key.split("/")[0] ?? "";
  const root = g?.root ?? OTHER_ROOT;

  let row = groups.get(prefix);
  if (!row) {
    row = { prefix, root, objects: 0, bytes: 0, byClass: {} };
    groups.set(prefix, row);
  }
  row.objects++;
  row.bytes += Number.isFinite(size) ? size : 0;
  const cls = (row.byClass[storageClass] ??= { objects: 0, bytes: 0 });
  cls.objects++;
  cls.bytes += Number.isFinite(size) ? size : 0;
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

export function gib(bytes: number): number {
  return bytes / 1024 ** 3;
}

/** Cost of moving `bytes` at `usdPerGib`. The rate is always supplied. */
export function transferUsd(bytes: number, usdPerGib: number): number {
  return gib(bytes) * usdPerGib;
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** A bucket lifecycle rule, as GCS returns it. */
export interface LifecycleRule {
  action: { type: string; storageClass?: string };
  condition: {
    age?: number;
    matchesPrefix?: string[];
    matchesStorageClass?: string[];
  };
}

/** Marks a group outside every configured root. A ROOT value, never part of a name. */
export const OTHER_ROOT = "(other)";

export type Coverage = "FULL" | "PARTIAL" | "NONE";

/** Trailing slash removed, so comparisons are between bare path prefixes. */
function bare(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Does `outer` contain `inner`, at a PATH SEGMENT boundary? */
function contains(outer: string, inner: string): boolean {
  return outer === "" || inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * A rule whose `condition` selects a subset of the objects it prefixes.
 *
 * `matchesPrefix` is the only condition the grouping can reason about. A rule
 * carrying `matchesStorageClass`, `createdBefore`, `numNewerVersions`,
 * `daysSinceNoncurrentTime` or `isLive` reaches only some of the objects under
 * its prefix, so it can never make a group FULLY covered — an all-STANDARD
 * prefix under a NEARLINE-only Delete has nothing scheduled to age it out, and
 * calling that covered is the same over-report as the prefix bugs below.
 * `age` alone is not selective: every object acquires an age.
 */
function isSelective(
  r: LifecycleRule,
  classesPresent?: readonly string[],
): boolean {
  const c = r.condition as Record<string, unknown>;
  const keys = Object.keys(c).filter(
    (k) => k !== "age" && k !== "matchesPrefix",
  );
  if (keys.length === 0) return false;

  // `matchesStorageClass` alone can be MEASURED against what the group holds,
  // and blanket-flagging it was an over-correction: a SetStorageClass rule
  // names its SOURCE class as idempotence plumbing, not as a gap. A
  // STANDARD→NEARLINE transition over an all-STANDARD prefix reaches every
  // object in it; calling that PARTIAL put a red flag on 8 of 23 rows and
  // buried the two that are real.
  //
  // Objects already AT the destination class need no rule, so the rule covers
  // the group when every class present is either selected or the target.
  if (
    keys.length === 1 &&
    keys[0] === "matchesStorageClass" &&
    classesPresent
  ) {
    const selected = new Set(
      (c.matchesStorageClass as string[] | undefined) ?? [],
    );
    if (r.action.type === "SetStorageClass" && r.action.storageClass) {
      selected.add(r.action.storageClass);
    }
    return !classesPresent.every((k) => selected.has(k));
  }
  return true;
}

/**
 * How much of this group a lifecycle rule set reaches.
 *
 * THREE states, because two over-reported in both directions:
 *
 *   - FULL    — a rule's prefix CONTAINS the group, so every object in the
 *               group is reached.
 *   - PARTIAL — a rule's prefix sits strictly INSIDE the group (it reaches some
 *               objects), or every reaching rule is condition-selective. The
 *               old code called both of these covered: a rule on
 *               `candles/US/D1/AAPL/` marked the whole `candles/US/D1` group
 *               covered while >99% of its bytes had nothing scheduled.
 *   - NONE    — nothing reaches it.
 *
 * Boundaries are per PATH SEGMENT. The old first disjunct was a bare
 * `startsWith` on a truncated group name, so a rule on `candles/US` claimed
 * `candles/USA`. That is not GCS parity — GCS matches a raw string prefix of
 * the OBJECT KEY, and an object key under `candles/USA/` does not start with
 * `candles/US/`.
 */
export function coverageFor(
  prefix: string,
  rules: readonly LifecycleRule[],
  classesPresent?: readonly string[],
): { coverage: Coverage; rules: LifecycleRule[] } {
  const g = bare(prefix);
  const reaching = rules.filter((r) => {
    const ps = r.condition.matchesPrefix;
    if (!ps || ps.length === 0) return true; // bucket-wide
    return ps.some((p) => contains(bare(p), g) || contains(g, bare(p)));
  });
  if (reaching.length === 0) return { coverage: "NONE", rules: [] };

  const full = reaching.filter((r) => {
    const ps = r.condition.matchesPrefix;
    const wholeGroup =
      !ps || ps.length === 0 || ps.some((p) => contains(bare(p), g));
    return wholeGroup && !isSelective(r, classesPresent);
  });
  return { coverage: full.length > 0 ? "FULL" : "PARTIAL", rules: reaching };
}

/** Back-compat shim: the rules that reach this group at all. */
export function rulesFor(
  prefix: string,
  rules: readonly LifecycleRule[],
): LifecycleRule[] {
  return coverageFor(prefix, rules).rules;
}

export function describeRule(r: LifecycleRule): string {
  const what =
    r.action.type === "SetStorageClass"
      ? `→ ${r.action.storageClass}`
      : r.action.type.toUpperCase();
  const age = r.condition.age === undefined ? "" : ` at ${r.condition.age} d`;
  // Extra conditions are NAMED. A rule rendered "DELETE at 30 d" that really
  // means "…but only NEARLINE objects" reads as coverage it does not provide.
  const extra = Object.keys(r.condition as Record<string, unknown>)
    .filter((k) => k !== "age" && k !== "matchesPrefix")
    .sort();
  return `${what}${age}${extra.length > 0 ? ` (only when ${extra.join(", ")})` : ""}`;
}

export interface SizeReport {
  /** Why this document exists, and what became of the decision it informed. */
  context?: string;
  generatedAt: string;
  commit: string;
  month: string;
  bucket: string;
  groups: PrefixGroup[];
  /** USD per GiB, supplied by the operator. Null when not given. */
  usdPerGib: number | null;
  /** Where the rate was read from, verbatim. */
  rateSource: string | null;
  /** Objects the listing returned in total, as a cross-check on the groups. */
  totalObjects: number;
  totalBytes: number;
  /** Soft-deleted objects — GCS bills for them during the retention window. */
  softDeletedObjects: number;
  softDeletedBytes: number;
  /** Retention window in days, or null when it could not be read. */
  softDeleteRetentionDays: number | null;
  /** The bucket's live rules, or NULL when the config could not be read. */
  lifecycle: LifecycleRule[] | null;
}

function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  return [header, header.map(() => "---"), ...rows]
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n");
}

function classCell(g: PrefixGroup): string {
  const parts = Object.entries(g.byClass)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([cls, v]) => `${cls} ${formatBytes(v.bytes)}`);
  return parts.length > 0 ? parts.join("<br>") : "—";
}

export function renderSizes(rep: SizeReport): string {
  const out: string[] = [];
  const inScope = rep.groups
    .filter((g) => g.root !== "(other)")
    .sort((a, b) => b.bytes - a.bytes);
  const other = rep.groups
    .filter((g) => g.root === "(other)")
    .sort((a, b) => b.bytes - a.bytes);
  const rate = rep.usdPerGib;
  const cost = (b: number) =>
    rate === null ? "**rate not supplied**" : formatUsd(transferUsd(b, rate));

  out.push(`# Mumbai → us-east4: what each prefix weighs — ${rep.month}`);
  out.push("");
  out.push(
    `> Sized before anything moves (D6). Inter-continental transfer is billed per GiB, so the question "what does this cost to copy" has to be answered from the bucket rather than from the design notes. Generated by \`scripts/ops/gcs-prefix-sizes.ts\` (read-only) at ${rep.generatedAt} from commit \`${rep.commit}\`. Bucket \`${rep.bucket}\`.`,
  );
  out.push("");
  if (rep.context) {
    out.push(rep.context);
    out.push("");
  }

  out.push("## The transfer rate");
  out.push("");
  if (rate === null) {
    out.push(
      "🔴 **No rate was supplied, so every cost column below is blank.** Re-run with `--transfer-usd-per-gib=` and `--rate-source=`. The rate is deliberately not a constant in the code — see below.",
    );
  } else {
    out.push(
      table(
        ["Field", "Value"],
        [
          ["Rate used", `**$${rate} per GiB**`],
          [
            "Read from",
            rep.rateSource ?? "**not recorded — re-run with `--rate-source=`**",
          ],
        ],
      ),
    );
  }
  out.push("");
  out.push(
    "**No transfer price is hardcoded anywhere in the code.** It is supplied per run and recorded here with the page it came from and the date it was read, because a rate baked into a script is a number that looks measured, ages silently, and is wrong in whichever direction nobody checks — Google reprices without touching this repo.",
  );
  out.push("");
  out.push(
    "**Nearline objects are billed TWICE on a move.** The transfer fee below is the egress leg only; a Nearline object also incurs a per-GB *retrieval* fee when it is read, and copying it is a read. `edgar/filings` transitions to Nearline at 30 days, so almost all of it is on the dearer side of that. The storage-class column is there to make the second bill visible; add the Nearline retrieval rate from the same pricing page to any prefix whose NEARLINE bytes are non-trivial.",
  );
  out.push("");

  out.push("## In scope for the US move");
  out.push("");
  out.push(
    table(
      [
        "Prefix",
        "Objects",
        "Bytes",
        "Storage class",
        "Transfer",
        "Read daily?",
        "Recommendation",
        "Why",
      ],
      inScope.map((g) => {
        const r = recommend(g);
        const daily = dailyReadReason(g.prefix);
        return [
          `\`${g.prefix}\``,
          formatCount(g.objects),
          formatBytes(g.bytes),
          classCell(g),
          cost(g.bytes),
          daily ? "yes" : "no",
          r.verdict === "MOVE" ? "**MOVE**" : "**LEAVE-HISTORY**",
          r.why,
        ];
      }),
    ),
  );
  out.push("");
  const moveBytes = inScope
    .filter((g) => recommend(g).verdict === "MOVE")
    .reduce((n, g) => n + g.bytes, 0);
  const leaveBytes = inScope
    .filter((g) => recommend(g).verdict === "LEAVE-HISTORY")
    .reduce((n, g) => n + g.bytes, 0);
  out.push(
    table(
      ["", "Bytes", "Transfer cost"],
      [
        ["**MOVE total**", formatBytes(moveBytes), cost(moveBytes)],
        ["**LEAVE-HISTORY total**", formatBytes(leaveBytes), cost(leaveBytes)],
        [
          "**In-scope total**",
          formatBytes(moveBytes + leaveBytes),
          cost(moveBytes + leaveBytes),
        ],
      ],
    ),
  );

  out.push("");
  out.push("### How to read the recommendation");
  out.push("");
  out.push(
    [
      `**Only one of its two inputs is measured.** Size comes from the bucket. \`Read daily?\` cannot be measured from objects — it is a property of the job schedule — so it is DECLARED in \`DAILY_READ\` with a reason per entry, printed in its own column above. Disagree with the premise there, not only with the verdict.`,
      "",
      `- **MOVE** — read on a daily US path, or under ${formatBytes(MOVE_CEILING_BYTES)}, where splitting the data across two buckets costs more in confusion than the copy costs in dollars.`,
      "- **LEAVE-HISTORY** — large and off the daily path. New writes go to the US bucket from D6a; these objects stay in Mumbai and the ledger records both locations.",
      "",
      `The ceiling is a SIZE, not a cost: cost moves with the rate, and a recommendation that flips when Google reprices is not a recommendation. The transfer column is beside it so a reader can overrule on money.`,
    ].join("\n"),
  );

  if (other.length > 0) {
    out.push("");
    out.push("## Everything else in the bucket");
    out.push("");
    out.push(
      "Not part of the US move — listed so the total below is a real total rather than a sum of the interesting parts.",
    );
    out.push("");
    out.push(
      table(
        ["Prefix", "Objects", "Bytes"],
        other.map((g) => [
          `\`${g.prefix}\``,
          formatCount(g.objects),
          formatBytes(g.bytes),
        ]),
      ),
    );
  }

  out.push("");
  out.push("## Lifecycle coverage — the part that outlives the cancelled move");
  out.push("");
  if (rep.lifecycle === null) {
    // NOT rendered as "no rules". The first run of this section did exactly
    // that — an expired credential returned `[]` and every prefix, including
    // ones with rules verified by hand, printed NONE. An absence you could not
    // measure is not an absence.
    out.push(
      '> 🔴 **The lifecycle configuration could not be read on this run, so coverage is UNKNOWN.** It is deliberately not rendered as "no rules": an unreadable config and an empty one are the same value and opposite facts, and the wrong one of them is a finding.',
    );
  } else {
    // The prose lives INSIDE the branch it describes: it explains a table and a
    // **NONE** cell, neither of which exists in the UNKNOWN case, and prose
    // about an absence is the last thing an unmeasured section should carry.
    out.push(
      "Read from the bucket on this run, never declared in code: a hardcoded table of what we *think* the rules are is a second copy of the truth, and the two drift. A prefix holding real bytes with **NONE** against it is paying Standard rates forever with nothing scheduled to age it out.",
    );
    out.push("");
    // Bound locally: the narrowing from `lifecycle === null` does not survive
    // into the closures below.
    const rules = rep.lifecycle;
    const all = [...rep.groups].sort((a, b) => b.bytes - a.bytes);
    out.push(
      table(
        ["Prefix", "Bytes", "Lifecycle rule", "Coverage"],
        all.map((g) => {
          const { coverage, rules: rs } = coverageFor(
            g.prefix,
            rules,
            Object.keys(g.byClass),
          );
          const big = g.bytes > 1024 ** 3 ? " 🔴" : "";
          return [
            `\`${g.prefix}\``,
            formatBytes(g.bytes),
            rs.length > 0 ? rs.map(describeRule).join("; ") : "**NONE**",
            coverage === "FULL" ? "covered" : `**${coverage}**${big}`,
          ];
        }),
      ),
    );
    const uncovered = all.filter(
      (g) =>
        coverageFor(g.prefix, rules, Object.keys(g.byClass)).coverage !==
          "FULL" && g.bytes > 1024 ** 3,
    );
    if (uncovered.length > 0) {
      out.push("");
      out.push(
        `**${formatBytes(uncovered.reduce((n, g) => n + g.bytes, 0))} across ${uncovered.length} prefix(es) is NOT fully covered**: ${uncovered.map((g) => `\`${g.prefix}\` (${coverageFor(g.prefix, rules, Object.keys(g.byClass)).coverage})`).join(", ")}. \`NONE\` means nothing is scheduled to age those bytes out; \`PARTIAL\` means a rule reaches only a subset — either because it sits deeper than the prefix, or because its condition selects a subset of the objects under it. Both are standing storage cost, and both are unaffected by the region decision.`,
      );
    }
  }

  out.push("");
  out.push("## Totals");
  out.push("");
  out.push(
    table(
      ["", "Objects", "Bytes"],
      [
        [
          "In scope",
          formatCount(inScope.reduce((n, g) => n + g.objects, 0)),
          formatBytes(moveBytes + leaveBytes),
        ],
        [
          "Other",
          formatCount(other.reduce((n, g) => n + g.objects, 0)),
          formatBytes(other.reduce((n, g) => n + g.bytes, 0)),
        ],
        [
          "Live objects",
          formatCount(rep.totalObjects),
          formatBytes(rep.totalBytes),
        ],
        [
          "Soft-deleted (still billed)",
          formatCount(rep.softDeletedObjects),
          formatBytes(rep.softDeletedBytes),
        ],
        [
          "**Whole bucket, billed**",
          `**${formatCount(rep.totalObjects + rep.softDeletedObjects)}**`,
          `**${formatBytes(rep.totalBytes + rep.softDeletedBytes)}**`,
        ],
      ],
    ),
  );
  out.push("");
  out.push(
    rep.softDeleteRetentionDays === null
      ? "The soft-delete row is objects GCS still bills for after deletion; the retention window could not be read on this run."
      : `Soft-delete retention on this bucket is **${rep.softDeleteRetentionDays} days**, and GCS bills for those bytes throughout it. A live-objects-only listing — which is what \`listFiles\` and every other reader here returns — omits them, so the storage line is larger than the in-scope tables above.`,
  );
  out.push("");
  out.push(
    [
      `**What actually protects this total, and what does not.** The grouped counts necessarily sum to ${formatCount(rep.totalObjects)} — \`accumulate\` has a catch-all bucket and is called once per object, so the equality is true by construction and cannot detect a dropped key. It is kept only as a cheap assertion that the two loops stayed in step.`,
      "",
      "The real protection against a short count is that the listing THROWS: `streamObjectSummaries` propagates a paging error instead of failing open to `[]` the way `listFiles` does, so a truncated walk kills the run rather than rendering as a smaller bucket.",
    ].join("\n"),
  );
  out.push("");
  return out.join("\n");
}
