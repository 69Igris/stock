/**
 * API V1 Route Helper Tests
 *
 * Exercises the REAL helpers used by the v1 route handlers:
 *  - pagination bounds & filter building (apps/api/src/routes/v1/pagination.ts)
 *  - the `paginate` response helper + `ErrorCodes` (apps/api/src/lib/response.ts)
 *  - the `V1_ENDPOINTS` catalogue (apps/api/src/routes/v1/index.ts)
 *
 * No inline reimplementation.
 *
 * Source: apps/api/src/routes/v1/pagination.ts
 *         apps/api/src/lib/response.ts
 *         apps/api/src/routes/v1/index.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parsePage,
  parseLimit,
  calculateSkip,
  buildFilter,
  getExchangeDefault,
  MAX_SKIP,
} from "../../src/routes/v1/pagination";
import { paginate, ErrorCodes } from "../../src/lib/response";
import { V1_ENDPOINTS } from "../../src/routes/v1/index";

// ── parsePage ────────────────────────────────────────────

describe("parsePage", () => {
  it("should parse a valid page number", () => {
    assert.strictEqual(parsePage("3"), 3);
  });

  it("should default to 1 when undefined", () => {
    assert.strictEqual(parsePage(undefined), 1);
  });

  it("should default to 1 when empty string", () => {
    assert.strictEqual(parsePage(""), 1);
  });

  it("should enforce a minimum of 1", () => {
    assert.strictEqual(parsePage("0"), 1);
    assert.strictEqual(parsePage("-5"), 1);
  });

  it("should handle large page numbers", () => {
    assert.strictEqual(parsePage("9999"), 9999);
  });

  it("should use a custom default", () => {
    assert.strictEqual(parsePage(undefined, 5), 5);
  });
});

// ── parseLimit ───────────────────────────────────────────

describe("parseLimit", () => {
  it("should parse a valid limit", () => {
    assert.strictEqual(parseLimit("25"), 25);
  });

  it("should default to 50 when undefined", () => {
    assert.strictEqual(parseLimit(undefined), 50);
  });

  it("should enforce a minimum of 1", () => {
    assert.strictEqual(parseLimit("0"), 1);
    assert.strictEqual(parseLimit("-10"), 1);
  });

  it("should enforce a maximum of 100", () => {
    assert.strictEqual(parseLimit("200"), 100);
    assert.strictEqual(parseLimit("999"), 100);
  });

  it("should pass through 100", () => {
    assert.strictEqual(parseLimit("100"), 100);
  });

  it("should pass through 1", () => {
    assert.strictEqual(parseLimit("1"), 1);
  });

  it("should use a custom default and max", () => {
    assert.strictEqual(parseLimit(undefined, 20, 50), 20);
    assert.strictEqual(parseLimit("75", 20, 50), 50);
  });
});

// ── calculateSkip ────────────────────────────────────────

describe("calculateSkip", () => {
  it("should return 0 for page 1", () => {
    assert.strictEqual(calculateSkip(1, 10), 0);
  });

  it("should return limit for page 2", () => {
    assert.strictEqual(calculateSkip(2, 10), 10);
  });

  it("should handle a custom limit", () => {
    assert.strictEqual(calculateSkip(3, 25), 50);
    assert.strictEqual(calculateSkip(5, 50), 200);
  });

  it("should saturate at MAX_SKIP (Prisma Int overflow guard)", () => {
    // A huge page (e.g. ?page=99999999999&limit=100 → ~1e13) used to overflow
    // Prisma's Int skip argument → 500. It now degrades to the cap.
    assert.strictEqual(calculateSkip(99999999999, 100), MAX_SKIP);
    assert.strictEqual(MAX_SKIP, 1_000_000);
  });
});

// ── buildFilter ──────────────────────────────────────────

describe("buildFilter", () => {
  it("should include truthy values", () => {
    assert.deepStrictEqual(buildFilter({ symbol: "RELIANCE", sector: "IT" }), {
      symbol: "RELIANCE",
      sector: "IT",
    });
  });

  it("should exclude undefined values", () => {
    assert.deepStrictEqual(
      buildFilter({ symbol: "RELIANCE", sector: undefined }),
      {
        symbol: "RELIANCE",
      },
    );
  });

  it("should exclude empty string values", () => {
    assert.deepStrictEqual(buildFilter({ symbol: "", broker: "ZERODHA" }), {
      broker: "ZERODHA",
    });
  });

  it("should return an empty object when all undefined", () => {
    assert.deepStrictEqual(
      buildFilter({ symbol: undefined, sector: undefined }),
      {},
    );
  });

  it("should handle multiple filters", () => {
    assert.deepStrictEqual(
      buildFilter({ symbol: "TCS", broker: "UPSTOX", segment: "CASH" }),
      { symbol: "TCS", broker: "UPSTOX", segment: "CASH" },
    );
  });
});

// ── getExchangeDefault ───────────────────────────────────

describe("getExchangeDefault", () => {
  it("should return the provided exchange", () => {
    assert.strictEqual(getExchangeDefault("BSE"), "BSE");
  });

  it("should default to NSE when undefined", () => {
    assert.strictEqual(getExchangeDefault(undefined), "NSE");
  });

  it("should default to NSE when empty string", () => {
    assert.strictEqual(getExchangeDefault(""), "NSE");
  });
});

// ── paginate (real response helper) ──────────────────────

describe("paginate", () => {
  it("should wrap items with pagination metadata", () => {
    const result = paginate(["a", "b"], 10, 1, 5);
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.data, ["a", "b"]);
    assert.strictEqual(result.meta?.total, 10);
    assert.strictEqual(result.meta?.page, 1);
    assert.strictEqual(result.meta?.limit, 5);
  });

  it("should calculate hasMore correctly", () => {
    assert.strictEqual(paginate([], 20, 1, 10).meta?.hasMore, true);
    assert.strictEqual(paginate([], 10, 1, 10).meta?.hasMore, false);
    assert.strictEqual(paginate([], 25, 3, 10).meta?.hasMore, false); // 3*10=30 >= 25
  });

  it("should handle empty items", () => {
    const result = paginate([], 0, 1, 10);
    assert.deepStrictEqual(result.data, []);
    assert.strictEqual(result.meta?.total, 0);
    assert.strictEqual(result.meta?.hasMore, false);
  });
});

// ── ErrorCodes (real constant) ───────────────────────────

describe("ErrorCodes", () => {
  it("should define the standard error codes", () => {
    assert.strictEqual(ErrorCodes.UNAUTHORIZED, "UNAUTHORIZED");
    assert.strictEqual(ErrorCodes.VALIDATION_ERROR, "VALIDATION_ERROR");
    assert.strictEqual(ErrorCodes.NOT_FOUND, "NOT_FOUND");
    assert.strictEqual(ErrorCodes.INTERNAL_ERROR, "INTERNAL_ERROR");
    assert.strictEqual(ErrorCodes.RATE_LIMIT_EXCEEDED, "RATE_LIMIT_EXCEEDED");
  });
});

// ── V1 endpoint catalogue (real V1_ENDPOINTS) ────────────

describe("V1 endpoint metadata", () => {
  it("should define 28 endpoints", () => {
    // 15 original + /v1/jobs (MONEY-731) + /v1/market + /v1/discover
    // (MONEY-730 Phase C P3) = 18, + the 10 MONEY-402 Phase C P4 engagement
    // endpoints (/v1/me, roast, documents, learning, credits, chat-history,
    // quizzes, feedback, alerts, consent).
    assert.strictEqual(V1_ENDPOINTS.length, 38);
  });

  it("should include the core endpoints", () => {
    const paths = V1_ENDPOINTS.map((e) => e.path);
    assert.ok(paths.includes("/v1/dashboard"));
    assert.ok(paths.includes("/v1/holdings"));
    assert.ok(paths.includes("/v1/positions"));
    assert.ok(paths.includes("/v1/trades"));
  });

  it("should include the feature endpoints", () => {
    const paths = V1_ENDPOINTS.map((e) => e.path);
    assert.ok(paths.includes("/v1/paper"));
    assert.ok(paths.includes("/v1/fire"));
    assert.ok(paths.includes("/v1/research"));
    assert.ok(paths.includes("/v1/risk"));
  });

  it("should include the management endpoints", () => {
    const paths = V1_ENDPOINTS.map((e) => e.path);
    assert.ok(paths.includes("/v1/notifications"));
    assert.ok(paths.includes("/v1/watchlists"));
    assert.ok(paths.includes("/v1/subscription"));
    assert.ok(paths.includes("/v1/brokers"));
    assert.ok(paths.includes("/v1/jobs"));
  });

  it("should include the P3 market + discovery endpoints", () => {
    const paths = V1_ENDPOINTS.map((e) => e.path);
    assert.ok(paths.includes("/v1/market"));
    assert.ok(paths.includes("/v1/discover"));
  });

  it("should include the P4 engagement endpoints", () => {
    const paths = V1_ENDPOINTS.map((e) => e.path);
    for (const p of [
      "/v1/me",
      "/v1/roast",
      "/v1/documents",
      "/v1/learning",
      "/v1/credits",
      "/v1/chat-history",
      "/v1/quizzes",
      "/v1/feedback",
      "/v1/alerts",
      "/v1/consent",
    ]) {
      assert.ok(paths.includes(p), `missing ${p}`);
    }
  });

  it("should give every endpoint a path under /v1/ and a description", () => {
    for (const ep of V1_ENDPOINTS) {
      assert.ok(
        ep.path.startsWith("/v1/"),
        `Endpoint "${ep.path}" should start with /v1/`,
      );
      assert.ok(ep.description.length > 0, `${ep.path} missing description`);
    }
  });
});
