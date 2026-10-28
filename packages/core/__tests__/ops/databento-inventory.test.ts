/**
 * The Databento inventory's verdicts, and the read-only policy.
 *
 * Every assertion here targets a failure that would render as a clean report.
 * The expensive one is specific: Databento files expire 30 days after
 * SUBMISSION, and past that the only remedy is to buy the range again at usage
 * prices after the Standard subscription has lapsed. A report that says
 * "complete" about an entry that is not is the one output worth guarding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type InventoryJob,
  type PresenceResult,
  consumerFor,
  harvestedVerdict,
  renderInventory,
  resolveExpiry,
  rollupEntries,
  summarisePresence,
  verifiedVerdict,
} from "../../src/ops/databento-inventory";

const SCRIPT = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "scripts",
    "ops",
    "databento-inventory.ts",
  ),
  "utf8",
);
/** Comments stripped: the script DOCUMENTS what it forbids. */
const CODE = SCRIPT.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-09-14T00:00:00.000Z");

function job(over: Partial<InventoryJob> = {}): InventoryJob {
  return {
    rowId: over.rowId ?? "r1",
    env: "prod",
    entryId: "ohlcv-1s-baseline",
    schema: "ohlcv-1s",
    dataset: "EQUS.MINI",
    purpose: "HARVEST",
    state: "DONE",
    jobId: "EQUS-1",
    costUsd: 0,
    costUsdQuoted: 0,
    submittedAt: new Date("2026-09-09T00:00:00.000Z"),
    tsExpiration: new Date("2026-10-09T00:00:00.000Z"),
    symbolCount: 507,
    start: null,
    end: null,
    loadedRows: 0,
    files: [],
    ...over,
  };
}

const present = (k: string): PresenceResult => ({
  archiveKey: k,
  state: "PRESENT",
  ledgerSize: 1,
  gcsSize: 1,
  ledgerVerified: true,
});
const absent = (k: string): PresenceResult => ({
  archiveKey: k,
  state: "ABSENT",
  ledgerSize: 1,
  ledgerVerified: false,
});
const unknown = (k: string): PresenceResult => ({
  archiveKey: k,
  state: "UNKNOWN",
  ledgerSize: 1,
  ledgerVerified: true,
});
/** In the bucket, correctly sized, and the harvest says the bytes are bad. */
const corrupt = (k: string): PresenceResult => ({
  archiveKey: k,
  state: "PRESENT",
  ledgerSize: 1,
  gcsSize: 1,
  ledgerVerified: false,
});

test("resolveExpiry takes the EARLIER of vendor and derived, and reports the disagreement", () => {
  // Asymmetric failure modes: believing a file lives longer than it does loses
  // the bytes permanently; believing it dies sooner costs one look.
  const vendorEarlier = resolveExpiry(
    job({
      submittedAt: new Date("2026-09-01T00:00:00Z"), // derived 2026-10-01
      tsExpiration: new Date("2026-09-20T00:00:00Z"),
    }),
  );
  assert.equal(vendorEarlier.expiry?.toISOString(), "2026-09-20T00:00:00.000Z");
  assert.ok((vendorEarlier.disagreementHours ?? 0) > 200);

  const derivedEarlier = resolveExpiry(
    job({
      submittedAt: new Date("2026-09-01T00:00:00Z"), // derived 2026-10-01
      tsExpiration: new Date("2026-12-01T00:00:00Z"), // vendor claims longer
    }),
  );
  assert.equal(
    derivedEarlier.expiry?.toISOString(),
    "2026-10-01T00:00:00.000Z",
    "a vendor claim of MORE time must not extend the deadline we plan against",
  );

  // Sub-hour drift is clock noise, not a policy change worth reporting.
  const noise = resolveExpiry(
    job({
      submittedAt: new Date("2026-09-01T00:00:00Z"),
      tsExpiration: new Date("2026-10-01T00:30:00Z"),
    }),
  );
  assert.equal(noise.disagreementHours, null);

  // Neither source present is UNKNOWN, never "now" and never epoch.
  assert.equal(
    resolveExpiry(job({ submittedAt: null, tsExpiration: null })).expiry,
    null,
  );
});

test("an EMPTY file list is NOT fully present", () => {
  // `every()` over an empty array is `true`. That would certify the real
  // ohlcv-1s row — 21,365 vendor files, state DONE — as complete if its files
  // array were ever empty. Emptiness is the state the report exists to surface.
  const empty = summarisePresence([]);
  assert.equal(
    empty.fullyPresent,
    false,
    "nothing archived is not the same as everything archived",
  );
  assert.equal(empty.total, 0);

  assert.equal(
    summarisePresence([present("a"), present("b")]).fullyPresent,
    true,
  );
  assert.equal(
    summarisePresence([present("a"), absent("b")]).fullyPresent,
    false,
  );
});

test("UNKNOWN blocks completeness but is reported as UNVERIFIED, never as missing", () => {
  // Measured while building this: an expired ADC token threw on every key.
  // Folding throw into "absent" would have declared all 66,046 files missing.
  const s = summarisePresence([present("a"), unknown("b")]);
  assert.equal(
    s.fullyPresent,
    false,
    "a file you could not see is not a file you have",
  );
  assert.equal(s.unknown, 1);
  assert.equal(
    s.absent,
    0,
    "an unreadable object must NOT be counted as absent",
  );

  const rolled = rollupEntries(
    [
      job({
        files: [{ filename: "f", archiveKey: "b", size: 1, kind: "data" }],
      }),
    ],
    new Map([["r1", [unknown("b")]]]),
    NOW,
  );
  assert.match(verifiedVerdict(rolled[0]!), /UNVERIFIED/);
  assert.ok(!/absent/i.test(verifiedVerdict(rolled[0]!)));
});

test("a QUOTED row never makes its entry look incomplete", () => {
  // The budget guard writes the row BEFORE submitting, so a crash between the
  // two leaves a QUOTED row with no files. Judging that incomplete paints the
  // whole entry red for a row that cost nothing and holds nothing — and prod
  // really has three of them on ohlcv-1h-master.
  const rolled = rollupEntries(
    [
      job({
        rowId: "a",
        entryId: "e",
        state: "LOADED",
        files: [{ filename: "f", archiveKey: "k", size: 1, kind: "data" }],
      }),
      job({ rowId: "b", entryId: "e", state: "QUOTED", files: [] }),
    ],
    new Map([["a", [present("k")]]]),
    NOW,
  );
  assert.equal(rolled.length, 1);
  assert.equal(
    rolled[0]!.fullyPresent,
    true,
    "the QUOTED row has nothing to be missing",
  );
  assert.equal(rolled[0]!.states.QUOTED, 1);
  assert.equal(rolled[0]!.jobCount, 2);
});

test("env never sums across — one ledger, two environments", () => {
  const rolled = rollupEntries(
    [
      job({ rowId: "a", env: "prod", entryId: "e", costUsd: 10 }),
      job({ rowId: "b", env: "qa", entryId: "e", costUsd: 5 }),
    ],
    new Map(),
    NOW,
  );
  assert.equal(
    rolled.length,
    2,
    "same entry id in two envs is TWO rows, never one",
  );
  // Numeric comparator: a bare `.sort()` is LEXICOGRAPHIC, so [10, 5] stays
  // [10, 5] because "10" < "5". The assertion, not the source, was wrong.
  assert.deepEqual(
    rolled.map((r) => r.costUsd).sort((a, b) => a - b),
    [5, 10],
  );
  assert.deepEqual(
    rolled.map((r) => r.env).sort(),
    ["prod", "qa"],
    "and each row keeps its own env rather than one absorbing the other",
  );
});

test("a file PRESENT in GCS that the ledger marks unverified is NOT complete", () => {
  // `downloadToArchive` writes to GCS BEFORE it digests and its cleanup delete
  // is `.catch(() => {})`, so a corrupt object can outlive the checksum failure
  // that produced it — present, correctly sized, and bad. A HEAD cannot see
  // that; only the ledger can. Deciding presence on the HEAD alone reports the
  // entry complete about bytes the harvest itself knows are wrong, while the
  // re-downloadable vendor copy ages out at 30 days.
  const sum = summarisePresence([present("a"), corrupt("b")]);
  assert.equal(sum.present, 2, "it IS in the bucket");
  assert.equal(sum.ledgerUnverified, 1);
  assert.equal(sum.fullyPresent, false, "…and that does not make it good");

  const rolled = rollupEntries(
    [
      job({
        files: [{ filename: "f", archiveKey: "b", size: 1, kind: "data" }],
      }),
    ],
    new Map([["r1", [corrupt("b")]]]),
    NOW,
  );
  assert.equal(rolled[0]!.atRisk, true);
  assert.match(verifiedVerdict(rolled[0]!), /ledger-unverified/);
  assert.match(rolled[0]!.riskReason ?? "", /possible corrupt object/);
});

test("the alarm fires on INCOMPLETENESS; expiry only ranks it", () => {
  const files = [
    { filename: "f", archiveKey: "k", size: 1, kind: "data" as const },
  ];

  // Complete -> never at risk, however close the deadline.
  const safe = rollupEntries(
    [job({ tsExpiration: new Date("2026-09-16T00:00:00Z"), files })],
    new Map([["r1", [present("k")]]]),
    NOW,
  );
  assert.equal(safe[0]!.atRisk, false);

  // INCOMPLETE but 25 days out -> STILL AT RISK. This is the regression that
  // matters: it is prod's exact ohlcv-1s state, and the old window-gated rule
  // printed "no entry is at re-purchase risk" over three genuinely missing
  // purchased files. Nothing schedules this script, so an entry can pass from
  // comfortable to expired between two hand-invoked runs and never be flagged.
  const later = rollupEntries(
    [job({ tsExpiration: new Date("2026-10-09T00:00:00Z"), files })],
    new Map([["r1", [absent("k")]]]),
    NOW,
  );
  assert.equal(later[0]!.atRisk, true, "incompleteness IS the alarm");
  assert.equal(later[0]!.urgent, false, "…but 25 days out is not urgent");
  assert.match(later[0]!.riskReason ?? "", /25\.0 d of vendor retention left/);

  // Inside the window -> urgent as well.
  const urgent = rollupEntries(
    [job({ tsExpiration: new Date("2026-09-16T00:00:00Z"), files })],
    new Map([["r1", [absent("k")]]]),
    NOW,
  );
  assert.equal(urgent[0]!.atRisk, true);
  assert.equal(urgent[0]!.urgent, true);

  // Already expired reads as expired, not as a negative countdown.
  const gone = rollupEntries(
    [
      job({
        submittedAt: null,
        tsExpiration: new Date("2026-09-04T00:00:00Z"),
        files,
      }),
    ],
    new Map([["r1", [absent("k")]]]),
    NOW,
  );
  assert.equal(gone[0]!.atRisk, true);
  assert.match(gone[0]!.riskReason ?? "", /EXPIRED 10\.0 d ago/);

  // A QUOTED-only entry has nothing submitted, so nothing to lose.
  const quoted = rollupEntries(
    [job({ state: "QUOTED", files: [] })],
    new Map(),
    NOW,
  );
  assert.equal(quoted[0]!.atRisk, false, "never submitted is not incomplete");
});

test("harvested/verified verdicts distinguish never-submitted from submitted-but-empty", () => {
  const quotedOnly = rollupEntries(
    [job({ state: "QUOTED", files: [] })],
    new Map(),
    NOW,
  )[0]!;
  assert.match(harvestedVerdict(quotedOnly), /quoted, never submitted/);
  assert.equal(
    verifiedVerdict(quotedOnly),
    "n/a",
    "nothing submitted is not a verification failure",
  );

  const submittedEmpty = rollupEntries(
    [job({ state: "DONE", files: [] })],
    new Map(),
    NOW,
  )[0]!;
  assert.match(harvestedVerdict(submittedEmpty), /no files recorded/);
  assert.ok(
    harvestedVerdict(submittedEmpty) !== harvestedVerdict(quotedOnly),
    "a submitted job with no files and a job never submitted are DIFFERENT states",
  );
});

test("an unknown schema is named loudly, not silently dropped", () => {
  assert.equal(consumerFor("ohlcv-1m"), "`trade_bar_m1` + backtest release");
  assert.equal(
    consumerFor("tbbo"),
    consumerFor("bbo-1m"),
    "both quote schemas feed the cost model",
  );
  assert.match(
    consumerFor("ohlcv-1d"),
    /unassigned/,
    "a new schema must not inherit a blank cell",
  );
});

test("the report names the missing KEYS and explains the Mongo/ledger gap", () => {
  const files = [
    {
      filename: "f",
      archiveKey: "databento/x/y.zst",
      size: 1024,
      kind: "data" as const,
    },
  ];
  const md = renderInventory({
    generatedAt: "2026-09-14T00:00:00.000Z",
    commit: "abc1234",
    month: "2026-09",
    bucket: "stockbook-content-prod",
    database: "tradebook",
    rollups: rollupEntries(
      [job({ files, loadedRows: 151_481_533 })],
      new Map([["r1", [absent("databento/x/y.zst")]]]),
      NOW,
    ),
    candles: [
      {
        timeframe: "M1",
        rows: 6_118_096,
        symbols: 507,
        minYear: 2026,
        maxYear: 2026,
      },
    ],
    candlesNote: null,
    manifestOnlyEntries: ["never-run-entry"],
    problems: [absent("databento/x/y.zst")],
    droppedRecords: 0,
    now: NOW,
  });

  // A count is not actionable; the key is.
  assert.ok(
    md.includes("databento/x/y.zst"),
    "the absent key must be NAMED, not merely counted",
  );
  assert.match(md, /## Files that are NOT present/);

  // 151,481,533 beside 6,118,096 reads as 96% data loss unless explained.
  assert.match(md, /do NOT reconcile with `Loaded rows` above, and must not/);
  assert.match(md, /cold shards/);
  assert.ok(
    md.includes("2026"),
    "the year span is the evidence that it is a window",
  );

  // A manifest entry the ledger has never seen is its own state.
  assert.ok(md.includes("never-run-entry"));
  // The expiry policy that makes any of this matter.
  assert.match(md, /30 days after SUBMISSION/);
});

test("databento-inventory.ts is READ-ONLY and never lists", () => {
  for (const verb of [
    "insertOne",
    "insertMany",
    "updateOne",
    "updateMany",
    "replaceOne",
    "deleteOne",
    "deleteMany",
    "findOneAndUpdate",
    "findOneAndDelete",
    "findOneAndReplace",
    "bulkWrite",
    "createIndex",
    "dropIndex",
    "drop",
    "uploadFile",
    "uploadStream",
    "deleteFile",
  ]) {
    assert.ok(
      !new RegExp(`[.\\s{,(]${verb}\\s*\\(`).test(CODE),
      `databento-inventory.ts calls ${verb}() — it reads production and must not be able to change it`,
    );
  }
  assert.ok(!/\$out\b/.test(CODE));
  assert.ok(!/\$merge\b/.test(CODE));

  // `listFiles` fails OPEN to [] on error, so a listing can never support an
  // "it is missing" verdict — an empty result is indistinguishable from an
  // outage. Every key must come from the ledger's own archiveKey.
  assert.ok(
    !/\blistFiles\b/.test(CODE),
    "listFiles fails open to [] — a missing-file verdict may never rest on a listing",
  );
  assert.ok(
    /getFileMetadata/.test(CODE),
    "…and the ledger's keys are checked with getFileMetadata",
  );
});

test("distinct symbols are counted with $addToSet, not $sum", () => {
  // The inner $group is keyed on (timeframe, symbol, YEAR), so counting its
  // documents counts symbol-YEARS. The defect is invisible while the hot window
  // holds a single year — which is exactly the state prod is in — and silently
  // multiplies the moment it does not.
  assert.match(CODE, /syms:\s*\{\s*\$addToSet:\s*"\$_id\.sym"\s*\}/);
  assert.ok(
    !/symbols:\s*\{\s*\$sum:\s*1\s*\}/.test(CODE),
    "a $sum over a year-keyed group is symbol-years, not symbols",
  );
});
