/**
 * MFAPI.in mutual-fund overview client (MONEY-1073).
 *
 * WHY THIS EXISTS: Tickertape's public MF API no longer surfaces open-ended
 * mutual funds — its `/search` returns only stocks/ETFs/indices (no
 * `mutualfunds` key under any `types` value) and `/mutual-funds/overview/{sid}`
 * 404s — so `tickertape-mf-client` resolves nothing for a fund and MF research
 * came back "Data Unavailable". MFAPI.in (already used by the core NAV service)
 * resolves an AMFI scheme code to real name/category/fund-house + full NAV
 * history, from which we derive latest NAV + trailing returns.
 *
 * SCOPE: overview + returns only. MFAPI has no holdings / peers / AUM /
 * expense-ratio, so those `MfOverview` fields stay null and the `mf-analysis`
 * skill's holdings/constituent sections degrade gracefully (available:false).
 *
 * The mapping + returns math are PURE and exported for unit tests; only
 * `fetchMfApiOverview` touches the network.
 */

import type { MfOverview } from "./tickertape-mf-types";

/** Raw MFAPI.in `/mf/<schemeCode>` shape (only the fields we read). */
export interface MfApiResponse {
  meta?: {
    fund_house?: string;
    scheme_type?: string;
    scheme_category?: string;
    scheme_code?: number;
    scheme_name?: string;
  };
  /** Newest-first daily NAV points; date is "DD-MM-YYYY", nav a string. */
  data?: Array<{ date: string; nav: string }>;
  status?: string;
}

const DAY_MS = 86_400_000;

/** Parse MFAPI's "DD-MM-YYYY" to epoch ms (UTC), or null on a bad value. */
export function parseMfApiDate(s: string): number | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((s ?? "").trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isFinite(t) ? t : null;
}

interface NavPoint {
  t: number;
  nav: number;
}

/** Normalize + sort NAV points newest-first, dropping any non-finite/≤0 nav. */
function toNavPoints(data: MfApiResponse["data"]): NavPoint[] {
  const pts: NavPoint[] = [];
  for (const d of data ?? []) {
    const t = parseMfApiDate(d.date);
    const nav = Number.parseFloat(d.nav);
    if (t !== null && Number.isFinite(nav) && nav > 0) pts.push({ t, nav });
  }
  pts.sort((a, b) => b.t - a.t);
  return pts;
}

/** Round to 2 dp, guarding non-finite so a bad ratio never renders "NaN%". */
function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Pick the NAV point nearest `target` epoch. Returns null when the history
 * doesn't reach back to `target` (so we never fabricate, say, a "5Y return"
 * from 1Y of data — the period is simply omitted).
 */
function pickNavAt(pts: NavPoint[], target: number): NavPoint | null {
  const oldest = pts[pts.length - 1];
  if (!oldest || target < oldest.t - 20 * DAY_MS) return null;
  let best = pts[0]!;
  let bestDiff = Infinity;
  for (const p of pts) {
    const diff = Math.abs(p.t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  return best;
}

/**
 * Trailing returns from newest-first NAV points: point-to-point % for ≤1Y,
 * annualized CAGR for 3Y/5Y (matching how fund returns are conventionally
 * shown). Periods without enough history are omitted, not zero-filled.
 */
export function computeMfReturns(
  data: MfApiResponse["data"],
): MfOverview["returns"] {
  const pts = toNavPoints(data);
  const latest = pts[0];
  if (!latest) return {};

  const periods: Array<[keyof MfOverview["returns"], number, boolean]> = [
    ["oneMonth", 30, false],
    ["threeMonth", 91, false],
    ["sixMonth", 182, false],
    ["oneYear", 365, false],
    ["threeYear", 365 * 3, true],
    ["fiveYear", 365 * 5, true],
  ];

  const out: MfOverview["returns"] = {};
  for (const [key, days, annualize] of periods) {
    const past = pickNavAt(pts, latest.t - days * DAY_MS);
    if (!past || past.nav <= 0) continue;
    const years = (latest.t - past.t) / (365 * DAY_MS);
    if (years <= 0) continue;
    const ratio = latest.nav / past.nav;
    const ret = annualize
      ? (Math.pow(ratio, 1 / years) - 1) * 100
      : (ratio - 1) * 100;
    if (Number.isFinite(ret)) out[key] = round2(ret);
  }
  return out;
}

/** Map an MFAPI response to `MfOverview`, or null when it carries no NAV. */
export function buildMfOverviewFromMfApi(
  schemeCode: string,
  raw: MfApiResponse | null,
): MfOverview | null {
  const pts = toNavPoints(raw?.data);
  const latest = pts[0];
  if (!raw?.meta || !latest) return null;

  return {
    sid: String(raw.meta.scheme_code ?? schemeCode),
    name: raw.meta.scheme_name ?? schemeCode,
    category: raw.meta.scheme_category ?? "",
    subCategory: raw.meta.scheme_type ?? "",
    aum: null, // MFAPI has none
    expenseRatio: null, // MFAPI has none
    nav: latest.nav,
    navDate: new Date(latest.t).toISOString().slice(0, 10),
    returns: computeMfReturns(raw.data),
    riskRating: null,
    exitLoad: null,
    minInvestment: null,
    rawData: {
      source: "mfapi.in",
      fundHouse: raw.meta.fund_house ?? null,
      schemeType: raw.meta.scheme_type ?? null,
      schemeCode,
    },
  };
}

/**
 * Fetch a fund's overview from MFAPI.in by AMFI scheme code. Returns null for a
 * non-numeric identifier (MFAPI is scheme-code-only) or any fetch/parse failure,
 * so the caller can fall through to another source.
 */
export async function fetchMfApiOverview(
  schemeCode: string,
): Promise<MfOverview | null> {
  const code = (schemeCode ?? "").trim();
  if (!/^\d+$/.test(code)) return null;
  try {
    const res = await fetch(`https://api.mfapi.in/mf/${code}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as MfApiResponse;
    return buildMfOverviewFromMfApi(code, raw);
  } catch {
    return null;
  }
}
