/**
 * Broker sync — transaction-safe write contract (MONEY-582a).
 *
 * The live sync helpers syncHoldingsToDb / syncPositionsToDb / syncMutualFundsToDb
 * (apps/web/lib/actions/broker-connection.ts) are "use server" + pull prisma,
 * so they cannot be imported under `node --import tsx`. Per the repo convention
 * we inline-copy the PURE write sequence and run it against a mock db that mirrors
 * Prisma's $transaction(cb)/deleteMany/createMany surface.
 *
 * Contract under test:
 *  - holdings: SKIP on empty (never delete), else atomic delete+insert
 *  - positions: clear-on-empty is intentional, but delete+insert must be ATOMIC
 *  - a createMany failure must roll back the delete (never a half/full wipe)
 *
 * (Trades + mutual funds use upsert-in-batches, not delete-then-insert, so they
 * have no wipe vector and are out of scope for 582a.)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ---- Mock Prisma surface (mirrors the real client used in the helpers) ----

interface Row {
  id: string;
}

class MockTable {
  rows: Row[];
  failCreate: boolean;
  deleteCalls = 0;
  createCalls = 0;
  constructor(initial: Row[], failCreate = false) {
    this.rows = [...initial];
    this.failCreate = failCreate;
  }
  async deleteMany() {
    this.deleteCalls++;
    this.rows = [];
    return { count: 0 };
  }
  async createMany({ data }: { data: Row[] }) {
    this.createCalls++;
    if (this.failCreate) throw new Error("createMany failed (simulated 5xx)");
    this.rows.push(...data);
    return { count: data.length };
  }
}

/**
 * Mock prisma.$transaction(cb): snapshots every table, runs the callback, and
 * on throw restores the snapshots — the atomicity guarantee the real fix relies
 * on. (Mongo replica-set transactions give the same all-or-nothing semantics.)
 */
function makeDb(tables: Record<string, MockTable>) {
  return {
    ...tables,
    async $transaction(cb: (tx: Record<string, MockTable>) => Promise<void>) {
      const snapshot: Record<string, Row[]> = {};
      for (const k of Object.keys(tables)) snapshot[k] = [...tables[k].rows];
      try {
        await cb(tables);
      } catch (e) {
        for (const k of Object.keys(tables)) tables[k].rows = snapshot[k];
        throw e;
      }
    },
  };
}

// ---- Inline copies of the fixed helpers (MONEY-582a) ----

async function syncHoldingsToDb(
  db: ReturnType<typeof makeDb>,
  holdings: Row[]
) {
  if (holdings.length === 0) return; // skip-on-empty
  await db.$transaction(async (tx) => {
    await tx.holding.deleteMany();
    await tx.holding.createMany({ data: holdings });
  });
}

async function syncPositionsToDb(
  db: ReturnType<typeof makeDb>,
  positions: Row[]
) {
  // positions: clear-on-empty is intentional, but atomic
  await db.$transaction(async (tx) => {
    await tx.position.deleteMany();
    if (positions.length > 0) {
      await tx.position.createMany({ data: positions });
    }
  });
}

const existing: Row[] = [{ id: "A" }, { id: "B" }];

describe("MONEY-582a — holdings sync is wipe-safe", () => {
  it("empty fetch is a NO-OP — never deletes existing holdings", async () => {
    const t = new MockTable(existing);
    const db = makeDb({ holding: t });
    await syncHoldingsToDb(db, []);
    assert.equal(t.deleteCalls, 0, "deleteMany must not run on empty");
    assert.deepEqual(
      t.rows.map((r) => r.id),
      ["A", "B"],
      "existing holdings preserved"
    );
  });

  it("non-empty fetch replaces atomically", async () => {
    const t = new MockTable(existing);
    const db = makeDb({ holding: t });
    await syncHoldingsToDb(db, [{ id: "C" }]);
    assert.equal(t.deleteCalls, 1);
    assert.deepEqual(
      t.rows.map((r) => r.id),
      ["C"]
    );
  });

  it("createMany failure ROLLS BACK the delete — no wipe", async () => {
    const t = new MockTable(existing, /* failCreate */ true);
    const db = makeDb({ holding: t });
    await assert.rejects(() => syncHoldingsToDb(db, [{ id: "C" }]));
    assert.deepEqual(
      t.rows.map((r) => r.id),
      ["A", "B"],
      "rolled back to original — never half/fully wiped"
    );
  });
});

describe("MONEY-582a — positions clear-on-empty but atomic", () => {
  it("empty fetch DOES clear (intentional — squared-off/expired)", async () => {
    const t = new MockTable(existing);
    const db = makeDb({ position: t });
    await syncPositionsToDb(db, []);
    assert.equal(t.deleteCalls, 1, "positions clear on empty by design");
    assert.deepEqual(t.rows, []);
  });

  it("non-empty replaces atomically", async () => {
    const t = new MockTable(existing);
    const db = makeDb({ position: t });
    await syncPositionsToDb(db, [{ id: "C" }]);
    assert.deepEqual(
      t.rows.map((r) => r.id),
      ["C"]
    );
  });

  it("createMany failure rolls back the delete", async () => {
    const t = new MockTable(existing, true);
    const db = makeDb({ position: t });
    await assert.rejects(() => syncPositionsToDb(db, [{ id: "C" }]));
    assert.deepEqual(
      t.rows.map((r) => r.id),
      ["A", "B"],
      "rolled back — positions not wiped on failed write"
    );
  });
});
