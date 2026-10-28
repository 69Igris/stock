/**
 * MONEY-1608 — `uploadFile({retries, createOnly})`.
 *
 * `retries` re-attempts the WHOLE upload, because the SDK will not: a write
 * with no `ifGenerationMatch` is "conditionally idempotent", so
 * `startResumableUpload_` sets `maxRetries = 0` and the first reset rejects.
 * It re-attempts only TRANSIENT failures — a 403 retried with a 15/60/240 s
 * ladder is a permanent fault reported ~5 minutes late, per object.
 *
 * `createOnly` sends `ifGenerationMatch: 0`, and when that refuses (the object
 * is already there — an earlier attempt committed and lost its response) the
 * object is read back and accepted only if it holds exactly these bytes. The
 * lake writer holds objectCreator and not delete, so an overwrite is a 403.
 *
 * Drives the real `uploadFile` through the real SDK against a local server
 * (`STORAGE_EMULATOR_HOST`) whose behaviour each case sets.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { CRC32C } from "@google-cloud/storage";

type Mode =
  | "reset-first-put"
  | "forbidden"
  | "exists-same"
  | "exists-different";

let mode: Mode = "reset-first-put";
let puts = 0;
let posts = 0;
let lastPostQuery = "";
let stored: string | null = null;

function crcOf(b: Buffer): string {
  const c = new CRC32C();
  c.update(b);
  return c.toString();
}

const server = http.createServer((req, res) => {
  const body: Buffer[] = [];
  req.on("data", (c: Buffer) => body.push(c));
  req.on("error", () => {});
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, obj: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // Metadata read-back (`file.getMetadata()`). Under STORAGE_EMULATOR_HOST
    // the JSON API path carries no `/storage/v1` prefix.
    if (
      req.method === "GET" &&
      /^(\/storage\/v1)?\/b\/b\/o\/o$/.test(url.pathname)
    ) {
      const bytes = Buffer.from(mode === "exists-same" ? "abc" : "abd");
      json(200, {
        name: "o",
        bucket: "b",
        size: String(bytes.length),
        crc32c: crcOf(bytes),
      });
      return;
    }
    if (req.method === "POST") {
      posts++;
      lastPostQuery = url.search;
      if (mode === "forbidden") return json(403, { error: { code: 403 } });
      if (mode === "exists-same" || mode === "exists-different") {
        return json(412, { error: { code: 412, message: "precondition" } });
      }
      const { port } = server.address() as AddressInfo;
      res.writeHead(200, { location: `http://127.0.0.1:${port}/s/1` });
      res.end();
      return;
    }
    puts++;
    // Odd PUTs reset: the first attempt of each upload fails.
    if (puts % 2 === 1) {
      req.socket.destroy();
      return;
    }
    const bytes = Buffer.concat(body);
    stored = bytes.toString();
    json(200, {
      name: "o",
      bucket: "b",
      size: String(bytes.length),
      crc32c: crcOf(bytes),
    });
  });
});

let uploadFile: typeof import("../src/index").uploadFile;
const args = {
  file: Buffer.from("abc"),
  fileName: "o",
  contentType: "text/plain",
  isPublic: false,
  bucketName: "b",
  timeoutMs: 10_000,
};

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  process.env.STORAGE_EMULATOR_HOST = `http://127.0.0.1:${port}`;
  process.env.GCP_PROJECT_ID ??= "p";
  ({ uploadFile } = await import("../src/index"));
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
function reset(m: Mode): void {
  mode = m;
  puts = 0;
  posts = 0;
  stored = null;
  lastPostQuery = "";
}

describe("uploadFile retries — MONEY-1608", () => {
  it("a reset first PUT fails with retries:0 and succeeds with retries:1", async () => {
    reset("reset-first-put");
    await assert.rejects(uploadFile(args), "no retries: the reset is final");
    reset("reset-first-put");
    await uploadFile({ ...args, retries: 1 });
    assert.equal(puts, 2, "one failed PUT, one good one");
    assert.equal(stored, "abc");
  });

  it("a PERMANENT failure (403) is thrown on the first attempt, never retried", async () => {
    reset("forbidden");
    const t0 = Date.now();
    await assert.rejects(uploadFile({ ...args, retries: 3 }));
    assert.equal(posts, 1, "exactly one attempt");
    assert.ok(Date.now() - t0 < 10_000, "no backoff was slept");
  });
});

describe("uploadFile createOnly — MONEY-1608 review", () => {
  it("sends ifGenerationMatch=0", async () => {
    reset("exists-same");
    await uploadFile({ ...args, createOnly: true });
    assert.match(lastPostQuery, /ifGenerationMatch=0/);
  });

  it("a refused create over the SAME bytes counts as done", async () => {
    reset("exists-same");
    const r = await uploadFile({ ...args, createOnly: true, retries: 3 });
    assert.equal(r.fileSize, 3);
    assert.equal(posts, 1);
  });

  it("a refused create over DIFFERENT bytes is thrown, not accepted", async () => {
    reset("exists-different");
    await assert.rejects(uploadFile({ ...args, createOnly: true, retries: 3 }));
    assert.equal(posts, 1, "a 412 is not transient either");
  });

  it("without createOnly a 412 is never read back", async () => {
    reset("exists-same");
    await assert.rejects(uploadFile(args));
  });
});
