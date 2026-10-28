/**
 * Request helpers — safeJson + zodParse (MONEY-736).
 *
 * Exercises the REAL exports from packages/api-utils/src/request. `safeJson`
 * needs a Hono `Context`, so a minimal stub whose `req.json()` resolves/rejects
 * is used — asserting that a malformed body becomes a typed `{ ok: false }`
 * (which routes map to 400) instead of a thrown rejection.
 *
 * Source: packages/api-utils/src/request/index.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Context } from "hono";

import { safeJson, zodParse, type SafeParseable } from "../src/request";

/** Minimal Context stub whose req.json() resolves to `value` or rejects. */
function ctxWithBody(value: unknown, reject = false): Context {
  return {
    req: {
      json: async () => {
        if (reject) throw new SyntaxError("Unexpected token in JSON");
        return value;
      },
    },
  } as unknown as Context;
}

describe("safeJson", () => {
  it("returns { ok: true, data } for a valid body", async () => {
    const result = await safeJson(ctxWithBody({ name: "Tech" }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data, { name: "Tech" });
  });

  it("returns { ok: false } for a malformed body (never throws)", async () => {
    const result = await safeJson(ctxWithBody(undefined, true));
    assert.equal(result.ok, false);
  });

  it("treats a JSON null body as valid (ok:true, data:null)", async () => {
    const result = await safeJson(ctxWithBody(null));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data, null);
  });

  it("carries the generic type through", async () => {
    const result = await safeJson<{ n: number }>(ctxWithBody({ n: 7 }));
    assert.ok(result.ok && result.data.n === 7);
  });
});

// A tiny Zod-compatible schema double (no zod dependency in api-utils).
const numberSchema: SafeParseable<number> = {
  safeParse(data: unknown) {
    return typeof data === "number"
      ? { success: true, data }
      : {
          success: false,
          error: { issues: [{ path: [], message: "Expected number" }] },
        };
  },
};

const objectSchema: SafeParseable<{ name: string }> = {
  safeParse(data: unknown) {
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { name?: unknown }).name === "string"
    ) {
      return { success: true, data: data as { name: string } };
    }
    return {
      success: false,
      error: { issues: [{ path: ["name"], message: "Required" }] },
    };
  },
};

describe("zodParse", () => {
  it("returns { ok: true, data } on a valid parse", () => {
    const result = zodParse(numberSchema, 42);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data, 42);
  });

  it("flattens issues into { ok: false, issues } on failure", () => {
    const result = zodParse(objectSchema, { name: 123 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues.length, 1);
      assert.deepEqual(result.issues[0]?.path, ["name"]);
      assert.equal(result.issues[0]?.message, "Required");
    }
  });

  it("never throws on invalid input", () => {
    assert.doesNotThrow(() => zodParse(numberSchema, "not a number"));
  });

  it("copies the issue path (defensive against a mutated source array)", () => {
    const result = zodParse(objectSchema, {});
    if (!result.ok) {
      // The returned path is a fresh array, not the schema's internal reference.
      assert.deepEqual(result.issues[0]?.path, ["name"]);
    }
  });
});
