/**
 * result-feedback.service — REAL exports, injected prisma (MONEY-1062 P4b).
 *
 * Pins the ported web-action semantics, most importantly the MONEY-800 (B6)
 * bandit OUTCOME side effect: `recordVariantOutcome` runs as the REAL pure fn
 * (deliberately not stubbed — the deps seam only injects prisma), so these
 * tests assert the actual `{variantId, outcome}` stamp that the bandit's next
 * selection pass consumes, and the MONEY-807 un-anchored-`outcome` strip.
 *
 * Source: packages/services/src/result-feedback.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  submitResultFeedback,
  clearResultFeedback,
  getResultFeedback,
  type ResultFeedbackServiceDeps,
} from "../src/result-feedback.service";

interface RecordedCall {
  method: string;
  args: Record<string, unknown>;
}

/** Fake prisma exposing only the resultFeedback delegate, recording calls. */
function fakePrisma(overrides?: {
  upsert?: (args: Record<string, unknown>) => unknown;
  findMany?: (args: Record<string, unknown>) => unknown;
  deleteMany?: (args: Record<string, unknown>) => unknown;
}): { prisma: ResultFeedbackServiceDeps["prisma"]; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const prisma = {
    resultFeedback: {
      upsert: async (args: Record<string, unknown>) => {
        calls.push({ method: "upsert", args });
        if (overrides?.upsert) return overrides.upsert(args);
        const create = args.create as Record<string, unknown>;
        return { rating: create.rating, comment: create.comment ?? null };
      },
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ method: "findMany", args });
        return overrides?.findMany ? overrides.findMany(args) : [];
      },
      deleteMany: async (args: Record<string, unknown>) => {
        calls.push({ method: "deleteMany", args });
        return overrides?.deleteMany
          ? overrides.deleteMany(args)
          : { count: 1 };
      },
    },
  } as unknown as ResultFeedbackServiceDeps["prisma"];
  return { prisma, calls };
}

const BASE_INPUT = {
  surface: "CHAT" as const,
  refId: "msg_1",
  rating: "UP" as const,
};

describe("submitResultFeedback — bandit outcome side effect (real recordVariantOutcome)", () => {
  it("with an arm: stamps {variantId, outcome} into the persisted metadata", async () => {
    const { prisma, calls } = fakePrisma();
    const res = await submitResultFeedback(
      "u1",
      { ...BASE_INPUT, variantId: "arm_a", metadata: { foo: "bar" } },
      { prisma },
    );
    assert.equal(res.success, true);
    const args = calls[0]?.args as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
      where: Record<string, unknown>;
    };
    // The bandit counts one tagged row == one outcome: the stamp IS the bump.
    assert.deepEqual(args.create.metadata, {
      foo: "bar",
      variantId: "arm_a",
      outcome: "UP",
    });
    // Re-rate path re-stamps too (a 👍→👎 flip must flip the recorded outcome).
    assert.deepEqual(args.update.metadata, {
      foo: "bar",
      variantId: "arm_a",
      outcome: "UP",
    });
    // Upsert key is the caller-scoped composite (IDOR).
    assert.deepEqual(args.where, {
      userId_surface_refId: { userId: "u1", surface: "CHAT", refId: "msg_1" },
    });
  });

  it("re-rate flips the recorded outcome (DOWN re-stamp)", async () => {
    const { prisma, calls } = fakePrisma({
      upsert: () => ({ rating: "DOWN", comment: null }),
    });
    const res = await submitResultFeedback(
      "u1",
      { ...BASE_INPUT, rating: "DOWN", variantId: "arm_a" },
      { prisma },
    );
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.rating, "DOWN");
    const update = (calls[0]?.args as { update: Record<string, unknown> })
      .update;
    assert.deepEqual(update.metadata, { variantId: "arm_a", outcome: "DOWN" });
  });

  it("no arm: strips the un-anchored `outcome` from caller metadata (MONEY-807), keeps the rest", async () => {
    const { prisma, calls } = fakePrisma();
    await submitResultFeedback(
      "u1",
      // Client echoed back a stale outcome copy with no variantId to anchor it.
      { ...BASE_INPUT, metadata: { outcome: "UP", keep: 1 } },
      { prisma },
    );
    const args = calls[0]?.args as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    assert.deepEqual(args.create.metadata, { keep: 1 }); // outcome stripped
    assert.deepEqual(args.update.metadata, { keep: 1 });
  });

  it("no arm + no metadata: update spread OMITS metadata (existing row's blob untouched)", async () => {
    const { prisma, calls } = fakePrisma();
    await submitResultFeedback("u1", { ...BASE_INPUT }, { prisma });
    const args = calls[0]?.args as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    assert.equal(args.create.metadata, undefined);
    // The conditional spread must not put a metadata key on update at all —
    // an explicit undefined would still be dropped by Prisma, but the ported
    // contract is "leave existing metadata untouched".
    assert.equal("metadata" in args.update, false);
  });

  it("normalises metadata through toJsonSafe (non-serializable values dropped)", async () => {
    const { prisma, calls } = fakePrisma();
    await submitResultFeedback(
      "u1",
      {
        ...BASE_INPUT,
        variantId: "arm_a",
        metadata: { ok: "yes", fn: (() => 1) as unknown as string },
      },
      { prisma },
    );
    const create = (calls[0]?.args as { create: Record<string, unknown> })
      .create;
    // Function dropped by the JSON round-trip; stamp + serializable keys kept.
    assert.deepEqual(create.metadata, {
      ok: "yes",
      variantId: "arm_a",
      outcome: "UP",
    });
  });

  it("degrades with a sanitised error when the write throws (never blocks the UI)", async () => {
    const { prisma } = fakePrisma({
      upsert: () => {
        throw new Error("Mongo down");
      },
    });
    const res = await submitResultFeedback("u1", { ...BASE_INPUT }, { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Could not save your feedback");
  });
});

describe("clearResultFeedback", () => {
  it("deletes scoped to userId + surface + refId (IDOR)", async () => {
    const { prisma, calls } = fakePrisma();
    const res = await clearResultFeedback("u1", "RESEARCH", "sess_9", {
      prisma,
    });
    assert.equal(res.success, true);
    assert.deepEqual(calls[0]?.args, {
      where: { userId: "u1", surface: "RESEARCH", refId: "sess_9" },
    });
  });

  it("rejects an empty refId with INVALID_INPUT before any DB work", async () => {
    const { prisma, calls } = fakePrisma();
    const res = await clearResultFeedback("u1", "CHAT", "", { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.code, "INVALID_INPUT");
    assert.equal(calls.length, 0);
  });
});

describe("getResultFeedback", () => {
  it("returns a refId-keyed map, scoped to the caller", async () => {
    const { prisma, calls } = fakePrisma({
      findMany: () => [
        { refId: "a", rating: "UP", comment: null },
        { refId: "b", rating: "DOWN", comment: "meh" },
      ],
    });
    const res = await getResultFeedback("u1", "CHAT", ["a", "b"], { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.deepEqual(res.data, {
        a: { rating: "UP", comment: null },
        b: { rating: "DOWN", comment: "meh" },
      });
    }
    const where = (calls[0]?.args as { where: Record<string, unknown> }).where;
    assert.equal((where as { userId: string }).userId, "u1");
  });

  it("empty/falsy id list short-circuits to {} with no DB call", async () => {
    const { prisma, calls } = fakePrisma();
    const res = await getResultFeedback("u1", "CHAT", ["", ""], { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data, {});
    assert.equal(calls.length, 0);
  });

  it("caps the id list at 200", async () => {
    const { prisma, calls } = fakePrisma();
    const ids = Array.from({ length: 250 }, (_, i) => `id_${i}`);
    await getResultFeedback("u1", "CHAT", ids, { prisma });
    const where = (calls[0]?.args as { where: Record<string, unknown> })
      .where as { refId: { in: string[] } };
    assert.equal(where.refId.in.length, 200);
  });

  it("read failure degrades to {} (best-effort hydration, still success)", async () => {
    const { prisma } = fakePrisma({
      findMany: () => {
        throw new Error("boom");
      },
    });
    const res = await getResultFeedback("u1", "ROAST", ["x"], { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.deepEqual(res.data, {});
  });
});
