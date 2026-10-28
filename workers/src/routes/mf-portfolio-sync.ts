import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import { processMfPortfolioSync } from "../processors/mf-portfolio-sync";
import {
  AMC_SOURCES,
  AMC_PAGE_SCRAPERS,
  type AmcId,
} from "@usemoney/core/market-data";

export const mfPortfolioSyncRoute = new Hono();

/**
 * DERIVED from the two source-of-truth tables — MONEY-1198.
 *
 * This was a hand-typed list of 12 ids, and it drifted the moment the `AmcId`
 * union grew to 17: `readonly AmcId[]` constrains the members to be VALID ids
 * but says nothing about COMPLETENESS, so TypeScript can never flag a missing
 * entry. `{"only":["MIRAE"]}` therefore filtered MIRAE out as unrecognised,
 * left `only` empty, and — via the `only.length` guard below — dropped the key
 * entirely, so the processor saw `undefined` and ran ALL of them. An operator
 * asking for one AMC silently got seventeen.
 *
 * Deriving it closes the class: a new entry in either table is a new allowed id
 * automatically, and there is no paired edit left to forget.
 *
 * ## Why this is the RAW table and not `fetchableSources()` — MONEY-1490
 *
 * A review proposed deriving it from the provenance-filtered
 * `fetchableSources()` / `scrapableAmcs()` instead, on the correct observation
 * that the processor SELECTS from those while this validates against the raw
 * ones — so a downgraded id would pass the gate and then select nothing.
 *
 * The mechanism is real. The remedy is not, and it was measured before being
 * applied:
 *
 *     raw       19   ABSL,...,HDFC,...
 *     filtered  18   (no HDFC)
 *
 * HDFC is absent from `fetchableSources()` because it publishes one workbook
 * PER SCHEME and is driven from the NAVAll index on its own code path, not
 * from the template loop. Narrowing this list would therefore answer **400**
 * to `only:["HDFC"]` — and HDFC is in this job's OWN deferred tail on a normal
 * run, so every chain hop carrying it would NACK, burn five deliveries,
 * dead-letter, and abandon the remainder of the month. Strictly worse than the
 * latent defect it set out to close.
 *
 * The residual risk is kept and stated: if an id is ever downgraded below
 * `verified`, a run naming it selects nothing and `mfPortfolioRunOk` reports a
 * loud failure rather than a quiet success. Closing it properly means
 * publishing ONE "what this job can act on" set that both the route and the
 * processor read — including the HDFC path — which is a change to the source
 * tables, not to this list. Tracked separately.
 */
const KNOWN_AMCS: readonly AmcId[] = [
  ...AMC_SOURCES.map((s) => s.id),
  ...AMC_PAGE_SCRAPERS.map((s) => s.id as AmcId),
];

mfPortfolioSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(
      `Processing MF portfolio sync (message: ${getMessageId(body)})`,
    );

    // UNWRAP THE ENVELOPE FIRST — MONEY-1490, and this job is where the class
    // finally cost something.
    //
    // A Pub/Sub push delivers `{message: {data: "<base64>", messageId}}`, not
    // the payload, because the subscription is created without
    // `--push-no-wrapper` (`workers/scripts/setup-pubsub.sh`). Reading `month`
    // or `only` straight off `body` therefore yielded `undefined` on EVERY
    // scheduled and every chained run.
    //
    // `xbrl-projection.ts` already carries this diagnosis in full — it was
    // found there, fixed there, and the sweep stopped before reaching here.
    // In an ordinary job the defect degrades to "ran with defaults". In THIS
    // job the payload IS the continuation cursor, so it degraded to a
    // perpetual chain: every hop discarded the remainder it was handed, ran
    // the full table from the top, re-fetched the same first four or five
    // houses, and chained the same tail again. Measured on prod 2026-09-21
    // across 1h40m the deferred count oscillated 14 <-> 15 and never once
    // reached 13 — a steady state, not a converging one. The 14 houses from
    // ABSL to HDFC had not been fetched in seven days.
    //
    // `parsePubSubMessage` falls back to the body itself when it is not an
    // envelope, so local dev and manual curl keep working unchanged.
    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ?? {}) as {
      month?: unknown;
      only?: unknown;
      chainDepth?: unknown;
    };

    // `YYYY-MM` lets an operator re-run a specific month without a deploy.
    // Rejected rather than coerced: a bad month string must not silently become
    // "last month" and overwrite the wrong period.
    let month: Date | undefined;
    if (typeof raw.month === "string") {
      const m = /^(\d{4})-(\d{2})$/.exec(raw.month.trim());
      if (!m) return c.json({ error: "month must be YYYY-MM" }, 400);
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (mo < 1 || mo > 12)
        return c.json({ error: "month out of range" }, 400);
      month = new Date(Date.UTC(y, mo - 1, 1));
    }

    // An UNRECOGNISED id is rejected, never filtered away — MONEY-1198.
    //
    // The old form silently dropped anything it did not recognise, and an `only`
    // that filtered down to nothing then collapsed into "no filter at all", so
    // a typo'd id ran the ENTIRE fan-out. "Filtered to nothing" and "not
    // filtered" are different states and must not share a representation — the
    // same fail-open shape as caching a couldn't-determine default.
    //
    // 400 rather than a silent no-op because the caller is an operator standing
    // in front of the job: a typo should come back immediately and by name.
    let only: AmcId[] | undefined;
    if (raw.only !== undefined) {
      if (!Array.isArray(raw.only)) {
        return c.json({ error: "only must be an array of AMC ids" }, 400);
      }
      const known = new Set<string>(KNOWN_AMCS as readonly string[]);
      const unknown = raw.only.filter(
        (v) => typeof v !== "string" || !known.has(v),
      );
      if (unknown.length > 0) {
        return c.json(
          {
            error: "unknown AMC id(s)",
            unknown,
            known: [...KNOWN_AMCS].sort(),
          },
          400,
        );
      }
      if (raw.only.length === 0) {
        return c.json(
          { error: "only must not be empty — omit it to run every AMC" },
          400,
        );
      }
      only = raw.only as AmcId[];
    }

    // Carried, never re-defaulted — see MAX_CHAIN_DEPTH in the processor. A
    // hop that recomputed its own depth would restart the count every time and
    // the cap would bound nothing.
    const chainDepth =
      typeof raw.chainDepth === "number" && Number.isFinite(raw.chainDepth)
        ? Math.max(0, Math.floor(raw.chainDepth))
        : 0;

    const result = await processMfPortfolioSync({
      ...(month ? { month } : {}),
      ...(only ? { only } : {}),
      chainDepth,
    });

    if (!result.ok) {
      // 500 so Pub/Sub retries. Safe: identity is
      // (period, amc, schemeKey, instrumentName), so a redelivery re-upserts
      // the same rows. And it MATTERS for Nippon, which keeps only the current
      // month — a period abandoned after one failed attempt may never be
      // recoverable.
      return c.json({ success: false, ...result }, 500);
    }
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("MF portfolio sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
