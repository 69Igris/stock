/**
 * Tickertape Mutual Fund Data Client
 *
 * Fetches mutual fund data from Tickertape:
 * - Overview (AUM, expense ratio, returns)
 * - Holdings (top holdings with weights)
 * - Peers (peer fund comparison)
 *
 * These enrich our existing MutualFundMaster model with data
 * not available from AMFI/Kuvera.
 */

import ky from "ky";
import { cacheWrap } from "./cache";
import {
  resolveSidFromSearch,
  mapMfOverview,
  mapMfHoldings,
  mapMfPeers,
} from "./tickertape-mf-client-logic";
import type { MfOverview, MfHolding, MfPeer } from "./tickertape-mf-types";

export type { MfOverview, MfHolding, MfPeer };

const logger = {
  warn: (...args: unknown[]) => console.warn("[tickertape-mf]", ...args),
  debug: (..._args: unknown[]) => {},
};

// Use api.tickertape.in - www.tickertape.in blocks non-browser requests
const BASE_URL = "https://api.tickertape.in";
const API_TIMEOUT_MS = 10_000;
const REQUEST_DELAY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── SID Resolution ───────────────────────────────────────────────────

const mfSidCache = new Map<string, string>();

/**
 * Resolve a mutual fund scheme code/name to a Tickertape SID
 */
export async function resolveTickertapeMfSid(
  schemeCode: string,
): Promise<string | null> {
  if (mfSidCache.has(schemeCode)) return mfSidCache.get(schemeCode)!;

  return cacheWrap(
    `tt:mf:sid:${schemeCode}`,
    async () => {
      try {
        await delay(REQUEST_DELAY_MS);
        const resp = await ky
          .get(`${BASE_URL}/search`, {
            searchParams: { text: schemeCode, types: "mutualfund" },
            timeout: API_TIMEOUT_MS,
            headers: { Accept: "application/json" },
          })
          .json<{
            data?: {
              mutualfunds?: Array<{ sid: string; name: string }>;
            };
          }>();

        const sid = resolveSidFromSearch(resp);
        if (sid) {
          mfSidCache.set(schemeCode, sid);
          return sid;
        }
        return null;
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response
          ?.status;
        if (status !== 404)
          logger.warn(
            `MF SID resolution failed for ${schemeCode}: ${status || err}`,
          );
        return null;
      }
    },
    7 * 86400, // 7 day cache
  );
}

// ── Overview ─────────────────────────────────────────────────────────

/**
 * Fetch mutual fund overview from Tickertape
 */
export async function fetchTickertapeMfOverview(
  schemeCode: string,
): Promise<MfOverview | null> {
  const sid = await resolveTickertapeMfSid(schemeCode);
  if (!sid) return null;

  return cacheWrap(
    `tt:mf:overview:${sid}`,
    async () => {
      try {
        await delay(REQUEST_DELAY_MS);
        const resp = await ky
          .get(`${BASE_URL}/mutual-funds/overview/${sid}`, {
            timeout: API_TIMEOUT_MS,
            headers: { Accept: "application/json" },
          })
          .json<Record<string, unknown>>();

        return mapMfOverview(sid, schemeCode, resp);
      } catch (err) {
        const s = (err as { response?: { status?: number } })?.response?.status;
        if (s !== 404)
          logger.warn(`MF overview fetch failed for ${sid}: ${s || err}`);
        return null;
      }
    },
    3600, // 1 hour cache
  );
}

// ── Holdings ─────────────────────────────────────────────────────────

/**
 * Fetch mutual fund top holdings from Tickertape
 */
export async function fetchTickertapeMfHoldings(
  schemeCode: string,
): Promise<MfHolding[] | null> {
  const sid = await resolveTickertapeMfSid(schemeCode);
  if (!sid) return null;

  return cacheWrap(
    `tt:mf:holdings:${sid}`,
    async () => {
      try {
        await delay(REQUEST_DELAY_MS);
        const resp = await ky
          .get(`${BASE_URL}/mutual-funds/holdings/${sid}`, {
            timeout: API_TIMEOUT_MS,
            headers: { Accept: "application/json" },
          })
          .json<Record<string, unknown>>();

        return mapMfHoldings(resp);
      } catch (err) {
        const s2 = (err as { response?: { status?: number } })?.response
          ?.status;
        if (s2 !== 404)
          logger.warn(`MF holdings fetch failed for ${sid}: ${s2 || err}`);
        return null;
      }
    },
    86400, // 24 hour cache
  );
}

// ── Peers ────────────────────────────────────────────────────────────

/**
 * Fetch peer mutual funds from Tickertape
 */
export async function fetchTickertapeMfPeers(
  schemeCode: string,
): Promise<MfPeer[] | null> {
  const sid = await resolveTickertapeMfSid(schemeCode);
  if (!sid) return null;

  return cacheWrap(
    `tt:mf:peers:${sid}`,
    async () => {
      try {
        await delay(REQUEST_DELAY_MS);
        const resp = await ky
          .get(`${BASE_URL}/mutual-funds/peers/${sid}`, {
            timeout: API_TIMEOUT_MS,
            headers: { Accept: "application/json" },
          })
          .json<Record<string, unknown>>();

        return mapMfPeers(resp);
      } catch (err) {
        const s3 = (err as { response?: { status?: number } })?.response
          ?.status;
        if (s3 !== 404)
          logger.warn(`MF peers fetch failed for ${sid}: ${s3 || err}`);
        return null;
      }
    },
    86400, // 24 hour cache
  );
}
