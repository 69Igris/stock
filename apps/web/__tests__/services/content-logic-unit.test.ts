/**
 * MONEY-620 — content-logic pure helpers (REAL exported logic).
 *
 * Asserts the ACTUAL helpers that `content.service.ts` CALLS — imported straight
 * from their pure source, no inline copy, no shadow. (This REPLACES the prior
 * shadow `__tests__/services/content.test.ts` that re-implemented the transform
 * + pagination inline and asserted the copy.) The module imports nothing
 * server-only, so it stays pure and exits clean.
 *
 * Covers:
 *   - clampPagePagination — NaN/negative/huge (page, limit) → safe Prisma bounds
 *     + non-negative skip = (page-1)*limit.
 *   - computePages — guards Math.ceil(total/0)=Infinity and /NaN=NaN poisoning the
 *     `pages` count a consumer renders/loops over.
 *   - decideContentAccess — premium FAILS CLOSED: FREE / unknown-plan / expired
 *     viewers denied; PRO/PREMIUM/ULTIMATE allowed; non-premium always public.
 *   - redactPremiumPost — strips the body for a denied viewer, returns the post
 *     unchanged for an allowed one (behavior-preserving for authorized access).
 *
 * Source: packages/services/src/content-logic.ts
 *         (called by packages/services/src/content.service.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Post } from "@usemoney/types";
import {
  clampPagePagination,
  computePages,
  decideContentAccess,
  redactPremiumPost,
  DEFAULT_CONTENT_LIMIT,
  MAX_CONTENT_LIMIT,
  PREMIUM_ACCESS_MIN_RANK,
  CONTENT_TIER_RANK,
} from "../../../../packages/services/src/content-logic";

describe("MONEY-620 — clampPagePagination (REAL service export)", () => {
  it("DEFAULT is 10 and MAX is 100", () => {
    assert.equal(DEFAULT_CONTENT_LIMIT, 10);
    assert.equal(MAX_CONTENT_LIMIT, 100);
  });

  describe("happy path", () => {
    it("page 2, limit 10 → skip 10", () => {
      assert.deepEqual(clampPagePagination(2, 10), {
        page: 2,
        limit: 10,
        skip: 10,
      });
    });

    it("undefined page/limit → page 1, default limit, skip 0", () => {
      assert.deepEqual(clampPagePagination(undefined, undefined), {
        page: 1,
        limit: DEFAULT_CONTENT_LIMIT,
        skip: 0,
      });
    });

    it("honors a per-endpoint default limit (docs uses 12)", () => {
      assert.deepEqual(clampPagePagination(undefined, undefined, 12), {
        page: 1,
        limit: 12,
        skip: 0,
      });
    });
  });

  describe("page — invalid / < 1 → 1 (never a negative skip)", () => {
    it("page 0 → 1, skip 0 (the classic ?page=0 negative-skip bug)", () => {
      const b = clampPagePagination(0, 10);
      assert.equal(b.page, 1);
      assert.equal(b.skip, 0);
    });

    it("negative / NaN / Infinity / non-number page → 1", () => {
      assert.equal(clampPagePagination(-3, 10).page, 1);
      assert.equal(clampPagePagination(NaN, 10).page, 1);
      assert.equal(clampPagePagination(Infinity, 10).page, 1);
      assert.equal(clampPagePagination("2" as unknown as number, 10).page, 1);
    });

    it("truncates a fractional page toward zero", () => {
      assert.equal(clampPagePagination(2.9, 10).page, 2);
    });
  });

  describe("limit — bounds", () => {
    it("caps over-MAX to MAX", () => {
      assert.equal(clampPagePagination(1, 99_999).limit, MAX_CONTENT_LIMIT);
    });

    it("zero / negative / NaN / non-number → default", () => {
      assert.equal(clampPagePagination(1, 0).limit, DEFAULT_CONTENT_LIMIT);
      assert.equal(clampPagePagination(1, -5).limit, DEFAULT_CONTENT_LIMIT);
      assert.equal(clampPagePagination(1, NaN).limit, DEFAULT_CONTENT_LIMIT);
      assert.equal(
        clampPagePagination(1, "10" as unknown as number).limit,
        DEFAULT_CONTENT_LIMIT
      );
    });

    it("a bad per-endpoint default falls back to DEFAULT", () => {
      assert.equal(
        clampPagePagination(1, undefined, 0).limit,
        DEFAULT_CONTENT_LIMIT
      );
      assert.equal(
        clampPagePagination(1, undefined, NaN).limit,
        DEFAULT_CONTENT_LIMIT
      );
    });
  });

  describe("totality — skip always a non-negative integer", () => {
    const adversarial: Array<[unknown, unknown]> = [
      [NaN, NaN],
      [-Infinity, -Infinity],
      [Infinity, Infinity],
      [0, 0],
      [-1, -1],
      ["x", "y"],
      [null, undefined],
      [{}, []],
      [1.5, 2.5],
      [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ];
    for (const [p, l] of adversarial) {
      it(`(${String(p)}, ${String(l)}) → page≥1, limit in [1,MAX], skip≥0`, () => {
        const { page, limit, skip } = clampPagePagination(p, l);
        assert.ok(Number.isInteger(page) && page >= 1);
        assert.ok(
          Number.isInteger(limit) && limit >= 1 && limit <= MAX_CONTENT_LIMIT
        );
        assert.ok(Number.isInteger(skip) && skip >= 0);
      });
    }
  });
});

describe("MONEY-620 — computePages (REAL service export)", () => {
  it("computes ceil(total/limit) for normal inputs", () => {
    assert.equal(computePages(0, 10), 0);
    assert.equal(computePages(1, 10), 1);
    assert.equal(computePages(10, 10), 1);
    assert.equal(computePages(11, 10), 2);
    assert.equal(computePages(101, 10), 11);
  });

  it("limit 0 → DOES NOT return Infinity (the Math.ceil(n/0) poison)", () => {
    const pages = computePages(50, 0);
    assert.ok(Number.isFinite(pages), "pages must be finite");
    assert.equal(pages, Math.ceil(50 / DEFAULT_CONTENT_LIMIT));
  });

  it("NaN limit → DOES NOT return NaN", () => {
    const pages = computePages(50, NaN);
    assert.ok(Number.isFinite(pages));
    assert.equal(pages, Math.ceil(50 / DEFAULT_CONTENT_LIMIT));
  });

  it("negative / NaN / non-finite total → 0 pages", () => {
    assert.equal(computePages(-5, 10), 0);
    assert.equal(computePages(NaN, 10), 0);
    assert.equal(computePages(Infinity, 10), 0);
    assert.equal(computePages("50" as unknown as number, 10), 0);
  });

  it("always returns a finite non-negative integer for adversarial input", () => {
    const cases: Array<[unknown, unknown]> = [
      [NaN, NaN],
      [Infinity, 0],
      [-1, -1],
      [100, 0],
      [100, NaN],
      [null, undefined],
    ];
    for (const [t, l] of cases) {
      const pages = computePages(t, l);
      assert.ok(
        Number.isInteger(pages) && pages >= 0,
        `pages for (${String(t)},${String(l)}) = ${pages}`
      );
    }
  });
});

// ── entitlement gate ────────────────────────────────────────────────

describe("MONEY-620 — decideContentAccess (premium gate, fail-closed)", () => {
  it("tier ranks: FREE<PRO<PREMIUM<ULTIMATE, premium unlocks at PRO", () => {
    assert.equal(CONTENT_TIER_RANK.FREE, 0);
    assert.equal(PREMIUM_ACCESS_MIN_RANK, 1);
    assert.ok(CONTENT_TIER_RANK.PRO! >= PREMIUM_ACCESS_MIN_RANK);
    assert.ok(CONTENT_TIER_RANK.PREMIUM! >= PREMIUM_ACCESS_MIN_RANK);
    assert.ok(CONTENT_TIER_RANK.ULTIMATE! >= PREMIUM_ACCESS_MIN_RANK);
  });

  it("non-premium content is ALWAYS public (any/no viewer)", () => {
    const free = { isPremium: false };
    assert.equal(decideContentAccess(free).allowed, true);
    assert.equal(decideContentAccess(free, null).allowed, true);
    assert.equal(decideContentAccess(free, { planId: "FREE" }).allowed, true);
    assert.equal(decideContentAccess(free, undefined).reason, "");
  });

  it("premium + FREE / anonymous / unknown plan → DENIED (premium_locked)", () => {
    const premium = { isPremium: true };
    assert.equal(decideContentAccess(premium).allowed, false);
    assert.equal(decideContentAccess(premium, null).allowed, false);
    assert.equal(decideContentAccess(premium, {}).allowed, false);
    assert.equal(
      decideContentAccess(premium, { planId: "FREE" }).allowed,
      false
    );
    assert.equal(
      decideContentAccess(premium, { planId: "free" }).allowed,
      false
    );
    assert.equal(
      decideContentAccess(premium, { planId: "WAT" }).allowed,
      false
    );
    assert.equal(
      decideContentAccess(premium, { planId: null }).reason,
      "premium_locked"
    );
  });

  it("premium + PRO / PREMIUM / ULTIMATE → ALLOWED (case-insensitive)", () => {
    const premium = { isPremium: true };
    for (const plan of ["PRO", "PREMIUM", "ULTIMATE", "pro", " Premium "]) {
      assert.equal(
        decideContentAccess(premium, { planId: plan }).allowed,
        true,
        `plan ${plan} should unlock premium`
      );
    }
  });

  it("premium + entitled:false hard override → DENIED even at a premium plan (expired sub)", () => {
    const premium = { isPremium: true };
    const d = decideContentAccess(premium, {
      planId: "PREMIUM",
      entitled: false,
    });
    assert.equal(d.allowed, false);
    assert.equal(d.reason, "entitlement_expired");
  });

  it("premium + entitled:true at FREE plan is still DENIED (plan governs, true is not an unlock)", () => {
    // entitled is a DE-entitlement override only; it must not grant access a
    // FREE plan otherwise lacks.
    const premium = { isPremium: true };
    assert.equal(
      decideContentAccess(premium, { planId: "FREE", entitled: true }).allowed,
      false
    );
  });
});

describe("MONEY-620 — redactPremiumPost (REAL service export)", () => {
  function makePost(isPremium: boolean): Post {
    const now = new Date("2026-06-01T00:00:00Z");
    return {
      id: "p1",
      contentPlatform: "STOCKBOOK",
      contentType: "BLOG",
      title: "Secret Alpha",
      content: "FULL PREMIUM BODY — paid only",
      featureImage: null,
      postUrl: "secret-alpha",
      excerpt: "teaser",
      publishDate: now,
      status: "PUBLISHED",
      isFeatured: false,
      isPremium,
      authorId: "a1",
      author: {
        id: "a1",
        clerkId: "c1",
        name: "Writer",
        username: "writer",
        email: "w@x.com",
        imageUrl: null,
        role: "WRITER",
        createdAt: now,
        updatedAt: now,
      },
      tags: [],
      metadataTitle: null,
      metadataDescription: null,
      metadataImageUrl: null,
      metadataKeywords: null,
      canonicalUrl: null,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("strips the body of a PREMIUM post for a FREE viewer, keeps preview fields", () => {
    const post = makePost(true);
    const out = redactPremiumPost(post, { planId: "FREE" });
    assert.equal(out.content, "", "premium body must NOT reach a FREE viewer");
    // Preview fields survive for the paywall.
    assert.equal(out.title, "Secret Alpha");
    assert.equal(out.excerpt, "teaser");
    assert.equal(out.isPremium, true);
  });

  it("strips the body for an EXPIRED premium subscriber (entitled:false)", () => {
    const post = makePost(true);
    const out = redactPremiumPost(post, {
      planId: "PREMIUM",
      entitled: false,
    });
    assert.equal(out.content, "");
  });

  it("returns the premium post UNCHANGED for an entitled (PRO) viewer", () => {
    const post = makePost(true);
    const out = redactPremiumPost(post, { planId: "PRO" });
    assert.equal(out.content, "FULL PREMIUM BODY — paid only");
    assert.equal(
      out,
      post,
      "authorized access is behavior-preserving (same ref)"
    );
  });

  it("returns a NON-premium post unchanged for anyone (public)", () => {
    const post = makePost(false);
    assert.equal(redactPremiumPost(post, null).content, post.content);
    assert.equal(redactPremiumPost(post, { planId: "FREE" }), post);
  });

  it("does not mutate the input post when redacting (returns a copy)", () => {
    const post = makePost(true);
    const out = redactPremiumPost(post, { planId: "FREE" });
    assert.notEqual(out, post);
    assert.equal(
      post.content,
      "FULL PREMIUM BODY — paid only",
      "original intact"
    );
  });
});
