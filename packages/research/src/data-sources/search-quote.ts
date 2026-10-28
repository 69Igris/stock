/**
 * Gemini google-search-grounded scalar quote (MONEY-1060, fix 10).
 *
 * The FINAL resilience tier for `fetch_stock_price`: when Yahoo, Tickertape
 * AND the synced `DailyPrice` fallback all miss a symbol — or the DB row is
 * staler than 7 days — a cheap Flash call with the `googleSearch` grounding
 * tool asks the live web for the current price. SCALARS ONLY (price,
 * marketCap, asOf); rows produced from it are tagged `source:"search"`.
 *
 * Safety posture:
 *   - strict-JSON prompt, parsed defensively (fences stripped, first `{...}`);
 *   - VALIDATION GATE: price must be finite and > 0, and when a last known
 *     close is supplied the result is rejected outside [0.5×, 2×] of it
 *     (hallucination / wrong-ticker guard);
 *   - swallow-and-null on ANY error, observable via an optional `onError`
 *     (mirrors yahoo-api's `YahooFetchErrorOpts` pattern);
 *   - hard ~8s wall-clock cap;
 *   - the Gemini client is lazy-imported inside the guarded call path
 *     (test-runner safe) and gated exactly like research's other Gemini usage:
 *     `getVertexAIClient()` requires GOOGLE_GENAI_API_KEY (Developer API) or
 *     GCP_PROJECT_ID (Vertex fallback) — unconfigured envs short-circuit to
 *     null instead of throwing out of the tier.
 */

export interface SearchGroundedQuote {
  price: number;
  marketCap?: number;
  asOf?: string;
  source: "search";
}

export interface SearchQuoteOpts {
  /**
   * Last known close (e.g. the stale DB row's price) — hallucination guard:
   * a search price outside [0.5×, 2×] of it is rejected.
   */
  lastKnownClose?: number;
  /**
   * Injectable raw generation call for tests: prompt in → model text out.
   * When omitted, the real search-grounded Gemini Flash call is used.
   */
  fetchImpl?: (prompt: string) => Promise<string>;
  /** Error observer — called before any swallow-to-null (yahoo-api pattern). */
  onError?: (error: unknown, context?: string) => void;
  /** Hard wall-clock cap in ms (default 8000). */
  timeoutMs?: number;
}

/**
 * The cheap grounding-capable Flash id from the core model registry
 * (packages/core/src/gemini/model-registry.ts — the FREE-tier default, and the
 * same model apps/web's `groundedGenerate` defaults to for search grounding).
 */
export const SEARCH_QUOTE_MODEL = "gemini-2.5-flash";

const DEFAULT_TIMEOUT_MS = 8_000;

/** Same conditions `getVertexAIClient` itself requires — cheap pre-gate. */
function isGeminiConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_GENAI_API_KEY || process.env.GCP_PROJECT_ID,
  );
}

/** Strict-JSON search prompt for one NSE/BSE symbol. Exported for tests. */
export function buildSearchQuotePrompt(symbol: string): string {
  const clean = symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const exchange = /\.BO$/i.test(symbol) ? "BSE" : "NSE";
  return (
    `What is the current stock price of the ${exchange}-listed Indian ` +
    `company with ticker "${clean}"? Search for the latest traded price. ` +
    `Return ONLY minified JSON, no prose, no markdown: ` +
    `{"price": <current price in INR as a number>, ` +
    `"marketCap": <market capitalisation in INR as a number, or null>, ` +
    `"asOf": "<price date, YYYY-MM-DD>"}`
  );
}

/**
 * Parse + VALIDATE a model response into a SearchGroundedQuote.
 *
 * Returns null unless `price` is a finite number > 0 that also passes the
 * [0.5×, 2×] bounds check against `lastKnownClose` (when provided — boundary
 * values are accepted). `marketCap` is kept only when finite and > 0; `asOf`
 * only when a non-empty string. Exported so the gate is unit-testable.
 */
export function parseSearchQuoteResponse(
  raw: string,
  lastKnownClose?: number,
): SearchGroundedQuote | null {
  if (typeof raw !== "string" || !raw.trim()) return null;

  let jsonStr = raw.trim();
  const fence = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) jsonStr = fence[1]!.trim();
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;

  const price = rec.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (
    typeof lastKnownClose === "number" &&
    Number.isFinite(lastKnownClose) &&
    lastKnownClose > 0 &&
    (price < lastKnownClose * 0.5 || price > lastKnownClose * 2)
  ) {
    // Hallucination / wrong-ticker guard: a real price does not halve or
    // double against the last synced close without a corporate action.
    return null;
  }

  const marketCap =
    typeof rec.marketCap === "number" &&
    Number.isFinite(rec.marketCap) &&
    rec.marketCap > 0
      ? rec.marketCap
      : undefined;
  const asOf =
    typeof rec.asOf === "string" && rec.asOf.trim()
      ? rec.asOf.trim()
      : undefined;

  return {
    price,
    ...(marketCap !== undefined ? { marketCap } : {}),
    ...(asOf ? { asOf } : {}),
    source: "search",
  };
}

/** Promise race with a CLEARED timer (never orphans the test runner). */
async function withHardTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`search-grounded quote timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Real generation path: search-grounded Gemini Flash. Lazy import inside the
 * guarded thunk keeps the Gemini SDK out of the module graph for the plain
 * node test runner; `generateWithTimeout(…, timeoutMs, 1)` = single attempt
 * under the same hard cap.
 */
async function generateWithSearchGrounding(
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const { getVertexAIClient, generateWithTimeout } =
    await import("@usemoney/core/gemini");
  const model = getVertexAIClient().getGenerativeModel({
    model: SEARCH_QUOTE_MODEL,
    generationConfig: { temperature: 0, maxOutputTokens: 256 },
    tools: [{ googleSearch: {} }],
  });
  return generateWithTimeout(model, prompt, timeoutMs, 1);
}

/**
 * Fetch a search-grounded scalar quote for one symbol. Never throws: any
 * error (unconfigured Gemini env, SDK failure, timeout, junk JSON, bounds
 * rejection) resolves to null, with the error observable via `opts.onError`.
 */
export async function fetchSearchGroundedQuote(
  symbol: string,
  opts: SearchQuoteOpts = {},
): Promise<SearchGroundedQuote | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    if (!symbol || typeof symbol !== "string") return null;
    const prompt = buildSearchQuotePrompt(symbol);

    let raw: string;
    if (opts.fetchImpl) {
      raw = await withHardTimeout(opts.fetchImpl(prompt), timeoutMs);
    } else {
      // Env gate: identical conditions to getVertexAIClient's own requirement;
      // short-circuits unconfigured envs without a thrown client init.
      if (!isGeminiConfigured()) return null;
      raw = await generateWithSearchGrounding(prompt, timeoutMs);
    }

    return parseSearchQuoteResponse(raw, opts.lastKnownClose);
  } catch (error) {
    opts.onError?.(error, `search-quote:${symbol}`);
    return null;
  }
}
