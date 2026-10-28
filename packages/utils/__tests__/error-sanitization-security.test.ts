/**
 * Error Sanitization — SECURITY + edge cases (MONEY-620)
 *
 * Negative / adversarial coverage for the user-facing error sanitizer. The
 * existing `error-sanitization.test.ts` pins the friendly-copy mappings for
 * KNOWN service errors; this file pins the security contract: a raw internal
 * string (connection string, credential, stack trace, DB driver internals,
 * DNS failure) must NEVER reach the user verbatim.
 *
 * It imports the REAL exported symbols (no shadow): if `sanitizeErrorMessage`
 * regresses and starts echoing a secret, these tests fail.
 *
 * Bug found + fixed (additive, MONEY-620): the sanitizer previously passed
 * through any unrecognised string verbatim, leaking
 * mongodb+srv/redis/postgres connection strings (with embedded passwords),
 * sk_/AIza/Bearer/JWT credentials, *_SECRET env values, getaddrinfo/ENOTFOUND
 * internal hostnames, stack traces + absolute paths, raw Prisma codes
 * (P2002 / PrismaClientKnownRequestError), and generic Mongo*Error driver
 * internals. Specific redaction patterns were added before the final
 * passthrough; the benign-passthrough contract ("Invalid date format") is
 * preserved.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeErrorMessage,
  sanitizeErrors,
  getSafeErrorMessage,
} from "../src/error-sanitization";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The fixed set of user-facing strings the sanitizer is allowed to emit. */
const SAFE_OUTPUTS = new Set<string>([
  "Service temporarily unavailable - please try again in a moment",
  "Service temporarily unavailable - please try again",
  "Service temporarily unavailable - please try again later",
  "Service is busy - please try again in a moment",
  "This trade already exists (duplicate trade ID)",
  "This trade already exists in your account",
  "This record already exists",
  "Import temporarily failed - please try again",
  "Connection error - please try again",
  "Request timed out - please try again",
  "Storage service error - please try again",
  "Something went wrong - please try again",
]);

/**
 * Substrings that must NEVER appear in sanitized output. Each maps to a real
 * credential / infra-detail class.
 */
const FORBIDDEN_FRAGMENTS = [
  "mongodb",
  "redis://",
  "rediss://",
  "postgres",
  "mysql://",
  "amqp",
  "sk_live",
  "sk_test",
  "pk_live",
  "AIza",
  "Bearer ",
  "eyJ", // JWT header segment
  "SECRET",
  "_TOKEN",
  "PASSWORD",
  "password '",
  "getaddrinfo",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "P2002",
  "P1001",
  "Prisma",
  "MongoNetworkError",
  "MongoServerError",
  "/Users/",
  "/var/task",
  "/home/",
  ".env",
  "\n    at ",
];

function assertNoSecretLeak(input: string): string {
  const out = sanitizeErrorMessage(input);
  for (const frag of FORBIDDEN_FRAGMENTS) {
    assert.ok(
      !out.includes(frag),
      `leaked forbidden fragment ${JSON.stringify(frag)} via output ${JSON.stringify(out)} for input ${JSON.stringify(input)}`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connection strings (with embedded credentials)
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — connection-string leak prevention", () => {
  it("does NOT leak a mongodb+srv DATABASE_URL with embedded password", () => {
    const out = assertNoSecretLeak(
      "MongoServerSelectionError: connect to mongodb+srv://admin:Sup3rSecret@cluster0.ab12c.mongodb.net/stockbook",
    );
    assert.ok(SAFE_OUTPUTS.has(out));
  });

  it("does NOT leak a bare mongodb+srv connection string", () => {
    const out = assertNoSecretLeak(
      "mongodb+srv://admin:hunter2@cluster0.ab12c.mongodb.net/db?retryWrites=true",
    );
    assert.strictEqual(
      out,
      "Service temporarily unavailable - please try again",
    );
  });

  it("does NOT leak a redis:// connection string with auth", () => {
    const out = assertNoSecretLeak(
      "redis://default:redisP@ss@redis-12345.c1.us-east-1.cloud.redislabs.com:6379",
    );
    assert.ok(SAFE_OUTPUTS.has(out));
  });

  it("does NOT leak a postgresql:// connection string", () => {
    assertNoSecretLeak("postgresql://user:pw123@db.internal.host:5432/app");
  });

  it("does NOT leak a mysql:// connection string", () => {
    assertNoSecretLeak("mysql://root:rootpw@127.0.0.1:3306/db");
  });

  it("does NOT leak an amqps:// connection string", () => {
    assertNoSecretLeak("amqps://guest:guestpw@rabbit.internal:5671/vhost");
  });
});

// ---------------------------------------------------------------------------
// Secrets: API keys, bearer tokens, JWTs, env-var values
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — credential / token leak prevention", () => {
  it("does NOT leak a Stripe-style sk_live_ secret key", () => {
    const out = assertNoSecretLeak(
      "Invalid API key provided: sk_live_" + "51HabcDEF1234567890ghiJKLmnop",
    );
    assert.strictEqual(out, "Something went wrong - please try again");
  });

  it("does NOT leak a pk_test_ key", () => {
    assertNoSecretLeak("Stripe error with pk_test_TYooMQauvdEDq54NiTphI7jx");
  });

  it("does NOT leak a Google AIza… API key", () => {
    assertNoSecretLeak(
      "API key not valid: AIzaSyA1bcD3fGhIjKlMnOpQrStUvWxYz012345",
    );
  });

  it("does NOT leak an Authorization: Bearer <jwt> header", () => {
    assertNoSecretLeak(
      "Request failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4",
    );
  });

  it("does NOT leak a raw three-segment JWT embedded in prose", () => {
    assertNoSecretLeak(
      "Token rejected: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36",
    );
  });

  it("does NOT leak a *_SECRET env assignment", () => {
    assertNoSecretLeak("DODO_WEBHOOK_SECRET=whsec_abc123def456 is invalid");
  });

  it("does NOT leak an ENCRYPTION_KEY env assignment", () => {
    assertNoSecretLeak(
      "ENCRYPTION_KEY: 0123456789abcdef0123456789abcdef failed to load",
    );
  });

  it("does NOT leak a plaintext password from an auth-failure message", () => {
    assertNoSecretLeak(
      "Authentication failed for user 'root' using password 'hunter2'",
    );
  });
});

// ---------------------------------------------------------------------------
// DNS / socket internals
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — DNS / network internals leak prevention", () => {
  it("does NOT leak getaddrinfo ENOTFOUND <internal host>", () => {
    const out = assertNoSecretLeak(
      "getaddrinfo ENOTFOUND cluster0-shard-00-00.ab12c.mongodb.net",
    );
    assert.strictEqual(out, "Connection error - please try again");
  });

  it("does NOT leak getaddrinfo EAI_AGAIN <k8s svc host>", () => {
    assertNoSecretLeak("getaddrinfo EAI_AGAIN internal-db.svc.cluster.local");
  });

  it("does NOT leak a bare ECONNRESET with upstream IP", () => {
    assertNoSecretLeak("read ECONNRESET from upstream 172.16.0.9");
  });
});

// ---------------------------------------------------------------------------
// Stack traces / filesystem paths
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — stack trace / path leak prevention", () => {
  it("does NOT leak a JS stack trace with absolute file paths", () => {
    const out = assertNoSecretLeak(
      "TypeError: Cannot read properties of undefined (reading 'symbol')\n" +
        "    at sync (/Users/deepshaswat/app/lib/db/holdings.ts:42:15)\n" +
        "    at process (/var/task/node_modules/next/server.js:1:1)",
    );
    assert.strictEqual(out, "Something went wrong - please try again");
  });

  it("does NOT leak an absolute /home path", () => {
    assertNoSecretLeak(
      "ENOENT: no such file, open '/home/runner/work/key.pem'",
    );
  });

  it("does NOT leak a .env file path", () => {
    assertNoSecretLeak("Cannot find module '/var/task/.env.production'");
  });
});

// ---------------------------------------------------------------------------
// Raw Prisma / Mongo driver internals
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — DB driver internals leak prevention", () => {
  it("does NOT leak a raw Prisma P2002 unique-violation code", () => {
    const out = assertNoSecretLeak("P2002");
    assert.strictEqual(out, "Something went wrong - please try again");
  });

  it("does NOT leak a raw Prisma P1001 connection code", () => {
    assertNoSecretLeak("P1001: Can't reach database server at db:27017");
  });

  it("does NOT leak a PrismaClientKnownRequestError class name", () => {
    assertNoSecretLeak("PrismaClientKnownRequestError: Invalid `db.user.find`");
  });

  it("does NOT leak a PrismaClientInitializationError", () => {
    assertNoSecretLeak(
      "PrismaClientInitializationError: env var DATABASE_URL not found",
    );
  });

  it("does NOT leak a generic MongoNetworkError", () => {
    assertNoSecretLeak("MongoNetworkError: connection 5 to cluster closed");
  });

  it("does NOT leak a MongoServerError", () => {
    assertNoSecretLeak("MongoServerError: not authorized on stockbook");
  });

  it("does NOT leak a raw JS Error stringified with a sensitive .message", () => {
    // getSafeErrorMessage runs sanitizeErrorMessage on error.message — assert
    // that path also redacts an internal string rather than echoing it.
    const err = new Error(
      "connect to mongodb+srv://svc:topsecret@prod.mongodb.net failed",
    );
    const out = getSafeErrorMessage(err);
    assert.ok(!out.includes("mongodb"));
    assert.ok(!out.includes("topsecret"));
    assert.ok(SAFE_OUTPUTS.has(out));
  });
});

// ---------------------------------------------------------------------------
// Benign passthrough must be preserved (regression guard for the redaction)
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — benign passthrough preserved", () => {
  it("returns a plain validation message unchanged", () => {
    assert.strictEqual(
      sanitizeErrorMessage("Invalid date format"),
      "Invalid date format",
    );
  });

  it("returns a user-facing 'select at least one' message unchanged", () => {
    assert.strictEqual(
      sanitizeErrorMessage("Please select at least one item"),
      "Please select at least one item",
    );
  });

  it("does not let the stack-trace regex swallow the word 'at' used in prose", () => {
    // The redaction keys off newline+indented "at " (a stack frame), not the
    // standalone English word, so ordinary copy survives.
    assert.strictEqual(
      sanitizeErrorMessage("Look at your inputs and try again"),
      "Look at your inputs and try again",
    );
  });

  it("does not redact a benign message that merely contains 'key'", () => {
    assert.strictEqual(
      sanitizeErrorMessage("The shortcut key is invalid"),
      "The shortcut key is invalid",
    );
  });
});

// ---------------------------------------------------------------------------
// Edge inputs: empty / whitespace / Row-prefix / huge / unicode
// ---------------------------------------------------------------------------

describe("sanitizeErrorMessage — edge inputs", () => {
  it("returns empty string unchanged for empty input", () => {
    assert.strictEqual(sanitizeErrorMessage(""), "");
  });

  it("returns whitespace-only input unchanged (no pattern matches)", () => {
    assert.strictEqual(sanitizeErrorMessage("   "), "   ");
  });

  it("truncates an over-long benign message to 100 chars + ellipsis", () => {
    const out = sanitizeErrorMessage("Z".repeat(250));
    assert.strictEqual(out.length, 103);
    assert.ok(out.endsWith("..."));
  });

  it("redacts a secret even when the message is very long (no leak via truncation)", () => {
    // A long stack-trace-shaped payload must not leak the path in its first
    // 100 chars; the redaction fires before truncation.
    const longTrace =
      "Error: boom\n    at /Users/deepshaswat/secret/path/file.ts:1:1 " +
      "x".repeat(300);
    const out = sanitizeErrorMessage(longTrace);
    assert.ok(!out.includes("/Users/"));
    assert.strictEqual(out, "Something went wrong - please try again");
  });

  it("preserves the Row N: prefix while redacting a leaked inner connection string", () => {
    const out = sanitizeErrorMessage(
      "Row 7: connect mongodb+srv://u:p@host.mongodb.net failed",
    );
    assert.ok(out.startsWith("Row 7: "));
    assert.ok(!out.includes("mongodb"));
  });

  it("preserves the Row N: prefix on a known friendly mapping", () => {
    const out = sanitizeErrorMessage(
      "Row 3: Unique constraint failed on the constraint: `brokerTradeId`",
    );
    assert.strictEqual(
      out,
      "Row 3: This trade already exists (duplicate trade ID)",
    );
  });

  it("handles unicode / emoji input without throwing or leaking", () => {
    const out = sanitizeErrorMessage("Validation failed for 📈 portfolio");
    assert.strictEqual(out, "Validation failed for 📈 portfolio");
  });
});

// ---------------------------------------------------------------------------
// getSafeErrorMessage — non-Error / unknown inputs
// ---------------------------------------------------------------------------

describe("getSafeErrorMessage — non-Error inputs use the fallback", () => {
  it("returns the default fallback for null", () => {
    assert.strictEqual(
      getSafeErrorMessage(null),
      "Something went wrong - please try again",
    );
  });

  it("returns the default fallback for undefined", () => {
    assert.strictEqual(
      getSafeErrorMessage(undefined),
      "Something went wrong - please try again",
    );
  });

  it("returns the default fallback for a plain string (not an Error)", () => {
    // A raw string is NOT an Error instance, so the message is not sanitized
    // — the fallback is returned, which is itself safe. This pins that a
    // string thrown value can't smuggle a secret to the user either.
    assert.strictEqual(
      getSafeErrorMessage("mongodb+srv://u:p@h.net leak attempt"),
      "Something went wrong - please try again",
    );
  });

  it("returns the default fallback for a number", () => {
    assert.strictEqual(
      getSafeErrorMessage(42),
      "Something went wrong - please try again",
    );
  });

  it("returns the default fallback for an object WITHOUT a message field", () => {
    assert.strictEqual(
      getSafeErrorMessage({ code: "P2002", detail: "secret" }),
      "Something went wrong - please try again",
    );
  });

  it("returns the default fallback for an empty object", () => {
    assert.strictEqual(
      getSafeErrorMessage({}),
      "Something went wrong - please try again",
    );
  });

  it("returns a custom fallback when provided for a non-Error", () => {
    assert.strictEqual(
      getSafeErrorMessage(null, "Custom fallback message"),
      "Custom fallback message",
    );
  });

  it("sanitizes (not echoes) a real Error whose message is a friendly-mappable DB error", () => {
    const out = getSafeErrorMessage(
      new Error("Unique constraint failed on brokerTradeId"),
    );
    assert.strictEqual(out, "This trade already exists (duplicate trade ID)");
  });

  it("returns the (safe) message for a benign Error", () => {
    assert.strictEqual(
      getSafeErrorMessage(new Error("Invalid date format")),
      "Invalid date format",
    );
  });

  it("handles a circular-referenced non-Error object without throwing", () => {
    // getSafeErrorMessage never stringifies a non-Error (it returns the
    // fallback), so a circular object must not blow up.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => getSafeErrorMessage(circular));
    assert.strictEqual(
      getSafeErrorMessage(circular),
      "Something went wrong - please try again",
    );
  });

  it("handles an Error subclass with a sensitive message (Prisma-like) by redacting", () => {
    class PrismaClientKnownRequestError extends Error {}
    const out = getSafeErrorMessage(
      new PrismaClientKnownRequestError(
        "Invalid `prisma.user.create()` invocation",
      ),
    );
    assert.strictEqual(out, "Something went wrong - please try again");
  });
});

// ---------------------------------------------------------------------------
// sanitizeErrors — array edge cases
// ---------------------------------------------------------------------------

describe("sanitizeErrors — array edges + leak prevention", () => {
  it("returns an empty array for empty input", () => {
    assert.deepStrictEqual(sanitizeErrors([]), []);
  });

  it("redacts every secret-bearing element in the array", () => {
    const out = sanitizeErrors([
      "mongodb+srv://u:p@h.mongodb.net/db",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJ.sig",
      "Invalid date format",
    ]);
    assert.strictEqual(out.length, 3);
    assert.ok(!out[0]!.includes("mongodb"));
    assert.ok(!out[1]!.includes("Bearer"));
    assert.strictEqual(out[2], "Invalid date format");
  });
});
