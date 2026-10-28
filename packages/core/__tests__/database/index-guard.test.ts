/**
 * The writers assume indexes the database is never asked about. MONEY-1485.
 *
 * `putCandles` absorbs a duplicate-key collision correctly — and only ever gets
 * one if the unique index exists. In QA it did not (duplicates predated the
 * `@@unique`, so `prisma db push` could not build it), so every duplicate
 * inserted cleanly and was counted as `created`: a green run writing exactly
 * the rows its own contract forbids.
 *
 * These cases EXECUTE the decision and the gathering, including against a fake
 * client, because MONEY-1481's lesson was that a rule which cannot be executed
 * by a test is a rule nothing checks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  auditIndexes,
  formatIndexAudit,
  judgeConstraint,
  uniqueConstraintsFromDmmf,
  type ObservedIndex,
  type UniqueConstraint,
} from "../../src/database/index-guard-logic";
import {
  auditDatabaseIndexes,
  type RawCommandRunner,
} from "../../src/database/index-guard";

const CANDLES: UniqueConstraint = {
  model: "Candle",
  collection: "candles",
  fields: ["symbol", "exchange", "timeframe", "ts"],
};

const idIndex: ObservedIndex = { name: "_id_", key: { _id: 1 }, unique: true };

function keyOf(fields: readonly string[]): Record<string, number> {
  return Object.fromEntries(fields.map((f) => [f, 1]));
}

describe("judgeConstraint", () => {
  it("MISSING when the collection exists and the index does not — the QA state", () => {
    const f = judgeConstraint(CANDLES, [idIndex]);
    assert.equal(f.verdict, "MISSING");
    assert.match(f.detail, /NO index/);
  });

  it("OK when a unique index covers exactly those fields", () => {
    const f = judgeConstraint(CANDLES, [
      idIndex,
      {
        name: "candles_symbol_exchange_timeframe_ts_key",
        key: keyOf(CANDLES.fields),
        unique: true,
      },
    ]);
    assert.equal(f.verdict, "OK");
  });

  it("MISSING when an index on the right fields is NOT unique", () => {
    // The most misleading state there is: every listing shows an index there.
    const f = judgeConstraint(CANDLES, [
      idIndex,
      { name: "candles_lookup", key: keyOf(CANDLES.fields), unique: false },
    ]);
    assert.equal(f.verdict, "MISSING");
    assert.match(f.detail, /NOT unique/);
  });

  it("WEAKENED when the unique index is SPARSE", () => {
    const f = judgeConstraint(CANDLES, [
      {
        name: "candles_sparse",
        key: keyOf(CANDLES.fields),
        unique: true,
        sparse: true,
      },
    ]);
    assert.equal(f.verdict, "WEAKENED");
  });

  it("WEAKENED when the unique index is PARTIAL", () => {
    const f = judgeConstraint(CANDLES, [
      {
        name: "candles_partial",
        key: keyOf(CANDLES.fields),
        unique: true,
        partialFilterExpression: { tier: "WINDOW" },
      },
    ]);
    assert.equal(f.verdict, "WEAKENED");
  });

  it("COLLECTION_ABSENT is not a fault — no row can violate a constraint in an empty namespace", () => {
    const f = judgeConstraint(CANDLES, null);
    assert.equal(f.verdict, "COLLECTION_ABSENT");
    assert.match(f.detail, /Not a fault/);
  });

  it("field ORDER does not matter: (a,b) and (b,a) enforce the same constraint", () => {
    const reversed = [...CANDLES.fields].reverse();
    const f = judgeConstraint(CANDLES, [
      { name: "rebuilt_by_hand", key: keyOf(reversed), unique: true },
    ]);
    assert.equal(
      f.verdict,
      "OK",
      "a false MISSING on a correct database is how an alarm gets switched off",
    );
  });

  it("direction does not matter: a DESC unique index enforces what ASC enforces", () => {
    const key = keyOf(CANDLES.fields);
    key.ts = -1;
    const f = judgeConstraint(CANDLES, [
      { name: "desc_ts", key, unique: true },
    ]);
    assert.equal(f.verdict, "OK");
  });

  it("a PREFIX of the fields is not a match", () => {
    const f = judgeConstraint(CANDLES, [
      { name: "too_narrow", key: keyOf(["symbol", "exchange"]), unique: true },
    ]);
    assert.equal(f.verdict, "MISSING");
  });

  it("a SUPERSET of the fields is not a match either", () => {
    const f = judgeConstraint(CANDLES, [
      {
        name: "too_wide",
        key: keyOf([...CANDLES.fields, "source"]),
        unique: true,
      },
    ]);
    assert.equal(f.verdict, "MISSING");
  });
});

describe("auditIndexes — the audit must not report health it did not measure", () => {
  it("REFUSES an empty constraint set rather than reporting 0 missing", () => {
    const audit = auditIndexes([], new Map());
    assert.notEqual(audit.refusal, null);
    assert.match(String(audit.refusal), /never ran/);
    assert.equal(audit.failing, 0);
    assert.match(formatIndexAudit(audit), /^REFUSED:/);
  });

  it("REFUSES when a constraint's collection was never looked up", () => {
    // Judging it absent would be the HEALTHY verdict, so an incomplete audit
    // would read as a clean one.
    const audit = auditIndexes([CANDLES], new Map());
    assert.notEqual(audit.refusal, null);
    assert.match(String(audit.refusal), /never looked up/);
  });

  it("counts each verdict and makes failing = MISSING + WEAKENED", () => {
    const other: UniqueConstraint = {
      model: "StockPeers",
      collection: "stock_peers",
      fields: ["symbol", "exchange"],
    };
    const audit = auditIndexes(
      [CANDLES, other],
      new Map<string, readonly ObservedIndex[] | null>([
        ["candles", [idIndex]],
        ["stock_peers", null],
      ]),
    );
    assert.equal(audit.refusal, null);
    assert.equal(audit.missing, 1);
    assert.equal(audit.collectionAbsent, 1);
    assert.equal(audit.failing, 1);
    assert.match(formatIndexAudit(audit), /\[MISSING\] Candle -> candles/);
  });
});

describe("uniqueConstraintsFromDmmf", () => {
  it("resolves BOTH axes to database names — @@map and @map", () => {
    const [c] = uniqueConstraintsFromDmmf([
      {
        name: "Candle",
        dbName: "candles",
        fields: [
          { name: "id", dbName: "_id" },
          { name: "symbol", dbName: null },
          { name: "listingId", dbName: "listing_id" },
        ],
        uniqueIndexes: [{ name: null, fields: ["symbol", "listingId"] }],
      },
    ]);
    assert.equal(c.collection, "candles");
    assert.deepEqual(
      c.fields,
      ["symbol", "listing_id"],
      "comparing Prisma names against Mongo names matches nothing and reports " +
        "every constraint MISSING — the false-alarm direction that gets a guard deleted",
    );
  });

  it("falls back to the model name when there is no @@map", () => {
    const [c] = uniqueConstraintsFromDmmf([
      {
        name: "WatchList",
        dbName: null,
        fields: [{ name: "userId" }],
        uniqueIndexes: [{ fields: ["userId"] }],
      },
    ]);
    assert.equal(c.collection, "WatchList");
  });

  it("a model with no @@unique contributes nothing", () => {
    assert.equal(
      uniqueConstraintsFromDmmf([
        { name: "StockFlag", dbName: "stock_flags", fields: [] },
      ]).length,
      0,
    );
  });
});

/** A client that answers the two commands from a fixture. */
function fakeClient(
  collections: readonly string[] | null,
  indexes: Readonly<Record<string, readonly ObservedIndex[]>>,
  cursorId: unknown = 0,
): RawCommandRunner {
  return {
    async $runCommandRaw(command: Record<string, unknown>): Promise<unknown> {
      if ("listCollections" in command) {
        if (collections === null) return { cursor: { id: 0 } };
        return {
          cursor: {
            id: cursorId,
            firstBatch: collections.map((name) => ({ name })),
          },
        };
      }
      const name = String(command.listIndexes);
      return { cursor: { id: 0, firstBatch: indexes[name] ?? [] } };
    },
  };
}

const CANDLE_MODEL = {
  name: "Candle",
  dbName: "candles",
  fields: [{ name: "symbol" }, { name: "ts" }],
  uniqueIndexes: [{ fields: ["symbol", "ts"] }],
};

describe("auditDatabaseIndexes — executed against a fake client", () => {
  it("finds the MONEY-1481 gap: collection present, unique index absent", async () => {
    const audit = await auditDatabaseIndexes(
      fakeClient(["candles"], { candles: [idIndex] }),
      [CANDLE_MODEL],
    );
    assert.equal(audit.refusal, null);
    assert.equal(audit.missing, 1);
    assert.equal(audit.failing, 1);
  });

  it("passes when the index is really there", async () => {
    const audit = await auditDatabaseIndexes(
      fakeClient(["candles"], {
        candles: [
          idIndex,
          { name: "k", key: { symbol: 1, ts: 1 }, unique: true },
        ],
      }),
      [CANDLE_MODEL],
    );
    assert.equal(audit.failing, 0);
    assert.equal(audit.ok, 1);
  });

  it("REFUSES a truncated listCollections instead of judging the rest absent", async () => {
    const audit = await auditDatabaseIndexes(
      fakeClient(["candles"], { candles: [] }, 12345),
      [CANDLE_MODEL],
    );
    assert.match(String(audit.refusal), /TRUNCATED/);
    assert.equal(audit.failing, 0);
  });

  it("does not call listIndexes on a collection that does not exist", async () => {
    const asked: string[] = [];
    const client: RawCommandRunner = {
      async $runCommandRaw(command) {
        if ("listCollections" in command) {
          return { cursor: { id: 0, firstBatch: [] } };
        }
        asked.push(String(command.listIndexes));
        throw new Error(
          "NamespaceNotFound — listIndexes errors on a missing collection",
        );
      },
    };
    const audit = await auditDatabaseIndexes(client, [CANDLE_MODEL]);
    assert.deepEqual(asked, []);
    assert.equal(audit.collectionAbsent, 1);
    assert.equal(audit.failing, 0);
  });

  it("reads EXTENDED-JSON directions — $runCommandRaw does not always send plain numbers", async () => {
    // `cursorIsExhausted` in the same module already has to handle
    // `{$numberLong}` for the cursor id, so requiring plain numbers here was an
    // asymmetry — and dropping a row makes its constraint read MISSING, a false
    // alarm on a correct database. Same encoding class that made MONEY-1481's
    // dedupe compare "[object Object]" against itself.
    const audit = await auditDatabaseIndexes(
      fakeClient(["candles"], {
        candles: [
          {
            name: "extended_json",
            key: {
              symbol: { $numberInt: "1" },
              ts: { $numberDouble: "-1.0" },
            } as never,
            unique: true,
          },
        ],
      }),
      [CANDLE_MODEL],
    );
    assert.equal(audit.failing, 0);
    assert.equal(audit.ok, 1);
  });

  it("a hashed/text index is not mistaken for a compound unique", async () => {
    const audit = await auditDatabaseIndexes(
      fakeClient(["candles"], {
        candles: [
          // `key` values are not numbers — this can never enforce the tuple.
          {
            name: "text_idx",
            key: { symbol: "text", ts: "text" } as never,
            unique: true,
          },
        ],
      }),
      [CANDLE_MODEL],
    );
    assert.equal(audit.missing, 1);
  });
});
