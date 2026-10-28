/**
 * Stock-document source cache (MONEY-587 / MONEY-593).
 *
 * Cache-aside fetch for research source docs:
 *   1. check GCS for an existing fresh doc,
 *   2. fetch the live source only on miss / stale,
 *   3. store the fetched doc back to GCS.
 *
 * Everything for one company lives in ONE canonical folder, so NSE & BSE
 * (same company, same name) share the same cache — the exchange suffix is
 * stripped before keying:
 *
 *   gs://<GCP_STORAGE_BUCKET>/stocks/<CANONICAL_SYMBOL>/<docType>.json
 *
 * The cache is best-effort: a GCS read/write failure never breaks the live
 * fetch (we just skip the cache). Read + write use the same default bucket so
 * they always agree.
 */

import { uploadFile, downloadFile } from "@usemoney/storage";

const STOCK_PREFIX = "stocks";

/**
 * Collapse any exchange-suffixed symbol (RELIANCE.NS, RELIANCE.BO, RELIANCE-EQ)
 * to one canonical folder key. NSE and BSE for the same company resolve to the
 * same name → the same folder.
 */
export function canonicalSymbol(symbol: string): string {
  return String(symbol || "")
    .toUpperCase()
    .replace(/\.(NS|BO|NSE|BSE)$/i, "") // exchange suffix
    .replace(/-(EQ|BE|BZ)$/i, "") // NSE series suffix
    .replace(/[^A-Z0-9_-]/g, "") // keep folder-safe chars only
    .trim();
}

/** `stocks/<CANONICAL>/<docType>.json` — the single per-stock doc path. */
export function stockDocPath(symbol: string, docType: string): string {
  return `${STOCK_PREFIX}/${canonicalSymbol(symbol)}/${docType}.json`;
}

interface CachedDoc<T> {
  fetchedAt: number; // epoch ms
  source?: string; // official source URL the data came from
  symbol: string; // canonical symbol
  docType: string;
  data: T;
}

/** Read a cached stock doc from GCS, or null if absent / stale / unreadable. */
export async function readStockDoc<T>(
  symbol: string,
  docType: string,
  ttlMs: number,
): Promise<T | null> {
  try {
    const buf = await downloadFile(stockDocPath(symbol, docType));
    if (!buf) return null;
    const cached = JSON.parse(buf.toString("utf-8")) as CachedDoc<T>;
    if (
      cached &&
      typeof cached.fetchedAt === "number" &&
      Date.now() - cached.fetchedAt < ttlMs
    ) {
      return cached.data;
    }
    return null;
  } catch {
    return null;
  }
}

/** Store a stock doc to GCS under the canonical folder (best-effort). */
export async function writeStockDoc<T>(
  symbol: string,
  docType: string,
  data: T,
  source?: string,
): Promise<void> {
  try {
    const payload: CachedDoc<T> = {
      fetchedAt: Date.now(),
      source,
      symbol: canonicalSymbol(symbol),
      docType,
      data,
    };
    await uploadFile({
      file: Buffer.from(JSON.stringify(payload)),
      fileName: stockDocPath(symbol, docType),
      contentType: "application/json",
      isPublic: false,
      metadata: { symbol: canonicalSymbol(symbol), docType },
    });
  } catch {
    // best-effort: never fail the fetch because the cache write failed.
  }
}

/**
 * Cache-aside fetch: GCS first → live fetch on miss/stale → store back.
 * Returns the raw fetched/cached doc plus whether it came from cache.
 */
export async function cachedFetch<T>(opts: {
  symbol: string;
  docType: string;
  ttlMs: number;
  source?: string;
  fetch: () => Promise<T>;
}): Promise<{ data: T; fromCache: boolean }> {
  const cached = await readStockDoc<T>(opts.symbol, opts.docType, opts.ttlMs);
  if (cached !== null) return { data: cached, fromCache: true };

  const data = await opts.fetch();
  await writeStockDoc(opts.symbol, opts.docType, data, opts.source);
  return { data, fromCache: false };
}
