/**
 * Cursor pagination — encodeCursor / decodeCursor / paginatedCursor (MONEY-402).
 *
 * Exercises the REAL exports from packages/api-utils/src/pagination. Asserts the
 * opaque cursor round-trips, that a tampered/garbage cursor decodes to `null`
 * (never throws → route falls back to the first page), and the envelope shape.
 *
 * Source: packages/api-utils/src/pagination/index.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { encodeCursor, decodeCursor, paginatedCursor } from "../src/pagination";

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a keyset snapshot", () => {
    const cursor = encodeCursor({ id: "w2" });
    assert.deepEqual(decodeCursor(cursor), { id: "w2" });
  });

  it("round-trips a composite keyset", () => {
    const key = { createdAt: "2026-07-10T00:00:00.000Z", id: "abc" };
    assert.deepEqual(decodeCursor(encodeCursor(key)), key);
  });

  it("round-trips a numeric offset snapshot", () => {
    assert.deepEqual(decodeCursor(encodeCursor({ skip: 50 })), { skip: 50 });
  });

  it("produces an opaque (base64url) string — no raw JSON leaked", () => {
    const cursor = encodeCursor({ id: "secret" });
    assert.doesNotMatch(cursor, /[{}":]/); // no JSON punctuation
    assert.doesNotMatch(cursor, /[+/=]/); // base64url, not standard base64
  });

  it("decodes an empty/undefined cursor to null", () => {
    assert.equal(decodeCursor(undefined), null);
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor(""), null);
  });

  it("decodes a garbage/tampered cursor to null (never throws)", () => {
    assert.equal(decodeCursor("%%%not-base64%%%"), null);
    assert.equal(decodeCursor("bm90LWpzb24"), null); // base64url of "not-json"
  });

  it("decodes a non-object JSON payload to null", () => {
    const arrayCursor = Buffer.from("[1,2,3]", "utf8").toString("base64url");
    const numberCursor = Buffer.from("42", "utf8").toString("base64url");
    assert.equal(decodeCursor(arrayCursor), null);
    assert.equal(decodeCursor(numberCursor), null);
  });
});

describe("paginatedCursor", () => {
  it("wraps items + nextCursor in the success envelope", () => {
    const env = paginatedCursor([{ id: 1 }, { id: 2 }], "cursor-abc");
    assert.equal(env.success, true);
    assert.deepEqual(env.data?.items, [{ id: 1 }, { id: 2 }]);
    assert.equal(env.data?.nextCursor, "cursor-abc");
  });

  it("supports a null nextCursor (last page)", () => {
    const env = paginatedCursor([], null);
    assert.deepEqual(env.data?.items, []);
    assert.equal(env.data?.nextCursor, null);
  });
});
