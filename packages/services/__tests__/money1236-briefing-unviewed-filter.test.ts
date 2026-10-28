/**
 * MONEY-1236 — `getLatestBriefing` must find a briefing whose `viewedAt` key is
 * ABSENT.
 *
 * THE DEFECT. Prisma's MongoDB connector does not treat a missing field as
 * null; `{ viewedAt: null }` lowers to an equality against an explicit JSON
 * null and matches ONLY documents that carry the key. No writer carries it. The
 * single `loginBriefing.create` in the repo lives in the Clerk `session.created`
 * handler (apps/web/app/api/webhooks/clerk/route.ts:530) and writes exactly
 * `{userId, status, briefingDate}`; `viewedAt DateTime?` has no `@default`, and
 * `prisma db push` creates INDEXES, never FIELDS. Every briefing was therefore
 * invisible to this read and /v1/me/briefing always answered "none".
 *
 * ROOT CAUSE vs. ROBUST FIX. The create path omitting `viewedAt` is the root
 * cause and lives in a file this ticket does not own. Widening the READ is the
 * better half regardless: it is correct whichever writer produced the row, and
 * it is the ONLY half that can see rows already on disk — a writer-side fix
 * backfills nothing.
 *
 * MEASURED ON PROD 2026-08-21: `login_briefings` total=0, absent=0 — so this
 * read was never wrong about a real row yet. It could not have been: the write
 * never fires either (see the report on MONEY-1236). Two independent defects on
 * one feature; this suite pins the READ half, which is the half in scope.
 *
 * WHY A FAKE PRISMA. `getLatestBriefing` already takes `deps.prisma`, so the
 * real function can be driven over a `where` evaluator that implements PRISMA's
 * rule (absent ≠ null) rather than raw Mongo's (where `{f: null}` WOULD match a
 * missing key). A source assertion alone would pass on a filter that drifts
 * later; a fake alone would pass on a double that collapsed the distinction —
 * hence the control case below, which fails the double itself.
 *
 * Source: packages/services/src/user.service.ts (getLatestBriefing)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { getLatestBriefing } from "../src/user.service";

// ════════════════════════════════════════════════════════════════════════════
// PRISMA-on-Mongo `where` evaluator (test double, not production logic)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A briefing document. Modelled as a bag so a field can be genuinely ABSENT —
 * `{viewedAt: undefined}` would not do: the key would still be owned, and
 * `hasOwnProperty` is precisely what separates the two cases.
 */
type BriefingDoc = Record<string, unknown>;

/**
 * PRISMA's semantics for one field condition — deliberately NOT raw Mongo's:
 *   - `{ viewedAt: null }`             → explicit null ONLY;
 *   - `{ viewedAt: { isSet: false } }` → the missing-key case, and only that;
 *   - `{ viewedAt: { not: null } }`    → present AND non-null (the mirror trap).
 */
function matchesCondition(
  want: unknown,
  doc: BriefingDoc,
  key: string,
): boolean {
  const present = Object.prototype.hasOwnProperty.call(doc, key);
  const value = doc[key];

  if (want === null) return present && value === null;
  if (want instanceof Date) {
    return (
      present && value instanceof Date && value.getTime() === want.getTime()
    );
  }
  if (typeof want === "object") {
    const w = want as {
      isSet?: boolean;
      gte?: Date;
      equals?: unknown;
      not?: unknown;
    };
    if (w.isSet !== undefined) return w.isSet === false ? !present : present;
    if (w.gte instanceof Date) {
      return (
        present &&
        value instanceof Date &&
        value.getTime() >= (w.gte as Date).getTime()
      );
    }
    if ("equals" in w) return present && w.equals === value;
    if ("not" in w) return present && value !== w.not;
    return false;
  }
  return present && value === want;
}

function matchesWhere(
  where: Record<string, unknown> | undefined,
  doc: BriefingDoc,
): boolean {
  if (!where) return true;
  for (const [key, want] of Object.entries(where)) {
    if (want === undefined) continue;
    if (key === "OR") {
      const arms = want as Record<string, unknown>[];
      if (!arms.some((arm) => matchesWhere(arm, doc))) return false;
      continue;
    }
    if (key === "AND") {
      const arms = want as Record<string, unknown>[];
      if (!arms.every((arm) => matchesWhere(arm, doc))) return false;
      continue;
    }
    if (key === "NOT") {
      if (matchesWhere(want as Record<string, unknown>, doc)) return false;
      continue;
    }
    if (!matchesCondition(want, doc, key)) return false;
  }
  return true;
}

interface FindFirstArgs {
  where?: Record<string, unknown>;
}

/** A fake prisma whose `loginBriefing.findFirst` honours the Mongo rule. */
function fakePrisma(rows: BriefingDoc[]) {
  const wheres: (Record<string, unknown> | undefined)[] = [];
  const client = {
    loginBriefing: {
      findFirst: (args: FindFirstArgs) => {
        wheres.push(args.where);
        return Promise.resolve(
          rows.find((r) => matchesWhere(args.where, r)) ?? null,
        );
      },
    },
  };
  return { client: client as never, wheres };
}

const NOW = new Date("2026-08-21T09:30:00.000Z");

/** A briefing exactly as the Clerk webhook writes it: NO `viewedAt` key. */
function absentViewedAtRow(over: Partial<BriefingDoc> = {}): BriefingDoc {
  return {
    id: "b_absent",
    userId: "u1",
    status: "COMPLETED",
    summary: "Your portfolio is up 1.2% today",
    sections: [{ kind: "movers" }],
    portfolioValue: 250000,
    dayChange: 3000,
    briefingDate: new Date("2026-08-21T03:30:00.000Z"),
    completedAt: new Date("2026-08-21T03:35:00.000Z"),
    createdAt: new Date("2026-08-21T03:30:00.000Z"),
    ...over,
    // `viewedAt` is deliberately NOT spread in. Adding it — even as `undefined`
    // — would give the doc the key and turn this suite into a test of the null
    // path, which was never broken.
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Behavioural
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1236 getLatestBriefing — briefings with an ABSENT viewedAt", () => {
  it("returns a briefing written WITHOUT the key (the Clerk-webhook shape)", async () => {
    const { client } = fakePrisma([absentViewedAtRow()]);
    const res = await getLatestBriefing("u1", {
      prisma: client,
      now: () => NOW,
    });
    assert.ok(res.success);
    assert.equal(
      res.success && res.data?.id,
      "b_absent",
      "pre-fix this returned null and the popup could never surface",
    );
    assert.equal(
      res.success && res.data?.summary,
      "Your portfolio is up 1.2% today",
    );
  });

  it("still returns one written WITH an explicit null (either writer shape works)", async () => {
    const { client } = fakePrisma([
      { ...absentViewedAtRow({ id: "b_null" }), viewedAt: null },
    ]);
    const res = await getLatestBriefing("u1", {
      prisma: client,
      now: () => NOW,
    });
    assert.ok(res.success);
    assert.equal(res.success && res.data?.id, "b_null");
  });

  it("still EXCLUDES a briefing the user has already viewed", async () => {
    const { client } = fakePrisma([
      {
        ...absentViewedAtRow({ id: "b_seen" }),
        viewedAt: new Date("2026-08-21T04:00:00.000Z"),
      },
    ]);
    const res = await getLatestBriefing("u1", {
      prisma: client,
      now: () => NOW,
    });
    assert.ok(res.success);
    assert.equal(
      res.success && res.data,
      null,
      "widening must not resurrect dismissed briefings",
    );
  });

  it("keeps the other predicates intact (IDOR userId, COMPLETED, today-only)", async () => {
    const { client } = fakePrisma([
      absentViewedAtRow({ id: "b_other_user", userId: "u2" }),
      absentViewedAtRow({ id: "b_queued", status: "QUEUED" }),
      absentViewedAtRow({
        id: "b_yesterday",
        briefingDate: new Date("2026-08-20T03:30:00.000Z"),
      }),
      absentViewedAtRow({ id: "b_good" }),
    ]);
    const res = await getLatestBriefing("u1", {
      prisma: client,
      now: () => NOW,
    });
    assert.ok(res.success);
    assert.equal(res.success && res.data?.id, "b_good");
  });

  it("emits an OR whose arms are exactly {viewedAt: null} and {viewedAt: {isSet:false}}", async () => {
    const { client, wheres } = fakePrisma([]);
    await getLatestBriefing("u1", { prisma: client, now: () => NOW });
    assert.equal(wheres.length, 1);
    assert.deepEqual(wheres[0]?.OR, [
      { viewedAt: null },
      { viewedAt: { isSet: false } },
    ]);
    assert.ok(
      !("viewedAt" in (wheres[0] ?? {})),
      "the bare top-level `viewedAt` predicate must be gone, not merely joined",
    );
  });

  it("[control] the PRE-FIX predicate matches none of these rows in the double", () => {
    const absent = absentViewedAtRow();
    assert.equal(
      matchesWhere({ viewedAt: null }, absent),
      false,
      "Prisma-on-Mongo: a bare null does NOT reach an absent key",
    );
    assert.equal(
      matchesWhere({ viewedAt: { not: null } }, absent),
      false,
      "`not: null` does not reach it either — the mirror-image trap",
    );
    assert.equal(
      matchesWhere(
        { OR: [{ viewedAt: null }, { viewedAt: { isSet: false } }] },
        absent,
      ),
      true,
      "only the isSet arm reaches an absent key",
    );
    assert.equal(
      matchesWhere({ viewedAt: null }, { ...absent, viewedAt: null }),
      true,
      "…and the double is not simply refusing every null",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Source assertion
// ════════════════════════════════════════════════════════════════════════════

const USER_SERVICE_SRC = fileURLToPath(
  new URL("../src/user.service.ts", import.meta.url),
);

/**
 * MONEY-1143 — strip LINE comments BEFORE block comments. Reversed, the block
 * pass runs first and the line pass then matches our OWN prose, so "the file
 * contains `isSet: false`" would be satisfied by the COMMENT explaining the fix
 * rather than by the code implementing it. The comment above the fixed query
 * genuinely contains that literal, so this ordering is load-bearing here — the
 * `[meta]` case below asserts the stripper actually removed it.
 */
function stripComments(src: string): string {
  const noLine = src.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return noLine.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("MONEY-1236 [src] user.service.ts — the unviewed predicate", () => {
  it("[meta] stripComments removes the prose that mentions isSet", () => {
    const raw = readFileSync(USER_SERVICE_SRC, "utf8");
    const stripped = stripComments(raw);
    const rawHits = raw.match(/isSet/g)?.length ?? 0;
    const strippedHits = stripped.match(/isSet/g)?.length ?? 0;
    assert.ok(
      rawHits > strippedHits,
      "comments mentioning isSet must be removed",
    );
    assert.equal(strippedHits, 1, "exactly one isSet remains, in the CODE");
  });

  it("carries both OR arms and no bare `viewedAt: null` filter", () => {
    const src = stripComments(readFileSync(USER_SERVICE_SRC, "utf8"));
    assert.match(
      src,
      /OR:\s*\[\s*\{\s*viewedAt:\s*null\s*\}\s*,\s*\{\s*viewedAt:\s*\{\s*isSet:\s*false\s*\}\s*\}\s*\]/,
      "getLatestBriefing must filter null-OR-absent",
    );
    // The only remaining `viewedAt:` writes are `markBriefingViewed`'s
    // `data: { viewedAt: now() }`. A bare `viewedAt: null` anywhere would be a
    // read that Prisma-on-Mongo cannot satisfy.
    assert.equal(
      src.match(/viewedAt:\s*null(?!\s*\}\s*,\s*\{)/g)?.length ?? 0,
      0,
      "no bare `viewedAt: null` outside the OR",
    );
  });
});
