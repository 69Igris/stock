/**
 * MONEY-1209 — log-payload redaction.
 *
 * The thing under test is not "does the function return an object without the
 * word SECRET1 somewhere in it". It is: **after this runs, can the string a log
 * sink actually receives still contain a replayable credential?** So every
 * assertion goes through `util.inspect`, which is what `console.error` uses, and
 * through it at `depth: null, showHidden: true` — inspect's own default depth of
 * 2 would hide deep nodes and hand us a green test for a payload that a
 * JSON-serialising sink (pino → Datadog, Cloud Logging) would still publish in
 * full.
 *
 * Each secret also gets a CONTROL assertion proving the unredacted value DOES
 * leak through the same rendering path. Without it, a case could pass because
 * the leak never existed in that shape rather than because the redactor
 * stopped it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import util from "node:util";

import {
  redactSensitive,
  maskSensitiveText,
  REDACTED,
  UNSERIALIZABLE,
  TRUNCATED,
  CIRCULAR,
  SENSITIVE_KEY_PATTERN,
  SESSION_COOKIE_NAMES,
} from "../src/log-redaction";

/** Render exactly the way a log sink would, with nothing elided. */
function render(value: unknown): string {
  return util.inspect(value, { depth: null, showHidden: true });
}

/** Build the ky `HTTPError` shape named in the ticket. */
function fakeKyError(): Error {
  return Object.assign(
    new Error("Request failed with status code 403 Forbidden"),
    {
      name: "HTTPError",
      request: {
        headers: { cookie: "ak_bmsc=SECRET1; bm_sz=SECRET2" },
        url: "https://www.nseindia.com/api/equity-stockIndices",
        method: "GET",
      },
      options: { headers: { authorization: "Bearer TOKENX" } },
    },
  );
}

describe("MONEY-1209 - redactSensitive", () => {
  it("[redaction] strips cookie + bearer from the ky HTTPError shape", () => {
    const err = fakeKyError();

    // CONTROL: this exact rendering path leaks all three today.
    const leaked = render(err);
    for (const secret of ["SECRET1", "SECRET2", "TOKENX"]) {
      assert.ok(
        leaked.includes(secret),
        `control failed: unredacted render did not contain ${secret}, ` +
          `so the assertion below would pass for the wrong reason`,
      );
    }

    const safe = render(redactSensitive(err));
    for (const secret of ["SECRET1", "SECRET2", "TOKENX"]) {
      assert.ok(
        !safe.includes(secret),
        `${secret} survived redaction: ${safe}`,
      );
    }
    // The diagnostics that make the log worth keeping must survive.
    assert.ok(safe.includes("403 Forbidden"), safe);
    assert.ok(safe.includes("equity-stockIndices"), safe);
    assert.ok(safe.includes("HTTPError"), safe);
    assert.ok(safe.includes(REDACTED), safe);
  });

  it("[redaction] keeps message + stack (masked, not dropped)", () => {
    const err = new Error("boom while warming session");
    const out = redactSensitive(err);
    assert.ok(
      out instanceof Error,
      "an Error must stay an Error for log sinks",
    );
    assert.equal(out.message, "boom while warming session");
    assert.ok(
      typeof out.stack === "string" && out.stack.includes("log-redaction.test"),
      "stack must be preserved so the log is still actionable",
    );
  });

  it("[redaction] masks a session cookie hiding inside a plain string", () => {
    // The key rule cannot see this one: `sessionHeader` is not a sensitive key
    // name, and the whole jar is joined into one value. This is the case that
    // makes the string scanner load-bearing rather than belt-and-braces.
    const payload = {
      note: "warm-up failed",
      sessionHeader: "ak_bmsc=SECRET3; bm_mi=SECRET4; bm_sz=SECRET5",
    };
    const leaked = render(payload);
    assert.ok(leaked.includes("SECRET3") && leaked.includes("SECRET5"));

    const safe = render(redactSensitive(payload));
    for (const secret of ["SECRET3", "SECRET4", "SECRET5"]) {
      assert.ok(!safe.includes(secret), `${secret} survived: ${safe}`);
    }
    assert.ok(safe.includes("ak_bmsc=" + REDACTED), safe);
    assert.ok(safe.includes("warm-up failed"), "context must survive");
  });

  it("[redaction] masks credentials embedded in message and stack", () => {
    // A 403 handler that interpolates the request it just sent leaves the
    // secret in a place with no object left to walk.
    const err = new Error(
      "NSE handshake rejected (sent Cookie: ak_bmsc=SECRET6, auth Bearer TOKENY)",
    );
    err.stack = `HTTPError: header was ak_bmsc=SECRET7\n    at nseFetch (nse-client.ts:70:11)`;

    const out = redactSensitive(err);
    const safe = render(out);
    for (const secret of ["SECRET6", "SECRET7", "TOKENY"]) {
      assert.ok(!safe.includes(secret), `${secret} survived: ${safe}`);
    }
    assert.ok(safe.includes("nseFetch"), "stack frames must survive");
  });

  it("[redaction] masks a JSON.stringify'd error without eating the quotes", () => {
    // `console.error(msg, JSON.stringify(err))` is a real call-site shape; the
    // argument arrives as ONE string and only the value scanner can help.
    const blob = JSON.stringify({
      headers: { "x-session": "ak_bmsc=SECRET8; bm_sz=SECRET9" },
    });
    const masked = maskSensitiveText(blob);
    assert.ok(!masked.includes("SECRET8"));
    assert.ok(!masked.includes("SECRET9"));
    // Still parseable: the mask must stop at the closing quote, not swallow it.
    const reparsed = JSON.parse(masked) as {
      headers: Record<string, string>;
    };
    assert.equal(
      reparsed.headers["x-session"],
      `ak_bmsc=${REDACTED}; bm_sz=${REDACTED}`,
    );
  });

  it("[redaction] covers the whole NSE/Akamai cookie jar, not just the three named", () => {
    for (const name of SESSION_COOKIE_NAMES) {
      const masked = maskSensitiveText(`${name}=LIVEVALUE`);
      assert.ok(
        !masked.includes("LIVEVALUE"),
        `${name} is in the jar but was not masked`,
      );
    }
  });

  it("[redaction] redacts by key across ky / got / axios shapes", () => {
    const shapes = {
      ky: { options: { headers: { cookie: "ak_bmsc=K1" } } },
      got: { options: { headers: { authorization: "Basic R1" } } },
      axios: { config: { headers: { Authorization: "Bearer A1" } } },
      apiKeys: { "x-api-key": "X1", api_key: "X2", apiKey: "X3", token: "X4" },
      secrets: { secret: "S1", password: "P1", "set-cookie": "nsit=C1" },
    };
    const safe = render(redactSensitive(shapes));
    for (const secret of [
      "K1",
      "R1",
      "A1",
      "X1",
      "X2",
      "X3",
      "X4",
      "S1",
      "P1",
      "C1",
    ]) {
      assert.ok(!safe.includes(`'${secret}'`), `${secret} survived: ${safe}`);
    }
  });

  it("[redaction] does NOT redact diagnostic keys that merely contain a sensitive word", () => {
    // A redactor that hides `tokenCount` and `apiKeyId` is a redactor people
    // route around. The key rule is anchored for exactly this reason.
    const out = redactSensitive({
      tokenCount: 42,
      apiKeyId: "kid_123",
      passwordPolicy: "min8",
      secretsManagerRegion: "asia-south1",
    }) as Record<string, unknown>;
    assert.equal(out.tokenCount, 42);
    assert.equal(out.apiKeyId, "kid_123");
    assert.equal(out.passwordPolicy, "min8");
    assert.equal(out.secretsManagerRegion, "asia-south1");
    assert.ok(
      SENSITIVE_KEY_PATTERN.test("token"),
      "sanity: bare key still hits",
    );
  });

  it("[redaction] censors the compound credential names MONEY-1229 added", () => {
    // These six had NO redaction anywhere in the pino path between `a92bcc32`
    // and MONEY-1229. The end-to-end proof lives in
    // `packages/logger/__tests__/config-redaction.test.ts`, which reads the
    // real bytes; this pins the PATTERN itself, so narrowing it here goes red
    // in the package a narrowing edit would actually be made in.
    const out = redactSensitive({
      conn: {
        accessToken: "A",
        refresh_token: "B",
        sessionToken: "C",
        clientSecret: "D",
        DATABASE_URL: "mongodb+srv://u:p@host",
        REDIS_URL: "redis://default:p@host:6379",
        apiSecret: "E",
        idToken: "F",
      },
    }) as { conn: Record<string, unknown> };
    for (const [key, value] of Object.entries(out.conn)) {
      assert.equal(value, REDACTED, `${key} must be censored`);
    }
  });

  it("[redaction] leaves Kite's instrument identifiers alone", () => {
    // The reason the compound names are SPELLED OUT instead of reached with a
    // `\w+[-_]?token$` suffix rule. These four are instrument IDs, not
    // credentials, and this repo logs them constantly — a suffix rule turns
    // every market-data line into `[REDACTED]`.
    const out = redactSensitive({
      instrument_token: 738561,
      instrumentToken: 738561,
      exchangeToken: 2885,
      symboltoken: "3045",
      accessTokenExpiry: "2026-09-06T00:00:00Z",
    }) as Record<string, unknown>;
    assert.deepEqual(out, {
      instrument_token: 738561,
      instrumentToken: 738561,
      exchangeToken: 2885,
      symboltoken: "3045",
      accessTokenExpiry: "2026-09-06T00:00:00Z",
    });
  });

  it("[redaction] marks a cycle as [Circular] instead of re-walking it", () => {
    interface Node {
      name: string;
      self?: Node;
      child?: Node;
    }
    const root: Node = { name: "root" };
    root.self = root;
    root.child = { name: "child", self: root };

    const out = redactSensitive(root) as Record<string, unknown>;
    // Asserting the MARKER, not merely "it did not throw": with the depth
    // budget in place a missing cycle guard terminates anyway, it just emits a
    // six-deep chain of clones. Only the marker distinguishes the two.
    assert.equal(out.self, CIRCULAR);
    const child = out.child as Record<string, unknown>;
    assert.equal(child.self, CIRCULAR);
    assert.equal(child.name, "child");
  });

  it("[redaction] treats a shared (acyclic) subtree as data, not as a cycle", () => {
    // Dropping the ancestor on the way out is what keeps a DAG readable; if the
    // guard degraded to "seen anywhere", `b` below would print as [Circular].
    const shared = { id: "shared" };
    const out = redactSensitive({ a: shared, b: shared }) as Record<
      string,
      unknown
    >;
    assert.deepEqual(out.a, { id: "shared" });
    assert.deepEqual(out.b, { id: "shared" });
  });

  it("[redaction] truncates below the depth budget instead of recursing forever", () => {
    const deep = { l1: { l2: { l3: { l4: "here" } } } };
    const out = redactSensitive(deep, 2) as Record<string, unknown>;
    const l1 = out.l1 as Record<string, unknown>;
    assert.equal(l1.l2, TRUNCATED);
    // A truncated node is not printed at all, so it cannot leak.
    assert.ok(!render(out).includes("here"));
  });

  it("[redaction] never throws on a getter that throws", () => {
    const hostile: Record<string, unknown> = { safe: "kept" };
    Object.defineProperty(hostile, "explode", {
      get() {
        throw new Error("getter says no");
      },
      enumerable: true,
      configurable: true,
    });

    let out: unknown;
    assert.doesNotThrow(() => {
      out = redactSensitive(hostile);
    });
    const record = out as Record<string, unknown>;
    assert.equal(record.explode, UNSERIALIZABLE);
    assert.equal(record.safe, "kept", "one bad getter must not lose the rest");
  });

  it("[redaction] never throws on hostile / revoked Proxies", () => {
    const trapped = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys says no");
        },
        get() {
          throw new Error("get says no");
        },
      },
    );
    assert.doesNotThrow(() => redactSensitive({ trapped }));
    assert.equal(
      (redactSensitive({ trapped }) as Record<string, unknown>).trapped,
      UNSERIALIZABLE,
    );

    const revocable = Proxy.revocable({ a: 1 }, {});
    revocable.revoke();
    assert.doesNotThrow(() => redactSensitive({ dead: revocable.proxy }));
  });

  it("[redaction] summarises Buffers instead of walking or printing them", () => {
    const buf = Buffer.from("cookie: ak_bmsc=SECRETBUF");
    const out = redactSensitive({ body: buf }) as Record<string, unknown>;
    assert.equal(out.body, `[Buffer ${buf.byteLength} bytes]`);
    const safe = render(out);
    assert.ok(!safe.includes("SECRETBUF"), safe);
    // A raw Buffer of that size inspects to its bytes; the summary is also what
    // stops a 5 MB response body from being pasted into a log line.
    assert.ok(!safe.includes("73 65 63"), safe);

    const view = new Uint8Array([1, 2, 3]);
    assert.equal(
      (redactSensitive({ view }) as Record<string, unknown>).view,
      "[Uint8Array 3 bytes]",
    );
  });

  it("[redaction] flattens fetch Request/Response and Headers without their cookies", () => {
    const req = new Request("https://www.nseindia.com/api/x", {
      headers: {
        cookie: "ak_bmsc=SECRETREQ",
        "user-agent": "Mozilla/5.0",
      },
    });
    // CONTROL: undici's custom inspector inlines the whole Headers bag even at
    // inspect's DEFAULT depth of 2 — the depth limit is not a mitigation here.
    assert.ok(util.inspect({ request: req }).includes("SECRETREQ"));

    const out = redactSensitive({ request: req }) as Record<string, unknown>;
    const safe = render(out);
    assert.ok(!safe.includes("SECRETREQ"), safe);
    assert.ok(safe.includes("nseindia.com/api/x"), "URL must survive");
    assert.ok(safe.includes("Mozilla/5.0"), "benign headers must survive");

    const res = new Response("body", {
      status: 403,
      headers: { "set-cookie": "ak_bmsc=SECRETRES; Path=/" },
    });
    const safeRes = render(redactSensitive({ response: res }));
    assert.ok(!safeRes.includes("SECRETRES"), safeRes);
    assert.ok(safeRes.includes("403"), "status must survive");
  });

  it("[redaction] walks Error.cause even though it is non-enumerable", () => {
    const cause = Object.assign(new Error("transport failed"), {
      options: { headers: { cookie: "ak_bmsc=SECRETCAUSE" } },
    });
    const err = new Error("wrapper", { cause });
    const safe = render(redactSensitive(err));
    assert.ok(!safe.includes("SECRETCAUSE"), safe);
    assert.ok(safe.includes("transport failed"), safe);
  });

  it("[redaction] handles Map / Set / URL / symbols / functions", () => {
    const out = redactSensitive({
      map: new Map<string, string>([
        ["cookie", "ak_bmsc=SECRETMAP"],
        ["x-request-id", "req-1"],
      ]),
      set: new Set(["ak_bmsc=SECRETSET"]),
      url: new URL("https://x.test/cb?token=SECRETURL&Bearer%20x=1"),
      sym: Symbol("sym"),
      fn: function namedFn() {},
    }) as Record<string, unknown>;

    const safe = render(out);
    assert.ok(!safe.includes("SECRETMAP"), safe);
    assert.ok(!safe.includes("SECRETSET"), safe);
    assert.deepEqual(out.map, { cookie: REDACTED, "x-request-id": "req-1" });
    assert.equal(out.fn, "[Function: namedFn]");
    assert.equal(out.sym, "Symbol(sym)");
  });

  it("[redaction] passes primitives through unchanged", () => {
    assert.equal(redactSensitive(null), null);
    assert.equal(redactSensitive(undefined), undefined);
    assert.equal(redactSensitive(7), 7);
    assert.equal(redactSensitive(true), true);
    assert.equal(redactSensitive(9n), 9n);
    assert.equal(redactSensitive("plain text"), "plain text");
  });
});
