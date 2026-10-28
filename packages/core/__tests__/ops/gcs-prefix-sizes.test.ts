/**
 * Prefix sizing: the grouping, the recommendation, and the two rules that keep
 * this report from quietly understating a transfer bill.
 *
 * A size report is acted on by copying terabytes between continents, so the
 * failures worth guarding are the ones that render as a *smaller* number:
 * a dropped key, a hardcoded sub-prefix list that misses a real child, a rate
 * that defaulted to zero, or a total that is a sum of the interesting parts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type PrefixGroup,
  DAILY_READ,
  MOVE_CEILING_BYTES,
  ROOTS,
  accumulate,
  coverageFor,
  describeRule,
  rulesFor,
  dailyReadReason,
  formatBytes,
  formatUsd,
  groupFor,
  recommend,
  renderSizes,
  transferUsd,
} from "../../src/ops/gcs-prefix-sizes";

const SCRIPT = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "scripts",
    "ops",
    "gcs-prefix-sizes.ts",
  ),
  "utf8",
);
const PURE = readFileSync(
  join(import.meta.dirname, "..", "..", "src", "ops", "gcs-prefix-sizes.ts"),
  "utf8",
);
/** Comments stripped — both files DISCUSS rates and listings while forbidding them. */
const strip = (s: string) =>
  s.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODE = strip(SCRIPT);
const PURE_CODE = strip(PURE);

function group(over: Partial<PrefixGroup> & { prefix: string }): PrefixGroup {
  return { root: "edgar/", objects: 1, bytes: 0, byClass: {}, ...over };
}

test("groupFor groups at the configured depth and never on the object name", () => {
  // Grouping on the filename would make one group per object.
  assert.deepEqual(groupFor("edgar/filings/2026/0001.json"), {
    prefix: "edgar/filings",
    root: "edgar/",
  });
  assert.deepEqual(groupFor("databento/EQUS.MINI/ohlcv-1m/2023/JOB/a.zst"), {
    prefix: "databento/EQUS.MINI/ohlcv-1m",
    root: "databento/",
  });
  assert.deepEqual(groupFor("candles/US/D1/AAPL/2019"), {
    prefix: "candles/US/D1",
    root: "candles/",
  });

  // Longest root wins: `feeds/TIINGO/` must claim the key, not a shorter root.
  assert.deepEqual(groupFor("feeds/TIINGO/news/2026/x.json"), {
    prefix: "feeds/TIINGO/news",
    root: "feeds/TIINGO/",
  });

  // An object sitting DIRECTLY under a root has fewer segments than groupDepth.
  // It is still bytes that must cross an ocean, so it groups at the depth it
  // has rather than being dropped.
  assert.deepEqual(groupFor("edgar/loose-object.json"), {
    prefix: "edgar",
    root: "edgar/",
  });

  assert.equal(
    groupFor("stocks/whatever/x.pdf"),
    null,
    "an unconfigured root does not match",
  );
});

test("a key outside every configured root still counts toward the bucket total", () => {
  // Dropping it would make the total a sum of the interesting parts rather than
  // a total — and the report's own cross-check depends on the two agreeing.
  const groups = new Map<string, PrefixGroup>();
  accumulate(groups, "stocks/reports/a.pdf", 100, "STANDARD");
  accumulate(groups, "edgar/filings/b.json", 200, "NEARLINE");

  assert.equal(
    [...groups.values()].reduce((n, g) => n + g.objects, 0),
    2,
    "no key is silently discarded",
  );
});

test("storage class is tracked per group, because Nearline is billed twice on a move", () => {
  // The transfer fee is the egress leg only; a Nearline object also incurs a
  // per-GB RETRIEVAL fee when it is read, and copying it is a read.
  // `edgar/filings` transitions to Nearline at 30 d, so most of it is dearer
  // than the transfer column alone implies.
  const groups = new Map<string, PrefixGroup>();
  accumulate(groups, "edgar/filings/a.json", 100, "NEARLINE");
  accumulate(groups, "edgar/filings/b.json", 50, "STANDARD");
  accumulate(groups, "edgar/filings/c.json", 25, "NEARLINE");

  const g = groups.get("edgar/filings")!;
  assert.equal(g.bytes, 175);
  assert.deepEqual(g.byClass.NEARLINE, { objects: 2, bytes: 125 });
  assert.deepEqual(g.byClass.STANDARD, { objects: 1, bytes: 50 });
});

test("a NaN size contributes zero rather than poisoning every total", () => {
  const groups = new Map<string, PrefixGroup>();
  accumulate(groups, "edgar/filings/a.json", Number.NaN, "STANDARD");
  accumulate(groups, "edgar/filings/b.json", 10, "STANDARD");
  const g = groups.get("edgar/filings")!;
  assert.equal(
    g.bytes,
    10,
    "one unparseable size must not make the prefix unmeasurable",
  );
  assert.equal(g.objects, 2, "…but the object is still counted");
});

test("the recommendation is MOVE for a daily read path at ANY size", () => {
  const huge = group({
    prefix: "candles/US/M1",
    root: "candles/",
    bytes: MOVE_CEILING_BYTES * 100,
  });
  const r = recommend(huge);
  assert.equal(r.verdict, "MOVE", "size never overrides a daily read path");
  assert.match(
    r.why,
    /CandleRepository/,
    "…and the report says WHICH job, so the premise is checkable",
  );
});

test("the recommendation is LEAVE-HISTORY only when large AND off the daily path", () => {
  const big = group({ prefix: "edgar/filings", bytes: MOVE_CEILING_BYTES + 1 });
  assert.equal(recommend(big).verdict, "LEAVE-HISTORY");

  const small = group({ prefix: "edgar/facts", bytes: MOVE_CEILING_BYTES - 1 });
  assert.equal(
    recommend(small).verdict,
    "MOVE",
    "under the ceiling, splitting costs more than copying",
  );

  // Exactly at the ceiling is MOVE — the boundary is inclusive and stated.
  assert.equal(
    recommend(group({ prefix: "edgar/x", bytes: MOVE_CEILING_BYTES })).verdict,
    "MOVE",
  );
});

test("every DAILY_READ entry carries a reason", () => {
  // The declared half of the recommendation is only auditable if each entry says
  // why. An entry with a blank reason renders a verdict nobody can dispute.
  for (const d of DAILY_READ) {
    assert.ok(
      d.reason.trim().length > 10,
      `DAILY_READ ${d.prefix} has no usable reason`,
    );
    assert.equal(dailyReadReason(d.prefix), d.reason);
    assert.equal(
      dailyReadReason(`${d.prefix}/deeper/key`),
      d.reason,
      "matches as a prefix, not an equality",
    );
  }
  assert.equal(dailyReadReason("edgar/filings"), null);
});

test("NO transfer rate is hardcoded in either file", () => {
  // A rate baked into a script is a number that looks measured, ages silently,
  // and is wrong in whichever direction nobody checks — Google reprices without
  // touching this repo. The rate is supplied per run and cited in the document.
  // PRECISE, not proximity-based. A "numeric literal near rate vocabulary"
  // scan flagged the word "delibe(rate)ly" inside a string, which is the
  // classic way a source scan asserts something other than what it means.
  // These are the shapes a hardcoded rate would actually take.
  for (const [label, code] of [
    ["script", CODE],
    ["pure module", PURE_CODE],
  ] as const) {
    assert.ok(
      !/usdPerGib\s*[:=]\s*[0-9]/.test(code),
      `${label} assigns a numeric rate`,
    );
    assert.ok(
      !/usdPerGib\s*(\?\?|\|\|)\s*[0-9.]/.test(code),
      `${label} falls back to a numeric rate`,
    );
    assert.ok(
      !/transferUsd\([^)]*,\s*[0-9.]+\s*\)/.test(code),
      `${label} passes a literal rate to transferUsd`,
    );
    // Any identifier NAMED for the rate, bound to a number.
    assert.ok(
      !/\b(?:const|let|var)\s+\w*(?:Gib|Usd|Rate|Price)\w*\s*(?::[^=]+)?=\s*[0-9]/.test(
        code,
      ),
      `${label} declares a rate-shaped constant with a numeric value`,
    );
  }
  // …and the ceiling that IS a constant is a SIZE, not a price.
  assert.equal(
    MOVE_CEILING_BYTES % 1024 ** 3,
    0,
    "the only constant is expressed in bytes",
  );
});

test("an absent rate renders blank cells, never $0.00", () => {
  // A zero cost reads as "free to move", which is the opposite of unknown.
  const rep = {
    generatedAt: "2026-09-15T00:00:00.000Z",
    commit: "c0ffee",
    month: "2026-09",
    bucket: "b",
    groups: [group({ prefix: "edgar/filings", bytes: 5 * 1024 ** 4 })],
    usdPerGib: null,
    rateSource: null,
    totalObjects: 1,
    totalBytes: 5 * 1024 ** 4,
    softDeletedObjects: 0,
    softDeletedBytes: 0,
    softDeleteRetentionDays: 7,
    lifecycle: [],
  };
  const md = renderSizes(rep);
  assert.match(md, /No rate was supplied/);
  assert.ok(!md.includes("$0.00"), "an unknown cost must not render as free");

  // With a rate, the cost appears AND its provenance is demanded.
  const priced = renderSizes({ ...rep, usdPerGib: 0.08, rateSource: null });
  assert.match(
    priced,
    /not recorded — re-run with/,
    "a rate with no citation is flagged",
  );
  const cited = renderSizes({
    ...rep,
    usdPerGib: 0.08,
    rateSource: "https://example/pricing read 2026-09-15",
  });
  assert.match(cited, /example\/pricing/);
});

test("transferUsd is linear in GiB and formats sub-cent costs honestly", () => {
  assert.equal(transferUsd(1024 ** 3, 0.08), 0.08);
  assert.equal(transferUsd(10 * 1024 ** 3, 0.08).toFixed(2), "0.80");
  assert.equal(
    formatUsd(0.0001),
    "<$0.01",
    "a tiny cost must not round to $0.00 and read as free",
  );
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatBytes(5 * 1024 ** 4), "5.0 TiB");
});

test("the report states that Nearline is billed twice, and that half the verdict is declared", () => {
  const md = renderSizes({
    generatedAt: "2026-09-15T00:00:00.000Z",
    commit: "c0ffee",
    month: "2026-09",
    bucket: "b",
    groups: [
      group({
        prefix: "edgar/filings",
        bytes: MOVE_CEILING_BYTES * 2,
        byClass: { NEARLINE: { objects: 1, bytes: MOVE_CEILING_BYTES * 2 } },
      }),
      group({ prefix: "feeds/TIINGO/eod", root: "feeds/TIINGO/", bytes: 10 }),
    ],
    usdPerGib: 0.08,
    rateSource: "cited",
    totalObjects: 2,
    totalBytes: MOVE_CEILING_BYTES * 2 + 10,
    softDeletedObjects: 0,
    softDeletedBytes: 0,
    softDeleteRetentionDays: 7,
    lifecycle: [],
  });
  assert.match(
    md,
    /billed TWICE/,
    "the retrieval fee on top of transfer must be stated",
  );
  assert.match(md, /retrieval/i);
  assert.match(
    md,
    /Only one of its two inputs is measured/,
    "the declared half must be labelled",
  );
  assert.match(md, /LEAVE-HISTORY/);
  assert.match(md, /MOVE/);
});

test("the script never calls listFiles, and says why a listing is allowed at all", () => {
  // `listFiles` fails OPEN to [] — an empty result is indistinguishable from an
  // outage — so it can never support a verdict. This script uses the throwing
  // paged reader instead.
  assert.ok(
    !/\blistFiles\b/.test(CODE),
    "listFiles fails open; a size report must not rest on it",
  );
  assert.ok(
    /streamObjectSummaries/.test(CODE),
    "the throwing paged reader is what is used",
  );
  // The exception has to be argued in the file, not just taken.
  // The header wraps across comment lines, so match on the phrase with
  // arbitrary whitespace + comment asterisks between words.
  assert.match(
    SCRIPT.replace(/\s*\n\s*\*\s*/g, " "),
    /SIZE REPORT AND NOT A DECISION ABOUT PRESENCE/,
    "the listing exception must be argued in the file, not merely taken",
  );
});

test("the script walks the bucket ONCE and refuses a report whose totals disagree", () => {
  // Five listings would cost five walks, and a per-prefix walk makes the total a
  // sum of the parts we happened to look at rather than a measured denominator.
  // TWO walks now, and they are disjoint by construction: `softDeleted: true`
  // returns only soft-deleted objects. A third would mean a per-prefix listing
  // crept back in, which is what makes the bucket total a sum of the parts.
  const walks = CODE.match(/streamObjectSummaries\(/g) ?? [];
  assert.equal(
    walks.length,
    2,
    "one live walk plus one soft-deleted walk — no per-prefix listings",
  );
  assert.equal(
    (
      CODE.match(
        /streamObjectSummaries\("",\s*1000,\s*\{\s*softDeleted:\s*true/g,
      ) ?? []
    ).length,
    1,
    "exactly one of them is the soft-deleted pass",
  );
  // …and it must walk the WHOLE bucket. Narrowing the prefix keeps the call
  // count at one while making the Totals row a partial count that still reads
  // as a total — and the grouped-vs-walked cross-check would agree with itself.
  assert.match(
    CODE,
    /streamObjectSummaries\(\s*""\s*\)/,
    "the walk must be unprefixed, or the bucket total is a subset wearing a total's label",
  );
  assert.match(
    CODE,
    /GROUPING LOST OBJECTS/,
    "a mismatch between walked and grouped must be fatal",
  );
  assert.match(CODE, /process\.exit\(1\)/);
});

test("lifecycle rules are matched from the BUCKET's own config, and gaps are named", () => {
  // Never a hardcoded table of what we think the rules are: the design notes
  // and the bucket already disagreed about `edgar/` once, which is why this
  // measurement exists at all.
  const rules = [
    {
      action: { type: "Delete" },
      condition: { age: 30, matchesPrefix: ["edgar/bulk/"] },
    },
    {
      action: { type: "SetStorageClass", storageClass: "NEARLINE" },
      condition: { age: 30, matchesPrefix: ["edgar/filings/"] },
    },
    { action: { type: "Delete" }, condition: { age: 7 } }, // no prefix: bucket-wide
  ];

  assert.equal(
    rulesFor("edgar/bulk", rules).length,
    2,
    "its own rule plus the bucket-wide one",
  );
  assert.equal(rulesFor("edgar/filings", rules).length, 2);
  // A prefix with no rule of its own still matches the bucket-wide rule — the
  // opposite would report it uncovered while a Delete quietly applied.
  assert.equal(rulesFor("stocks/reports", rules).length, 1);

  assert.equal(describeRule(rules[0]!), "DELETE at 30 d");
  assert.equal(describeRule(rules[1]!), "→ NEARLINE at 30 d");

  // With NO bucket-wide rule, an uncovered prefix is genuinely uncovered.
  const scoped = rules.slice(0, 2);
  assert.deepEqual(
    rulesFor("stocks/reports", scoped),
    [],
    "no rule reaches it",
  );

  const md = renderSizes({
    generatedAt: "2026-09-15T00:00:00.000Z",
    commit: "c0ffee",
    month: "2026-09",
    bucket: "b",
    groups: [
      group({
        prefix: "(other) stocks",
        root: "(other)",
        bytes: 399 * 1024 ** 3,
      }),
    ],
    usdPerGib: 0.08,
    rateSource: "cited",
    totalObjects: 1,
    totalBytes: 399 * 1024 ** 3,
    softDeletedObjects: 0,
    softDeletedBytes: 0,
    softDeleteRetentionDays: 7,
    lifecycle: scoped,
  });
  assert.match(
    md,
    /\*\*NONE\*\*/,
    "an uncovered prefix must say so in its own cell",
  );
  assert.match(
    md,
    /is NOT fully covered/,
    "…and be called out in prose with its size",
  );
  assert.match(
    md,
    /unaffected by the region decision/,
    "the finding outlives the cancelled move",
  );

  // An UNREADABLE config must never render as "no rules". The first real run
  // did exactly that: an expired credential returned `[]` and every prefix,
  // including ones whose rules were verified by hand, printed NONE — the report
  // asserted a 977 GiB absence it had not measured.
  const unknown = renderSizes({
    generatedAt: "2026-09-15T00:00:00.000Z",
    commit: "c0ffee",
    month: "2026-09",
    bucket: "b",
    groups: [group({ prefix: "edgar/filings", bytes: 490 * 1024 ** 3 })],
    usdPerGib: 0.08,
    rateSource: "cited",
    totalObjects: 1,
    totalBytes: 490 * 1024 ** 3,
    softDeletedObjects: 0,
    softDeletedBytes: 0,
    softDeleteRetentionDays: 7,
    lifecycle: null,
  });
  assert.match(unknown, /coverage is UNKNOWN/);
  assert.ok(
    !unknown.includes("**NONE**"),
    "an unmeasured absence must not be reported as an absence",
  );
  assert.ok(
    !unknown.includes("is NOT fully covered"),
    "…nor summarised as one",
  );
});

test("the document says the move was cancelled, wherever its numbers are quoted", () => {
  // Without this the table reads as a live migration plan. Plan v2.3 cites this
  // file's totals, so the costs stay — the banner is what makes that honest.
  const md = renderSizes({
    context:
      "> ⚠️ **The move this sized was CANCELLED.** Retained as the record.",
    generatedAt: "2026-09-15T00:00:00.000Z",
    commit: "c0ffee",
    month: "2026-09",
    bucket: "b",
    groups: [group({ prefix: "edgar/filings", bytes: 490 * 1024 ** 3 })],
    usdPerGib: 0.08,
    rateSource: "cited",
    totalObjects: 1,
    totalBytes: 490 * 1024 ** 3,
    softDeletedObjects: 0,
    softDeletedBytes: 0,
    softDeleteRetentionDays: 7,
    lifecycle: [],
  });
  assert.match(md, /CANCELLED/);
  assert.ok(
    md.indexOf("CANCELLED") < md.indexOf("## The transfer rate"),
    "the banner precedes the costs it qualifies",
  );
  assert.match(
    md,
    /\$39\.20/,
    "…and the costs are still rendered, because the plan cites them",
  );
});

test("ROOTS covers every prefix the US move touches", () => {
  const roots = ROOTS.map((r) => r.root);
  for (const required of [
    "edgar/",
    "databento/",
    "feeds/TIINGO/",
    "candles/",
  ]) {
    assert.ok(
      roots.includes(required),
      `${required} is in scope for the US move and must be grouped`,
    );
  }
  for (const r of ROOTS) {
    assert.ok(
      r.root.endsWith("/"),
      `${r.root} must end in a slash or it prefix-matches a sibling`,
    );
    assert.ok(r.groupDepth >= 1);
    assert.ok(
      r.note.length > 10,
      `${r.root} needs a note saying why it is in scope`,
    );
  }
});

/**
 * The coverage matcher, after a review found three ways it over-reported and one
 * way it could not report at all. Every case below was verified against the real
 * function before the fix, and each is a DIFFERENT direction of wrongness — all
 * of them landing on "this data is looked after" when it is not.
 */
test("coverage: a decorative group name is a name a rule can never match", () => {
  const stocksRule = [
    {
      action: { type: "Delete" },
      condition: { age: 30, matchesPrefix: ["stocks/"] },
    },
  ];
  // The group used to be NAMED `(other) stocks`, which no lifecycle rule can
  // match — so 424 of the 428 GiB this report flagged as "no rule at all" was a
  // verdict the code was structurally incapable of computing, rendered in red.
  // Exactly the failure the UNKNOWN branch of this same file guards against.
  assert.equal(coverageFor("stocks", stocksRule).coverage, "FULL");
  assert.equal(coverageFor("(other) stocks", stocksRule).coverage, "NONE");
});

test("coverage: a rule DEEPER than the group covers only part of it", () => {
  const deep = [
    {
      action: { type: "Delete" },
      condition: { age: 30, matchesPrefix: ["candles/US/D1/AAPL/"] },
    },
  ];
  assert.equal(
    coverageFor("candles/US/D1", deep).coverage,
    "PARTIAL",
    "a rule on one symbol must not mark the whole timeframe covered",
  );
  assert.notEqual(coverageFor("candles/US/D1", deep).coverage, "FULL");
});

test("coverage: prefixes match at PATH SEGMENT boundaries, not raw string starts", () => {
  const us = [
    {
      action: { type: "Delete" },
      condition: { age: 30, matchesPrefix: ["candles/US/"] },
    },
  ];
  assert.equal(coverageFor("candles/US", us).coverage, "FULL");
  assert.equal(coverageFor("candles/US/D1", us).coverage, "FULL");
  assert.equal(
    coverageFor("candles/USA", us).coverage,
    "NONE",
    "a bare startsWith on a truncated group name claims its sibling",
  );
});

test("coverage: a condition-SELECTIVE rule can never make a group FULLY covered", () => {
  // An all-STANDARD prefix under a NEARLINE-only Delete has nothing scheduled to
  // age it out. `age` is not selective — every object acquires an age.
  const nearlineOnly = [
    {
      action: { type: "Delete" },
      condition: {
        age: 30,
        matchesPrefix: ["edgar/"],
        matchesStorageClass: ["NEARLINE"],
      },
    },
  ];
  assert.equal(coverageFor("edgar/facts", nearlineOnly).coverage, "PARTIAL");

  const ageOnly = [
    {
      action: { type: "Delete" },
      condition: { age: 30, matchesPrefix: ["edgar/"] },
    },
  ];
  assert.equal(coverageFor("edgar/facts", ageOnly).coverage, "FULL");

  // …and the extra condition is NAMED, not rendered as unconditional coverage.
  assert.match(
    describeRule(nearlineOnly[0]!),
    /only when matchesStorageClass/,
    "a rule shown as 'DELETE at 30 d' that really means 'only NEARLINE' reads as coverage it does not provide",
  );
});

test("the report renders three coverage states, and PARTIAL is not covered", () => {
  const md = renderSizes({
    generatedAt: "2026-09-15T00:00:00.000Z",
    commit: "c0ffee",
    month: "2026-09",
    bucket: "b",
    groups: [
      group({
        prefix: "candles/US/D1",
        root: "candles/",
        bytes: 2 * 1024 ** 3,
      }),
      group({ prefix: "stocks", root: "(other)", bytes: 399 * 1024 ** 3 }),
    ],
    usdPerGib: 0.08,
    rateSource: "cited",
    totalObjects: 2,
    totalBytes: 401 * 1024 ** 3,
    softDeletedObjects: 12,
    softDeletedBytes: 5 * 1024 ** 3,
    softDeleteRetentionDays: 7,
    lifecycle: [
      {
        action: { type: "Delete" },
        condition: { age: 30, matchesPrefix: ["candles/US/D1/AAPL/"] },
      },
    ],
  });
  assert.match(
    md,
    /\*\*PARTIAL\*\*/,
    "a partially-reached prefix is not 'covered'",
  );
  assert.match(md, /is NOT fully covered/);

  // Soft-deleted bytes are BILLED and were omitted entirely before the review.
  assert.match(md, /Soft-deleted \(still billed\)/);
  assert.match(
    md,
    /7 days/,
    "the retention window is stated, since it sets how long the bill runs",
  );
  assert.match(md, /Whole bucket, billed/);
});

test("the tautological cross-check claim is gone", () => {
  // `accumulate` has a catch-all bucket and runs once per object, so
  // grouped === walked by construction and cannot detect a dropped key. The
  // report used to promise exactly that protection.
  assert.ok(
    !/a key was dropped and the report says so/.test(PURE_CODE + CODE),
    "the report must not claim a guarantee its arithmetic cannot provide",
  );
  assert.match(PURE, /true by construction and cannot detect a dropped key/);
  assert.match(
    PURE,
    /the listing THROWS/,
    "…and must name what actually protects the count",
  );
});

test("accumulate names an out-of-scope group with its REAL key prefix", () => {
  // This is the assertion that holds the fix, and the earlier one did not: the
  // bug was in what `accumulate` NAMES the group, not in how `coverageFor`
  // matches. A group called `(other) stocks` is structurally unmatchable
  // against a rule on `stocks/`, so the report rendered 424 GiB of "no
  // lifecycle rule at all" that the code could never have computed. Scope
  // belongs on `root`, which is what the renderer filters on.
  const groups = new Map<string, PrefixGroup>();
  accumulate(groups, "stocks/reports/a.pdf", 100, "STANDARD");

  assert.deepEqual(
    [...groups.keys()],
    ["stocks"],
    "the key is a real prefix, not a label",
  );
  assert.equal(
    groups.get("stocks")!.root,
    "(other)",
    "scope is carried on `root`",
  );

  // …and the name it keeps is one a lifecycle rule can actually match.
  const rule = [
    {
      action: { type: "Delete" },
      condition: { age: 30, matchesPrefix: ["stocks/"] },
    },
  ];
  const [name] = [...groups.keys()];
  assert.equal(
    coverageFor(name!, rule).coverage,
    "FULL",
    "a group name that cannot join to a lifecycle rule makes every verdict about it fiction",
  );
});

test("selectivity is MEASURED against the classes a group holds, not assumed", () => {
  // The first fix over-corrected. A `SetStorageClass STANDARD → NEARLINE` rule
  // names its SOURCE class as idempotence plumbing, not as a coverage gap, so
  // blanket-flagging `matchesStorageClass` put PARTIAL 🔴 on 8 of 23 rows and
  // buried the two that were real. Objects already AT the destination need no
  // rule, so the rule covers the group when every class present is either
  // selected or the target.
  const transition = [
    {
      action: { type: "SetStorageClass", storageClass: "NEARLINE" },
      condition: {
        age: 30,
        matchesPrefix: ["edgar/filings/"],
        matchesStorageClass: ["STANDARD"],
      },
    },
  ];
  assert.equal(
    coverageFor("edgar/filings", transition, ["STANDARD"]).coverage,
    "FULL",
    "a transition over an all-STANDARD prefix reaches every object in it",
  );
  assert.equal(
    coverageFor("edgar/filings", transition, ["STANDARD", "COLDLINE"]).coverage,
    "PARTIAL",
    "…but a class it neither selects nor targets is genuinely unreached",
  );

  // THE CASE THE EXEMPTION EXISTS FOR, and it arrives on 2026-09-29 when
  // `edgar/filings` starts transitioning: the group then holds STANDARD AND
  // NEARLINE. The rule does not select NEARLINE — it does not need to, those
  // objects are already at the destination — and reading that as a coverage
  // gap would flag the prefix red for the rule having worked.
  assert.equal(
    coverageFor("edgar/filings", transition, ["STANDARD", "NEARLINE"]).coverage,
    "FULL",
    "objects already AT the target class need no rule",
  );
  assert.equal(
    coverageFor("edgar/filings", transition, ["NEARLINE"]).coverage,
    "FULL",
    "…including once the whole prefix has transitioned",
  );

  // A DELETE that only matches NEARLINE leaves an all-STANDARD prefix with
  // nothing scheduled — still PARTIAL, which is the case finding #4 named.
  const del = [
    {
      action: { type: "Delete" },
      condition: {
        age: 30,
        matchesPrefix: ["edgar/"],
        matchesStorageClass: ["NEARLINE"],
      },
    },
  ];
  assert.equal(
    coverageFor("edgar/facts", del, ["STANDARD"]).coverage,
    "PARTIAL",
  );

  // With no class information, fall back to treating it as selective: an
  // unmeasured condition must not be assumed harmless.
  assert.equal(coverageFor("edgar/facts", del).coverage, "PARTIAL");
});
