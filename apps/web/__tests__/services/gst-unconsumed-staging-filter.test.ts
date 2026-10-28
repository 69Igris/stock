/**
 * MONEY-1236 — the GST invoice engine must SEE staging rows whose
 * `consumedByInvoiceId` key is ABSENT.
 *
 * THE DEFECT. Prisma's MongoDB connector does not treat a missing field as
 * null. `{ consumedByInvoiceId: null }` lowers to an equality against an
 * explicit JSON null and matches ONLY documents that carry the key. Nothing
 * carried it: `stageDodoRows` never wrote the field, `DodoPayoutStaging
 * .consumedByInvoiceId` has no `@default`, and `prisma db push` creates
 * INDEXES, never FIELDS. So `aggregateStagingForPeriod` selected zero rows
 * against a full staging table and `generateGstInvoice` threw
 * `NoPendingPayoutsError` — silently, on a GST-compliance path.
 *
 * MEASURED ON PROD 2026-08-21: `dodo_payout_staging` total=0, absent=0. Nothing
 * has been mis-invoiced, because nothing has been staged: the ONLY ingest door
 * is the manual admin CSV paste at `/gst/invoices`
 * (apps/admin/app/(dashboard)/gst/invoices/page.tsx:128 →
 * apps/admin/lib/actions/gst.ts:48 → stageDodoRows) — no scheduler, no Pub/Sub
 * topic, and the `FEATURE_DODO_WEBHOOK_INGEST` branch
 * (apps/web/app/api/webhooks/dodopayments/route.ts:72-80) logs and returns
 * without staging in BOTH flag states. This suite therefore pins the fix
 * BEFORE the table fills, which is the only moment it can be pinned cheaply.
 *
 * WHY THESE LAYERS. The behavioural half drives the REAL `generateGstInvoice`
 * through a `require.cache`-injected prisma double whose `where` evaluator
 * implements PRISMA's rule (absent ≠ null), not raw Mongo's (where `{f: null}`
 * WOULD match a missing key). A source assertion alone would happily pass on a
 * hand-copied filter that drifts later; a behavioural test alone would pass on
 * a double that quietly collapsed absent into null. Both are here, plus a
 * control case that fails the double itself if it ever stops modelling the
 * distinction.
 *
 * Lives in apps/web (CJS) because packages/services runs its suite as ESM,
 * where `require.cache` injection is unavailable
 * (payment-provisioning-service.test.ts pattern).
 *
 * Source: packages/services/src/gst/invoice-engine.service.ts
 *         packages/services/src/gst/staging.service.ts
 *         apps/admin/lib/actions/gst.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// ════════════════════════════════════════════════════════════════════════════
// A PRISMA-on-Mongo `where` evaluator (test double, not production logic)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A staged document. Modelled as a bag so a field can be genuinely ABSENT —
 * `undefined` would not do, because `hasOwnProperty` is what separates the two
 * cases and an explicit `{k: undefined}` still owns the key.
 */
type StagingDoc = Record<string, unknown>;

/**
 * PRISMA's semantics for one field condition — deliberately NOT raw Mongo's.
 * The entire ticket turns on this distinction:
 *   - `{ f: null }`            → explicit null ONLY. Does NOT match a document
 *                                missing the key, even though raw Mongo's
 *                                `{f: null}` would.
 *   - `{ f: { isSet: false } }`→ the missing-key case, and only that.
 *   - `{ f: { in: [...] } }`   → membership, key must be present.
 * Collapsing the first two would report a pass for a query that returns
 * nothing in production — which is exactly the bug being fixed.
 */
function matchesCondition(
  want: unknown,
  doc: StagingDoc,
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
    const w = want as {
      isSet?: boolean;
      in?: unknown[];
      equals?: unknown;
      not?: unknown;
      gte?: Date;
    };
    if (w.isSet !== undefined) return w.isSet === false ? !present : present;
    if (w.in !== undefined) {
      if (!present) return false;
      return w.in.some((v) =>
        v instanceof Date && value instanceof Date
          ? v.getTime() === value.getTime()
          : v === value
      );
    }
    if ("equals" in w) return present && w.equals === value;
    // `not: null` in Prisma-on-Mongo ALSO requires the key to be present —
    // the mirror image of the bug, and modelled so a "fix" that reached for
    // `{not: null}` could not sneak past this suite.
    if ("not" in w) return present && value !== w.not;
    if (w.gte instanceof Date) {
      return (
        present && value instanceof Date && value.getTime() >= w.gte.getTime()
      );
    }
    return false;
  }
  return present && value === want;
}

/** Recursive `where` evaluation with AND/OR/NOT, Prisma-shaped. */
function matchesWhere(
  where: Record<string, unknown> | undefined,
  doc: StagingDoc
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

// ════════════════════════════════════════════════════════════════════════════
// Recording prisma double
// ════════════════════════════════════════════════════════════════════════════

interface RecordedCall {
  model: string;
  method: string;
  args: Record<string, unknown>;
}

const PERIOD_START = new Date("2026-04-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-04-15T23:59:59.999Z");

function makePrisma(rows: StagingDoc[]) {
  const calls: RecordedCall[] = [];
  const push = (model: string, method: string, args: Record<string, unknown>) =>
    calls.push({ model, method, args });

  const select = (where: Record<string, unknown> | undefined) =>
    rows.filter((r) => matchesWhere(where, r));

  return {
    calls,
    rows,
    dodoPayoutStaging: {
      findMany: (args: { where?: Record<string, unknown> }) => {
        push("dodoPayoutStaging", "findMany", args);
        return Promise.resolve(select(args.where));
      },
      findFirst: (args: { where?: Record<string, unknown> }) => {
        push("dodoPayoutStaging", "findFirst", args);
        return Promise.resolve(select(args.where)[0] ?? null);
      },
      updateMany: (args: {
        where?: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        push("dodoPayoutStaging", "updateMany", args);
        const hit = select(args.where);
        for (const r of hit) Object.assign(r, args.data);
        return Promise.resolve({ count: hit.length });
      },
    },
    gstInvoiceCounter: {
      upsert: (args: Record<string, unknown>) => {
        push("gstInvoiceCounter", "upsert", args);
        return Promise.resolve({ sequence: 1 });
      },
    },
    gstInvoice: {
      create: (args: { data: Record<string, unknown> }) => {
        push("gstInvoice", "create", args);
        return Promise.resolve({ id: "inv_new", ...args.data });
      },
      update: (args: Record<string, unknown>) => {
        push("gstInvoice", "update", args);
        return Promise.resolve({ id: "inv_new" });
      },
      findFirst: (args: Record<string, unknown>) => {
        push("gstInvoice", "findFirst", args);
        return Promise.resolve(null);
      },
    },
    gstCreditNote: {
      create: (args: { data: Record<string, unknown> }) => {
        push("gstCreditNote", "create", args);
        return Promise.resolve({ id: "cn_new", ...args.data });
      },
    },
    gstAuditLog: {
      create: (args: Record<string, unknown>) => {
        push("gstAuditLog", "create", args);
        return Promise.resolve({});
      },
    },
  };
}

type Stub = ReturnType<typeof makePrisma>;

/** A staged row exactly as `stageDodoRows` used to write it: NO lifecycle key. */
function absentKeyRow(over: Partial<StagingDoc> = {}): StagingDoc {
  return {
    id: "stg_absent",
    currency: "USD",
    grossAmount: 100,
    feesAmount: 10,
    netAmount: 90,
    customerCountry: "US",
    billingPeriodStart: PERIOD_START,
    billingPeriodEnd: PERIOD_END,
    ...over,
    // NOTE: `consumedByInvoiceId` is deliberately NOT spread in. Adding it here
    // — even as `undefined` — would give the doc the key and quietly turn this
    // whole suite into a test of the null path.
  };
}

// ════════════════════════════════════════════════════════════════════════════
// require.cache injection (CJS)
// ════════════════════════════════════════════════════════════════════════════

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const GST_DIR = "../../../../packages/services/src/gst";
const ENGINE_REL = `${GST_DIR}/invoice-engine.service`;
const NUMBERING_REL = `${GST_DIR}/numbering`;
const AUDIT_REL = `${GST_DIR}/audit-log`;
const FX_REL = `${GST_DIR}/rbi-fx`;

type EngineModule =
  typeof import("../../../../packages/services/src/gst/invoice-engine.service");

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
  for (const rel of [ENGINE_REL, NUMBERING_REL, AUDIT_REL, FX_REL]) {
    delete cache[require.resolve(rel)];
  }
}

class FakeRbiRateUnavailableError extends Error {}

function loadEngine(stub: Stub): EngineModule {
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  const logPath = require.resolve("@usemoney/logger");
  const fxPath = require.resolve(FX_REL);
  for (const p of [dbPath, logPath, fxPath]) snapshotOnce(p);

  // Enums come from the GENERATED client so `GstInvoiceStatus.DRAFT` etc. are
  // the real values; only `prisma` itself is replaced. Requiring
  // `@prisma/client` does NOT construct a PrismaClient, so no DATABASE_URL is
  // needed — requiring `@usemoney/database` for the same enums would.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const generated = require("@prisma/client") as Record<string, unknown>;
  cache[dbPath] = {
    exports: { __esModule: true, ...generated, prisma: stub, default: stub },
  };
  cache[logPath] = {
    exports: {
      __esModule: true,
      dbLogger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  };
  // Stub the RBI leg so a USD (export-under-LUT) invoice — the real-world case
  // this engine exists for — can be exercised without a live network fetch.
  cache[fxPath] = {
    exports: {
      __esModule: true,
      RbiRateUnavailableError: FakeRbiRateUnavailableError,
      getRbiReferenceRate: () =>
        Promise.resolve({
          rate: 83.5,
          source: "TEST",
          sourceUrl: "https://test.invalid/rbi",
        }),
    },
  };
  // Fresh-require the engine AND its prisma-touching siblings so each test
  // rebinds to the injected doubles with no leaked module state. Leaving
  // `numbering`/`audit-log` cached would keep them bound to whichever database
  // module they FIRST saw — the stub would be silently ignored and the engine
  // would try to reach a real Mongo.
  for (const rel of [ENGINE_REL, NUMBERING_REL, AUDIT_REL]) {
    delete cache[require.resolve(rel)];
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ENGINE_REL) as EngineModule;
}

const stagingCalls = (s: Stub, method: string) =>
  s.calls.filter((c) => c.model === "dodoPayoutStaging" && c.method === method);

// ════════════════════════════════════════════════════════════════════════════
// Behavioural — the REAL engine over absent-key rows
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-1236 generateGstInvoice — staging rows with an ABSENT consumedByInvoiceId", () => {
  let originalLut: string | undefined;

  before(() => {
    originalLut = process.env.GST_LUT_ARN;
  });
  beforeEach(() => {
    process.env.GST_LUT_ARN = "AD0726-TESTARN";
  });
  after(() => {
    if (originalLut === undefined) delete process.env.GST_LUT_ARN;
    else process.env.GST_LUT_ARN = originalLut;
    restoreCache();
  });

  const generate = (engine: EngineModule) =>
    engine.generateGstInvoice({
      billingPeriodStart: PERIOD_START,
      billingPeriodEnd: PERIOD_END,
      currency: "USD",
      generatedBy: "admin_1",
    });

  it("aggregates rows written WITHOUT the key — the shape stageDodoRows produced", async () => {
    const stub = makePrisma([
      absentKeyRow({ id: "stg_1", netAmount: 90 }),
      absentKeyRow({
        id: "stg_2",
        netAmount: 60,
        grossAmount: 70,
        feesAmount: 10,
      }),
    ]);
    const engine = loadEngine(stub);
    const result = await generate(engine);

    assert.equal(result.kind, "invoice");
    const created = stub.calls.find(
      (c) => c.model === "gstInvoice" && c.method === "create"
    );
    assert.ok(created, "expected an invoice insert, not NoPendingPayoutsError");
    const data = created.args.data as Record<string, unknown>;
    assert.equal(data.subtotalForeign, 150, "both absent-key rows summed");
    assert.equal(data.subtotalInr, 12525, "150 * 83.5");
  });

  it("claims those rows, so the concurrency guard does NOT cancel the invoice", async () => {
    // Pre-fix, the read widened but the claim stayed `{consumedByInvoiceId: null}`
    // would match ZERO rows → claim.count !== rowIds.length → the engine cancels
    // the invoice it just issued and burns an audited UMAI number, every run.
    const stub = makePrisma([
      absentKeyRow({ id: "stg_1" }),
      absentKeyRow({ id: "stg_2" }),
    ]);
    const engine = loadEngine(stub);
    const result = await generate(engine);

    assert.equal(result.kind, "invoice");
    const claim = stagingCalls(stub, "updateMany")[0];
    assert.ok(claim, "expected the claim updateMany");
    assert.equal(
      (claim.args.data as Record<string, unknown>).consumedByInvoiceId,
      "inv_new"
    );
    const cancels = stub.calls.filter(
      (c) => c.model === "gstInvoice" && c.method === "update"
    );
    assert.equal(cancels.length, 0, "no phantom race-cancel");
    // And the rows really flipped in the double's store.
    assert.deepEqual(
      stub.rows.map((r) => r.consumedByInvoiceId),
      ["inv_new", "inv_new"]
    );
  });

  it("samples the customer country from an absent-key row (snapshot query stays in lockstep)", async () => {
    const stub = makePrisma([absentKeyRow({ customerCountry: "GB" })]);
    const engine = loadEngine(stub);
    await generate(engine);

    const data = stub.calls.find(
      (c) => c.model === "gstInvoice" && c.method === "create"
    )!.args.data as Record<string, unknown>;
    assert.equal(
      data.customerCountry,
      "GB",
      "a narrower findFirst would fall back to the 'ZZ' sentinel"
    );
  });

  it("includes an EXPLICIT-null row too (written by the zero-net / release paths)", async () => {
    const stub = makePrisma([
      absentKeyRow({ id: "stg_absent", netAmount: 40 }),
      {
        ...absentKeyRow({ id: "stg_null", netAmount: 60 }),
        consumedByInvoiceId: null,
      },
    ]);
    const engine = loadEngine(stub);
    await generate(engine);

    const data = stub.calls.find(
      (c) => c.model === "gstInvoice" && c.method === "create"
    )!.args.data as Record<string, unknown>;
    assert.equal(data.subtotalForeign, 100, "both OR arms contribute");
  });

  it("still EXCLUDES rows already consumed by an invoice", async () => {
    const stub = makePrisma([
      absentKeyRow({ id: "stg_open", netAmount: 40 }),
      {
        ...absentKeyRow({ id: "stg_done", netAmount: 999 }),
        consumedByInvoiceId: "inv_previous",
      },
    ]);
    const engine = loadEngine(stub);
    await generate(engine);

    const data = stub.calls.find(
      (c) => c.model === "gstInvoice" && c.method === "create"
    )!.args.data as Record<string, unknown>;
    assert.equal(
      data.subtotalForeign,
      40,
      "widening must not re-invoice a consumed row"
    );
  });

  it("[control] the PRE-FIX predicate matches none of these rows in the double", () => {
    // Guards the double itself. If `matchesCondition` ever collapsed absent into
    // null (raw-Mongo semantics), every case above would pass for the wrong
    // reason and this suite would stop protecting anything.
    const absent = absentKeyRow();
    const explicitNull = { ...absentKeyRow(), consumedByInvoiceId: null };

    assert.equal(
      matchesWhere({ consumedByInvoiceId: null }, absent),
      false,
      "Prisma-on-Mongo: a bare null does NOT reach an absent key"
    );
    assert.equal(
      matchesWhere({ consumedByInvoiceId: null }, explicitNull),
      true
    );
    assert.equal(
      matchesWhere({ consumedByInvoiceId: { not: null } }, absent),
      false,
      "`not: null` does not reach it either — the mirror-image trap"
    );
    assert.equal(
      matchesWhere(
        {
          OR: [
            { consumedByInvoiceId: null },
            { consumedByInvoiceId: { isSet: false } },
          ],
        },
        absent
      ),
      true,
      "only the isSet arm reaches an absent key"
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Source assertions — the query SHAPE at every site
// ════════════════════════════════════════════════════════════════════════════

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ENGINE_SRC = path.join(
  REPO_ROOT,
  "packages/services/src/gst/invoice-engine.service.ts"
);
const STAGING_SRC = path.join(
  REPO_ROOT,
  "packages/services/src/gst/staging.service.ts"
);
const ADMIN_SRC = path.join(REPO_ROOT, "apps/admin/lib/actions/gst.ts");

/**
 * MONEY-1143 — strip LINE comments BEFORE block comments. Reversed, the block
 * pass removes a `/* … *\/` first and the line pass then matches our OWN prose,
 * so an assertion "the file contains `isSet: false`" would be satisfied by the
 * COMMENT explaining the fix rather than by the code implementing it. The
 * comments in all three files below genuinely contain that literal, so this is
 * load-bearing here, not ceremonial — `stripComments` is itself asserted below.
 */
function stripComments(src: string): string {
  const noLine = src.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  return noLine.replace(/\/\*[\s\S]*?\*\//g, "");
}

function count(src: string, re: RegExp): number {
  return src.match(re)?.length ?? 0;
}

describe("MONEY-1236 [src] — every staging read carries the isSet arm", () => {
  it("[meta] stripComments actually removes the prose that mentions isSet", () => {
    const raw = readFileSync(ENGINE_SRC, "utf8");
    const stripped = stripComments(raw);
    const rawHits = count(raw, /isSet/g);
    const strippedHits = count(stripped, /isSet/g);
    assert.ok(
      rawHits > strippedHits,
      "comments mentioning isSet must be removed"
    );
    assert.ok(
      strippedHits >= 1,
      "…but the CODE must still carry at least one isSet"
    );
  });

  it("invoice-engine.service.ts routes all four staging predicates through UNCONSUMED_STAGING_OR", () => {
    const src = stripComments(readFileSync(ENGINE_SRC, "utf8"));
    assert.match(
      src,
      /UNCONSUMED_STAGING_OR[\s\S]*?\{\s*consumedByInvoiceId:\s*null\s*\}[\s\S]*?\{\s*consumedByInvoiceId:\s*\{\s*isSet:\s*false\s*\}\s*\}/,
      "the constant must declare BOTH arms"
    );
    assert.equal(
      count(src, /OR:\s*UNCONSUMED_STAGING_OR/g),
      4,
      "aggregate + customer-snapshot + zero-net guard + claim = 4 sites; a " +
        "half-fixed predicate is how MONEY-1234's second broken pipe hid"
    );
  });

  it("no bare `consumedByInvoiceId: null` survives in a READ position", () => {
    const src = stripComments(readFileSync(ENGINE_SRC, "utf8"));
    // Three bare-null occurrences are legitimate and must NOT be flagged:
    //   1. the first arm of UNCONSUMED_STAGING_OR itself;
    //   2+3. two WRITES (`data: {…}`) — the zero-net stamp and the race release.
    // Writing an explicit null MATERIALISES the key, which is the point. A bare
    // null under a `where:` is the bug, so classify each hit by whichever of
    // `where:` / `data:` most recently precedes it rather than by block-scanning
    // (a greedy block regex swallows the where AND the data that follows it).
    const constStart = src.indexOf("UNCONSUMED_STAGING_OR: Prisma");
    assert.ok(constStart > -1, "constant declaration not found");
    const constEnd = src.indexOf("];", constStart);
    assert.ok(constEnd > constStart, "constant declaration not terminated");

    const re = /consumedByInvoiceId:\s*null/g;
    let hits = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      hits++;
      if (m.index > constStart && m.index < constEnd) continue; // the OR arm
      const before = src.slice(0, m.index);
      const lastData = before.lastIndexOf("data:");
      const lastWhere = before.lastIndexOf("where:");
      assert.ok(
        lastData > lastWhere,
        `bare null in a READ position at offset ${m.index} — Prisma-on-Mongo ` +
          "cannot see an absent key with this spelling"
      );
    }
    assert.equal(hits, 3, "1 OR arm + 2 deliberate writes");
  });

  it("staging.service.ts materialises consumedByInvoiceId at ingest", () => {
    const src = stripComments(readFileSync(STAGING_SRC, "utf8"));
    assert.match(
      src,
      /consumedByInvoiceId:\s*null/,
      "new rows must carry the key so the naive filter is not silently wrong"
    );
  });

  it("apps/admin listPendingPayoutGroupsAction carries both arms", () => {
    const src = stripComments(readFileSync(ADMIN_SRC, "utf8"));
    assert.match(
      src,
      /OR:\s*\[[\s\S]*?\{\s*consumedByInvoiceId:\s*null\s*\}[\s\S]*?\{\s*consumedByInvoiceId:\s*\{\s*isSet:\s*false\s*\}\s*\}[\s\S]*?\]/,
      "the admin 'pending payouts' drawer is a SECOND copy of the predicate " +
        "(it cannot import the constant — @usemoney/services only exposes the " +
        "gst barrel), so it is pinned here against drift"
    );
  });
});
