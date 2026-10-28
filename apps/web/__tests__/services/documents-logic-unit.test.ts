/**
 * MONEY-620 — documents-logic pure helpers (REAL exported logic).
 *
 * Asserts the ACTUAL helpers that `documents.service.ts` CALLS — imported
 * straight from their pure source, no inline copy, no shadow. The module imports
 * nothing server-only (no prisma / redis / socket at load), so this file stays
 * pure and exits clean.
 *
 * Covers:
 *   - clampDocumentPagination — NaN/negative/huge limit|skip → safe Prisma bounds
 *     (mirrors the notifications clampPagination 500-guard; a future apps/api
 *     `/v1/documents` route forwards raw ?skip=/?limit= straight into the service).
 *   - documentScopeWhere — the IDOR scope clause carries BOTH id AND userId.
 *   - buildDocumentListWhere — userId + isDeleted pin, optional filters, blank
 *     search ignored (no all-matching empty OR).
 *   - deriveDocumentStatus — READY⇒downloadable; PENDING/PROCESSING/FAILED and any
 *     unknown/null status ⇒ NOT downloadable (fail-closed).
 *
 * Source: packages/services/src/documents-logic.ts
 *         (called by packages/services/src/documents.service.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampDocumentPagination,
  DEFAULT_DOCUMENT_LIMIT,
  MAX_DOCUMENT_LIMIT,
  documentScopeWhere,
  buildDocumentListWhere,
  deriveDocumentStatus,
} from "../../../../packages/services/src/documents-logic";

describe("MONEY-620 — clampDocumentPagination (REAL service export)", () => {
  it("DEFAULT is 20 and MAX is 100", () => {
    assert.equal(DEFAULT_DOCUMENT_LIMIT, 20);
    assert.equal(MAX_DOCUMENT_LIMIT, 100);
  });

  describe("happy path", () => {
    it("passes a normal (limit, skip) pair through unchanged", () => {
      assert.deepEqual(clampDocumentPagination(25, 50), {
        take: 25,
        skip: 50,
      });
    });

    it("defaults to DEFAULT limit / skip 0 when called with no args", () => {
      assert.deepEqual(clampDocumentPagination(), {
        take: DEFAULT_DOCUMENT_LIMIT,
        skip: 0,
      });
    });

    it("allows exactly MAX and a large valid skip", () => {
      assert.equal(clampDocumentPagination(MAX_DOCUMENT_LIMIT).take, 100);
      assert.equal(clampDocumentPagination(20, 100_000).skip, 100_000);
    });
  });

  describe("limit — upper bound", () => {
    it("caps an over-MAX limit to MAX (payload guard)", () => {
      assert.equal(
        clampDocumentPagination(99_999_999).take,
        MAX_DOCUMENT_LIMIT
      );
      assert.equal(
        clampDocumentPagination(Number.MAX_SAFE_INTEGER).take,
        MAX_DOCUMENT_LIMIT
      );
    });
  });

  describe("limit — invalid / lower → DEFAULT", () => {
    it("zero / negative / NaN / Infinity → DEFAULT (never a bad take)", () => {
      assert.equal(clampDocumentPagination(0).take, DEFAULT_DOCUMENT_LIMIT);
      assert.equal(clampDocumentPagination(-5).take, DEFAULT_DOCUMENT_LIMIT);
      assert.equal(clampDocumentPagination(NaN).take, DEFAULT_DOCUMENT_LIMIT);
      assert.equal(
        clampDocumentPagination(Infinity).take,
        DEFAULT_DOCUMENT_LIMIT
      );
      assert.equal(
        clampDocumentPagination(-Infinity).take,
        DEFAULT_DOCUMENT_LIMIT
      );
    });

    it("non-number limit (string '20' from query) → DEFAULT", () => {
      // The exact apps/api hazard: parseInt failures arrive as NaN, but a
      // raw string would also bypass the schema if forwarded — both → DEFAULT.
      assert.equal(
        clampDocumentPagination("20" as unknown as number).take,
        DEFAULT_DOCUMENT_LIMIT
      );
      assert.equal(
        clampDocumentPagination(null as unknown as number).take,
        DEFAULT_DOCUMENT_LIMIT
      );
    });

    it("truncates a fractional limit toward zero", () => {
      assert.equal(clampDocumentPagination(7.9).take, 7);
      assert.equal(clampDocumentPagination(0.4).take, DEFAULT_DOCUMENT_LIMIT);
    });
  });

  describe("skip — invalid / negative → 0", () => {
    it("negative / NaN / Infinity / non-number skip → 0", () => {
      assert.equal(clampDocumentPagination(20, -1).skip, 0);
      assert.equal(clampDocumentPagination(20, -99_999).skip, 0);
      assert.equal(clampDocumentPagination(20, NaN).skip, 0);
      assert.equal(clampDocumentPagination(20, Infinity).skip, 0);
      assert.equal(
        clampDocumentPagination(20, "30" as unknown as number).skip,
        0
      );
    });

    it("truncates a fractional skip toward zero", () => {
      assert.equal(clampDocumentPagination(20, 30.9).skip, 30);
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
      it(`(${String(l)}, ${String(s)}) → finite take in [1,MAX], skip ≥ 0`, () => {
        const { take, skip } = clampDocumentPagination(l, s);
        assert.ok(
          Number.isInteger(take) && take >= 1 && take <= MAX_DOCUMENT_LIMIT
        );
        assert.ok(Number.isInteger(skip) && skip >= 0);
      });
    }
  });
});

describe("MONEY-620 — documentScopeWhere (IDOR scope, REAL export)", () => {
  it("carries BOTH the document id AND the caller userId (and isDeleted:false)", () => {
    const where = documentScopeWhere("doc-1", "user-A");
    assert.equal(where.id, "doc-1");
    assert.equal(where.userId, "user-A");
    assert.equal(where.isDeleted, false);
  });

  it("a different user produces a different (non-matching) scope for the same id", () => {
    const a = documentScopeWhere("doc-1", "user-A");
    const b = documentScopeWhere("doc-1", "user-B");
    // Same id, different userId → the where-clauses must differ so user B can
    // never match user A's row. This is the property that defeats IDOR.
    assert.notDeepEqual(a, b);
    assert.equal(a.userId, "user-A");
    assert.equal(b.userId, "user-B");
  });
});

describe("MONEY-620 — buildDocumentListWhere (REAL export)", () => {
  it("always pins userId + isDeleted:false (per-user scope, hides soft-deleted)", () => {
    const where = buildDocumentListWhere("user-1");
    assert.equal(where.userId, "user-1");
    assert.equal(where.isDeleted, false);
    assert.equal(where.OR, undefined);
  });

  it("layers optional category and sourceType equality", () => {
    const where = buildDocumentListWhere("user-1", {
      category: "TAX_REPORT",
      sourceType: "GENERATED",
    });
    assert.equal(where.category, "TAX_REPORT");
    assert.equal(where.sourceType, "GENERATED");
  });

  it("builds a case-insensitive title/fileName search OR", () => {
    const where = buildDocumentListWhere("user-1", { search: "report" });
    assert.deepEqual(where.OR, [
      { title: { contains: "report", mode: "insensitive" } },
      { fileName: { contains: "report", mode: "insensitive" } },
    ]);
  });

  it("ignores a blank / whitespace-only search (no all-matching empty OR)", () => {
    assert.equal(
      buildDocumentListWhere("user-1", { search: "" }).OR,
      undefined
    );
    assert.equal(
      buildDocumentListWhere("user-1", { search: "   " }).OR,
      undefined
    );
  });

  it("never lets a filter overwrite the userId/isDeleted pins", () => {
    // category/sourceType are scalar fields and can't clobber userId; assert the
    // scope survives alongside every optional filter.
    const where = buildDocumentListWhere("owner", {
      category: "OTHER",
      sourceType: "UPLOAD",
      search: "q",
    });
    assert.equal(where.userId, "owner");
    assert.equal(where.isDeleted, false);
  });
});

describe("MONEY-620 — deriveDocumentStatus (download gate, REAL export)", () => {
  it("READY ⇒ downloadable", () => {
    const s = deriveDocumentStatus("READY");
    assert.equal(s.readiness, "ready");
    assert.equal(s.canDownload, true);
    assert.equal(s.isProcessing, false);
    assert.equal(s.isFailed, false);
  });

  it("PENDING / PROCESSING ⇒ NOT downloadable, in-flight", () => {
    for (const st of ["PENDING", "PROCESSING"]) {
      const s = deriveDocumentStatus(st);
      assert.equal(s.canDownload, false, `${st} not downloadable`);
      assert.equal(s.isProcessing, true, `${st} processing`);
      assert.equal(s.readiness, "processing");
    }
  });

  it("FAILED ⇒ NOT downloadable, failed", () => {
    const s = deriveDocumentStatus("FAILED");
    assert.equal(s.canDownload, false);
    assert.equal(s.isFailed, true);
    assert.equal(s.readiness, "failed");
  });

  it("unknown / null / undefined / garbage status ⇒ NOT downloadable (fail-closed)", () => {
    for (const st of [
      null,
      undefined,
      "",
      "READYish",
      "deleted",
      "  READY  ",
    ]) {
      const s = deriveDocumentStatus(st as string | null | undefined);
      assert.equal(
        s.canDownload,
        false,
        `status ${JSON.stringify(st)} must NOT be downloadable`
      );
      assert.equal(s.readiness, "unknown");
    }
  });
});
