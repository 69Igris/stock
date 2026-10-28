/**
 * NSE India API Client
 *
 * Cookie-based session management for NSE India's free APIs.
 * Auto-refreshes cookies when they expire.
 */

const NSE_BASE = process.env.NSE_BASE_URL || "https://www.nseindia.com";
const SESSION_TTL = parseInt(process.env.NSE_SESSION_TTL_MS || "300000"); // 5 min
const MAX_RETRIES = 3;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export class NseClient {
  private cookies: string | null = null;
  private cookieExpiry = 0;
  private refreshPromise: Promise<void> | null = null;

  private async refreshSession(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${NSE_BASE}/`, {
          headers: { "User-Agent": UA },
          redirect: "manual",
        });

        const setCookie = res.headers.get("set-cookie");
        if (setCookie) {
          // Split on ", " followed by a cookie name= (not on commas inside Expires dates)
          const cookieParts: string[] = [];
          const parts = setCookie.split(/,\s*(?=[a-zA-Z_][a-zA-Z0-9_]*=)/);
          for (const part of parts) {
            const cookieValue = part.trim().split(";")[0];
            if (cookieValue && cookieValue.includes("=")) {
              cookieParts.push(cookieValue);
            }
          }
          if (cookieParts.length > 0) {
            this.cookies = cookieParts.join("; ");
            this.cookieExpiry = Date.now() + SESSION_TTL;
          }
        }
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  private async ensureSession(): Promise<string> {
    if (!this.cookies || Date.now() >= this.cookieExpiry) {
      await this.refreshSession();
    }
    return this.cookies || "";
  }

  private async nseFetch<T>(path: string): Promise<T | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const cookies = await this.ensureSession();
        const res = await fetch(`${NSE_BASE}${path}`, {
          headers: {
            Cookie: cookies,
            "User-Agent": UA,
            Accept: "application/json",
            Referer: `${NSE_BASE}/`,
          },
          // Per-request deadline so a stalled NSE socket fails fast instead of
          // riding the executor's 30s budget (it has no timeout otherwise).
          // MONEY-672: a hung NSE leg was the worst case behind peer-fetch.
          signal: AbortSignal.timeout(6000),
        });

        if (res.status === 401 || res.status === 403) {
          // Session expired, refresh and retry
          this.cookies = null;
          continue;
        }

        if (res.status === 429) {
          // Rate limited - back off and retry
          const delay = 1000 * Math.pow(2, attempt) + Math.random() * 500;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          lastError = new Error(`NSE API returned ${res.status} for ${path}`);
          continue;
        }

        return (await res.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Transient network error - retry with backoff
        if (attempt < MAX_RETRIES - 1) {
          const delay = 500 * Math.pow(2, attempt) + Math.random() * 300;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    console.warn(
      `[nse-client] All ${MAX_RETRIES} attempts failed for ${path}:`,
      lastError?.message,
    );
    return null;
  }

  /**
   * Get peer comparison data for a symbol
   */
  async getPeerComparison(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/corporate-peer-comparison?symbol=${encodeURIComponent(symbol)}`,
    );
  }

  /**
   * Get corporate actions (dividends, splits, bonuses)
   */
  async getCorporateActions(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/corporates/corporateActions?index=equities&symbol=${encodeURIComponent(symbol)}`,
    );
  }

  /**
   * Get equity quote info
   */
  async getQuote(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/quote-equity?symbol=${encodeURIComponent(symbol)}`,
    );
  }

  /**
   * Get trade info (bulk/block deals)
   */
  async getTradeInfo(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/quote-equity?symbol=${encodeURIComponent(symbol)}&section=trade_info`,
    );
  }

  /**
   * Get shareholding pattern (promoter, FII, DII trends)
   */
  async getShareholdingPattern(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/corporates/shareholding?symbol=${encodeURIComponent(symbol)}`,
    );
  }

  /**
   * Get financial results (quarterly/annual from NSE filings)
   */
  async getFinancialResults(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/corporates/financial-results?index=equities&symbol=${encodeURIComponent(symbol)}`,
    );
  }

  /**
   * Get index constituents (for benchmark comparisons)
   */
  async getIndexConstituents(index: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/equity-stockIndices?index=${encodeURIComponent(index)}`,
    );
  }

  /**
   * Get board / shareholder meetings (board meetings, AGM / EGM) from NSE
   * corporate filings. Official channel for MONEY-587 sources.
   */
  async getBoardMeetings(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/corporate-board-meetings?index=equities&symbol=${encodeURIComponent(symbol)}`,
    );
  }

  /**
   * Get official corporate announcements / exchange filings from NSE.
   */
  async getAnnouncements(symbol: string): Promise<unknown | null> {
    return this.nseFetch(
      `/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`,
    );
  }
}

// Singleton instance
let nseClientInstance: NseClient | null = null;

export function getNseClient(): NseClient {
  if (!nseClientInstance) {
    nseClientInstance = new NseClient();
  }
  return nseClientInstance;
}
