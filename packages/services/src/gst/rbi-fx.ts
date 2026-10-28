/**
 * RBI reference exchange rate fetcher for GST invoice generation.
 *
 * GST AS-11 policy requires invoices to be denominated in INR using the
 * Reserve Bank of India's reference rate as of the invoice date. The rate
 * is the same one we MUST use in books and on GSTR-1 - never the customs
 * rate. See `docs/gst-as11-policy.md`.
 *
 * Strategy:
 *   1. Look up `process.env.GST_FX_RATE_<CURRENCY>_<YYYY-MM-DD>` for ops-set
 *      overrides (used during back-fills when the live API is unreachable
 *      or when CA needs to pin a specific rate per record).
 *   2. Try RBI's reference-rate JSON endpoint with 24-hour cache.
 *   3. Fall back to the cached previous business day's rate if the API is down
 *      and the request is for a Sunday/Monday morning.
 *   4. Throw RbiRateUnavailableError otherwise - invoice generation must NOT
 *      silently invent a rate.
 *
 * For INR payouts, the engine skips this module entirely.
 */

const RBI_REFERENCE_URL =
  "https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx";

const FX_CACHE_TTL_SECONDS = 86400; // 24h - RBI rates fix daily

export class RbiRateUnavailableError extends Error {
  constructor(
    public readonly currency: string,
    public readonly date: string,
    cause?: unknown,
  ) {
    super(
      `RBI reference rate for ${currency} on ${date} is not available. ` +
        `Set GST_FX_RATE_${currency}_${date} env or retry once RBI archive is reachable.`,
    );
    this.name = "RbiRateUnavailableError";
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

export interface FxRateLookup {
  currency: string;
  rate: number;
  rateDate: string; // YYYY-MM-DD
  source: "rbi_live" | "rbi_cached" | "ops_override";
  sourceUrl: string;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function envOverrideRate(currency: string, date: string): number | null {
  const key = `GST_FX_RATE_${currency}_${date}`;
  const raw = process.env[key];
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Live fetch from RBI's reference-rate archive. The actual archive URL +
 * payload schema changes between RBI website revisions, so the contract
 * here is intentionally narrow: take a date + currency, return a number or
 * throw. Any change to RBI's archive format gets isolated to this function.
 *
 * Currently a stub - wired to env overrides only. The downstream invoice
 * engine cannot ship to production without either a live fetcher or a full
 * set of env overrides for the relevant date range. Tracking in MONEY-217
 * (ops runbook).
 */
async function fetchFromRbi(
  _currency: string,
  _date: string,
): Promise<number | null> {
  // TODO(MONEY-217): implement live fetch + parse of RBI reference-rate page.
  // Until then, every non-overridden lookup throws RbiRateUnavailableError.
  return null;
}

/**
 * Resolve INR-per-unit rate for a foreign currency on a given date.
 * Throws RbiRateUnavailableError if no source provides one - callers must
 * surface this to the operator as a hard block on invoice generation.
 */
export async function getRbiReferenceRate(args: {
  currency: string;
  invoiceDate: Date;
}): Promise<FxRateLookup> {
  const currency = args.currency.toUpperCase();
  const date = formatDate(args.invoiceDate);

  // 1. Ops env override
  const override = envOverrideRate(currency, date);
  if (override !== null) {
    return {
      currency,
      rate: override,
      rateDate: date,
      source: "ops_override",
      sourceUrl: `env:GST_FX_RATE_${currency}_${date}`,
    };
  }

  // 2. Live RBI archive (cached for 24h once we have a fetcher)
  const live = await fetchFromRbi(currency, date);
  if (live !== null) {
    return {
      currency,
      rate: live,
      rateDate: date,
      source: "rbi_live",
      sourceUrl: RBI_REFERENCE_URL,
    };
  }

  throw new RbiRateUnavailableError(currency, date);
}

export const FX_RATE_CACHE_TTL = FX_CACHE_TTL_SECONDS;
