/**
 * Consent-ledger pure logic (no Prisma, no next/* glue).
 *
 * Extracted from `apps/web/lib/actions/consent.ts` (MONEY-505 / 501, SEBI IA
 * Reg 18(9)) so the version constant, the kind allow-list, and the row→view
 * mapper ship as testable pure functions shared by the API service.
 *
 * ── SINGLE SOURCE OF TRUTH CAVEAT ──
 * `AI_ADVISORY_VERSION` is ALSO declared in
 * `apps/web/lib/consent/ai-advisory.ts` (the web disclosure copy lives there and
 * a package MUST NOT import from apps/*). The two MUST stay in sync — a mismatch
 * would make the API report "not accepted" for a version the web app recorded.
 * Follow-up: hoist the constant into this package and have apps/web re-export it
 * (out of scope here — apps/web is not edited in this change).
 *
 * @see packages/services/src/consent.service.ts
 * @see packages/services/__tests__/consent-service.test.ts
 */

/**
 * Current AI-advisory disclosure version recorded into `ConsentRecord.version`.
 * MUST equal `AI_ADVISORY_VERSION` in apps/web/lib/consent/ai-advisory.ts.
 */
export const AI_ADVISORY_VERSION = "2026-05-30";

/** The `ConsentKind` enum values (mirrors the Prisma enum, Prisma-free here). */
export const CONSENT_KINDS = [
  "AI_ADVISORY",
  "TERMS",
  "PRIVACY",
  "DATA",
  "RISK",
] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** A consent record as returned to the client (the exportable ledger row). */
export interface ConsentRecordView {
  kind: string;
  version: string;
  acceptedAt: Date;
  source: string | null;
}

/** Map a raw ConsentRecord row to the client-facing view. */
export function toConsentRecordView(row: {
  kind: string;
  version: string;
  acceptedAt: Date;
  source: string | null;
}): ConsentRecordView {
  return {
    kind: row.kind,
    version: row.version,
    acceptedAt: row.acceptedAt,
    source: row.source ?? null,
  };
}

/**
 * Normalise a caller-supplied `source` for a recorded consent. Falls back to
 * `"broker_connect"` (the primary capture point) for an empty/absent/non-string
 * value and caps the length so a junk value can't bloat the ledger row.
 */
export function normalizeConsentSource(source: unknown): string {
  if (typeof source !== "string") return "broker_connect";
  const trimmed = source.trim();
  if (!trimmed) return "broker_connect";
  return trimmed.slice(0, 64);
}
