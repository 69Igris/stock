/**
 * The Databento HTTP client — MONEY-1373.
 *
 * Every case here drives an INJECTED fetch, so the suite needs no key, no
 * network and no vendor account. That is the point: the whole branch is
 * buildable and testable before the founder ever signs up, and the only things
 * that genuinely need a key are the live probe and arming.
 *
 * The two cases that matter most are the ones where this client deliberately
 * DIVERGES from the vendor's own reference implementation:
 *
 *   - a checksum mismatch THROWS and deletes the partial object, where theirs
 *     logs a warning and keeps it;
 *   - an unreadable cost quote THROWS, where the obvious `Number(x) || 0`
 *     would authorise every spend.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  DATABENTO_SUBMIT_INTERVAL_MS,
  __resetDatabentoPacer,
  databentoApiKey,
  databentoAuthHeader,
  downloadToArchive,
  getCost,
  getDatasetRange,
  listFiles,
  submitBatchJob,
} from "../../src/market-data/databento/databento-client";
import {
  DatabentoAuthError,
  DatabentoChecksumError,
  DatabentoRequestError,
} from "../../src/market-data/databento/databento-errors";
import type { DatabentoArchiveStore } from "../../src/market-data/databento/databento-archive";
import type { DatabentoJobRequest } from "../../src/market-data/databento/databento-logic";

/* ── harness ───────────────────────────────────────────────────────────── */

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface Reply {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Simulate a TRANSPORT fault — the fetch itself rejects, no response. */
  throws?: string;
}

function harness(replies: Reply[]) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  let i = 0;
  const fetchImpl = async (url: string, init?: Call): Promise<never> => {
    calls.push({ url, ...(init ?? {}) });
    const r = replies[Math.min(i++, replies.length - 1)] ?? {};
    if (r.throws !== undefined) throw new Error(r.throws);
    const status = r.status ?? 200;
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      headers: { get: (n: string) => r.headers?.[n] ?? null },
      text: async () => r.text ?? "",
      json: async () => r.json,
      body: r.body ?? null,
    } as never;
  };
  const opts = {
    fetchImpl: fetchImpl as never,
    // The fake clock ADVANCES on sleep, so the pacer's own wait is satisfied
    // by the same mechanism the test observes — otherwise a paced call would
    // sleep forever against a frozen clock.
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { calls, sleeps, opts, advance: (ms: number) => (clock += ms) };
}

const REQ: DatabentoJobRequest = {
  dataset: "EQUS.MINI",
  symbols: ["AAPL"],
  schema: "ohlcv-1m",
  start: new Date("2024-01-02T00:00:00Z"),
  end: new Date("2024-01-03T00:00:00Z"),
  // REQUIRED since MONEY-1375 — the optional form with a `?? "day"` fallback
  // is how a real purchase got its shape from an omission.
  splitSymbols: false,
  splitDuration: "none",
};

beforeEach(() => {
  process.env["DATABENTO_API_KEY"] = "db-test-key";
  __resetDatabentoPacer();
});

/* ── auth ──────────────────────────────────────────────────────────────── */

describe("auth — Basic with the key as USERNAME and an empty password", () => {
  it("builds the header the vendor's own client builds", () => {
    // Not Bearer. A bearer token returns 401 and reads exactly like a bad key,
    // which is a wrong diagnosis at the worst possible moment.
    assert.equal(
      databentoAuthHeader("db-abc"),
      `Basic ${Buffer.from("db-abc:", "utf8").toString("base64")}`,
    );
  });

  it("sends it on every request", async () => {
    const h = harness([{ json: 1.23 }]);
    await getCost(REQ, h.opts);
    assert.equal(
      h.calls[0]!.headers!["Authorization"],
      databentoAuthHeader("db-test-key"),
    );
  });

  it("reads the key PER CALL, never at import", () => {
    process.env["DATABENTO_API_KEY"] = "rotated";
    assert.equal(databentoApiKey(), "rotated");
    process.env["DATABENTO_API_KEY"] = "rotated-again";
    assert.equal(databentoApiKey(), "rotated-again");
  });

  it("THROWS before the first request when the key is absent", async () => {
    delete process.env["DATABENTO_API_KEY"];
    const h = harness([{ json: 1 }]);
    await assert.rejects(() => getCost(REQ, h.opts), DatabentoAuthError);
    // The point: nothing was sent. An unauthenticated call is a 401 that gets
    // reported as an upstream fault.
    assert.equal(h.calls.length, 0);
  });
});

/* ── the ladder ────────────────────────────────────────────────────────── */

describe("the retry ladder", () => {
  it("waits Retry-After on a 429 and retries WITHOUT consuming a retry", async () => {
    const h = harness([
      { status: 429, headers: { "Retry-After": "2" } },
      { json: 4.5 },
    ]);
    const cost = await getCost(REQ, h.opts);
    assert.equal(cost, 4.5);
    assert.ok(h.sleeps.includes(2000), `sleeps were ${h.sleeps.join(",")}`);
    assert.equal(h.calls.length, 2);
  });

  it("defaults to one second when the vendor sends no Retry-After", async () => {
    const h = harness([{ status: 429 }, { json: 1 }]);
    await getCost(REQ, h.opts);
    assert.ok(h.sleeps.includes(1000), `sleeps were ${h.sleeps.join(",")}`);
  });

  it("does NOT retry a 403 — a wrong key does not become right", async () => {
    const h = harness([{ status: 403, text: '{"detail":"Invalid token."}' }]);
    await assert.rejects(() => getCost(REQ, h.opts), DatabentoAuthError);
    assert.equal(h.calls.length, 1);
  });

  it("does NOT retry a 422 — that is our own bad request", async () => {
    const h = harness([{ status: 422, text: "bad schema" }]);
    await assert.rejects(() => getCost(REQ, h.opts), DatabentoRequestError);
    assert.equal(h.calls.length, 1);
  });

  it("retries a 503 and gives up after the budget", async () => {
    const h = harness([{ status: 503 }]);
    await assert.rejects(() => getCost(REQ, h.opts), DatabentoRequestError);
    assert.equal(h.calls.length, 4, "one attempt plus three retries");
  });

  it("stops waiting on an endless 429 rather than parking the whole job", async () => {
    const h = harness([{ status: 429, headers: { "Retry-After": "1" } }]);
    await assert.rejects(() => getCost(REQ, h.opts), /rate-limited/);
    // A job that waits forever looks like progress in the logs and produces
    // nothing before its task timeout.
    assert.ok(h.calls.length <= 12, `made ${h.calls.length} calls`);
  });
});

/* ── the spending call ─────────────────────────────────────────────────── */

describe("submitBatchJob", () => {
  const JOB = {
    id: "EQUS-20260906-ABC",
    dataset: "EQUS.MINI",
    schema: "ohlcv-1m",
    symbols: "AAPL",
    start: "2024-01-02 00:00:00+00:00",
    end: "2024-01-03 00:00:00+00:00",
    state: "queued",
    ts_received: "2026-09-06T00:00:00Z",
    cost_usd: null,
  };

  it("POSTs a form body carrying the fixed encoding contract", async () => {
    const h = harness([{ json: JOB }]);
    await submitBatchJob(REQ, h.opts);
    const sent = new URLSearchParams(h.calls[0]!.body!);
    assert.equal(h.calls[0]!.method, "POST");
    assert.equal(
      h.calls[0]!.headers!["Content-Type"],
      "application/x-www-form-urlencoded",
    );
    assert.equal(sent.get("encoding"), "csv");
    assert.equal(sent.get("compression"), "zstd");
    assert.equal(sent.get("pretty_px"), "true");
    assert.equal(sent.get("pretty_ts"), "true");
    assert.equal(sent.get("map_symbols"), "true");
  });

  it("returns a job whose costUsd is null — the budget must not read it", async () => {
    const h = harness([{ json: JOB }]);
    const job = await submitBatchJob(REQ, h.opts);
    assert.equal(job.id, "EQUS-20260906-ABC");
    assert.equal(job.costUsd, null);
  });

  it("PACES submissions well under the 20-per-minute ceiling", async () => {
    const h = harness([{ json: JOB }]);
    await submitBatchJob(REQ, h.opts);
    await submitBatchJob(REQ, h.opts);
    // The second submission waited. The limit is per IP and Cloud Run shares
    // egress addresses, so the cost of racing it is borne by every environment.
    assert.ok(
      h.sleeps.some((s) => s >= DATABENTO_SUBMIT_INTERVAL_MS - 1),
      `expected a >=${DATABENTO_SUBMIT_INTERVAL_MS}ms pace, saw ${h.sleeps.join(",")}`,
    );
  });

  it("the pacer's own sleep keeps the process ALIVE until the submit returns", () => {
    // MONEY-1539. The default sleep was unref'd, so a job whose only pending
    // work was that awaited wait exited 0 mid-submit: 7 of 9 nightly appends
    // died this way, each leaving one chunk QUOTED and a green Cloud Run
    // execution. Only a separate process can show it — inside the runner the
    // test harness itself holds the loop open.
    const res = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join("__tests__", "fixtures", "databento", "paced-submit-probe.ts"),
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(res.status, 0, `probe exited ${res.status}: ${res.stderr}`);
    assert.match(
      res.stdout,
      /SECOND-SUBMIT-RETURNED/,
      "the process exited while the pacer was still waiting",
    );
  });
});

describe("getCost — an unreadable quote is not zero", () => {
  it("returns the bare number the endpoint sends", async () => {
    const h = harness([{ json: 0.7847935900092124 }]);
    assert.equal(await getCost(REQ, h.opts), 0.7847935900092124);
  });

  it("accepts a genuine zero — an included window quotes 0.00", async () => {
    const h = harness([{ json: 0 }]);
    assert.equal(await getCost(REQ, h.opts), 0);
  });

  it("THROWS on a non-numeric payload instead of coercing it to 0", async () => {
    // `Number(undefined) || 0` is the obvious shape and it is a budget guard
    // that authorises every spend.
    const h = harness([{ json: { detail: "nope" } }]);
    await assert.rejects(() => getCost(REQ, h.opts), /not a number/);
  });
});

describe("getCost is a POST FORM — the URL cannot carry 2,000 symbols", () => {
  it("sends a form body and a bare URL, never a query string", async () => {
    const h = harness([{ json: 0 }]);
    await getCost(REQ, h.opts);
    const call = h.calls[0]!;
    assert.equal(call.method, "POST");
    // Measured live 2026-09-07: the vendor's front door 414s above ~8 KB of
    // URL. 1,000 symbols (7.3 KB) pass, 1,500 (10.8 KB) fail. A GET could not
    // quote `ohlcv-1h-master`, and the quote runs BEFORE the submit — so the
    // entry could not be bought at all.
    assert.ok(
      !call.url.includes("?"),
      `the quote URL still carries a query string: ${call.url}`,
    );
    assert.equal(
      call.headers!["Content-Type"],
      "application/x-www-form-urlencoded",
    );
    const sent = new URLSearchParams(String(call.body));
    assert.equal(sent.get("symbols"), "AAPL");
    assert.equal(sent.get("stype_in"), "raw_symbol");
    assert.equal(sent.get("schema"), "ohlcv-1m");
  });

  it("renders a full 2,000-symbol chunk with the URL still tiny", async () => {
    const symbols = Array.from({ length: 2000 }, (_, i) => `SYM${i}`);
    const h = harness([{ json: 0 }]);
    await getCost({ ...REQ, symbols }, h.opts);
    const call = h.calls[0]!;
    // The whole point of the change: the payload moved off the URL. 100 bytes
    // is ~80x under the vendor's limit, so this cannot creep back.
    assert.ok(
      call.url.length < 100,
      `URL grew to ${call.url.length} bytes: ${call.url.slice(0, 120)}`,
    );
    const sent = new URLSearchParams(String(call.body));
    assert.equal(sent.get("symbols")!.split(",").length, 2000);
  });

  it("RETRIES a transport fault — a quote is free and idempotent", async () => {
    // `kind` must stay "metadata". The no-retry rule is keyed on
    // `kind === "submit"` because a submission BUYS something and carries no
    // idempotency key; a quote that refuses to retry a socket reset would
    // abort a harvest over a blip that costs nothing to repeat.
    const h = harness([{ throws: "ECONNRESET" }, { json: 3.5 }]);
    assert.equal(await getCost(REQ, h.opts), 3.5);
    assert.equal(h.calls.length, 2);
  });

  it("a SUBMIT does not retry the same fault — it would buy twice", async () => {
    const h = harness([{ throws: "ECONNRESET" }, { json: {} }]);
    await assert.rejects(
      () => submitBatchJob(REQ, h.opts),
      /NOT retried/,
      "a lost response after the vendor accepted the job bills a second time",
    );
    assert.equal(h.calls.length, 1);
  });
});

describe("getDatasetRange", () => {
  it("parses the per-schema map the append gates on", async () => {
    const h = harness([
      {
        json: {
          start: "2023-03-28T00:00:00Z",
          end: "2026-09-05T00:00:00Z",
          schema: {
            "ohlcv-1m": {
              start: "2023-03-28T00:00:00Z",
              end: "2026-09-05T00:00:00Z",
            },
          },
        },
      },
    ]);
    const r = await getDatasetRange("EQUS.MINI", h.opts);
    assert.equal(
      r.bySchema["ohlcv-1m"]!.end.toISOString().slice(0, 10),
      "2026-09-05",
    );
    assert.ok(h.calls[0]!.url.includes("metadata.get_dataset_range"));
  });
});

/* ── download ──────────────────────────────────────────────────────────── */

function fakeStore() {
  const put: Array<{ key: string; bytes: number; contentType: string }> = [];
  const deleted: string[] = [];
  const store: DatabentoArchiveStore = {
    async put(key, body, contentType) {
      let bytes = 0;
      for await (const chunk of body) bytes += (chunk as Buffer).length;
      put.push({ key, bytes, contentType });
      return { bytes };
    },
    async getStream() {
      return null;
    },
    async exists() {
      return false;
    },
    async delete(key) {
      deleted.push(key);
    },
  };
  return { store, put, deleted };
}

describe("downloadToArchive — verified in flight, and a mismatch is fatal", () => {
  const PAYLOAD = Buffer.from(
    "ts_event,open\n2024-01-02T14:30:00Z,1.0\n",
    "utf8",
  );
  const GOOD = createHash("sha256").update(PAYLOAD).digest("hex");

  const file = (sha: string) => ({
    filename: "equs-mini-20240102.ohlcv-1m.csv.zst",
    size: PAYLOAD.length,
    sha256: sha,
    httpsUrl:
      "https://api.databento.com/v0/batch/download/U/J/equs-mini-20240102.ohlcv-1m.csv.zst",
  });

  it("streams into the store and reports the byte count and digest", async () => {
    const h = harness([{ body: Readable.from(PAYLOAD) }]);
    const s = fakeStore();
    const out = await downloadToArchive({
      file: file(GOOD),
      key: "databento/EQUS.MINI/ohlcv-1m/2024/J/f.csv.zst",
      store: s.store,
      opts: h.opts,
    });
    assert.equal(out.sha256, GOOD);
    assert.equal(out.bytes, PAYLOAD.length);
    assert.equal(s.put.length, 1);
    assert.equal(s.put[0]!.bytes, PAYLOAD.length);
    assert.equal(s.deleted.length, 0);
  });

  it("stamps the registered zstd content type", async () => {
    const h = harness([{ body: Readable.from(PAYLOAD) }]);
    const s = fakeStore();
    await downloadToArchive({
      file: file(GOOD),
      key: "k",
      store: s.store,
      opts: h.opts,
    });
    assert.equal(s.put[0]!.contentType, "application/zstd");
  });

  it("DELETES the partial object and throws when the digest disagrees", async () => {
    // The vendor's own client warns and keeps it. These bytes are the only copy
    // of data bought once, and a kept-but-truncated object is skipped by every
    // later run because `exists()` reports it as present.
    const h = harness([{ body: Readable.from(PAYLOAD) }]);
    const s = fakeStore();
    await assert.rejects(
      () =>
        downloadToArchive({
          file: file("0".repeat(64)),
          key: "databento/partial",
          store: s.store,
          opts: h.opts,
        }),
      DatabentoChecksumError,
    );
    assert.deepEqual(s.deleted, ["databento/partial"]);
  });

  it("does not retry a 403 on the download host either", async () => {
    const h = harness([{ status: 403, text: "no" }]);
    const s = fakeStore();
    await assert.rejects(
      () =>
        downloadToArchive({
          file: file(GOOD),
          key: "k",
          store: s.store,
          opts: h.opts,
        }),
      DatabentoAuthError,
    );
    assert.equal(h.calls.length, 1);
  });

  it("targets the DOWNLOAD host, which is not the API gateway", async () => {
    const h = harness([{ body: Readable.from(PAYLOAD) }]);
    const s = fakeStore();
    await downloadToArchive({
      file: file(GOOD),
      key: "k",
      store: s.store,
      opts: h.opts,
    });
    assert.ok(h.calls[0]!.url.startsWith("https://api.databento.com/"));
  });
});

describe("listFiles", () => {
  it("passes the job id and parses the manifest", async () => {
    const h = harness([
      {
        json: [
          {
            filename: "f.csv.zst",
            size: 10,
            hash: `sha256:${"a".repeat(64)}`,
            urls: { https: "https://api.databento.com/x" },
          },
        ],
      },
    ]);
    const files = await listFiles("JOB-1", h.opts);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.sha256, "a".repeat(64));
    assert.ok(h.calls[0]!.url.includes("job_id=JOB-1"));
  });
});
