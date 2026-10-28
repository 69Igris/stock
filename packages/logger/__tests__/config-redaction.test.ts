/**
 * MONEY-1209 — pino serializers must redact before the line leaves the process.
 *
 * `workers/src/log-boundary.ts` wraps `console`, and pino does not go through
 * `console`: it writes JSON straight to its own stream (stdout plus the Datadog
 * multistream). So the console boundary cannot see these lines at all, and this
 * is the second, independent place the same leak can reach a log sink.
 *
 * It is also the WORSE of the two. `util.inspect` at least has a depth limit;
 * `JSON.stringify` has none, so an unredacted pino error line publishes the
 * entire `options` / `config` / `response` subtree — the whole credentialed
 * request — rather than an elided `[Object]`.
 *
 * Asserted against the REAL exported `pinoConfig`, driving a REAL pino logger,
 * and inspecting the REAL bytes it writes. Asserting the shape of the config
 * object alone would pass on a config pino never reads.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";

import { pinoConfig } from "../src/config";

const SECRETS = ["SECRET1", "SECRET2", "TOKENX"] as const;

/** The ky `HTTPError` shape named in the ticket. */
function fakeKyError(): Error {
  return Object.assign(
    new Error("Request failed with status code 403 Forbidden"),
    {
      name: "HTTPError",
      options: {
        headers: {
          cookie: "ak_bmsc=SECRET1; bm_sz=SECRET2",
          authorization: "Bearer TOKENX",
        },
        method: "get",
      },
    },
  );
}

/**
 * Drive the real config into a capture stream.
 *
 * `transport` is dropped because pino refuses `{ transport }` together with an
 * explicit stream, and under `NODE_ENV=development` the config carries a
 * pino-pretty transport. Dropping it changes the FORMATTING destination only —
 * `serializers`, the thing under test, is untouched.
 */
function captureLines(emit: (logger: pino.Logger) => void): string {
  const chunks: string[] = [];
  const sink = {
    write(line: string): boolean {
      chunks.push(line);
      return true;
    },
  };
  const logger = pino(
    { ...pinoConfig, transport: undefined },
    sink as unknown as pino.DestinationStream,
  );
  emit(logger);
  return chunks.join("");
}

describe("MONEY-1209 - pino serializer redaction", () => {
  it("[pino] control: the std error serializer DOES leak this shape", () => {
    // Without this, every assertion below could be passing because the leak
    // never existed in this shape rather than because we stopped it.
    const raw = JSON.stringify(pino.stdSerializers.err(fakeKyError()));
    for (const secret of SECRETS) {
      assert.ok(
        raw.includes(secret),
        `control failed: pino.stdSerializers.err did not emit ${secret}`,
      );
    }
  });

  it("[pino] redacts an error logged under the `error` key", () => {
    const out = captureLines((logger) => {
      logger.error({ error: fakeKyError() }, "nse sync failed");
    });
    for (const secret of SECRETS) {
      assert.ok(!out.includes(secret), `${secret} survived: ${out}`);
    }
    assert.ok(out.includes("403 Forbidden"), "the message must survive");
    assert.ok(out.includes("[REDACTED]"), out);
  });

  it("[pino] redacts an error logged under pino's default `err` key", () => {
    // pino's built-in error key is `err` and no config can turn it off; a
    // wrapper on `error` alone just moves the leak one key over.
    const out = captureLines((logger) => {
      logger.error({ err: fakeKyError() }, "nse sync failed");
    });
    for (const secret of SECRETS) {
      assert.ok(!out.includes(secret), `${secret} survived: ${out}`);
    }
  });

  it("[pino] output stays valid JSON lines after redaction", () => {
    // A redactor that mangles the line is a redactor that breaks every log
    // query built on it.
    const out = captureLines((logger) => {
      logger.error({ error: fakeKyError() }, "nse sync failed");
    });
    const parsed = JSON.parse(out.trim()) as {
      msg: string;
      error: { name: string; options: { headers: Record<string, string> } };
    };
    assert.equal(parsed.msg, "nse sync failed");
    assert.equal(parsed.error.name, "HTTPError");
    assert.equal(parsed.error.options.headers.cookie, "[REDACTED]");
    assert.equal(parsed.error.options.headers.authorization, "[REDACTED]");
    assert.equal(
      parsed.error.options.method,
      "get",
      "non-credential diagnostics must survive",
    );
  });

  it("[pino] redacts inbound request headers via the `req` serializer", () => {
    // The same bug from the other side: pino's std HTTP serializers copy
    // `headers` verbatim, which on an inbound request is the caller's session.
    const fakeReq = {
      method: "POST",
      url: "/jobs/nse-sync",
      headers: {
        cookie: "ak_bmsc=SECRET1",
        authorization: "Bearer TOKENX",
        "user-agent": "curl/8",
      },
      socket: { remoteAddress: "10.0.0.1", remotePort: 4242 },
    };
    const out = captureLines((logger) => {
      logger.info({ req: fakeReq }, "job received");
    });
    for (const secret of ["SECRET1", "TOKENX"]) {
      assert.ok(!out.includes(secret), `${secret} survived: ${out}`);
    }
    assert.ok(out.includes("/jobs/nse-sync"), "the route must survive");
    assert.ok(out.includes("curl/8"), "benign headers must survive");
  });

  it("[pino] leaves ordinary log lines untouched", () => {
    const out = captureLines((logger) => {
      logger.info({ broker: "ZERODHA", count: 42 }, "sync complete");
    });
    const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
    assert.equal(parsed.broker, "ZERODHA");
    assert.equal(parsed.count, 42);
    assert.equal(parsed.msg, "sync complete");
  });
});

/**
 * MONEY-716 / MONEY-1229 — the redact PATHS, and the DEEP layer that replaced
 * their wildcards.
 *
 * `redact` hooks a PATH; the serializers above hook four KEYS; `formatters.log`
 * hooks EVERY key at EVERY depth. MONEY-716 shipped nineteen paths, sixteen of
 * them `*.k` wildcards, to reach a credential on a hand-built line. `a92bcc32`
 * removed those sixteen on cost — correctly — but shipped nothing in their
 * place, so `accessToken`, `refreshToken`, `sessionToken`, `clientSecret`,
 * `DATABASE_URL` and `REDIS_URL` had no redaction anywhere in the pino path.
 * `formatters.log` (`redactLogObject`) is what closes that, and it is CHEAPER
 * than one wildcard. Re-measured on this branch, real pino 10.2, 5 interleaved
 * rounds x 200k iterations, a realistic request-path object, no-op sink,
 * medians:
 *
 *   baseline, no redact                     3,517 ns/line    1.00x
 *   the three concrete paths                5,938 ns/line    1.69x
 *   + one `*.k` wildcard                    9,533 ns/line    2.71x
 *   + the six wildcards whose loss          21,636 ns/line   6.15x
 *     was the regression
 *   + all sixteen as MONEY-716 shipped      39,004 ns/line  11.09x
 *   + formatters.log (what ships)            8,372 ns/line   2.38x
 *
 * Every case drives the REAL exported `pinoConfig` through a REAL pino logger
 * and reads the REAL bytes, `captureOne` refuses to assert on a stream that
 * received nothing, and every protection case is paired with a control that
 * ablates the layer and proves the shape leaks without it.
 */

/** One log line, parsed. Throws rather than letting an empty capture pass. */
function captureOne(emit: (logger: pino.Logger) => void): {
  raw: string;
  parsed: Record<string, unknown>;
} {
  const raw = captureLines(emit).trim();
  assert.ok(raw.length > 0, "the capture stream received no line at all");
  return { raw, parsed: JSON.parse(raw) as Record<string, unknown> };
}

/**
 * The same config with the named redaction layers ablated — the control.
 *
 * `redact` alone is not enough to ablate: the surviving paths all name shapes
 * the `req` / `res` serializers ALSO cover, so removing one layer would leave
 * the other passing and the control would prove nothing.
 *
 * The `formatters` entry is inert for a `req`-shaped payload and deliberately
 * kept anyway: `redactLogObject` SKIPS the serialized keys, so ablating it
 * changes nothing there — mutation-checked, that removal survives. It is load-
 * bearing for every shape that is NOT one of those four keys, which is what the
 * per-case `{ formatters: {} }` override below relies on.
 */
function unredacted(
  emit: (logger: pino.Logger) => void,
  drop: Partial<pino.LoggerOptions> = {
    redact: undefined,
    serializers: {},
    formatters: {},
  },
): string {
  const chunks: string[] = [];
  const sink = {
    write(line: string): boolean {
      chunks.push(line);
      return true;
    },
  };
  const logger = pino(
    { ...pinoConfig, transport: undefined, ...drop },
    sink as unknown as pino.DestinationStream,
  );
  emit(logger);
  return chunks.join("");
}

/** Every value below is unique, so "it survived" can never be a substring hit. */
const LEAK = {
  auth: "BEARER-LEAK-1",
  cookie: "SESSION-LEAK-2",
  accessToken: "BROKER-LEAK-3",
  email: "person@leak-4.example",
  phone: "9990000004",
} as const;

/**
 * The six key names whose protection `a92bcc32` removed, and the value each
 * one carries in production. One per name so a partial fix cannot pass.
 */
const REGRESSED = {
  accessToken: "KITE-ACCESS-LEAK-A",
  refreshToken: "KITE-REFRESH-LEAK-B",
  sessionToken: "CLERK-SESSION-LEAK-C",
  clientSecret: "DODO-CLIENT-LEAK-D",
  DATABASE_URL: "mongodb+srv://u:DBPASS-LEAK-E@cluster0.example",
  REDIS_URL: "redis://default:REDISPASS-LEAK-F@10.0.0.9:6379",
} as const;

describe("MONEY-716 / MONEY-1229 - pino redact paths and the deep layer", () => {
  it("[redact] control: this shape DOES leak with every layer removed", () => {
    // Without this, the assertion below could be passing because the shape was
    // never reachable rather than because we censor it.
    const out = unredacted((logger) => {
      logger.info(
        {
          req: {
            method: "POST",
            url: "/api/brokers/zerodha/callback",
            headers: { authorization: LEAK.auth, cookie: LEAK.cookie },
          },
        },
        "control",
      );
    });
    for (const secret of [LEAK.auth, LEAK.cookie]) {
      assert.ok(
        out.includes(secret),
        `control failed: ${secret} was already contained unredacted`,
      );
    }
  });

  it("[redact] censors credentials nested under `req.headers`", () => {
    // The one shape the surviving concrete paths name. Layered on purpose: the
    // `req` serializer covers it too, so this asserts the OUTCOME all layers
    // owe rather than `redact` alone — the paths are the backstop for someone
    // narrowing that serializer.
    const { parsed } = captureOne((logger) => {
      logger.info(
        {
          req: {
            method: "POST",
            url: "/api/brokers/zerodha/callback",
            headers: {
              authorization: LEAK.auth,
              cookie: LEAK.cookie,
              "user-agent": "curl/8",
            },
            socket: { remoteAddress: "10.0.0.1", remotePort: 4242 },
          },
        },
        "callback received",
      );
    });
    const req = parsed.req as { headers: Record<string, string>; url: string };
    assert.equal(req.headers.authorization, "[REDACTED]");
    assert.equal(req.headers.cookie, "[REDACTED]");
    assert.equal(req.url, "/api/brokers/zerodha/callback");
  });

  it("[redact] carries NO wildcard path — the 11x is not allowed back", () => {
    // Every `*.k` walks the object's own top-level keys on EVERY line this
    // platform emits, and once any wildcard exists pino swaps its stringifier
    // for every key. Measured on this branch: 5,938 -> 9,533 ns/line for the
    // FIRST one, 39,004 for the sixteen MONEY-716 shipped. `formatters.log`
    // costs 8,372 and covers strictly more, so a wildcard here would now be a
    // weaker copy of it at a higher price.
    //
    // Asserted on the REAL exported config rather than on a copy of the list,
    // so it cannot go green against a config pino never reads.
    const paths = (pinoConfig.redact as { paths: string[] }).paths;
    assert.ok(paths.length > 0, "the redact layer must not vanish entirely");
    const wildcards = paths.filter((path) => path.includes("*"));
    assert.deepEqual(
      wildcards,
      [],
      `wildcard redact paths cost ~3.6 µs/line each: ${wildcards.join(", ")}`,
    );
  });

  it("[deep] censors the six key names whose wildcards were dropped", () => {
    // THE REGRESSION GUARD. `a92bcc32` removed `*.accessToken`,
    // `*.refreshToken`, `*.sessionToken`, `*.clientSecret`, `*.DATABASE_URL`
    // and `*.REDIS_URL` and put nothing in their place, so a single
    // `logger.info({ conn: { accessToken } })` wrote a live broker token into
    // prod Cloud Logging in cleartext, where it is retained, indexed and
    // replayable by anyone with project log access.
    const { raw, parsed } = captureOne((logger) => {
      logger.info(
        {
          conn: { ...REGRESSED },
          // Depth 1 is where this repo's sensitive keys actually live: the
          // sweep behind a92bcc32 found all nine `email` sites at the TOP
          // level. `*.accessToken` never reached here either — a wildcard
          // needs a parent — so this half is new coverage, not a restoration.
          accessToken: "TOP-LEVEL-LEAK-G",
          broker: "ZERODHA",
        },
        "sync start",
      );
    });
    for (const [key, secret] of Object.entries(REGRESSED)) {
      assert.ok(!raw.includes(secret), `${key} still leaks its value: ${raw}`);
    }
    assert.ok(
      !raw.includes("TOP-LEVEL-LEAK-G"),
      `a top-level credential key leaked: ${raw}`,
    );
    assert.equal(parsed.accessToken, "[REDACTED]");
    const conn = parsed.conn as Record<string, string>;
    for (const key of Object.keys(REGRESSED)) {
      assert.equal(conn[key], "[REDACTED]", `${key} must be censored`);
    }
    assert.equal(parsed.broker, "ZERODHA", "diagnostics must survive");
  });

  it("[deep] control: those six DO leak with `formatters.log` removed", () => {
    // Pairs with the case above. Ablates ONLY `formatters.log`, leaving
    // `redact` and the serializers in place, so this proves the deep layer is
    // what censors them and not something else in the config.
    const out = unredacted(
      (logger) => {
        logger.info({ conn: { ...REGRESSED } }, "sync start");
      },
      { formatters: {} },
    );
    for (const [key, secret] of Object.entries(REGRESSED)) {
      assert.ok(
        out.includes(secret),
        `control failed: ${key} was already censored without formatters.log`,
      );
    }
  });

  it("[deep] reaches depths and arrays that no `*.k` wildcard could", () => {
    // `*` matches EXACTLY ONE level and an array element counts as a level, so
    // the wildcards never covered either of these shapes even before they were
    // dropped. This is the half of the fix that is an upgrade rather than a
    // restoration.
    const { raw } = captureOne((logger) => {
      logger.warn(
        {
          a: { b: { c: { accessToken: "DEEP-LEAK-1" } } },
          connections: [{ broker: "UPSTOX", refreshToken: "ARRAY-LEAK-2" }],
        },
        "outbound call failed",
      );
    });
    assert.ok(
      !raw.includes("DEEP-LEAK-1"),
      `depth-4 credential leaked: ${raw}`,
    );
    assert.ok(
      !raw.includes("ARRAY-LEAK-2"),
      `in-array credential leaked: ${raw}`,
    );
    assert.ok(raw.includes("UPSTOX"), "the sibling diagnostic must survive");
  });

  it("[deep] control: a NON-sensitive key is passed through untouched", () => {
    // Without this, "censor everything" would satisfy every case above. The
    // names here are the ones a suffix rule would have eaten: Kite's
    // `instrument_token` and `exchangeToken` are INSTRUMENT IDENTIFIERS, not
    // credentials, and blanking them turns every market-data line into
    // `[REDACTED]`.
    const { parsed } = captureOne((logger) => {
      logger.info(
        {
          quote: {
            symbol: "RELIANCE",
            instrument_token: 738561,
            instrumentToken: 738561,
            exchangeToken: 2885,
            tokenCount: 42,
            apiKeyId: "kid_123",
            sourceUrl: "https://api.kite.trade/quote",
          },
        },
        "quote received",
      );
    });
    assert.deepEqual(parsed.quote, {
      symbol: "RELIANCE",
      instrument_token: 738561,
      instrumentToken: 738561,
      exchangeToken: 2885,
      tokenCount: 42,
      apiKeyId: "kid_123",
      sourceUrl: "https://api.kite.trade/quote",
    });
  });

  it("[deep] does NOT walk the keys the serializers own", () => {
    // `formatters.log` runs BEFORE the per-key serializers, so a deep-copy of a
    // live `IncomingMessage` here would DESTROY the diagnostics MONEY-1209's
    // `req` serializer exists to keep: `headers` is a PROTOTYPE ACCESSOR in
    // modern Node, so `Object.keys` never sees it and the whole header bag
    // vanishes. A plain-object fake CANNOT catch that, which is why this builds
    // a real one. Measured with the skip removed: {"req":{"method":"POST",
    // "url":"/jobs/nse-sync"}} — no headers, no address, nothing to redact and
    // nothing to debug with.
    const raw = new IncomingMessage(new Socket());
    raw.method = "POST";
    raw.url = "/jobs/nse-sync";
    raw.headers = {
      cookie: `ak_bmsc=${LEAK.cookie}`,
      authorization: `Bearer ${LEAK.auth}`,
      "user-agent": "curl/8",
    };

    const { parsed } = captureOne((logger) => {
      logger.info({ req: raw }, "job received");
    });
    const req = parsed.req as { headers?: Record<string, string>; url: string };
    assert.ok(req.headers, "the header bag must survive the deep layer");
    assert.equal(req.headers.authorization, "[REDACTED]");
    assert.equal(req.headers.cookie, "[REDACTED]");
    assert.equal(req.headers["user-agent"], "curl/8");
    assert.equal(req.url, "/jobs/nse-sync");
  });

  it("[deep] leaves top-level `email` and `actorEmail` intact", () => {
    // Two audit lines exist whose whole point is WHO did it —
    // `account-deletion.service.ts` and `payment-provisioning.service.ts` —
    // and both log the address at the TOP level. A bare `email` path, or an
    // `email` alternative in `SENSITIVE_KEY_PATTERN`, would turn the record
    // into "somebody deleted a user". This pins the contract in both
    // directions: adding either turns it red.
    const { parsed } = captureOne((logger) => {
      logger.info(
        {
          actorEmail: "ops@usemoney.ai",
          email: "deleted-user@example.com",
          action: "user.deleted",
        },
        "admin audit",
      );
    });
    assert.equal(parsed.actorEmail, "ops@usemoney.ai");
    assert.equal(parsed.email, "deleted-user@example.com");
    assert.equal(parsed.action, "user.deleted");
  });

  it("[deep] keeps the line parseable and the message intact", () => {
    // A broken censor breaks every log query built on the line, and pino routes
    // the message through the same stringifier machinery.
    const { parsed } = captureOne((logger) => {
      logger.error(
        { req: { headers: { cookie: LEAK.cookie } }, count: 42, ok: false },
        "sync failed for 1 user",
      );
    });
    assert.equal(parsed.msg, "sync failed for 1 user");
    assert.equal(parsed.count, 42);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.level, "error");
  });

  it("[deep] survives a bare message with no merge object", () => {
    // `formatters.log` is only reached when there IS an object, but a config
    // that throws on `logger.info("...")` would take down every caller that
    // logs a bare string, which is most of them.
    const { parsed } = captureOne((logger) => {
      logger.info("no merge object at all");
    });
    assert.equal(parsed.msg, "no merge object at all");
  });
});
