/**
 * External-contract pinning harness (packages/core).
 *
 * Contract tests prove that OUR code obeys an EXTERNAL system's wire format:
 * the exact request bytes we send and the exact response shape we parse. A
 * mocked unit test can never see that contract — only a test that drives the
 * REAL source through the REAL `fetch` boundary can.
 *
 * This module wires Node's built-in `undici` `MockAgent` (the engine behind the
 * global `fetch` on Node 18+) so we can:
 *   1. intercept outbound `fetch` with ZERO live network (NO orphan — the test
 *      stays pure and exits clean; `disableNetConnect()` makes any un-mocked
 *      host throw instead of escaping to the internet), and
 *   2. reply with a RECORDED JSON fixture to assert what our transform parses.
 *
 * A sibling copy lives at apps/web/__tests__/_contracts/mock-agent.ts; each
 * package keeps its own so `undici` resolves from that package's node_modules.
 */

import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  type Dispatcher,
} from "undici";

/** A single captured outbound request (the bytes WE sent). */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface InterceptJsonOptions {
  origin: string;
  /** Path to match. A RegExp matches the full path incl. query string. */
  path: string | RegExp;
  method?: string;
  statusCode?: number;
  body: unknown;
  responseHeaders?: Record<string, string>;
  /** Reply to every matching call, not just the first (default false). */
  persist?: boolean;
}

export interface InterceptTextOptions {
  origin: string;
  path: string | RegExp;
  method?: string;
  statusCode?: number;
  body: string;
  responseHeaders?: Record<string, string>;
  contentType?: string;
  persist?: boolean;
  /**
   * Hold the reply for this many ms before answering (MONEY-1198).
   *
   * Needed to simulate a COLD auth handshake. A stub that answers in under a
   * millisecond cannot lose a race against a 1 ms timer, so the
   * `setTimeout(..., Infinity)` clamp was invisible to every existing test.
   */
  delayMs?: number;
}

export interface MockAgentHandle {
  agent: MockAgent;
  interceptJson(opts: InterceptJsonOptions): { calls: CapturedRequest[] };
  interceptText(opts: InterceptTextOptions): { calls: CapturedRequest[] };
  close(): Promise<void>;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      out[String(headers[i]).toLowerCase()] = String(headers[i + 1]);
    }
    return out;
  }
  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
    }
  }
  return out;
}

/**
 * Install a fresh `MockAgent` as the global dispatcher with net-connect
 * disabled. Always pair with `.close()` in a `finally`.
 */
export function installMockAgent(): MockAgentHandle {
  const previous: Dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  function interceptJson(opts: InterceptJsonOptions): {
    calls: CapturedRequest[];
  } {
    const calls: CapturedRequest[] = [];
    const interceptor = agent
      .get(opts.origin)
      .intercept({ path: opts.path, method: opts.method ?? "GET" })
      .reply((req) => {
        calls.push({
          method: String(req.method ?? opts.method ?? "GET"),
          path: String(req.path ?? ""),
          headers: normalizeHeaders(req.headers),
          body: req.body == null ? "" : String(req.body),
        });
        return {
          statusCode: opts.statusCode ?? 200,
          data: JSON.stringify(opts.body),
          responseOptions: {
            headers: {
              "content-type": "application/json",
              ...(opts.responseHeaders ?? {}),
            },
          },
        };
      });
    if (opts.persist) interceptor.persist();
    return { calls };
  }

  function interceptText(opts: InterceptTextOptions): {
    calls: CapturedRequest[];
  } {
    const calls: CapturedRequest[] = [];
    const interceptor = agent
      .get(opts.origin)
      .intercept({ path: opts.path, method: opts.method ?? "GET" })
      .reply((req) => {
        calls.push({
          method: String(req.method ?? opts.method ?? "GET"),
          path: String(req.path ?? ""),
          headers: normalizeHeaders(req.headers),
          body: req.body == null ? "" : String(req.body),
        });
        return {
          statusCode: opts.statusCode ?? 200,
          data: opts.body,
          responseOptions: {
            headers: {
              "content-type": opts.contentType ?? "text/plain",
              ...(opts.responseHeaders ?? {}),
            },
          },
        };
      });
    if (opts.delayMs) interceptor.delay(opts.delayMs);
    if (opts.persist) interceptor.persist();
    return { calls };
  }

  async function close(): Promise<void> {
    try {
      await agent.close();
    } finally {
      setGlobalDispatcher(previous);
    }
  }

  return { agent, interceptJson, interceptText, close };
}

/**
 * Stub Yahoo's cookie+crumb auth handshake so a chart/quote contract test can
 * reach the data call. `yahoo-api.ts.getAuth()` first GETs a cookie from
 * fc.yahoo.com, then GETs a crumb from query2 — both must be intercepted (and
 * `persist`ed, since the auth cache is process-global and may already be warm
 * or expire between calls).
 */
export function stubYahooAuth(mock: MockAgentHandle): void {
  // Cookie endpoint — undici exposes set-cookie like any response header.
  mock.interceptText({
    origin: "https://fc.yahoo.com",
    path: "/",
    method: "GET",
    statusCode: 200,
    body: "",
    responseHeaders: { "set-cookie": "A3=mock-cookie-value; Path=/; Secure" },
    persist: true,
  });
  // Crumb endpoint — a short opaque token, NOT containing "<" (the source
  // treats an HTML-looking body as an invalid crumb).
  mock.interceptText({
    origin: "https://query2.finance.yahoo.com",
    path: "/v1/test/getcrumb",
    method: "GET",
    statusCode: 200,
    body: "mockCrumb123",
    persist: true,
  });
}
