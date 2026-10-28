/**
 * MONEY-1236 — `getLatestBriefingAction` must find a briefing whose `viewedAt`
 * key is ABSENT.
 *
 * THE DEFECT. Prisma's MongoDB connector does not treat a missing field as
 * null; `{ viewedAt: null }` lowers to an equality against an explicit JSON
 * null and matches ONLY documents that carry the key. Nothing carries it: the
 * one `loginBriefing.create` in the repo (the Clerk `session.created` handler,
 * apps/web/app/api/webhooks/clerk/route.ts:530) writes exactly
 * `{userId, status, briefingDate}`, `viewedAt DateTime?` has no `@default`, and
 * `prisma db push` creates INDEXES, never FIELDS. The dashboard popup could
 * therefore never surface, however many briefings the worker completed.
 *
 * This is the WEB half of the same query; the API half lives in
 * packages/services/src/user.service.ts and is pinned by
 * packages/services/__tests__/money1236-briefing-unviewed-filter.test.ts. The
 * two must stay identical — they are the same product feature on two clients,
 * and a fix applied to only one is how a "fixed" ticket keeps reproducing.
 *
 * MEASURED ON PROD 2026-08-21: `login_briefings` total=0, absent=0. The read
 * was never wrong about a real row because the write never fires either (the
 * webhook resolves the user by SESSION id — a second, independent defect in a
 * file this ticket does not own). This suite pins the read half.
 *
 * Drives the REAL server action through the `require.cache` seam over a prisma
 * double whose `findFirst` implements PRISMA's rule (absent ≠ null) rather than
 * raw Mongo's (where `{f: null}` WOULD match a missing key), plus a control
 * case that fails the double itself if that distinction is ever lost.
 *
 * Source: apps/web/lib/actions/briefing.ts
 */

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// ════════════════════════════════════════════════════════════════════════════
// PRISMA-on-Mongo `where` evaluator (test double, not production logic)
// ════════════════════════════════════════════════════════════════════════════

type BriefingDoc = Record<string, unknown>;

/**
 * PRISMA's semantics for one field condition — deliberately NOT raw Mongo's:
 *   - `{ viewedAt: null }`             → explicit null ONLY;
 *   - `{ viewedAt: { isSet: false } }` → the missing-key case, and only that.
 * A double that collapsed the two would report a pass for a query that returns
 * nothing in production, which is the whole bug.
 */
function matchesCondition(
  want: unknown,
  doc: BriefingDoc,
  key: string
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
    const w = want as { isSet?: boolean; gte?: Date; not?: unknown };
    if (w.isSet !== undefined) return w.isSet === false ? !present : present;
    if (w.gte instanceof Date) {
      return (
        present && value instanceof Date && value.getTime() >= w.gte.getTime()
      );
    }
    if ("not" in w) return present && value !== w.not;
    return false;
  }
  return present && value === want;
}

function matchesWhere(
  where: Record<string, unknown> | undefined,
  doc: BriefingDoc
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
    if (!matchesCondition(want, doc, key)) return false;
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// Harness
// ════════════════════════════════════════════════════════════════════════════

interface Harness {
  authUser: { userId: string } | null;
  rows: BriefingDoc[];
  wheres: (Record<string, unknown> | undefined)[];
  updates: { where: unknown; data: Record<string, unknown> }[];
}

function freshHarness(): Harness {
  return { authUser: { userId: "u1" }, rows: [], wheres: [], updates: [] };
}

/** A briefing exactly as the Clerk webhook writes it: NO `viewedAt` key. */
/** A time TODAY in the runner's own timezone — the action compares against
 *  `new Date()` with `setHours(0,0,0,0)`, so any hour of today satisfies it. */
function todayAt(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 30, 0, 0);
  return d;
}

function absentViewedAtRow(over: Partial<BriefingDoc> = {}): BriefingDoc {
  return {
    id: "b_absent",
    userId: "u1",
    status: "COMPLETED",
    summary: "Your portfolio is up 1.2% today",
    sections: [{ kind: "movers" }],
    portfolioValue: 250000,
    dayChange: 3000,
    // RELATIVE TO TODAY, not a calendar date — and this is a repaired
    // time bomb, not a style preference.
    //
    // `getLatestBriefingAction` is documented "today only" and filters
    // `briefingDate: { gte: today }` where `today` is midnight LOCAL, read from
    // a `new Date()` the action creates itself. The fixture used to hardcode
    // 2026-08-21, so it passed for exactly one day and then failed every day
    // after — it went red at 00:00 IST on 2026-08-22 while the source it tests
    // was untouched. That is the worst shape of test failure: it accuses code
    // that did not change.
    //
    // The sibling `packages/services/__tests__/money1236-briefing-unviewed-filter.test.ts`
    // does NOT have this problem, because `getLatestBriefing` there takes an
    // injectable `now`. The web action does not, so the fixture moves instead.
    briefingDate: todayAt(9),
    completedAt: todayAt(9),
    createdAt: todayAt(9),
    ...over,
    // `viewedAt` deliberately NOT spread in — an explicit `undefined` would
    // still own the key and silently turn this into a test of the null path.
  };
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const ACTION_REL = "../../lib/actions/briefing";

interface ActionModule {
  getLatestBriefingAction: () => Promise<{
    success: boolean;
    data?: { id: string; summary: string | null } | null;
    error?: string;
  }>;
  markBriefingViewedAction: (
    id: string
  ) => Promise<{ success: boolean; error?: string }>;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(p: string): void {
  if (!priorCacheEntries.has(p)) priorCacheEntries.set(p, moduleCache()[p]);
}
function restoreCache(): void {
  const cache = moduleCache();
  for (const [p, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[p];
    else cache[p] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

function loadAction(h: Harness): ActionModule {
  const cache = moduleCache();
  const authPath = require.resolve("../../lib/auth");
  const dbPath = require.resolve("@usemoney/database");
  for (const p of [authPath, dbPath]) snapshotOnce(p);

  cache[authPath] = {
    exports: {
      __esModule: true,
      getAuthenticatedUser: () => Promise.resolve(h.authUser),
    },
  };
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: {
        loginBriefing: {
          findFirst: (args: { where?: Record<string, unknown> }) => {
            h.wheres.push(args.where);
            return Promise.resolve(
              h.rows.find((r) => matchesWhere(args.where, r)) ?? null
            );
          },
          findUnique: (args: { where: { id: string } }) =>
            Promise.resolve(h.rows.find((r) => r.id === args.where.id) ?? null),
          update: (args: { where: unknown; data: Record<string, unknown> }) => {
            h.updates.push(args);
            return Promise.resolve({});
          },
        },
      },
    },
  };
  delete cache[require.resolve(ACTION_REL)];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ActionModule;
}

// ════════════════════════════════════════════════════════════════════════════
// Behavioural
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1236 getLatestBriefingAction — briefings with an ABSENT viewedAt", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  it("returns a briefing written WITHOUT the key (the Clerk-webhook shape)", async () => {
    h.rows = [absentViewedAtRow()];
    const action = loadAction(h);
    const res = await action.getLatestBriefingAction();
    assert.equal(res.success, true);
    assert.equal(
      res.data?.id,
      "b_absent",
      "pre-fix this returned null and the dashboard popup never rendered"
    );
  });

  it("still returns one written WITH an explicit null", async () => {
    h.rows = [{ ...absentViewedAtRow({ id: "b_null" }), viewedAt: null }];
    const action = loadAction(h);
    const res = await action.getLatestBriefingAction();
    assert.equal(res.data?.id, "b_null");
  });

  it("still EXCLUDES a briefing the user already dismissed", async () => {
    h.rows = [
      {
        ...absentViewedAtRow({ id: "b_seen" }),
        viewedAt: new Date("2026-08-21T04:00:00.000Z"),
      },
    ];
    const action = loadAction(h);
    const res = await action.getLatestBriefingAction();
    assert.equal(res.success, true);
    assert.equal(res.data, null, "widening must not resurrect dismissed rows");
  });

  it("emits an OR whose arms are exactly {viewedAt: null} and {viewedAt: {isSet:false}}", async () => {
    const action = loadAction(h);
    await action.getLatestBriefingAction();
    assert.equal(h.wheres.length, 1);
    assert.deepEqual(h.wheres[0]?.OR, [
      { viewedAt: null },
      { viewedAt: { isSet: false } },
    ]);
    assert.ok(
      !("viewedAt" in (h.wheres[0] ?? {})),
      "the bare top-level predicate must be gone, not merely joined"
    );
  });

  it("mark-viewed still MATERIALISES the key with a real Date", async () => {
    // The write half of the same lifecycle: once dismissed, the row carries the
    // key, so the `{viewedAt: null}` arm alone correctly stops matching it.
    h.rows = [absentViewedAtRow()];
    const action = loadAction(h);
    const res = await action.markBriefingViewedAction("b_absent");
    assert.equal(res.success, true);
    assert.equal(h.updates.length, 1);
    assert.ok(h.updates[0].data.viewedAt instanceof Date);
  });

  it("[control] the PRE-FIX predicate matches none of these rows in the double", () => {
    const absent = absentViewedAtRow();
    assert.equal(matchesWhere({ viewedAt: null }, absent), false);
    assert.equal(matchesWhere({ viewedAt: { not: null } }, absent), false);
    assert.equal(
      matchesWhere(
        { OR: [{ viewedAt: null }, { viewedAt: { isSet: false } }] },
        absent
      ),
      true
    );
    assert.equal(
      matchesWhere({ viewedAt: null }, { ...absent, viewedAt: null }),
      true,
      "…and the double is not simply refusing every null"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Source assertions — web and API halves must stay identical
// ════════════════════════════════════════════════════════════════════════════

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const WEB_SRC = path.join(REPO_ROOT, "apps/web/lib/actions/briefing.ts");
const API_SRC = path.join(REPO_ROOT, "packages/services/src/user.service.ts");

/**
 * MONEY-1143 — strip LINE comments BEFORE block comments, or the block pass
 * runs first and the line pass then matches our OWN prose. Both files below
 * genuinely mention `isSet: false` in a comment, so the ordering is
 * load-bearing; the `[meta]` case asserts the stripper really removed it.
 */
function stripComments(src: string): string {
  const noLine = src.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return noLine.replace(/\/\*[\s\S]*?\*\//g, "");
}

const UNVIEWED_OR =
  /OR:\s*\[\s*\{\s*viewedAt:\s*null\s*\}\s*,\s*\{\s*viewedAt:\s*\{\s*isSet:\s*false\s*\}\s*\}\s*\]/;

describe("MONEY-1236 [src] briefing — the unviewed predicate on both clients", () => {
  it("[meta] stripComments removes the prose that mentions isSet", () => {
    const raw = readFileSync(WEB_SRC, "utf8");
    const stripped = stripComments(raw);
    assert.ok(
      (raw.match(/isSet/g)?.length ?? 0) >
        (stripped.match(/isSet/g)?.length ?? 0),
      "comments mentioning isSet must be removed"
    );
    assert.equal(
      stripped.match(/isSet/g)?.length ?? 0,
      1,
      "exactly one isSet remains, in the CODE"
    );
  });

  it("apps/web getLatestBriefingAction filters null-OR-absent", () => {
    const src = stripComments(readFileSync(WEB_SRC, "utf8"));
    assert.match(src, UNVIEWED_OR);
    assert.equal(
      src.match(/viewedAt:\s*null(?!\s*\}\s*,\s*\{)/g)?.length ?? 0,
      0,
      "no bare `viewedAt: null` outside the OR"
    );
  });

  it("packages/services getLatestBriefing uses the IDENTICAL predicate", () => {
    const src = stripComments(readFileSync(API_SRC, "utf8"));
    assert.match(
      src,
      UNVIEWED_OR,
      "the apps/api half must not drift from the web half — same feature, two " +
        "clients, and a one-sided fix is how a closed ticket keeps reproducing"
    );
  });
});
