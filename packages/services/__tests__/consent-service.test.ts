/**
 * consent.service + consent-logic — REAL exports, injected prisma (MONEY-402/505).
 *
 * Pins the SEBI IA Reg 18(9) consent-ledger contract:
 *   - status/record/list are all scoped to the caller's userId + kind
 *     AI_ADVISORY at the CURRENT version,
 *   - recording is idempotent per version (an existing record → no second
 *     create),
 *   - the source is normalised (default broker_connect, capped),
 *   - the exportable ledger is newest-first,
 *   - a thrown query fails closed to a sanitised error.
 *
 * Source: packages/services/src/consent.service.ts + consent-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AI_ADVISORY_VERSION,
  normalizeConsentSource,
  toConsentRecordView,
} from "../src/consent-logic";
import {
  getBrokerConsentStatus,
  recordBrokerConsent,
  getConsentRecords,
  type ConsentServiceDeps,
} from "../src/consent.service";

// ── pure logic ───────────────────────────────────────────────────────────────

describe("consent-logic", () => {
  it("AI_ADVISORY_VERSION is a stable non-empty string", () => {
    assert.equal(typeof AI_ADVISORY_VERSION, "string");
    assert.ok(AI_ADVISORY_VERSION.length > 0);
  });

  it("normalizeConsentSource defaults, trims and caps at 64", () => {
    assert.equal(normalizeConsentSource(undefined), "broker_connect");
    assert.equal(normalizeConsentSource("   "), "broker_connect");
    assert.equal(normalizeConsentSource(123), "broker_connect");
    assert.equal(normalizeConsentSource("  settings  "), "settings");
    assert.equal(normalizeConsentSource("x".repeat(200)).length, 64);
  });

  it("toConsentRecordView maps a row and null-coerces source", () => {
    const at = new Date("2026-05-30T00:00:00Z");
    assert.deepEqual(
      toConsentRecordView({
        kind: "AI_ADVISORY",
        version: "v1",
        acceptedAt: at,
        source: null,
      }),
      { kind: "AI_ADVISORY", version: "v1", acceptedAt: at, source: null },
    );
  });
});

// ── service (injected prisma) ────────────────────────────────────────────────

interface Call {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
  select?: unknown;
  orderBy?: unknown;
}
function fake(delegates: Record<string, (args: Call) => unknown>): {
  prisma: ConsentServiceDeps["prisma"];
  calls: Record<string, Call[]>;
} {
  const calls: Record<string, Call[]> = {};
  const db: Record<string, Record<string, (a: Call) => unknown>> = {};
  for (const key of Object.keys(delegates)) {
    const [model, method] = key.split(".");
    db[model] ??= {};
    db[model][method] = async (args: Call) => {
      (calls[key] ??= []).push(args);
      return delegates[key](args);
    };
  }
  return { prisma: db as unknown as ConsentServiceDeps["prisma"], calls };
}

describe("consent.service getBrokerConsentStatus", () => {
  it("reports accepted=true when a current-version record exists (scoped)", async () => {
    const { prisma, calls } = fake({
      "consentRecord.findFirst": () => ({ id: "c1" }),
    });
    const res = await getBrokerConsentStatus("u1", { prisma });
    assert.equal(res.success, true);
    if (res.success) {
      assert.equal(res.data.accepted, true);
      assert.equal(res.data.version, AI_ADVISORY_VERSION);
    }
    assert.deepEqual(calls["consentRecord.findFirst"]?.[0]?.where, {
      userId: "u1",
      kind: "AI_ADVISORY",
      version: AI_ADVISORY_VERSION,
    });
  });

  it("reports accepted=false when there is no record", async () => {
    const { prisma } = fake({ "consentRecord.findFirst": () => null });
    const res = await getBrokerConsentStatus("u1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.accepted, false);
  });
});

describe("consent.service recordBrokerConsent", () => {
  it("creates a version-stamped record with the normalised source when absent", async () => {
    const { prisma, calls } = fake({
      "consentRecord.findFirst": () => null,
      "consentRecord.create": () => ({ id: "c1" }),
    });
    const res = await recordBrokerConsent("u1", "  settings  ", { prisma });
    assert.equal(res.success, true);
    const data = calls["consentRecord.create"]?.[0]?.data;
    assert.equal(data?.userId, "u1");
    assert.equal(data?.kind, "AI_ADVISORY");
    assert.equal(data?.version, AI_ADVISORY_VERSION);
    assert.equal(data?.source, "settings"); // trimmed
  });

  it("is idempotent per version — an existing record → no second create", async () => {
    let created = false;
    const { prisma } = fake({
      "consentRecord.findFirst": () => ({ id: "c1" }),
      "consentRecord.create": () => {
        created = true;
        return {};
      },
    });
    const res = await recordBrokerConsent("u1", undefined, { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.accepted, true);
    assert.equal(created, false);
  });

  it("fails closed with a sanitised error when the write throws", async () => {
    const { prisma } = fake({
      "consentRecord.findFirst": () => null,
      "consentRecord.create": () => {
        throw new Error("write conflict");
      },
    });
    const res = await recordBrokerConsent("u1", undefined, { prisma });
    assert.equal(res.success, false);
    if (!res.success) assert.equal(res.error, "Failed to record consent");
  });
});

describe("consent.service getConsentRecords", () => {
  it("returns the caller's ledger newest-first (scoped)", async () => {
    const at = new Date("2026-05-30T00:00:00Z");
    const { prisma, calls } = fake({
      "consentRecord.findMany": () => [
        {
          kind: "AI_ADVISORY",
          version: "v1",
          acceptedAt: at,
          source: "broker_connect",
        },
      ],
    });
    const res = await getConsentRecords("u1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data[0]?.kind, "AI_ADVISORY");
    assert.deepEqual(calls["consentRecord.findMany"]?.[0]?.where, {
      userId: "u1",
    });
    assert.deepEqual(calls["consentRecord.findMany"]?.[0]?.orderBy, {
      acceptedAt: "desc",
    });
  });

  it("fails closed with a sanitised error when the query throws", async () => {
    const { prisma } = fake({
      "consentRecord.findMany": () => {
        throw new Error("Mongo down");
      },
    });
    const res = await getConsentRecords("u1", { prisma });
    assert.equal(res.success, false);
    if (!res.success)
      assert.equal(res.error, "Failed to fetch consent records");
  });
});
