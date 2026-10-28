/**
 * MF metadata enrichment — the provider SEAM (MONEY-1205).
 *
 * This file carries NO implementation. {@link MfMetadataProvider} is the whole
 * contract: a source implements `id` / `isConfigured()` / `fetch()`, registers
 * itself with {@link registerMfMetadataProvider} at module load, and inherits
 * the cursor handling, the absence rules, the zero-field guard and the liveness
 * accounting for free. AMFI is the live implementation
 * (`./amfi-fund-metadata-provider`); MONEY-1409 deleted the only other one.
 *
 * ## Why the rules below are shaped the way they are
 *
 * Measured on prod 2026-08-18: **0 of 14,223** `MutualFundMaster` rows carried
 * `aum`, `expenseRatio`, `fundManager`, `returns1Y/3Y/5Y/Inception`,
 * `crisilRating`, `volatility`, `fundType`, `riskLevel`, `launchDate`,
 * `exitLoad` or `benchmarkName` — not sparse, ZERO — while 7,263 of them
 * carried a non-null `metadataSource`. The upstream had been dead for months
 * (the post-mortem is in `./amfi-fund-metadata-provider`'s header). Three
 * separate defects kept that invisible, and all three are fixed here:
 *
 * 1. **A failure never advanced the cursor.** `enrichMfMetadata` returned
 *    `enriched:false` without writing anything, and the worker orders
 *    `metadataSyncedAt asc, take 500` — so every Sunday it re-picked the same
 *    oldest 500 rows and failed on them again. Deterministic failures now stamp
 *    an ATTEMPT marker (`metadataSyncedAt: now`, `metadataSource: "none"`).
 * 2. **A success marker was stamped over an all-null row.** The old update
 *    named the provider unconditionally, even when every spread-in field was
 *    absent. A row enriched with nothing then looked identical to a row
 *    enriched with everything, and was excluded from retry for 7 days. A
 *    success marker is now only written when at least one field was actually
 *    extracted; otherwise the row gets the "none" attempt marker.
 * 3. **A dead provider was indistinguishable from a quiet week.** There is now
 *    an explicit outcome taxonomy (see {@link MfMetadataOutcome}) so the caller
 *    can tell "the provider answered, this fund is not in its universe" from
 *    "the provider could not be reached at all" — the distinction the worker's
 *    liveness assertion is keyed on (MONEY-1189 class).
 *
 * ## No provider is a first-class state, not an error
 *
 * {@link getMfMetadataProvider} returns null when nothing is registered AND
 * configured, and {@link enrichMfMetadata} short-circuits on it before it even
 * reads the database. That matters beyond the weekly job: the MF detail page
 * fires this fire-and-forget on EVERY stale page view, so an unconfigured
 * provider must cost a user-facing request nothing.
 *
 * @see workers/src/processors/mf-metadata-sync.ts (batch caller + liveness gate)
 * @see workers/src/processors/mf-metadata-sync-logic.ts (pure cursor/health decisions)
 */

import { prisma } from "@usemoney/database";

// ============== ABSENCE RULES ==============
//
// House rule: `""` / `"-"` / blank => null, NEVER 0. And the reverse, which is
// the bug this replaces: a real 0 must NEVER become null. The old code used
// `parseFloat(raw.expense_ratio) || null`, which maps a legitimate 0% expense
// ratio (index and direct plans really do publish 0) to "we don't know".

/** Values a feed uses to mean "no value here". Never applied to numbers. */
const BLANK_TEXTS = new Set(["", "-", "--", "n/a", "na", "null", "nil"]);

/**
 * Coerce a feed value to `string | null`.
 *
 * Blank-ish sentinels collapse to null. A non-empty string is trimmed and kept
 * verbatim — this is free text (fund manager, exit load, benchmark) and we do
 * not normalise what the AMC wrote.
 */
export function mfTextOrNull(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (BLANK_TEXTS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * Coerce a feed value to `number | null`.
 *
 * **0 survives.** `parseFloat(x) || null` is the bug being fixed: it cannot
 * distinguish a real 0 from an unparseable value, so every zero-expense-ratio
 * direct plan was stored as "unknown". Only a blank sentinel, a non-numeric
 * string, or a non-finite result yields null.
 */
export function mfNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (BLANK_TEXTS.has(trimmed.toLowerCase())) return null;
  // Strip grouping separators and a trailing percent sign; keep the sign.
  const cleaned = trimmed.replace(/,/g, "").replace(/%$/, "").trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a feed value to `Date | null`. Invalid / blank => null. */
export function mfDateOrNull(value: unknown): Date | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  const text = mfTextOrNull(value);
  if (text === null) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ============== FIELD SHAPE ==============

/**
 * Every `MutualFundMaster` column a metadata provider is allowed to write.
 *
 * All nullable by construction: a provider that does not carry a field returns
 * null for it, and null NEVER reaches the database (see
 * {@link buildMfMetadataUpdate}) — a source that lacks `crisilRating` must not
 * erase a rating another source supplied.
 */
export interface MfMetadataFields {
  aum: number | null;
  expenseRatio: number | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  returnsInception: number | null;
  crisilRating: string | null;
  fundManager: string | null;
  volatility: string | null;
  fundType: string | null;
  riskLevel: string | null;
  /** MONEY-1207 columns. `benchmarkName` must be the scheme's OWN stated
   *  benchmark — MONEY-610 removed a fabricated "Nifty 50 TRI" derived from the
   *  fund's own CAGR. A provider that cannot read it returns null. */
  launchDate: Date | null;
  exitLoad: string | null;
  benchmarkName: string | null;
}

/** The writable field names, in a stable order (used for counting + updates). */
export const MF_METADATA_FIELD_KEYS = [
  "aum",
  "expenseRatio",
  "returns1Y",
  "returns3Y",
  "returns5Y",
  "returnsInception",
  "crisilRating",
  "fundManager",
  "volatility",
  "fundType",
  "riskLevel",
  "launchDate",
  "exitLoad",
  "benchmarkName",
] as const satisfies ReadonlyArray<keyof MfMetadataFields>;

/** An all-null field set — the starting point for every provider mapper. */
export function emptyMfMetadata(): MfMetadataFields {
  return {
    aum: null,
    expenseRatio: null,
    returns1Y: null,
    returns3Y: null,
    returns5Y: null,
    returnsInception: null,
    crisilRating: null,
    fundManager: null,
    volatility: null,
    fundType: null,
    riskLevel: null,
    launchDate: null,
    exitLoad: null,
    benchmarkName: null,
  };
}

/**
 * How many fields the provider actually produced.
 *
 * This is the number the zero-field guard is keyed on. **0 means the provider
 * gave us nothing usable**, which must never be recorded as a successful
 * enrichment — the row would be excluded from retry while still carrying no
 * data. A real 0 VALUE (e.g. `expenseRatio: 0`) counts as extracted.
 */
export function countMfMetadataFields(fields: MfMetadataFields): number {
  let n = 0;
  for (const key of MF_METADATA_FIELD_KEYS) {
    if (fields[key] !== null) n++;
  }
  return n;
}

/**
 * The Prisma `data` patch for a successful enrichment: non-null fields only.
 *
 * Opportunistic by design — a provider that carries AUM but not the fund
 * manager must not null out a manager some other source wrote.
 */
export function buildMfMetadataUpdate(
  fields: MfMetadataFields,
): Record<string, number | string | Date> {
  const patch: Record<string, number | string | Date> = {};
  for (const key of MF_METADATA_FIELD_KEYS) {
    const value = fields[key];
    if (value !== null) patch[key] = value;
  }
  return patch;
}

// ============== PROVIDER CONTRACT ==============

/** What a provider is told about the fund it is being asked to enrich. */
export interface MfMetadataLookup {
  schemeCode: string;
  isinGrowth: string | null;
  isinDividend: string | null;
  schemeName: string;
  amcName: string;
}

/**
 * The three outcomes a provider must distinguish.
 *
 * The split between `not-found` and `unavailable` is the whole point: a 404
 * ("I answered; this fund is not in my universe") is a DETERMINISTIC answer and
 * should advance the cursor, while a timeout / DNS failure / 5xx ("I could not
 * answer") is TRANSIENT and must not be recorded as an attempt. Conflating them
 * is how a dead upstream and a fund we simply do not cover became the same log
 * line for three months.
 */
export type MfMetadataOutcome =
  | { status: "ok"; fields: MfMetadataFields }
  | { status: "not-found" }
  | { status: "unavailable"; error: string };

/**
 * The seam a metadata source implements.
 *
 * MONEY-1205 W3-C implements this against AMFI's AUM / TER feeds. Everything
 * else — cursor stamping, the zero-field guard, the liveness accounting, the
 * "null never overwrites" rule — is inherited from {@link enrichMfMetadata} and
 * needs no change.
 */
export interface MfMetadataProvider {
  /** Stamped into `MutualFundMaster.metadataSource` on a successful write. */
  readonly id: string;
  /**
   * Cheap, synchronous, NO NETWORK. Answers "could this provider possibly
   * work right now?" (env configured, credentials present, not kill-switched).
   * A false here short-circuits `enrichMfMetadata` before it touches the DB.
   */
  isConfigured(): boolean;
  /** Fetch metadata for one fund. Must never throw — return `unavailable`. */
  fetch(lookup: MfMetadataLookup): Promise<MfMetadataOutcome>;
}

// ============== PROVIDER REGISTRY ==============

// EMPTY ON PURPOSE (MONEY-1409). This file ships NO built-in provider: a
// source registers itself at module load (see mf-metadata-sync.ts) and
// `getMfMetadataProvider()` returning null is the documented refusal state.
// Seeding this with a default is what let a dead upstream look like a
// configured one for three months.
const REGISTERED: MfMetadataProvider[] = [];
let overrideProvider: MfMetadataProvider | null = null;

/**
 * Register a metadata source (MONEY-1205 W3-C: AMFI AUM/TER).
 *
 * Later registrations win, so a source registered at module load takes
 * precedence without touching this file.
 */
export function registerMfMetadataProvider(provider: MfMetadataProvider): void {
  const existing = REGISTERED.findIndex((p) => p.id === provider.id);
  if (existing >= 0) REGISTERED.splice(existing, 1);
  REGISTERED.push(provider);
}

/** Test seam: force a specific provider (or `null` to clear the override). */
export function setMfMetadataProviderForTests(
  provider: MfMetadataProvider | null,
): void {
  overrideProvider = provider;
}

/**
 * The provider that will be used, or `null` when NONE is configured.
 *
 * A `null` here is a first-class state, not an error to swallow: the batch
 * worker refuses to run rather than logging `enriched=0` and exiting 0.
 */
export function getMfMetadataProvider(): MfMetadataProvider | null {
  if (overrideProvider) return overrideProvider;
  for (let i = REGISTERED.length - 1; i >= 0; i--) {
    const p = REGISTERED[i]!;
    if (p.isConfigured()) return p;
  }
  return null;
}

// ============== ENRICHMENT ==============

/**
 * The attempt marker written to `metadataSource` when a fund was evaluated and
 * yielded nothing. Deliberately the SAME literal the seed script already
 * writes (`scripts/seed/seed-mf-metadata.ts:132`), so the 7,263 prod rows that
 * already carry it keep one meaning: "we looked, there was nothing."
 *
 * It is NOT a success marker — `metadataSource` never claims a provider that
 * did not actually supply a field.
 */
export const MF_METADATA_ATTEMPT_SOURCE = "none";

/** Why an enrichment ended the way it did. Drives the worker's health gate. */
export type MfEnrichReason =
  /** Fields were extracted and written. */
  | "enriched"
  /** No provider is configured at all — nothing was attempted. */
  | "provider-unconfigured"
  /** The scheme code is not in `MutualFundMaster`. */
  | "fund-not-found"
  /** The fund has no ISIN, so an ISIN-keyed provider cannot look it up. */
  | "no-isin"
  /** The provider ANSWERED and does not carry this fund. */
  | "not-found-upstream"
  /** The provider answered but produced 0 usable fields. */
  | "no-fields"
  /** The provider could NOT be reached (timeout / DNS / 5xx). Transient. */
  | "provider-unavailable"
  /** An unexpected throw (almost always the database write). */
  | "error";

export interface MfMetadataResult {
  schemeCode: string;
  /** True only when >= 1 field was extracted AND written. */
  enriched: boolean;
  /** The provider id on success; null otherwise. Never a lie. */
  source: string | null;
  data: MfMetadataFields | null;
  /** How many of the 14 writable fields the provider produced. */
  fieldsExtracted: number;
  /** Did we actually reach the provider? Drives the liveness denominator. */
  attempted: boolean;
  /** Did we stamp `metadataSyncedAt`? If false the cursor did not advance. */
  marked: boolean;
  reason: MfEnrichReason;
  error?: string;
}

/** What {@link enrichMfMetadata} should do with a provider outcome. */
export type MfEnrichAction =
  /** Write the fields AND a success marker naming the provider. */
  | "write-fields"
  /** Write ONLY the attempt marker (`metadataSource: "none"`). */
  | "mark-attempted"
  /** Write nothing — the cursor must not advance. */
  | "no-write";

export interface MfEnrichDecision {
  action: MfEnrichAction;
  reason: MfEnrichReason;
  /** How many of the 14 writable fields the provider produced. */
  fieldsExtracted: number;
  /** Did we reach the provider at all? (liveness denominator) */
  attempted: boolean;
}

/**
 * The cursor decision, extracted so it is directly testable without Prisma.
 *
 * `enrichMfMetadata` CALLS this — it is not a mirror of it. Two rules are
 * encoded here and both were defects:
 *
 *  - **Never a success marker on zero fields.** `fieldsExtracted === 0` maps to
 *    `mark-attempted`, so `metadataSource` never names a provider that supplied
 *    nothing. The old code stamped `metadataSource:"kuvera"` unconditionally on
 *    a row where every spread-in field was absent.
 *  - **Deterministic failures still advance the cursor.** `no-isin` and
 *    `not-found-upstream` are real answers, so they mark. Only a TRANSIENT
 *    provider failure declines to write — retrying that one next run is the
 *    point, and a whole batch of them is caught by the liveness gate rather
 *    than being papered over with fake attempt records.
 */
export function decideMfEnrichAction(
  outcome: MfMetadataOutcome | { status: "no-isin" },
): MfEnrichDecision {
  if (outcome.status === "no-isin") {
    return {
      action: "mark-attempted",
      reason: "no-isin",
      fieldsExtracted: 0,
      attempted: false,
    };
  }

  if (outcome.status === "unavailable") {
    return {
      action: "no-write",
      reason: "provider-unavailable",
      fieldsExtracted: 0,
      attempted: true,
    };
  }

  if (outcome.status === "not-found") {
    return {
      action: "mark-attempted",
      reason: "not-found-upstream",
      fieldsExtracted: 0,
      attempted: true,
    };
  }

  const fieldsExtracted = countMfMetadataFields(outcome.fields);
  if (fieldsExtracted === 0) {
    return {
      action: "mark-attempted",
      reason: "no-fields",
      fieldsExtracted: 0,
      attempted: true,
    };
  }

  return {
    action: "write-fields",
    reason: "enriched",
    fieldsExtracted,
    attempted: true,
  };
}

function result(
  partial: Partial<MfMetadataResult> & {
    schemeCode: string;
    reason: MfEnrichReason;
  },
): MfMetadataResult {
  return {
    enriched: false,
    source: null,
    data: null,
    fieldsExtracted: 0,
    attempted: false,
    marked: false,
    ...partial,
  };
}

/**
 * Stamp the attempt marker so the `metadataSyncedAt asc` cursor advances.
 *
 * Without this the worker re-selects the same oldest 500 rows every single run,
 * forever — the exact behaviour observed on prod, where the weekly job "ran
 * successfully" on 2026-08-16 and wrote nothing.
 */
async function markAttempted(schemeCode: string): Promise<boolean> {
  try {
    await prisma.mutualFundMaster.update({
      where: { schemeCode },
      data: {
        metadataSource: MF_METADATA_ATTEMPT_SOURCE,
        metadataSyncedAt: new Date(),
      },
    });
    return true;
  } catch (error) {
    console.error(
      `[mf-metadata] failed to stamp attempt marker for ${schemeCode}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * Enrich one `MutualFundMaster` row from the configured metadata provider.
 *
 * Never throws. The cursor discipline, which is the point of the function:
 *
 * | outcome                | stamps `metadataSyncedAt`? | why                                  |
 * | ---------------------- | -------------------------- | ------------------------------------ |
 * | enriched               | yes, with the provider id  | real data landed                     |
 * | `no-isin`              | yes, as `"none"`           | deterministic; re-checked in 7 days  |
 * | `not-found-upstream`   | yes, as `"none"`           | the provider ANSWERED "not mine"     |
 * | `no-fields`            | yes, as `"none"`           | evaluated, nothing usable            |
 * | `provider-unavailable` | **no**                     | transient — retry on the next run    |
 * | `provider-unconfigured`| **no**                     | nothing was attempted; run must fail |
 * | `fund-not-found`       | **no**                     | there is no row to stamp             |
 *
 * The transient/unconfigured rows are the only ones that can re-block the
 * cursor, and both are caught by the worker's liveness gate (which fails the
 * run instead of quietly re-picking the same batch next week).
 */
export async function enrichMfMetadata(
  schemeCode: string,
): Promise<MfMetadataResult> {
  const provider = getMfMetadataProvider();

  // Short-circuit BEFORE the database read. The MF detail page fires this
  // fire-and-forget on every stale view; with no provider it must cost nothing.
  if (!provider) {
    return result({
      schemeCode,
      reason: "provider-unconfigured",
      error:
        "No MF metadata provider is configured (set MF_METADATA_PROVIDER, " +
        "or register one via registerMfMetadataProvider()).",
    });
  }

  try {
    const fund = await prisma.mutualFundMaster.findUnique({
      where: { schemeCode },
      select: {
        isinGrowth: true,
        isinDividend: true,
        schemeName: true,
        amcName: true,
      },
    });

    if (!fund) {
      return result({
        schemeCode,
        reason: "fund-not-found",
        error: "Fund not found in MutualFundMaster",
      });
    }

    const lookup: MfMetadataLookup = {
      schemeCode,
      isinGrowth: fund.isinGrowth ?? null,
      isinDividend: fund.isinDividend ?? null,
      schemeName: fund.schemeName,
      amcName: fund.amcName,
    };

    const hasIsin = Boolean(lookup.isinGrowth || lookup.isinDividend);
    const outcome: MfMetadataOutcome | { status: "no-isin" } = hasIsin
      ? await provider.fetch(lookup)
      : { status: "no-isin" };

    // The cursor decision lives in a pure, separately-tested function.
    const decision = decideMfEnrichAction(outcome);
    const fields = outcome.status === "ok" ? outcome.fields : null;

    if (decision.action === "no-write") {
      return result({
        schemeCode,
        reason: decision.reason,
        attempted: decision.attempted,
        error:
          outcome.status === "unavailable"
            ? outcome.error
            : "Provider produced no result",
      });
    }

    if (decision.action === "mark-attempted") {
      const marked = await markAttempted(schemeCode);
      return result({
        schemeCode,
        reason: decision.reason,
        attempted: decision.attempted,
        marked,
        data: fields,
        error:
          decision.reason === "no-isin"
            ? "No ISIN available for this fund"
            : undefined,
      });
    }

    await prisma.mutualFundMaster.update({
      where: { schemeCode },
      data: {
        ...buildMfMetadataUpdate(fields!),
        metadataSource: provider.id,
        metadataSyncedAt: new Date(),
      },
    });

    return {
      schemeCode,
      enriched: true,
      source: provider.id,
      data: fields,
      fieldsExtracted: decision.fieldsExtracted,
      attempted: true,
      marked: true,
      reason: "enriched",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[mf-metadata] Failed to enrich ${schemeCode}: ${message}`);
    return result({
      schemeCode,
      reason: "error",
      attempted: true,
      error: message,
    });
  }
}
