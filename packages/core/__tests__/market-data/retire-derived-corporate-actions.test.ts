/**
 * UNIT TEST — retiring DERIVED corporate actions their own series no longer
 * supports (MONEY-1600). Rows and closes are the real prod ones, 2026-09-23.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

/** Dynamic, as `vendor-fundamentals-snapshot.test.ts` explains. */
const {
  BACKUP_COLLECTION,
  planRetire,
  planRetireRestore,
  sessionDay,
  simulateRetire,
} =
  (await import("../../../../scripts/data/retire-derived-corporate-actions-logic")) as typeof import("../../../../scripts/data/retire-derived-corporate-actions-logic");

type RawDoc = Record<string, unknown>;
type Evidence = {
  onDay: { date: Date; close: number; volume: number } | null;
  before: { date: Date; close: number; volume: number } | null;
};

const bar = (iso: string, close: number) => ({
  date: new Date(`${iso}T00:00:00Z`),
  close,
  volume: 0,
});

function row(
  oid: string,
  symbol: string,
  exchange: string,
  day: string,
  ratio: number | null,
  source = "DERIVED",
): RawDoc {
  return {
    _id: { $oid: oid },
    symbol,
    exchange,
    type: "CAPITAL_ADJUSTMENT",
    exDate: { $date: `${day}T00:00:00Z` },
    ratio,
    source,
    updatedAt: { $date: "2026-08-12T10:32:21.293Z" },
  };
}

const SAYAJI = row(
  "6a7c4bb5c76486c7e9feadaf",
  "SAYAJIHOTL",
  "NSE",
  "2026-04-22",
  0.5,
);
const KANORI = row(
  "6a7c4943c76486c7e9fead4b",
  "KANORICHEM",
  "NSE",
  "1996-06-04",
  2,
);
const ZEEL = row("6a7c4605c76486c7e9fead23", "ZEEL", "BSE", "2024-01-23", 1.5);
const DOLPHIN = row(
  "6a7c465dc76486c7e9fead25",
  "DOLPHIN",
  "BSE",
  "2024-01-29",
  10,
);
const LOST = row(
  "00000000000000000000000a",
  "LOSTBARS",
  "NSE",
  "2019-03-01",
  2,
);
const NOLIST = row("00000000000000000000000b", "GONE", "BSE", "2019-03-01", 2);
const NOBEFORE = row(
  "00000000000000000000000e",
  "TRUNCATED",
  "NSE",
  "2026-04-22",
  0.5,
);
const NORATIO = row(
  "00000000000000000000000c",
  "NORATIO",
  "BSE",
  "2019-03-01",
  null,
);
const FEED = row(
  "00000000000000000000000d",
  "FOCUS",
  "BSE",
  "2023-08-23",
  1.8,
  "BSE",
);

const ROWS = [
  SAYAJI,
  KANORI,
  ZEEL,
  DOLPHIN,
  LOST,
  NOLIST,
  NORATIO,
  FEED,
  NOBEFORE,
];
const EVIDENCE = new Map<string, Evidence | null>([
  [
    "6a7c4bb5c76486c7e9feadaf",
    { before: bar("2015-01-16", 138.7), onDay: bar("2026-04-22", 276) },
  ],
  [
    "6a7c4943c76486c7e9fead4b",
    { before: bar("1996-01-24", 69.45), onDay: bar("1996-06-04", 35) },
  ],
  [
    "6a7c4605c76486c7e9fead23",
    { before: bar("2024-01-19", 235.5), onDay: bar("2024-01-23", 155.9) },
  ],
  [
    "6a7c465dc76486c7e9fead25",
    { before: bar("2024-01-24", 1826.85), onDay: bar("2024-01-29", 186.35) },
  ],
  ["00000000000000000000000a", { before: bar("2019-02-28", 100), onDay: null }],
  ["00000000000000000000000b", null],
  // SAYAJIHOTL's own day, with every earlier close gone from the series.
  ["00000000000000000000000e", { before: null, onDay: bar("2026-04-22", 276) }],
  [
    "00000000000000000000000c",
    { before: bar("2019-02-28", 100), onDay: bar("2019-03-01", 50) },
  ],
  [
    "00000000000000000000000d",
    { before: bar("2023-08-22", 100), onDay: bar("2023-08-23", 100) },
  ],
]);

const byKey = (plan: ReturnType<typeof planRetire>) =>
  Object.fromEntries(plan.judged.map((j) => [j.key, j.verdict]));

describe("planRetire — the real prod rows", () => {
  // Planned INSIDE each case, so a planner that throws fails every case by
  // name rather than as one suite-level error that `# fail 0` hides.
  let plan: ReturnType<typeof planRetire>;
  beforeEach(() => {
    plan = planRetire(ROWS, EVIDENCE);
  });

  it("retires the two gap-spanning rows and nothing else", () => {
    assert.deepEqual(byKey(plan), {
      "SAYAJIHOTL:NSE 2026-04-22": "GAP",
      "KANORICHEM:NSE 1996-06-04": "GAP",
      "ZEEL:BSE 2024-01-23": "CONFIRMED",
      "DOLPHIN:BSE 2024-01-29": "CONFIRMED",
      "LOSTBARS:NSE 2019-03-01": "NO_BAR_ON_DAY",
      "GONE:BSE 2019-03-01": "NO_LISTING",
      "NORATIO:BSE 2019-03-01": "NO_RATIO",
      "TRUNCATED:NSE 2026-04-22": "NO_BAR_BEFORE",
    });
    assert.deepEqual(
      plan.deletes.map((d) => d.id),
      ["6a7c4bb5c76486c7e9feadaf", "6a7c4943c76486c7e9fead4b"],
    );
  });

  it("ZEEL:BSE and DOLPHIN:BSE stay — ZEEL:NSE and DOLPHIN:NSE are adjusted only by them", () => {
    const kept = new Set(plan.deletes.map((d) => d.id));
    assert.ok(!kept.has(idOf(ZEEL)) && !kept.has(idOf(DOLPHIN)));
  });

  it("an UNKNOWN row is never retired: no bar on its day or before it, no listing, no ratio", () => {
    for (const r of [LOST, NOLIST, NORATIO, NOBEFORE]) {
      assert.ok(!plan.deletes.some((d) => d.id === idOf(r)), String(r.symbol));
    }
  });

  it("a FEED row is never judged, even with a flat print on its day", () => {
    assert.ok(!plan.judged.some((j) => j.id === idOf(FEED)));
    assert.ok(!plan.deletes.some((d) => d.id === idOf(FEED)));
  });

  it("each delete is compare-and-set on the source and the updatedAt read", () => {
    for (const d of plan.deletes) {
      assert.deepEqual(d.expect, {
        source: "DERIVED",
        updatedAt: { $date: "2026-08-12T10:32:21.293Z" },
      });
    }
  });

  it("backs up each retired row VERBATIM before anything is deleted", () => {
    assert.deepEqual(
      plan.backup.map((b) => [b.id, b.role, b.doc]),
      [
        [idOf(SAYAJI), "retired:GAP", SAYAJI],
        [idOf(KANORI), "retired:GAP", KANORI],
      ],
    );
    assert.equal(BACKUP_COLLECTION, "corporate_actions_money1600_backup");
  });

  it("is idempotent: re-planning the simulated result retires nothing", () => {
    assert.deepEqual(
      planRetire(simulateRetire(ROWS, plan), EVIDENCE).deletes,
      [],
    );
  });
});

describe("sessionDay — the IST session a row's exDate names", () => {
  it("00:00Z (MONEY-1530's anchor) and 18:30Z the evening before name the same day", () => {
    const want = {
      start: Date.parse("2026-04-22T00:00:00Z"),
      end: Date.parse("2026-04-23T00:00:00Z"),
    };
    assert.deepEqual(sessionDay({ $date: "2026-04-22T00:00:00Z" }), want);
    assert.deepEqual(sessionDay({ $date: "2026-04-21T18:30:00Z" }), want);
    assert.equal(sessionDay(null), null);
  });
});

describe("planRetireRestore", () => {
  it("re-inserts what is gone and never overwrites what is there", () => {
    const backup = [SAYAJI, KANORI].map((doc) => ({
      _id: doc._id,
      doc,
      role: "retired:GAP",
    }));
    const plan = planRetireRestore(backup, new Set([idOf(KANORI)]));
    assert.deepEqual(plan.insert, [SAYAJI]);
    assert.deepEqual(plan.present, [idOf(KANORI)]);
  });
});

function idOf(doc: RawDoc): string {
  return (doc._id as { $oid: string }).$oid;
}
