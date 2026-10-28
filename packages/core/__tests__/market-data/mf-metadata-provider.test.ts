/**
 * MF metadata provider seam + absence rules — REAL exports (MONEY-1205).
 *
 * Source: packages/core/src/market-data/instruments/mf-metadata-provider.ts
 *
 * What this pins:
 *   - the absence rules (`""`/`-`/blank => null, a real 0 SURVIVES);
 *   - `countMfMetadataFields` / `buildMfMetadataUpdate` — the zero-field guard's
 *     numerator and the "null never overwrites" write shape;
 *   - `decideMfEnrichAction` — the cursor decision `enrichMfMetadata` CALLS
 *     (not a mirror of it): 0 fields must NEVER stamp a success marker, and a
 *     deterministic failure MUST still advance the cursor;
 *   - the registry: it ships EMPTY (MONEY-1409 deleted the built-in Kuvera
 *     default), so with nothing registered `getMfMetadataProvider()` is null —
 *     including when MF_METADATA_PROVIDER names the deleted provider — and
 *     `enrichMfMetadata` short-circuits WITHOUT touching the database.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  mfTextOrNull,
  mfNumberOrNull,
  mfDateOrNull,
  emptyMfMetadata,
  countMfMetadataFields,
  buildMfMetadataUpdate,
  decideMfEnrichAction,
  getMfMetadataProvider,
  setMfMetadataProviderForTests,
  registerMfMetadataProvider,
  enrichMfMetadata,
  MF_METADATA_FIELD_KEYS,
  MF_METADATA_ATTEMPT_SOURCE,
  type MfMetadataProvider,
  type MfMetadataFields,
} from "../../src/market-data/instruments/mf-metadata-provider";
import { AMFI_METADATA_PROVIDER_ID } from "../../src/market-data/instruments/amfi-fund-metadata-provider";

// ══════════════════════════════════════════════════════════════════════
// Absence rules — "" / "-" / blank => null, NEVER 0; and 0 => 0
// ══════════════════════════════════════════════════════════════════════

describe("mfTextOrNull (real export)", () => {
  it("maps blank sentinels to null", () => {
    for (const blank of [
      "",
      "   ",
      "-",
      "--",
      "N/A",
      "n/a",
      "NA",
      "null",
      "nil",
    ]) {
      assert.equal(
        mfTextOrNull(blank),
        null,
        `expected null for ${JSON.stringify(blank)}`,
      );
    }
  });

  it("keeps real text verbatim (trimmed)", () => {
    assert.equal(mfTextOrNull("  Prashant Jain  "), "Prashant Jain");
    assert.equal(mfTextOrNull("1% if redeemed <365d"), "1% if redeemed <365d");
  });

  it("returns null for non-string, non-number inputs", () => {
    assert.equal(mfTextOrNull(null), null);
    assert.equal(mfTextOrNull(undefined), null);
    assert.equal(mfTextOrNull({}), null);
  });
});

describe("mfNumberOrNull (real export) — the defect-5 rule, in reverse", () => {
  it("PRESERVES a real 0 (the bug: `parseFloat(x) || null` nulled it)", () => {
    // Index and direct plans genuinely publish a 0 expense ratio. Mapping that
    // to null says "we don't know" about a number we were told exactly.
    assert.equal(mfNumberOrNull(0), 0);
    assert.equal(mfNumberOrNull("0"), 0);
    assert.equal(mfNumberOrNull("0.00"), 0);
    assert.equal(mfNumberOrNull("0%"), 0);
  });

  it("maps blank sentinels to null (never 0)", () => {
    for (const blank of ["", "  ", "-", "N/A", "nil"]) {
      assert.equal(mfNumberOrNull(blank), null);
    }
  });

  it("parses ordinary numbers, percents and grouped digits", () => {
    assert.equal(mfNumberOrNull("1.25"), 1.25);
    assert.equal(mfNumberOrNull("1.25%"), 1.25);
    assert.equal(mfNumberOrNull("12,345.6"), 12345.6);
    assert.equal(mfNumberOrNull("-3.5"), -3.5);
  });

  it("rejects garbage and non-finite values rather than coercing", () => {
    assert.equal(mfNumberOrNull("abc"), null);
    assert.equal(mfNumberOrNull("1.2.3"), null);
    assert.equal(mfNumberOrNull(Number.NaN), null);
    assert.equal(mfNumberOrNull(Number.POSITIVE_INFINITY), null);
  });
});

describe("mfDateOrNull (real export)", () => {
  it("parses an ISO date and rejects blanks/garbage", () => {
    assert.equal(
      mfDateOrNull("2024-02-15")?.toISOString().slice(0, 10),
      "2024-02-15",
    );
    assert.equal(mfDateOrNull(""), null);
    assert.equal(mfDateOrNull("-"), null);
    assert.equal(mfDateOrNull("not a date"), null);
    assert.equal(mfDateOrNull(new Date("nope")), null);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Field accounting — the zero-field guard's numerator
// ══════════════════════════════════════════════════════════════════════

describe("countMfMetadataFields (real export)", () => {
  it("is 0 for an all-null field set — the guard's trigger", () => {
    assert.equal(countMfMetadataFields(emptyMfMetadata()), 0);
  });

  it("counts a REAL ZERO as extracted (0 is data, not absence)", () => {
    const f = emptyMfMetadata();
    f.expenseRatio = 0;
    assert.equal(countMfMetadataFields(f), 1);
  });

  it("counts every writable key", () => {
    const f = emptyMfMetadata();
    for (const k of MF_METADATA_FIELD_KEYS) {
      // Assign a type-appropriate non-null value.
      // Through `unknown`: MfMetadataFields is a closed shape, so TS treats a
      // direct cast to an open index signature as a probable mistake. The cast
      // is deliberate — this loop assigns by key name to prove every field is
      // covered — so it says so explicitly.
      (f as unknown as Record<string, unknown>)[k] =
        k === "launchDate"
          ? new Date("2024-02-15")
          : typeof f[k] === "string"
            ? "x"
            : 1;
    }
    assert.equal(countMfMetadataFields(f), MF_METADATA_FIELD_KEYS.length);
    assert.equal(MF_METADATA_FIELD_KEYS.length, 14);
  });
});

describe("buildMfMetadataUpdate (real export)", () => {
  it("omits nulls so a partial source cannot erase another source's data", () => {
    const f = emptyMfMetadata();
    f.aum = 1234;
    const patch = buildMfMetadataUpdate(f);
    assert.deepEqual(patch, { aum: 1234 });
    assert.equal("fundManager" in patch, false);
    assert.equal("crisilRating" in patch, false);
  });

  it("INCLUDES a real 0 in the patch", () => {
    const f = emptyMfMetadata();
    f.expenseRatio = 0;
    assert.deepEqual(buildMfMetadataUpdate(f), { expenseRatio: 0 });
  });

  it("is empty for an all-null field set", () => {
    assert.deepEqual(buildMfMetadataUpdate(emptyMfMetadata()), {});
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE CURSOR DECISION — decideMfEnrichAction (called by enrichMfMetadata)
// ══════════════════════════════════════════════════════════════════════

describe("decideMfEnrichAction (real export)", () => {
  it("0 fields extracted => mark-attempted, NEVER a success marker", () => {
    const d = decideMfEnrichAction({ status: "ok", fields: emptyMfMetadata() });
    assert.equal(d.action, "mark-attempted");
    assert.equal(d.reason, "no-fields");
    assert.equal(d.fieldsExtracted, 0);
    assert.notEqual(
      d.action,
      "write-fields",
      "an all-null provider result must never claim a source",
    );
  });

  it(">= 1 field => write-fields with the provider's id", () => {
    const fields: MfMetadataFields = { ...emptyMfMetadata(), aum: 100 };
    const d = decideMfEnrichAction({ status: "ok", fields });
    assert.equal(d.action, "write-fields");
    assert.equal(d.reason, "enriched");
    assert.equal(d.fieldsExtracted, 1);
  });

  it("a real 0 counts as a field and DOES write", () => {
    const fields: MfMetadataFields = { ...emptyMfMetadata(), expenseRatio: 0 };
    const d = decideMfEnrichAction({ status: "ok", fields });
    assert.equal(d.action, "write-fields");
    assert.equal(d.fieldsExtracted, 1);
  });

  it("FAILED ENRICH ADVANCES THE CURSOR: 404 from the provider marks the row", () => {
    // This is defect 2. The old code returned enriched:false and wrote NOTHING,
    // so `orderBy metadataSyncedAt asc, take 500` re-picked the same oldest 500
    // rows every Sunday, forever.
    const d = decideMfEnrichAction({ status: "not-found" });
    assert.equal(d.action, "mark-attempted");
    assert.equal(d.reason, "not-found-upstream");
    assert.equal(d.attempted, true);
  });

  it("a fund with no ISIN also advances the cursor", () => {
    const d = decideMfEnrichAction({ status: "no-isin" });
    assert.equal(d.action, "mark-attempted");
    assert.equal(d.reason, "no-isin");
    assert.equal(d.attempted, false, "we never reached the provider");
  });

  it("a TRANSIENT provider failure does NOT mark (retry it next run)", () => {
    const d = decideMfEnrichAction({
      status: "unavailable",
      error: "ETIMEDOUT",
    });
    assert.equal(d.action, "no-write");
    assert.equal(d.reason, "provider-unavailable");
    assert.equal(
      d.attempted,
      true,
      "counted against the provider, not our data",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Registry — EMPTY by default; a provider must register itself
// ══════════════════════════════════════════════════════════════════════

describe("provider registry (real exports)", () => {
  const prevEnv = process.env.MF_METADATA_PROVIDER;

  beforeEach(() => {
    setMfMetadataProviderForTests(null);
    delete process.env.MF_METADATA_PROVIDER;
  });

  afterEach(() => {
    setMfMetadataProviderForTests(null);
    if (prevEnv === undefined) delete process.env.MF_METADATA_PROVIDER;
    else process.env.MF_METADATA_PROVIDER = prevEnv;
  });

  it("returns null when nothing is configured — a first-class state", () => {
    assert.equal(getMfMetadataProvider(), null);
  });

  it("MF_METADATA_PROVIDER=kuvera selects NOTHING (MONEY-1409)", () => {
    // The dead captnemo/Kuvera provider was this module's built-in default, so
    // naming it in the env used to select a guaranteed-doomed upstream. It is
    // deleted; naming it now has to reach the SAME refusal as naming nothing,
    // rather than half-selecting a provider that answers 404 for every ISIN.
    process.env.MF_METADATA_PROVIDER = "kuvera";
    assert.equal(
      getMfMetadataProvider(),
      null,
      "no built-in provider may be seeded into the registry",
    );
  });

  it("a registered provider that reports configured wins (the W3-C seam)", () => {
    const amfi: MfMetadataProvider = {
      id: "amfi-ter",
      isConfigured: () => true,
      fetch: async () => ({ status: "ok", fields: emptyMfMetadata() }),
    };
    registerMfMetadataProvider(amfi);
    try {
      assert.equal(getMfMetadataProvider()?.id, "amfi-ter");
    } finally {
      // Re-register a disabled stand-in so later tests see a clean registry.
      registerMfMetadataProvider({ ...amfi, isConfigured: () => false });
    }
  });
});

describe("enrichMfMetadata with NO provider (real export)", () => {
  const prevEnv = process.env.MF_METADATA_PROVIDER;

  beforeEach(() => {
    setMfMetadataProviderForTests(null);
    delete process.env.MF_METADATA_PROVIDER;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.MF_METADATA_PROVIDER;
    else process.env.MF_METADATA_PROVIDER = prevEnv;
  });

  it("short-circuits BEFORE any database or network call (defect 6)", async () => {
    // The MF detail page fires this fire-and-forget on every stale page view.
    // With no provider it must be free — no 30s timeout x 3 retries, and no DB
    // read either. If it touched Prisma this would hang or throw with no
    // DATABASE_URL, so completing fast IS the assertion.
    const before = Date.now();
    const res = await enrichMfMetadata("120503");
    const elapsed = Date.now() - before;

    assert.equal(res.enriched, false);
    assert.equal(res.reason, "provider-unconfigured");
    assert.equal(res.source, null);
    assert.equal(res.attempted, false);
    assert.equal(res.marked, false);
    assert.equal(res.fieldsExtracted, 0);
    assert.ok(
      elapsed < 1000,
      `expected an immediate return, took ${elapsed}ms`,
    );
  });
});

describe("attempt marker literal", () => {
  it('is "none" — the same value the seed script already wrote', () => {
    // 7,263 prod rows already carry metadataSource:"none". Introducing a second
    // spelling would split one meaning across two values.
    assert.equal(MF_METADATA_ATTEMPT_SOURCE, "none");
    assert.notEqual(
      MF_METADATA_ATTEMPT_SOURCE,
      AMFI_METADATA_PROVIDER_ID,
      "the attempt marker must never be mistakable for a success marker",
    );
  });
});
