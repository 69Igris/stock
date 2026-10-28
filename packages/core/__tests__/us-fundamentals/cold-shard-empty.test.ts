/**
 * MONEY-979 — a cold shard that EXISTS and holds no rows is not a portfolio.
 *
 * ## The hole the three-state design left open
 *
 * `cold-holdings.ts` was built so that "we could not read it" can never render
 * as "this manager sold everything": a storage error is `failed`, a 404 is
 * `absent`, and both reach `getManagerHoldings` as `degraded: true` with a
 * named reason. Neither door was the one this got through.
 *
 * The Python evictor has no `if not rows` guard. A filing whose holdings yield
 * zero rows writes a **20-byte gzip of the empty string** (measured, not
 * assumed — see the first case). The reader gunzipped it, parsed zero rows, and
 * answered `{status: "present", rows: []}` — which is an ANSWER. The
 * completeness check passed, `getManagerHoldings` fell through to
 * `empty(REASON_NO_ROWS, degraded = false)`, and the API returned a confident,
 * NON-degraded empty portfolio.
 *
 * A shard of pure corruption lands in exactly the same place. `parseThirteenFShard`
 * drops a bad line rather than throwing — deliberately, so one damaged line does
 * not cost a whole manager-quarter — and "every line" is still `[]`.
 *
 * So this file pins two things: the reader classifies bytes-with-no-rows as its
 * own state, and that state survives all the way to `degraded: true` at the
 * repository boundary. The second half matters on its own — a status nothing
 * reads is the wired-to-nothing shape this branch has already found three times.
 *
 * MUTATION-VERIFIED: each `MUTATION:` note names the source edit applied,
 * confirmed RED, and reverted.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { prisma } from "@usemoney/database";

import { getManagerHoldings } from "../../src/us-fundamentals/repository";
import {
  encodeThirteenFShard,
  readThirteenFColdShard,
  setUsColdStore,
  US_COLD_REASON_SHARD_EMPTY,
  US_COLD_REASON_SHARD_UNPARSEABLE,
} from "../../src/us-fundamentals/cold-holdings";
import type { UsHoldingRow } from "../../src/us-fundamentals/types";

const COLD_PERIOD = new Date("2024-03-31T00:00:00.000Z");
const COLD_PATH = "edgar/13f/0001067983/2024-03-31";

/* ─────────────────────────────────────────────────────────────────────────
   A minimal Prisma stand-in — the same monkey-patch pattern repository.test.ts
   and candle-hot-load.test.ts use. No database, no network.
   ──────────────────────────────────────────────────────────────────────── */

type Delegate = Record<string, unknown>;
const restore: Array<() => void> = [];

function patch(model: string, method: string, impl: () => unknown): void {
  const client = prisma as unknown as Record<string, Delegate>;
  const delegate = client[model];
  if (!delegate) throw new Error(`no prisma delegate "${model}"`);
  const original = delegate[method];
  restore.push(() => {
    delegate[method] = original;
  });
  delegate[method] = async () => impl();
}

/** One COLD filing, and a hot half that legitimately has nothing. */
function armColdFiling(): void {
  patch("usThirteenFFiling", "findMany", () => [
    {
      accession: "COLD-ACC",
      filedAt: new Date("2024-05-15T00:00:00.000Z"),
      isAmendment: false,
      amendmentType: null,
      tier: "COLD",
      coldPath: COLD_PATH,
      managerName: "BERKSHIRE HATHAWAY INC",
    },
  ]);
  patch("usThirteenFHolding", "findMany", () => []);
}

beforeEach(() => {
  setUsColdStore(null);
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore.length = 0;
  setUsColdStore(null);
});

/** One real holding, so the healthy path is exercised alongside the empty one. */
function holdingRow(): UsHoldingRow {
  return {
    accession: "COLD-ACC",
    rowIndex: 0,
    managerCik10: "0001067983",
    managerName: null,
    periodOfReport: COLD_PERIOD,
    filedAt: new Date("2024-05-15T00:00:00.000Z"),
    cusip: "037833100",
    figi: "BBG000B9XRY4",
    issuerName: "Apple Inc.",
    titleOfClass: "COM",
    valueUsd: 135_360_000_000,
    shares: 789_368_450,
    sharesType: "SH",
    putCall: null,
    symbol: "AAPL",
    currency: "USD",
  };
}

describe("a present-but-EMPTY cold shard (MONEY-979)", () => {
  it("the empty shard the evictor writes really is 20 bytes of valid gzip", () => {
    // The premise. If this were not a decodable shard the reader would have
    // thrown and the defect would have surfaced as `failed` — loudly, and
    // there would be nothing to fix. It decodes perfectly, which is what made
    // it silent.
    const body = gzipSync(Buffer.from("", "utf8"));
    assert.equal(body.length, 20);
    assert.equal(body[0], 0x1f, "gzip magic — the format sniffer accepts it");
    assert.equal(body[1], 0x8b);
  });

  it("bytes with NO lines are `empty`, not `present`", async () => {
    // MUTATION: deleting the `decoded.rows.length === 0` branch from
    // readThirteenFColdShard (returning `{status:"present", rows: decoded.rows}`
    // unconditionally) turned this RED with `status === "present"`. Restored.
    setUsColdStore({ get: async () => gzipSync(Buffer.from("", "utf8")) });
    const out = await readThirteenFColdShard({
      managerCik10: "0001067983",
      periodOfReport: COLD_PERIOD,
    });
    assert.equal(out.status, "empty");
    assert.equal(
      out.status === "empty" ? out.reason : null,
      US_COLD_REASON_SHARD_EMPTY,
    );
    assert.equal(out.status === "empty" ? out.lines : -1, 0);
  });

  it("bytes whose EVERY line is dropped are `empty` and say so differently", async () => {
    // Three lines in, zero rows out. `parseThirteenFShard` drops a bad line
    // rather than throwing — correct per-line policy, and it means "the shard
    // is garbage" and "the quarter is empty" both decode to `[]`. The reason
    // is the only thing that separates them, so it is asserted rather than
    // collapsed into one state.
    const corrupt = gzipSync(
      Buffer.from('{"bad":1}\nnot json at all\n{"cusip":null}', "utf8"),
    );
    setUsColdStore({ get: async () => corrupt });
    const out = await readThirteenFColdShard({
      managerCik10: "0001067983",
      periodOfReport: COLD_PERIOD,
    });
    assert.equal(out.status, "empty");
    assert.equal(
      out.status === "empty" ? out.reason : null,
      US_COLD_REASON_SHARD_UNPARSEABLE,
      "a shard we could not understand must not be spelled the same way as a " +
        "quarter that genuinely held nothing",
    );
    assert.equal(
      out.status === "empty" ? out.lines : -1,
      3,
      "the line count is what makes the two distinguishable at all",
    );
  });

  it("a POPULATED shard is still `present` — the fix does not fire on real data", async () => {
    setUsColdStore({ get: async () => encodeThirteenFShard([holdingRow()]) });
    const out = await readThirteenFColdShard({
      managerCik10: "0001067983",
      periodOfReport: COLD_PERIOD,
    });
    assert.equal(out.status, "present");
    assert.equal(out.status === "present" ? out.rows.length : -1, 1);
  });

  it("[end-to-end] an empty shard reaches getManagerHoldings as DEGRADED", async () => {
    // The half that matters, and the half a status nobody reads would fail.
    // Before the fix this returned `reason: NO_ROWS_FOR_QUERY, degraded: false`
    // — a confident empty portfolio, i.e. a manager who sold everything.
    //
    // MUTATION: reverting readThirteenFColdShard to `{status:"present", rows}`
    // turned this RED with `degraded === false`. Restored.
    armColdFiling();
    setUsColdStore({ get: async () => gzipSync(Buffer.from("", "utf8")) });

    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.deepEqual(out.rows, [], "we have nothing to show…");
    assert.equal(
      out.degraded,
      true,
      "…and the caller must be told it is not a confirmed portfolio",
    );
    assert.notEqual(
      out.reason,
      "NO_ROWS_FOR_QUERY",
      "an empty COLD shard is not 'this query matched nothing' — the filing " +
        "says the quarter was archived",
    );
    assert.ok(
      typeof out.reason === "string" && out.reason.length > 0,
      `a degraded result must name a reason, got ${String(out.reason)}`,
    );
  });

  it("[end-to-end] a corrupt-every-line shard is degraded too", async () => {
    armColdFiling();
    setUsColdStore({
      get: async () => gzipSync(Buffer.from("not json\nalso not json", "utf8")),
    });
    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.deepEqual(out.rows, []);
    assert.equal(out.degraded, true);
  });

  it("[end-to-end] a POPULATED cold shard is still NOT degraded", async () => {
    // The control. Without it, "always degrade a cold read" would pass every
    // case above while destroying the feature.
    armColdFiling();
    setUsColdStore({ get: async () => encodeThirteenFShard([holdingRow()]) });
    const out = await getManagerHoldings({
      managerCik10: "1067983",
      period: COLD_PERIOD,
    });
    assert.equal(out.rows.length, 1);
    assert.equal(out.degraded, false);
    assert.equal(out.reason, null);
    assert.equal(out.origin, "COLD");
  });
});
