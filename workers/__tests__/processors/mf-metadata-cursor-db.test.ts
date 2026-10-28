/**
 * MF metadata cursor — SEMANTIC proof against a real MongoDB (MONEY-1205).
 *
 * Source: workers/src/processors/mf-metadata-sync-logic.ts#buildMfMetadataWhere
 *
 * ## Why this test has to touch a server
 *
 * The defect is a MongoDB matching rule, not a shape: **Prisma's
 * `{ field: null }` matches an explicitly stored `null` but NOT a document
 * where the field is entirely ABSENT.** No pure unit test can catch that — a
 * unit test can only assert the object we build, and the old object looked
 * perfectly reasonable. It took a real matcher to show that
 * `{ metadataSyncedAt: null }` selected 7,263 of 14,223 prod rows and missed the
 * 6,960 that had never been touched.
 *
 * So this fixture creates **two documents that differ only in that respect** —
 * one with `metadataSyncedAt` absent, one with an explicit `null` — and asserts
 * the REAL exported WHERE clause selects BOTH. It also runs the OLD clause and
 * asserts it selects only ONE, so the mutation proof travels with the test.
 *
 * ## Running it
 *
 * Env-gated, like `tests/integration/db/**`:
 *
 * ```bash
 * RUN_INTEGRATION_TESTS=true DATABASE_URL="<qa-or-local-mongo>" \
 *   yarn workspace @usemoney/workers test
 * ```
 *
 * Writes are confined to sentinel scheme codes prefixed `ZZTEST-MONEY1205-` and
 * removed in `after()`, including on failure.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  buildMfMetadataWhere,
  computeStaleDate,
} from "../../src/processors/mf-metadata-sync-logic";

const ENABLED = Boolean(
  process.env.RUN_INTEGRATION_TESTS && process.env.DATABASE_URL,
);

const PREFIX = "ZZTEST-MONEY1205-";
const CODE_ABSENT = `${PREFIX}ABSENT`;
const CODE_NULL = `${PREFIX}NULL`;
const CODE_FRESH = `${PREFIX}FRESH`;

if (!ENABLED) {
  describe("Integration: MF metadata cursor (skipped)", () => {
    it("skipped — set RUN_INTEGRATION_TESTS=true and DATABASE_URL to run", () => {
      // Deliberately not silent: the structural half of this proof lives in
      // mf-metadata-sync-logic.test.ts and DOES run everywhere. This file adds
      // the semantic half, which needs a MongoDB server that CI does not have.
      assert.ok(true);
    });
  });
} else {
  describe("Integration: MF metadata cursor selects ABSENT and NULL alike", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let prisma: any;

    before(async () => {
      const { PrismaClient } = await import("@prisma/client");
      prisma = new PrismaClient();

      await cleanup();

      const base = {
        schemeName: "MONEY-1205 cursor fixture",
        amcName: "Test AMC",
        category: "Flexi Cap",
        nav: 10,
        navDate: new Date("2026-08-18T00:00:00Z"),
        isActive: true,
        isinGrowth: "INFTEST0000001",
      };

      // (1) metadataSyncedAt ABSENT — Prisma omits unset optional fields on
      //     MongoDB, which is exactly how the 6,960 prod rows came to be.
      await prisma.mutualFundMaster.create({
        data: { ...base, schemeCode: CODE_ABSENT },
      });

      // (2) metadataSyncedAt EXPLICIT NULL — set through a raw command, because
      //     Prisma will not write a literal null for an unset optional field.
      await prisma.mutualFundMaster.create({
        data: { ...base, schemeCode: CODE_NULL },
      });
      await prisma.$runCommandRaw({
        update: "mutual_fund_masters",
        updates: [
          {
            q: { schemeCode: CODE_NULL },
            u: { $set: { metadataSyncedAt: null } },
          },
        ],
      });

      // (3) A FRESH row that must NOT be selected — proves the clause is not
      //     simply matching everything.
      await prisma.mutualFundMaster.create({
        data: { ...base, schemeCode: CODE_FRESH, metadataSyncedAt: new Date() },
      });
    });

    after(async () => {
      try {
        await cleanup();
      } finally {
        await prisma?.$disconnect?.();
      }
    });

    async function cleanup(): Promise<void> {
      await prisma.mutualFundMaster.deleteMany({
        where: { schemeCode: { startsWith: PREFIX } },
      });
    }

    it("the fixture really does store the two shapes differently", async () => {
      const res = (await prisma.$runCommandRaw({
        aggregate: "mutual_fund_masters",
        pipeline: [
          { $match: { schemeCode: { $in: [CODE_ABSENT, CODE_NULL] } } },
          {
            $project: {
              schemeCode: 1,
              t: { $type: "$metadataSyncedAt" },
            },
          },
        ],
        cursor: {},
      })) as { cursor: { firstBatch: Array<{ schemeCode: string; t: string }> } };

      const byCode = new Map(res.cursor.firstBatch.map((r) => [r.schemeCode, r.t]));
      assert.equal(byCode.get(CODE_ABSENT), "missing", "row 1 must have NO key");
      assert.equal(byCode.get(CODE_NULL), "null", "row 2 must store an explicit null");
    });

    it("THE FIX: the real WHERE clause selects BOTH", async () => {
      const rows = await prisma.mutualFundMaster.findMany({
        where: {
          AND: [
            buildMfMetadataWhere(false, computeStaleDate()),
            { schemeCode: { startsWith: PREFIX } },
          ],
        },
        select: { schemeCode: true },
      });
      const codes = new Set(rows.map((r: { schemeCode: string }) => r.schemeCode));

      assert.ok(
        codes.has(CODE_ABSENT),
        "an ABSENT metadataSyncedAt must be selected — this is the 6,960-row backlog",
      );
      assert.ok(codes.has(CODE_NULL), "an explicit null must be selected too");
      assert.ok(!codes.has(CODE_FRESH), "a freshly-synced row must NOT be selected");
    });

    it("MUTATION PROOF: the OLD clause misses the ABSENT row", async () => {
      // This is verbatim the shipped predicate before MONEY-1205.
      const oldWhere = {
        isActive: true,
        OR: [
          { metadataSyncedAt: null },
          { metadataSyncedAt: { lt: computeStaleDate() } },
        ],
      };
      const rows = await prisma.mutualFundMaster.findMany({
        where: { AND: [oldWhere, { schemeCode: { startsWith: PREFIX } }] },
        select: { schemeCode: true },
      });
      const codes = new Set(rows.map((r: { schemeCode: string }) => r.schemeCode));

      assert.ok(
        !codes.has(CODE_ABSENT),
        "if this ever starts matching, Prisma changed its Mongo null semantics " +
          "and the isSet:false branch can be revisited",
      );
      assert.ok(codes.has(CODE_NULL), "the old clause did match an explicit null");
    });
  });
}
