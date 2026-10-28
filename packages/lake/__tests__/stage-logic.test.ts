/**
 * `stage-logic` — MONEY-1496 (B2).
 *
 * Staging is where two runs can silently corrupt each other and where an empty
 * batch can report success having stored nothing. Both are tested here because
 * neither produces an error in production.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  STAGE_UPLOAD_POLICY,
  dedupeBySession,
  encodeNdjson,
  stageKey,
} from "../src/stage-logic";
import {
  toPriceBarRow,
  type RawBar,
  type RowProvenance,
} from "../src/price-bar-logic";

const PROV: RowProvenance = {
  sourceObjectUri: "gs://b/k",
  sourceRecordKey: "r",
  pipelineRunId: "run-1",
  observedAtMs: 1_700_000_000_000,
  ingestedAtMs: 1_700_000_001_000,
};

function row(sessionDate: string, close: number) {
  const bar: RawBar = {
    market: "US",
    listingId: "AAPL:NASDAQ:1980-12-12",
    symbol: "AAPL",
    exchange: "NASDAQ",
    sessionDate,
    open: 1,
    high: 2,
    low: 0.5,
    close,
    volume: 10,
    source: "TIINGO",
  };
  return toPriceBarRow(bar, PROV);
}

describe("stageKey", () => {
  it("puts the RUN ID in the key so two runs cannot collide", () => {
    // GCS has no rename and no locking. Without a per-run key, run B can
    // overwrite run A's bytes while A's `bq load` is still reading them — a
    // load that half-succeeds against two different inputs and reports success.
    const a = stageKey({
      table: "price_bar_d1",
      partitionKey: "US/2026-03",
      runId: "run-a",
    });
    const b = stageKey({
      table: "price_bar_d1",
      partitionKey: "US/2026-03",
      runId: "run-b",
    });
    assert.notEqual(a, b);
    assert.match(a, /^lake\/stage\/price_bar_d1\/US\/2026-03\/run-a\.ndjson$/);
  });

  it("REFUSES an empty or control-character segment", () => {
    // A malformed key files the object somewhere the loader will never look,
    // and GCS reports the write as a success.
    assert.throws(
      () => stageKey({ table: "", partitionKey: "US/2026-03", runId: "r" }),
      /non-empty/,
    );
    assert.throws(
      () => stageKey({ table: "t\nx", partitionKey: "US/2026-03", runId: "r" }),
      /control-character-free/,
    );
  });
});

describe("encodeNdjson", () => {
  it("one JSON object per line, with a trailing newline", () => {
    const out = encodeNdjson([row("2026-03-02", 1), row("2026-03-03", 2)]);
    const lines = out.split("\n");
    assert.equal(lines.length, 3, "two rows plus the trailing newline");
    assert.equal(lines[2], "");
    assert.equal(JSON.parse(lines[0] as string).session_date, "2026-03-02");
  });

  it("REGRESSION: refuses zero rows rather than writing an empty object", () => {
    // A zero-byte stage object loads successfully and adds nothing, so the
    // partition would be ACCEPTED having stored nothing — the silent-success
    // shape the ledger exists to prevent.
    assert.throws(() => encodeNdjson([]), /refusing to encode zero rows/);
  });

  it("volume survives as a decimal string, not a number", () => {
    // BigQuery's INT64-over-JSON convention. A JS number loses precision above
    // 2^53 and JSON.stringify THROWS on a bigint.
    const parsed = JSON.parse(encodeNdjson([row("2026-03-02", 1)]).trim());
    assert.equal(typeof parsed.volume, "string");
  });
});

describe("dedupeBySession", () => {
  const hot = [{ listingId: "A:X:1", sessionDate: "2026-03-03", src: "hot" }];
  const cold = [
    { listingId: "A:X:1", sessionDate: "2026-03-03", src: "cold" },
    { listingId: "A:X:1", sessionDate: "2026-03-02", src: "cold" },
  ];

  it("the HOT row wins on an overlapping session", () => {
    // Both describe the same session, but the hot row is where a later
    // correction was written — candle-repository updates OHLC in place on an
    // upgrade, while a cold shard is a point-in-time archive. Preferring the
    // shard silently reverts a corrected bar.
    const out = dedupeBySession(hot, cold);
    const march3 = out.filter((r) => r.sessionDate === "2026-03-03");
    assert.equal(march3.length, 1);
    assert.equal(march3[0]?.src, "hot");
  });

  it("keeps a cold-only session", () => {
    const out = dedupeBySession(hot, cold);
    assert.equal(out.filter((r) => r.sessionDate === "2026-03-02").length, 1);
  });

  it("REGRESSION: overlap is REMOVED, not merely reordered", () => {
    // planShardYears deliberately does not subtract the hot window, so overlap
    // is expected. Left in, the partition gets two rows for one session and
    // every downstream aggregate double-counts.
    assert.equal(dedupeBySession(hot, cold).length, 2);
  });

  it("de-dupes within one side too", () => {
    const dupes = [
      { listingId: "A:X:1", sessionDate: "2026-03-03", src: "1" },
      { listingId: "A:X:1", sessionDate: "2026-03-03", src: "2" },
    ];
    assert.equal(dedupeBySession(dupes, []).length, 1);
  });

  it("does not collapse two LISTINGS that share a session date", () => {
    // The key is (listing, session). Keying on the date alone would delete one
    // security's entire history wherever it overlapped another's.
    const a = [{ listingId: "A:X:1", sessionDate: "2026-03-03", src: "a" }];
    const b = [{ listingId: "B:X:1", sessionDate: "2026-03-03", src: "b" }];
    assert.equal(dedupeBySession(a, b).length, 2);
  });
});

describe("every stage writer uses STAGE_UPLOAD_POLICY — MONEY-1608", () => {
  it("the policy is a deadline, transient retries, and create-only", () => {
    assert.equal(STAGE_UPLOAD_POLICY.timeoutMs, 300_000);
    assert.equal(STAGE_UPLOAD_POLICY.retries, 3);
    // Create-only is what lets a writer holding objectCreator (and not
    // delete) retry at all: a re-attempt over a committed part is verified,
    // never overwritten.
    assert.equal(STAGE_UPLOAD_POLICY.createOnly, true);
  });

  // The four jobs that write `lake/stage/`. filing-registry-sync's parts are
  // the largest (52.6 MiB) and it is the run that died 132 of 188 in.
  for (const job of [
    "lake-replay-us",
    "lake-replay-in",
    "lake-load-databento",
    "filing-registry-sync",
  ]) {
    it(`${job}: every uploadFile call spreads the policy`, () => {
      const src = readFileSync(
        join(
          import.meta.dirname,
          "..",
          "..",
          "..",
          "scripts",
          "jobs",
          `${job}.ts`,
        ),
        "utf8",
      );
      const calls = src.split("await uploadFile({").slice(1);
      assert.ok(calls.length >= 1, `${job} has no uploadFile call`);
      for (const call of calls) {
        assert.match(
          call.slice(0, call.indexOf("});")),
          /\.\.\.STAGE_UPLOAD_POLICY,/,
        );
      }
    });
  }
});
