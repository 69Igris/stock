/**
 * MONEY-1617 — `scripts/data/relabel-us-candles-logic.ts`: which stored US D1
 * bars move to the window the master resolves, and which are refused.
 *
 * Fixtures are the measured prod shapes: RAM (a split row, 50 sessions under
 * the old id), GAB (a one-day phantom took 09-21), DSPC (a venue change whose
 * bars already sit, identical, under the resolved id) and CADE (a ticker's
 * whole series filed under one listing).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ListingRow } from "../../src/market-data/databento/databento-symbology";

const L =
  (await import("../../../../scripts/data/relabel-us-candles-logic")) as typeof import("../../../../scripts/data/relabel-us-candles-logic");

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const win = (
  listingId: string,
  start: string,
  end: string | null,
  listingStatus = "ACTIVE",
): ListingRow => {
  const [symbol, exchange] = listingId.split(":") as [string, string];
  return {
    symbol,
    exchange,
    listingId,
    listingStartDate: d(start),
    listingEndDate: end ? d(end) : null,
    listingStatus,
  };
};
let seq = 0;
const bar = (
  listingId: string,
  date: string,
  close = 10,
): import("../../../../scripts/data/relabel-us-candles-logic").StoredBar => {
  const [symbol, exchange] = listingId.split(":") as [string, string];
  return {
    id: `id${++seq}`,
    symbol,
    exchange,
    timeframe: "D1",
    ts: d(date),
    listingId,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
  };
};

const RAM_OLD = win(
  "RAM:NASDAQ:2021-07-09",
  "2021-07-09",
  "2023-03-31",
  "DELISTED",
);
const RAM_NEW = win("RAM:NASDAQ:2026-06-24", "2026-06-24", "2026-09-22");

describe("MONEY-1617 — relabel planning", () => {
  it("RAM: bars after the old window's new END move to the split-off row (SPLIT)", () => {
    const bars = [
      bar(RAM_OLD.listingId, "2023-03-31"),
      bar(RAM_OLD.listingId, "2026-06-24", 12.305),
      bar(RAM_OLD.listingId, "2026-09-02", 12.24),
    ];
    const p = L.planStore(bars, [RAM_OLD, RAM_NEW]);
    assert.equal(p.ok, 1);
    assert.deepEqual(
      p.moves.map((m) => [
        m.from.ts.toISOString().slice(0, 10),
        m.listingId,
        m.cls,
      ]),
      [
        ["2026-06-24", RAM_NEW.listingId, "SPLIT"],
        ["2026-09-02", RAM_NEW.listingId, "SPLIT"],
      ],
    );
    assert.equal(p.moves[0]!.exchange, "NASDAQ");
    assert.equal(p.moves[0]!.venueChange, false);
  });

  it("GAB: the session a one-day phantom took goes back to the long listing (PHANTOM)", () => {
    const LONG = win("GAB:NYSE:1987-11-05", "1987-11-05", "2026-09-23");
    const PHANTOM = win(
      "GAB:NYSE:2026-09-21",
      "2026-09-21",
      "2026-09-21",
      "DELISTED",
    );
    const p = L.planStore(
      [bar(PHANTOM.listingId, "2026-09-21")],
      [LONG, PHANTOM],
    );
    assert.deepEqual(
      p.moves.map((m) => [m.listingId, m.cls]),
      [[LONG.listingId, "PHANTOM"]],
    );
  });

  it("CADE: sessions either side of an OVERLAP move to the one window covering them; the overlap stays", () => {
    // Prod's real shape: 1985-10-16..2026-01-30 and 2017-04-13..2021-10-28 on
    // ONE venue, every bar stored under the 2017 id.
    const LONG = win(
      "CADE:NYSE:1985-10-16",
      "1985-10-16",
      "2026-01-30",
      "DELISTED",
    );
    const SHORT = win(
      "CADE:NYSE:2017-04-13",
      "2017-04-13",
      "2021-10-28",
      "DELISTED",
    );
    const p = L.planStore(
      [
        bar(SHORT.listingId, "2001-05-01"),
        bar(SHORT.listingId, "2019-06-03"),
        bar(SHORT.listingId, "2022-05-02"),
      ],
      [LONG, SHORT],
    );
    // 2022: the stored window ENDED before the session, but the target began
    // long before it ended — not a split, a whole series under one id.
    assert.deepEqual(
      p.moves.map((m) => [
        m.from.ts.toISOString().slice(0, 4),
        m.listingId,
        m.cls,
      ]),
      [
        ["2001", LONG.listingId, "NON_COVERING"],
        ["2022", LONG.listingId, "NON_COVERING"],
      ],
    );
    assert.equal(p.left.AMBIGUOUS, 1);
  });

  describe("DSPC: a venue change", () => {
    const NASDAQ = win(
      "DSPC:NASDAQ:2021-05-19",
      "2021-05-19",
      "2026-08-26",
      "DELISTED",
    );
    const BATS = win("DSPC:BATS:2026-08-27", "2026-08-27", "2026-09-22");

    it("an IDENTICAL bar already under the resolved id makes the stale copy a REMOVE", () => {
      const stale = bar(NASDAQ.listingId, "2026-08-27", 5);
      const kept = bar(BATS.listingId, "2026-08-27", 5);
      const p = L.planStore([stale, kept], [NASDAQ, BATS]);
      assert.equal(p.moves.length, 0);
      assert.deepEqual(
        p.removes.map((m) => m.from.id),
        [stale.id],
      );
      assert.equal(p.ok, 1);
    });

    it("a DIFFERENT bar at the target key is a CONFLICT — never merged, nothing moved", () => {
      const stale = bar(NASDAQ.listingId, "2026-08-27", 5);
      // Only the CLOSE differs: a same-close definition of "duplicate" is the
      // one the MISMATCH extract used, and it is not identity.
      const kept = { ...bar(BATS.listingId, "2026-08-27", 5), close: 5.01 };
      const p = L.planStore([stale, kept], [NASDAQ, BATS]);
      assert.equal(p.moves.length + p.removes.length, 0);
      assert.equal(p.left.CONFLICT, 1);
    });

    it("with nothing at the target key the bar moves, venue AND id", () => {
      const p = L.planStore(
        [bar(NASDAQ.listingId, "2026-09-01")],
        [NASDAQ, BATS],
      );
      assert.deepEqual(
        p.moves.map((m) => [m.listingId, m.exchange, m.venueChange]),
        [[BATS.listingId, "BATS", true]],
      );
    });
  });

  it("REFUSES a session several real windows cover, and one none covers", () => {
    const a = win("SLVR:NASDAQ:2021-11-01", "2021-11-01", "2026-06-08");
    const b = win("SLVR:NASDAQ:2025-01-15", "2025-01-15", "2026-09-22");
    const p = L.planStore(
      [bar(b.listingId, "2025-06-02"), bar(b.listingId, "2021-01-04")],
      [a, b],
    );
    assert.equal(p.moves.length + p.removes.length, 0);
    assert.deepEqual(p.left, { UNRESOLVED: 1, AMBIGUOUS: 1, CONFLICT: 0 });
  });

  it("is IDEMPOTENT: re-planning the applied result plans nothing", () => {
    const NASDAQ = win(
      "DSPC:NASDAQ:2021-05-19",
      "2021-05-19",
      "2026-08-26",
      "DELISTED",
    );
    const BATS = win("DSPC:BATS:2026-08-27", "2026-08-27", "2026-09-22");
    const windows = [RAM_OLD, RAM_NEW];
    const bars = [
      bar(RAM_OLD.listingId, "2026-06-24"),
      bar(RAM_OLD.listingId, "2022-01-03"),
    ];
    const once = L.planStore(bars, windows);
    assert.equal(L.planSize(once), 1);
    assert.equal(
      L.planSize(L.planStore(L.applyStorePlan(bars, once), windows)),
      0,
    );

    // A VENUE move must land under the new key, or a re-plan finds it again.
    const venue = [bar(NASDAQ.listingId, "2026-09-01")];
    const vp = L.planStore(venue, [NASDAQ, BATS]);
    const va = L.applyStorePlan(venue, vp);
    assert.deepEqual(
      [va[0]!.listingId, va[0]!.exchange],
      [BATS.listingId, "BATS"],
    );
    assert.equal(L.planSize(L.planStore(va, [NASDAQ, BATS])), 0);

    const dup = [
      bar(NASDAQ.listingId, "2026-08-27", 5),
      bar(BATS.listingId, "2026-08-27", 5),
    ];
    const first = L.planStore(dup, [NASDAQ, BATS]);
    const after = L.applyStorePlan(dup, first);
    assert.equal(after.length, 1, "the identical stale copy is gone");
    assert.equal(L.planSize(L.planStore(after, [NASDAQ, BATS])), 0);
  });
});

describe("MONEY-1617 — the arm flag and the backup order", () => {
  it("arms on the LITERAL string only", () => {
    assert.equal(L.isArmed("true"), true);
    for (const v of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      assert.equal(L.isArmed(v), false, String(v));
    }
  });

  const SRC = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "scripts",
      "data",
      "relabel-us-candles.ts",
    ),
    "utf8",
  );
  const at = (needle: string): number => {
    const i = SRC.indexOf(needle);
    assert.ok(i > 0, `${needle} not found`);
    return i;
  };

  it("writes nothing unless BOTH --apply and the arm flag say so", () => {
    assert.match(SRC, /const apply = wantApply && isArmed\(\);/);
    assert.ok(at("if (!apply) {") < at("await consent("));
  });

  it("backs up — and counts back — BEFORE any Mongo write, and copies a shard BEFORE rewriting it", () => {
    const backup = at("await backupVerified(");
    assert.ok(backup < at("await deleteOps("));
    assert.ok(backup < at("await updateOps("));
    assert.ok(
      at(".copy(bucket.file(backupKey))") <
        at("await bucket.file(s.key).save("),
    );
    assert.match(SRC, /ifGenerationMatch: Number\(s\.generation\)/);
  });

  it("rewrites a shard in the format it was READ in, never the configured one", () => {
    assert.match(
      SRC,
      /encodeColdShard\(\s*applyStorePlan\(s\.bars, s\.plan\),\s*s\.format,?\s*\)/,
    );
    assert.doesNotMatch(SRC, /resolveColdShardFormat/);
  });
});
