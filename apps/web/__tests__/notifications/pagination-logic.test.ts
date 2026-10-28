/**
 * MONEY-620 — notifications pagination clamping (REAL exported logic).
 *
 * Asserts the ACTUAL `clampPagination` that `notifications.service.ts`
 * (`getNotifications`) CALLS — imported straight from its pure source, no inline
 * copy, no shadow. The module imports nothing server-only, so this stays pure
 * and exits clean (no prisma/redis/socket at load).
 *
 * Why this exists: BOTH untrusted entrypoints forward raw pagination into the
 * service →
 *   - web  `getNotificationsAction(limit, skip)` passes its params verbatim.
 *   - api  `GET /v1/notifications` does `parseInt(query("limit"))` → can be NaN
 *     (`?limit=abc`), negative (`?limit=-5`), or absurd (`?limit=99999999`).
 * An unclamped NaN/negative/huge `take`|`skip` reaches `prisma.findMany` and
 * Prisma 5 THROWS (`Invalid value … Expected Int`), turning a stray query string
 * into a 500. This is the regression guard for that bug class.
 *
 * Source: packages/services/src/notifications-pagination.ts
 *         (called by packages/services/src/notifications.service.ts#getNotifications)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampPagination,
  DEFAULT_NOTIFICATION_LIMIT,
  MAX_NOTIFICATION_LIMIT,
  MAX_NOTIFICATION_SKIP,
} from "../../../../packages/services/src/notifications-pagination";

describe("MONEY-620 — clampPagination (REAL service export)", () => {
  describe("constants", () => {
    it("DEFAULT is 20 and MAX is 100", () => {
      assert.equal(DEFAULT_NOTIFICATION_LIMIT, 20);
      assert.equal(MAX_NOTIFICATION_LIMIT, 100);
    });
  });

  describe("happy path", () => {
    it("passes through a normal (limit, skip) pair unchanged", () => {
      assert.deepEqual(clampPagination(15, 30), { take: 15, skip: 30 });
    });

    it("defaults to DEFAULT limit / skip 0 when called with no args", () => {
      assert.deepEqual(clampPagination(), {
        take: DEFAULT_NOTIFICATION_LIMIT,
        skip: 0,
      });
    });

    it("allows exactly the MAX limit", () => {
      assert.equal(clampPagination(MAX_NOTIFICATION_LIMIT).take, 100);
    });

    it("allows a large but valid skip (deep pagination)", () => {
      assert.equal(clampPagination(20, 10_000).skip, 10_000);
    });
  });

  describe("limit — upper bound", () => {
    it("caps an over-MAX limit to MAX (payload/memory guard)", () => {
      assert.equal(clampPagination(99_999_999).take, MAX_NOTIFICATION_LIMIT);
    });

    it("caps MAX+1 to MAX", () => {
      assert.equal(
        clampPagination(MAX_NOTIFICATION_LIMIT + 1).take,
        MAX_NOTIFICATION_LIMIT
      );
    });

    it("caps Number.MAX_SAFE_INTEGER to MAX", () => {
      assert.equal(
        clampPagination(Number.MAX_SAFE_INTEGER).take,
        MAX_NOTIFICATION_LIMIT
      );
    });
  });

  describe("limit — lower / invalid → DEFAULT", () => {
    it("zero limit → DEFAULT", () => {
      assert.equal(clampPagination(0).take, DEFAULT_NOTIFICATION_LIMIT);
    });

    it("negative limit → DEFAULT (never a negative take)", () => {
      assert.equal(clampPagination(-5).take, DEFAULT_NOTIFICATION_LIMIT);
      assert.equal(clampPagination(-99_999).take, DEFAULT_NOTIFICATION_LIMIT);
    });

    it("NaN limit → DEFAULT (the parseInt('abc') case)", () => {
      assert.equal(clampPagination(NaN).take, DEFAULT_NOTIFICATION_LIMIT);
    });

    it("+Infinity / -Infinity limit → DEFAULT", () => {
      assert.equal(clampPagination(Infinity).take, DEFAULT_NOTIFICATION_LIMIT);
      assert.equal(clampPagination(-Infinity).take, DEFAULT_NOTIFICATION_LIMIT);
    });

    it("a non-number limit (string/null/undefined/object) → DEFAULT", () => {
      assert.equal(
        clampPagination("50" as unknown as number).take,
        DEFAULT_NOTIFICATION_LIMIT
      );
      assert.equal(
        clampPagination(null as unknown as number).take,
        DEFAULT_NOTIFICATION_LIMIT
      );
      assert.equal(clampPagination(undefined).take, DEFAULT_NOTIFICATION_LIMIT);
      assert.equal(
        clampPagination({} as unknown as number).take,
        DEFAULT_NOTIFICATION_LIMIT
      );
    });

    it("truncates a fractional limit toward zero", () => {
      assert.equal(clampPagination(7.9).take, 7);
      // 0.4 truncates to 0 → DEFAULT (never a take of 0)
      assert.equal(clampPagination(0.4).take, DEFAULT_NOTIFICATION_LIMIT);
    });
  });

  // MONEY-1062: a forged cursor `{ skip: 1e300 }` is FINITE (survives the
  // Number.isFinite check) yet overflows Prisma's 32-bit signed Int for `skip`
  // ("Unable to fit value … into a 32-bit signed integer") → a 500. The clamp
  // caps it to MAX_NOTIFICATION_SKIP instead of letting it reach findMany.
  describe("skip — upper bound (Prisma 32-bit Int overflow guard)", () => {
    it("exports MAX_NOTIFICATION_SKIP = 1_000_000", () => {
      assert.equal(MAX_NOTIFICATION_SKIP, 1_000_000);
    });

    it("caps a forged huge-but-finite skip (1e300) to MAX_NOTIFICATION_SKIP", () => {
      assert.equal(clampPagination(20, 1e300).skip, MAX_NOTIFICATION_SKIP);
    });

    it("caps MAX_NOTIFICATION_SKIP + 1 to the cap (boundary)", () => {
      assert.equal(
        clampPagination(20, MAX_NOTIFICATION_SKIP + 1).skip,
        MAX_NOTIFICATION_SKIP
      );
    });

    it("keeps exactly MAX_NOTIFICATION_SKIP intact (cap is inclusive)", () => {
      assert.equal(
        clampPagination(20, MAX_NOTIFICATION_SKIP).skip,
        MAX_NOTIFICATION_SKIP
      );
    });

    it("caps Number.MAX_SAFE_INTEGER (still > 32-bit Int) to the cap", () => {
      assert.equal(
        clampPagination(20, Number.MAX_SAFE_INTEGER).skip,
        MAX_NOTIFICATION_SKIP
      );
    });
  });

  describe("skip — invalid / negative → 0", () => {
    it("negative skip → 0 (never a negative skip)", () => {
      assert.equal(clampPagination(20, -1).skip, 0);
      assert.equal(clampPagination(20, -99_999).skip, 0);
    });

    it("NaN skip → 0", () => {
      assert.equal(clampPagination(20, NaN).skip, 0);
    });

    it("+Infinity / -Infinity skip → 0", () => {
      assert.equal(clampPagination(20, Infinity).skip, 0);
      assert.equal(clampPagination(20, -Infinity).skip, 0);
    });

    it("a non-number skip → 0", () => {
      assert.equal(clampPagination(20, "30" as unknown as number).skip, 0);
      assert.equal(clampPagination(20, null as unknown as number).skip, 0);
    });

    it("truncates a fractional skip toward zero", () => {
      assert.equal(clampPagination(20, 30.9).skip, 30);
      assert.equal(clampPagination(20, 0.9).skip, 0);
    });
  });

  describe("totality — never throws, always safe bounds", () => {
    const adversarial: Array<[unknown, unknown]> = [
      [NaN, NaN],
      [-Infinity, -Infinity],
      [Infinity, Infinity],
      [-1, -1],
      ["x", "y"],
      [null, undefined],
      [{}, []],
      [1.5, 2.5],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ];
    for (const [l, s] of adversarial) {
      it(`(${String(l)}, ${String(s)}) → finite take in [1,MAX] and skip ≥ 0`, () => {
        const { take, skip } = clampPagination(l, s);
        assert.ok(Number.isInteger(take), "take is an integer");
        assert.ok(
          take >= 1 && take <= MAX_NOTIFICATION_LIMIT,
          "take in bounds"
        );
        assert.ok(Number.isInteger(skip) && skip >= 0, "skip ≥ 0 integer");
      });
    }
  });
});
