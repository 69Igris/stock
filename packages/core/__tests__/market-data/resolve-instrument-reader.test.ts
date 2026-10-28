/**
 * MONEY-980 — `defaultInstrumentReader`, EXECUTED.
 *
 * ## Why this file exists separately from `resolve-instrument.test.ts`
 *
 * That file tests `resolveInstrument` through an injected reader, so it proves
 * which reads are ISSUED and with what arguments — and then hands
 * `defaultInstrumentReader` to a source SCAN, because the production reader
 * talks to Prisma and CI has no database.
 *
 * A scan is not a test of behaviour, and the gap was measurable: FOUR
 * where-clause mutations survived the entire suite —
 *
 *   1. swapping the `US_LIVE_STATUSES` / `US_ALL_STATUSES` ternary, so
 *      `liveOnly` returned the DELISTED tail and `includeInactive` hid it;
 *   2. deleting `exchange: { in: exchanges }` from the India read, so every
 *      India lookup ignored the venue scope `resolveInstrument` computed;
 *   3. deleting the US venue narrowing, so `exchange: "NASDAQ"` silently
 *      answered from NYSE as well;
 *   4. flipping `orderBy: { listingStartDate }` to `asc`, so a pathological
 *      recycled ticker's `take` kept its OLDEST windows — the ones most likely
 *      to be delisted — and dropped the current occupant.
 *
 * Every one is a `where`/`orderBy` clause, which is exactly the class of bug
 * this whole module was written to fix: the old call sites' ranking was fine,
 * it was the query that had gone stale. So they get executing tests.
 *
 * ## How the reader is reached without a database
 *
 * `packages/database/client.ts` reads `globalThis.prisma` BEFORE constructing a
 * `PrismaClient`. That seam already exists for Next's dev-server HMR; setting
 * it here makes the exported `prisma` a recording double. It has to be set
 * before `@usemoney/database` is first evaluated, which is why the module under
 * test is pulled in with a DYNAMIC import — a static one is hoisted above every
 * statement in the file and would win the race.
 *
 * No module mocking, no experimental flags, and the assertions run against the
 * REAL exported `defaultInstrumentReader`.
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** One captured `findMany` argument object. */
interface FindManyArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: unknown;
  take?: unknown;
}

const indiaCalls: FindManyArgs[] = [];
const usCalls: FindManyArgs[] = [];

// Rows the doubles return. Mutated per test; the reader passes them through
// verbatim, so their shape only has to satisfy the return types.
let indiaRows: unknown[] = [];
let usRows: unknown[] = [];

(
  globalThis as unknown as {
    prisma?: unknown;
  }
).prisma = {
  instrumentMapping: {
    findMany: async (args: FindManyArgs) => {
      indiaCalls.push(args);
      return indiaRows;
    },
  },
  usInstrument: {
    findMany: async (args: FindManyArgs) => {
      usCalls.push(args);
      return usRows;
    },
  },
};

// DYNAMIC, and after the assignment above. See the header.
const { defaultInstrumentReader } =
  await import("../../src/market-data/instruments/resolve-instrument");
const { RESOLVE_ROW_LIMIT } =
  await import("../../src/market-data/instruments/resolve-instrument-logic");

/** The last India `where`, or a failure if no read was issued. */
function lastIndiaWhere(): Record<string, unknown> {
  const call = indiaCalls.at(-1);
  assert.ok(call, "no India read was issued");
  assert.ok(call.where, "the India read carried no where clause");
  return call.where;
}

function lastUsWhere(): Record<string, unknown> {
  const call = usCalls.at(-1);
  assert.ok(call, "no US read was issued");
  assert.ok(call.where, "the US read carried no where clause");
  return call.where;
}

beforeEach(() => {
  indiaCalls.length = 0;
  usCalls.length = 0;
  indiaRows = [];
  usRows = [];
});

describe("the double is actually wired to the real reader", () => {
  test("a read reaches the recorder and its rows come back out", async () => {
    // Without this every assertion below could be passing against a reader
    // that never ran. It pins BOTH directions: the args arrive, and the rows
    // the double returns are what the reader hands back.
    const sentinel = { id: "sentinel" };
    indiaRows = [sentinel];
    usRows = [sentinel];

    const india = await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["NSE"],
      liveOnly: true,
    });
    const us = await defaultInstrumentReader.readUs({
      symbol: "ACC",
      liveOnly: true,
    });

    assert.equal(indiaCalls.length, 1);
    assert.equal(usCalls.length, 1);
    assert.equal(india[0], sentinel);
    assert.equal(us[0], sentinel);
  });
});

describe("the India read — mutation 2: the venue scope", () => {
  test("the caller's exchanges reach the where clause as an `in`", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["NSE", "BSE", "MCX"],
      liveOnly: true,
    });
    // Deleting `exchange: { in: exchanges }` leaves this key ABSENT — which
    // reads as "any venue", the exact widening `resolveInstrument` computes the
    // list to prevent.
    assert.deepEqual(lastIndiaWhere().exchange, { in: ["NSE", "BSE", "MCX"] });
  });

  test("the exchange list is COPIED, not aliased into the query", async () => {
    // Prisma keeps the argument object; handing it the caller's array lets a
    // later mutation of that array change a query already issued.
    const exchanges = ["NSE", "BSE"];
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges,
      liveOnly: true,
    });
    const sent = (lastIndiaWhere().exchange as { in: string[] }).in;
    assert.notEqual(sent, exchanges, "the query aliases the caller's array");
    assert.deepEqual(sent, exchanges);
  });

  test("a one-venue scope is one venue, not a widen", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["BSE"],
      liveOnly: true,
    });
    assert.deepEqual(lastIndiaWhere().exchange, { in: ["BSE"] });
  });

  test("the symbol is passed through EXACTLY, with no operator wrapper", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "RELIANCE",
      exchanges: ["NSE"],
      liveOnly: true,
    });
    // A `{ contains }` or `{ startsWith }` here would turn an exact-symbol
    // rung into a prefix search and resolve RELIANCE to RELIANCEPP.
    assert.equal(lastIndiaWhere().symbol, "RELIANCE");
  });
});

describe("the India read — liveness is POSITIVE and conditional", () => {
  test("liveOnly asks for isActive: true", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["NSE"],
      liveOnly: true,
    });
    assert.equal(lastIndiaWhere().isActive, true);
  });

  test("liveOnly: false OMITS the key rather than negating it", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["NSE"],
      liveOnly: false,
    });
    const where = lastIndiaWhere();
    assert.ok(
      !("isActive" in where),
      "`isActive: { not: true }` / `false` would EXCLUDE the live rows " +
        "includeInactive is supposed to ADD to",
    );
  });
});

describe("the US read — mutation 1: which statuses are live", () => {
  test("liveOnly asks for ACTIVE and nothing else", async () => {
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    // Swapping the ternary makes this ["ACTIVE","DELISTED"] — the default
    // lookup then answers with Lehman Brothers.
    assert.deepEqual(lastUsWhere().listingStatus, { in: ["ACTIVE"] });
  });

  test("liveOnly: false widens to ACTIVE **and** DELISTED", async () => {
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: false });
    // Swapping the ternary makes this ["ACTIVE"], so `includeInactive` — whose
    // entire purpose is the delisted tail — would return exactly what it
    // returned without it, silently.
    assert.deepEqual(lastUsWhere().listingStatus, {
      in: ["ACTIVE", "DELISTED"],
    });
  });

  test("the two status sets DIFFER (a ternary over one list is not a ternary)", async () => {
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: false });
    const live = (usCalls[0]?.where?.listingStatus as { in: string[] }).in;
    const all = (usCalls[1]?.where?.listingStatus as { in: string[] }).in;
    assert.notDeepEqual(live, all);
    assert.ok(all.length > live.length);
  });

  test("liveness is never expressed as a NEGATION", async () => {
    // `{ not: "DELISTED" }` matches ZERO against a Mongo-absent attribute —
    // MONEY-1050 / -1205 / -1234 / -1235. Asserted on the VALUE the reader
    // actually built, not on the file's text.
    for (const liveOnly of [true, false]) {
      await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly });
      const status = lastUsWhere().listingStatus as Record<string, unknown>;
      assert.ok(!("not" in status), "negated liveness matches nothing");
      assert.ok(!("notIn" in status));
      assert.ok(Array.isArray(status.in));
    }
  });
});

describe("the US read — mutation 3: the venue narrowing", () => {
  test("an exchange hint reaches the where clause", async () => {
    await defaultInstrumentReader.readUs({
      symbol: "ACC",
      exchange: "NASDAQ",
      liveOnly: true,
    });
    // Deleting the spread leaves this ABSENT, so a caller who named NASDAQ
    // gets NYSE rows too — and on a recycled ticker that is an AMBIGUOUS
    // refusal where there should have been one answer.
    assert.equal(lastUsWhere().exchange, "NASDAQ");
  });

  test("NO exchange hint omits the key — it does not send undefined", async () => {
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    const where = lastUsWhere();
    assert.ok(
      !("exchange" in where),
      "`exchange: undefined` is a different query from an absent key",
    );
  });

  test("the two shapes differ, so the branch is real", async () => {
    await defaultInstrumentReader.readUs({
      symbol: "ACC",
      exchange: "NYSE",
      liveOnly: true,
    });
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    assert.notDeepEqual(usCalls[0]?.where, usCalls[1]?.where);
  });
});

describe("the US read — mutation 4: the ordering under the bound", () => {
  test("rows are ordered by listingStartDate DESC", async () => {
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    // `asc` truncates to the OLDEST windows of a recycled ticker, which are the
    // most likely to be DELISTED — so the bound would drop the current
    // occupant and the resolver would answer about a dead company.
    assert.deepEqual(usCalls.at(-1)?.orderBy, { listingStartDate: "desc" });
  });

  test("the order is not left to Mongo's natural order", async () => {
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    assert.notEqual(
      usCalls.at(-1)?.orderBy,
      undefined,
      "an unordered `take` is an arbitrary N of the matching rows",
    );
  });
});

describe("both reads are bounded and project what the ranker needs", () => {
  test("take is RESOLVE_ROW_LIMIT on both collections", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["NSE"],
      liveOnly: true,
    });
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    assert.equal(indiaCalls.at(-1)?.take, RESOLVE_ROW_LIMIT);
    assert.equal(usCalls.at(-1)?.take, RESOLVE_ROW_LIMIT);
  });

  test("the India select carries every field toResolvedIndia reads", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["NSE"],
      liveOnly: true,
    });
    // A missing column is not a type error at runtime — Prisma just omits it
    // and the projection silently reports `undefined`. `isActive` in
    // particular would make every row read as NOT live.
    for (const field of [
      "id",
      "symbol",
      "exchange",
      "name",
      "yahooSymbol",
      "instrumentType",
      "isin",
      "isActive",
    ]) {
      assert.equal(
        indiaCalls.at(-1)?.select?.[field],
        true,
        `India select is missing ${field}`,
      );
    }
  });

  test("the US select carries every field toResolvedUs reads", async () => {
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    for (const field of [
      "id",
      "listingId",
      "symbol",
      "exchange",
      "name",
      "assetType",
      "listingStatus",
      "listingStartDate",
    ]) {
      assert.equal(
        usCalls.at(-1)?.select?.[field],
        true,
        `US select is missing ${field}`,
      );
    }
  });

  test("neither read selects the OTHER collection's columns", async () => {
    await defaultInstrumentReader.readIndia({
      symbol: "ACC",
      exchanges: ["NSE"],
      liveOnly: true,
    });
    await defaultInstrumentReader.readUs({ symbol: "ACC", liveOnly: true });
    assert.ok(!("listingId" in (indiaCalls.at(-1)?.select ?? {})));
    assert.ok(!("yahooSymbol" in (usCalls.at(-1)?.select ?? {})));
  });
});
