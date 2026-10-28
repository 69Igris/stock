/**
 * MONEY-1379 — the broker-sync SHARD LEAF, guarded at the source.
 *
 * ## What went wrong, measured on prod 2026-09-11
 *
 * The scheduled trigger `{userId:"*", isScheduled:true}` fans out to 64 shard
 * leaves (`buildShardFanoutMessages`; `DEFAULT_SYNC_BUCKET_COUNT = 64`). Prod
 * holds 9 broker connections occupying 6 buckets, so **58 leaves of every
 * fan-out matched nothing** — and each one threw "No broker connections found",
 * answered 500, was redelivered five times by Pub/Sub, dead-lettered, and
 * notified the founder in-app. 3,733 5xx and 928 dead-letters a day, 97.6 % of
 * that subscription, for work that did not need doing.
 *
 * The service now answers a shard truthfully (`isScheduledShard`), and the two
 * guards below cover what that change made reachable.
 *
 * ## Why these are SOURCE guards and not a behavioural test
 *
 * `processSync` imports Prisma, `@usemoney/security`, the broker adapters,
 * Datadog and the e-mail templates at module load, so it cannot be pulled into
 * a unit test — which is exactly why the sibling `processor-sync.test.ts` tests
 * the pure `sync-logic` exports and mirrors only the prisma call SEQUENCE. The
 * DECISIONS here are pure and are exercised directly in
 * `packages/services/__tests__/broker-sync.test.ts` (`isScheduledShard`,
 * including the bucket-0 case a truthiness check gets wrong). What is left to
 * pin is the WIRING, and both properties below are the presence or absence of a
 * named field in a named call — a thing a scan reads exactly, unlike the
 * `marks[0]`-vs-`marks[len-1]` class of expression a scan cannot tell apart.
 *
 * Giving `processSync` a dependency seam would test this better. It is not done
 * here: that is a signature change on a money path, for a leaf whose two
 * remaining risks are both binary, and it belongs in its own change rather than
 * riding a monitoring ticket.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const WORKERS_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
);
const SYNC = readFileSync(join(WORKERS_SRC, "processors/sync.ts"), "utf8");

/** The body of the one `syncHistoricalTradebook({...})` call in the leaf. */
function historicalCallArgs(): string {
  const at = SYNC.indexOf("await syncHistoricalTradebook({");
  assert.notStrictEqual(
    at,
    -1,
    "the leaf no longer calls syncHistoricalTradebook — re-read this file",
  );
  const rest = SYNC.slice(at);
  return rest.slice(0, rest.indexOf("});") + 3);
}

describe("sync leaf — an empty shard is not a failure (MONEY-1379)", () => {
  it("says so, rather than passing in silence", () => {
    assert.match(
      SYNC,
      /matched no syncable connections/,
      "an empty selection must be visible in the log; it is the ordinary state " +
        "of 58 of every 64 leaves and somebody will eventually ask why",
    );
  });

  it("does NOT return early — pairing must still run", () => {
    // THE regression guard, and it guards against a fix I wrote and withdrew.
    // Returning as soon as `connectionCount === 0` reads as a harmless
    // optimisation: it skips a metrics loop over an empty array and two cheap
    // queries. It also skips the per-bucket RE-PAIRING below, which has nothing
    // to do with broker connections — it re-pairs every user in the shard whose
    // trades are flagged `needsRepairing`, INCLUDING trades that arrived by CSV
    // import. Those users would simply have stopped being paired, silently.
    //
    // Asserted as "no `return` between the result and the pairing block",
    // which is the property, rather than as the absence of one particular
    // spelling of the early return.
    const from = SYNC.indexOf("const { synced, total, connectionCount");
    const to = SYNC.indexOf("data.syncBucket != null");
    assert.ok(
      from !== -1 && to > from,
      "the leaf's shape has changed — re-read",
    );
    const between = SYNC.slice(from, to);
    assert.doesNotMatch(
      between,
      /^\s+return;\s*$/m,
      "a `return` between the sync result and the pairing block skips the " +
        "per-bucket re-pairing, which also covers CSV-imported trades",
    );
  });

  it("pairing selects the bucket directly, not through the broker filter", () => {
    // The independence is the point. `buildConnectionWhere` narrows a scheduled
    // shard to the syncable brokers; pairing must NOT inherit that, because a
    // user's trades need pairing whatever broker they came from — including
    // trades that arrived by CSV import and have no broker connection at all.
    const to = SYNC.indexOf("data.syncBucket != null");
    assert.notStrictEqual(to, -1, "the per-bucket pairing block is gone");
    const block = SYNC.slice(to, to + 1200);
    assert.match(
      block,
      /brokerConnection\.findMany\(\{[\s\S]*?where: \{ syncBucket: data\.syncBucket \}/,
      `pairing no longer selects the bucket directly:\n${block.slice(0, 400)}`,
    );
    assert.ok(
      !/buildConnectionWhere/.test(block),
      "pairing must not route through the broker-filtered selection",
    );
  });
});

describe("sync leaf — the historical backfill is sharded (MONEY-1379)", () => {
  it("passes its own bucket to syncHistoricalTradebook", () => {
    // THE regression guard. Without this field the call reached the service
    // with `userId:"*"` and no bucket, so every POPULATED leaf backfilled the
    // tradebook of every connection on the platform — connectionCount x 64
    // slow, rate-limited Zerodha Console calls on the weekly cron instead of
    // connectionCount. At 9 connections that is 54 instead of 9 and nobody
    // notices; at 5,000 it is 320,000.
    assert.match(
      historicalCallArgs(),
      /syncBucket: data\.syncBucket/,
      "the historical call must carry the leaf's own shard",
    );
  });

  it("the day-sync call carries it too (both selections, one scope)", () => {
    const at = SYNC.indexOf("await syncBrokerConnections({");
    const rest = SYNC.slice(at);
    assert.match(
      rest.slice(0, rest.indexOf("});") + 3),
      /syncBucket: data\.syncBucket/,
    );
  });
});

describe("buildConnectionWhere has exactly one home (MONEY-1379)", () => {
  it("no copy survives anywhere under workers/src", () => {
    // It lived in BOTH workers/src/processors/sync-logic.ts and
    // packages/services/src/broker-sync.service.ts, each docblock calling
    // itself "the single source". Nothing imported the worker's copy, so two
    // spellings of a cross-user data-hazard rule could have drifted apart with
    // nothing to catch it.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!p.endsWith(".ts")) continue;
        if (
          /export function buildConnectionWhere/.test(readFileSync(p, "utf8"))
        )
          offenders.push(p.slice(WORKERS_SRC.length + 1));
      }
    };
    walk(WORKERS_SRC);
    assert.deepEqual(
      offenders,
      [],
      "a second copy of the connection filter has reappeared under workers/src",
    );
  });
});
