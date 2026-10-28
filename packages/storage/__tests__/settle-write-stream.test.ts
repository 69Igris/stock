/**
 * MONEY-1608 — an upload promise must reach a VERDICT.
 *
 * `lake-replay-us` ran 8 h on prod and exited 0 mid-way through its final
 * flush: the last stage object landed at 12:55:03Z, the process ended at
 * 12:55:04Z, and the log line that follows the flush never printed. The only
 * await in that flush is `uploadFile`, whose promise listened for `finish` and
 * `error` and nothing else, with no timer. When neither arrives, nothing holds
 * the event loop, and Node ends the process "successfully".
 *
 * These drive `settleWriteStream` with plain Node streams — the two failure
 * shapes are properties of the Writable contract, not of GCS — and then the
 * REAL SDK against a local server, because the settle-on-close rule is only
 * safe if the SDK never emits `close` BEFORE `finish` on a good upload.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";

import { Storage } from "@google-cloud/storage";

import { settleWriteStream } from "../src/index";

function sink(): Writable {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

describe("settleWriteStream — MONEY-1608", () => {
  it("resolves on finish, and the close that follows does not flip it", async () => {
    await settleWriteStream(sink(), {
      label: "t",
      start: (ws) => ws.end(Buffer.from("x")),
    });
  });

  it("REJECTS a stream that closes without finish or error", async () => {
    // `destroy()` with no error emits `close` ONLY — the shape the SDK's own
    // default pipeline callback produces. Before the fix this awaited forever.
    await assert.rejects(
      settleWriteStream(sink(), {
        label: "t",
        start: (ws) => {
          ws.write("x");
          ws.destroy();
        },
      }),
      /CLOSED without finishing/,
    );
  });

  it("rejects on error and hands the error to onError", async () => {
    let seen: Error | null = null;
    await assert.rejects(
      settleWriteStream(sink(), {
        label: "t",
        onError: (e) => (seen = e),
        start: (ws) => ws.destroy(new Error("boom")),
      }),
      /boom/,
    );
    assert.equal((seen as Error | null)?.message, "boom");
  });

  it("the deadline REJECTS a stream that never emits anything", async () => {
    // Never ended, never destroyed: the "SDK parked on an internal promise"
    // shape. The ref'd timer is also the handle that keeps the process alive
    // to deliver this verdict.
    const ws = sink();
    await assert.rejects(
      settleWriteStream(ws, { label: "t", timeoutMs: 50, start: () => {} }),
      /timed out after 50ms/,
    );
    assert.equal(ws.destroyed, true, "the stream is torn down, not abandoned");
  });

  it("the deadline rejects DIRECTLY — it does not rely on destroy() emitting", async () => {
    // `destroy()` on a stream that is already destroyed emits nothing, so a
    // deadline that only destroyed would fire, clear the last handle, and
    // leave the promise pending — the incident, one layer down.
    const ws = sink();
    ws.destroy = (() => ws) as Writable["destroy"];
    await assert.rejects(
      settleWriteStream(ws, { label: "t", timeoutMs: 50, start: () => {} }),
      /timed out after 50ms/,
    );
  });

  it("the real SDK finishes BEFORE it closes on a good upload", async () => {
    const server = http.createServer((req, res) => {
      const body: Buffer[] = [];
      req.on("data", (c: Buffer) => body.push(c));
      req.on("end", () => {
        if (req.method === "POST") {
          const { port } = server.address() as AddressInfo;
          res.writeHead(200, { location: `http://127.0.0.1:${port}/s/1` });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            name: "o",
            bucket: "b",
            size: String(Buffer.concat(body).length),
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const { port } = server.address() as AddressInfo;
      const file = new Storage({
        projectId: "p",
        apiEndpoint: `http://127.0.0.1:${port}`,
      })
        .bucket("b")
        .file("o");
      await settleWriteStream(
        // CRC32C off only because the fake server does not compute one.
        file.createWriteStream({ resumable: true, validation: false }),
        { label: "t", timeoutMs: 10_000, start: (ws) => ws.end("abc") },
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
