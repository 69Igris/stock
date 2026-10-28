/**
 * External-contract pinning harness (apps/web).
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
 *   2. capture the request (method, path, headers, body) to assert what we send,
 *      then reply with a RECORDED JSON fixture to assert what we parse.
 *
 * Usage (one MockAgent per test, torn down in a `finally`):
 *
 *   const mock = installMockAgent();
 *   try {
 *     const captured = mock.interceptJson({
 *       origin: "https://api.kite.trade",
 *       path: "/session/token",
 *       method: "POST",
 *       statusCode: 200,
 *       body: fixtureJson,
 *     });
 *     ... call the real source ...
 *     assert.equal(captured.calls.length, 1);
 *   } finally {
 *     await mock.close();
 *   }
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
  /** Lower-cased header map (undici normalizes header names to lower-case). */
  headers: Record<string, string>;
  /** Raw request body as a string (e.g. a urlencoded form or JSON). */
  body: string;
}

export interface InterceptJsonOptions {
  origin: string;
  /** Path to match. A RegExp matches the full path incl. query string. */
  path: string | RegExp;
  method?: string;
  /** HTTP status to reply with (default 200). */
  statusCode?: number;
  /** JSON value to serialize as the response body. */
  body: unknown;
  /** Extra response headers (content-type defaults to application/json). */
  responseHeaders?: Record<string, string>;
}

export interface InterceptTextOptions {
  origin: string;
  path: string | RegExp;
  method?: string;
  statusCode?: number;
  /** Raw (already-stringified) response body. */
  body: string;
  responseHeaders?: Record<string, string>;
  contentType?: string;
}

export interface MockAgentHandle {
  agent: MockAgent;
  /**
   * Intercept one request and reply with a JSON body. Returns a handle whose
   * `.calls` array is populated with every matching request as it arrives, so
   * the test can assert the exact request bytes that were sent.
   */
  interceptJson(opts: InterceptJsonOptions): { calls: CapturedRequest[] };
  /** Same as interceptJson but replies with an arbitrary (text) body. */
  interceptText(opts: InterceptTextOptions): { calls: CapturedRequest[] };
  /** Restore the previous global dispatcher and close the mock agent. */
  close(): Promise<void>;
}

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  // undici passes request headers either as a plain object or a flat
  // [k, v, k, v, ...] array depending on the call path — handle both.
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const key = String(headers[i]).toLowerCase();
      out[key] = String(headers[i + 1]);
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
 * Install a fresh `MockAgent` as the global dispatcher (so the global `fetch`
 * routes through it) with net-connect disabled. Always pair with `.close()` in
 * a `finally` to restore the previous dispatcher and avoid leaking state across
 * test files.
 */
export function installMockAgent(): MockAgentHandle {
  const previous: Dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  // Any host we did NOT explicitly intercept must throw, never hit the network.
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  function interceptJson(opts: InterceptJsonOptions): {
    calls: CapturedRequest[];
  } {
    const calls: CapturedRequest[] = [];
    const pool = agent.get(opts.origin);
    pool
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
    return { calls };
  }

  function interceptText(opts: InterceptTextOptions): {
    calls: CapturedRequest[];
  } {
    const calls: CapturedRequest[] = [];
    const pool = agent.get(opts.origin);
    pool
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
