/**
 * MONEY-1608 review — only TRANSIENT failures are retried.
 *
 * `lake-replay-us` retried every throw 3x at 15/60/240 s. A missing
 * `candles/` grant is a 403 on every read, so the walk would have spent
 * ~128 h in backoff before reporting anything. These pin which errors a
 * retry may absorb, in the shapes the real clients produce.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { httpStatusOf, isTransientError } from "../../src/ops/transient-error";

const sys = (code: string): Error => Object.assign(new Error(code), { code });

describe("isTransientError", () => {
  it("accepts network-layer failures, directly or as a cause", () => {
    for (const c of [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "EPIPE",
    ]) {
      assert.equal(isTransientError(sys(c)), true, c);
    }
    const wrapped = new Error("fetch failed", { cause: sys("ECONNRESET") });
    assert.equal(isTransientError(wrapped), true);
  });

  it("accepts 408, 429 and 5xx in every place a client carries a status", () => {
    // GCS ApiError: `code` numeric. gaxios: `status` / `response.status`.
    assert.equal(
      isTransientError(Object.assign(new Error("x"), { code: 503 })),
      true,
    );
    assert.equal(
      isTransientError(Object.assign(new Error("x"), { status: 429 })),
      true,
    );
    assert.equal(
      isTransientError(
        Object.assign(new Error("x"), { response: { status: 500 } }),
      ),
      true,
    );
    assert.equal(
      isTransientError(Object.assign(new Error("x"), { code: 408 })),
      true,
    );
  });

  it("accepts the SDK's 'Retry limit exceeded' and our own unknown-outcome verdicts", () => {
    assert.equal(
      isTransientError(new Error('Retry limit exceeded - {"code":"EPIPE"}')),
      true,
    );
    assert.equal(
      isTransientError(new Error("uploadFile(k): timed out after 300000ms")),
      true,
    );
    assert.equal(
      isTransientError(
        new Error(
          "uploadFile(k): the write stream CLOSED without finishing or erroring",
        ),
      ),
      true,
    );
  });

  it("accepts Prisma's connection-level codes", () => {
    assert.equal(isTransientError(sys("P1001")), true);
    assert.equal(
      isTransientError(
        Object.assign(new Error("pool"), { errorCode: "P2024" }),
      ),
      true,
    );
  });

  it("REFUSES permanent failures: 4xx, a missing bucket, validation, a bug", () => {
    assert.equal(
      isTransientError(Object.assign(new Error("Forbidden"), { code: 403 })),
      false,
    );
    assert.equal(
      isTransientError(Object.assign(new Error("x"), { status: 404 })),
      false,
    );
    assert.equal(
      isTransientError(
        Object.assign(new Error("The specified bucket does not exist."), {
          code: 404,
        }),
      ),
      false,
    );
    assert.equal(
      isTransientError(Object.assign(new Error("x"), { code: 412 })),
      false,
    );
    assert.equal(
      isTransientError(sys("P2009")),
      false,
      "Prisma query validation",
    );
    assert.equal(
      isTransientError(new TypeError("undefined is not a function")),
      false,
    );
    assert.equal(isTransientError(null), false);
    assert.equal(isTransientError("ECONNRESET"), false);
  });
});

describe("httpStatusOf", () => {
  it("reads code, status or response.status, and nothing else", () => {
    assert.equal(
      httpStatusOf(Object.assign(new Error("x"), { code: 412 })),
      412,
    );
    assert.equal(
      httpStatusOf(Object.assign(new Error("x"), { status: 403 })),
      403,
    );
    assert.equal(httpStatusOf({ response: { status: 409 } }), 409);
    assert.equal(httpStatusOf(sys("ECONNRESET")), null);
    assert.equal(httpStatusOf(null), null);
  });
});

describe("lake-replay-us wires it — MONEY-1608 review", () => {
  const src = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "scripts/jobs/lake-replay-us.ts",
    ),
    "utf8",
  );
  it("the read retry refuses a non-transient error", () => {
    const fn = src.slice(src.indexOf("async function withReadRetry"));
    assert.match(fn.slice(0, 400), /!isTransientError\(err\)\) throw err/);
  });
  it("a symbol failure is logged when it happens, through the tracker", () => {
    assert.match(src, /const failures = createSymbolFailureTracker\(\);/);
    assert.match(src, /log\.err\(failures\.fail\(symbol, err\)\);/);
    assert.match(src, /failures\.ok\(\);/);
  });
});
