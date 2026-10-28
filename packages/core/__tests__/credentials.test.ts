/**
 * Google Cloud credential resolver tests (MONEY-780).
 *
 * Covers the pure resolver in packages/core/src/gemini/credentials.ts:
 *   - precedence across all 4 tiers (base64 → JSON-var → key-file → ADC)
 *   - base64 vs raw-JSON parsing + projectId derivation from `project_id`
 *   - malformed input falls through and NEVER throws
 *   - MONEY-806: warn-once PER VAR (a second bad source is NOT silenced) +
 *     the `credentialsFellBackToAdcAfterMalformed()` flag when a malformed var
 *     falls through to ADC (the spreadable resolution stays a clean {})
 *   - memoization + resetGoogleCredentials() seam
 *   - SECRET HYGIENE: the SA-JSON bytes never reach console output
 *
 * No network/auth: googleCredentials() is pure (env → object). We stub
 * console.warn to assert the warn-per-var message and that no secret leaks.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  credentialsFellBackToAdcAfterMalformed,
  googleCredentials,
  resetGoogleCredentials,
} from "../src/gemini/credentials";

const BASE64 = "GCP_SERVICE_ACCOUNT_KEY_BASE64";
const JSON_VAR = "GOOGLE_APPLICATION_CREDENTIALS_JSON";
const KEYFILE = "GOOGLE_APPLICATION_CREDENTIALS";

const CRED_VARS = [BASE64, JSON_VAR, KEYFILE] as const;

function clearEnv(): void {
  for (const v of CRED_VARS) delete process.env[v];
}

/** A realistic SA JSON with a (fake) private key so we can assert it never leaks. */
const FAKE_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nSUPERSECRETKEYBYTES1234567890\n-----END PRIVATE KEY-----\n";
const SA_OBJECT = {
  type: "service_account",
  project_id: "stock-book-483718",
  private_key_id: "abc123",
  private_key: FAKE_PRIVATE_KEY,
  client_email: "svc@stock-book-483718.iam.gserviceaccount.com",
};
const SA_JSON = JSON.stringify(SA_OBJECT);
const SA_BASE64 = Buffer.from(SA_JSON, "utf-8").toString("base64");

/** Capture every console.warn arg into a single joined string. */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return { lines, restore: () => (console.warn = original) };
}

beforeEach(() => {
  clearEnv();
  resetGoogleCredentials();
});
afterEach(() => {
  clearEnv();
  resetGoogleCredentials();
});

describe("googleCredentials — precedence", () => {
  it("(4) returns {} (ADC) when no credential var is set", () => {
    assert.deepStrictEqual(googleCredentials(), {});
  });

  it("(1) GCP_SERVICE_ACCOUNT_KEY_BASE64 wins (base64 → creds + projectId)", () => {
    process.env[BASE64] = SA_BASE64;
    const out = googleCredentials();
    assert.deepStrictEqual(out.credentials, SA_OBJECT);
    assert.strictEqual(out.projectId, "stock-book-483718");
    assert.strictEqual(out.keyFilename, undefined);
  });

  it("(1) base64 takes precedence over the JSON var and the key-file path", () => {
    process.env[BASE64] = SA_BASE64;
    process.env[JSON_VAR] = JSON.stringify({ project_id: "other" });
    process.env[KEYFILE] = "/tmp/key.json";
    const out = googleCredentials();
    // base64 wins → its project_id, not "other", not a keyFilename.
    assert.strictEqual(out.projectId, "stock-book-483718");
    assert.strictEqual(out.keyFilename, undefined);
  });

  it("(2) GOOGLE_APPLICATION_CREDENTIALS_JSON — raw JSON form", () => {
    process.env[JSON_VAR] = SA_JSON;
    const out = googleCredentials();
    assert.deepStrictEqual(out.credentials, SA_OBJECT);
    assert.strictEqual(out.projectId, "stock-book-483718");
  });

  it("(2) GOOGLE_APPLICATION_CREDENTIALS_JSON — base64 form", () => {
    process.env[JSON_VAR] = SA_BASE64;
    const out = googleCredentials();
    assert.deepStrictEqual(out.credentials, SA_OBJECT);
    assert.strictEqual(out.projectId, "stock-book-483718");
  });

  it("(2) JSON var wins over the key-file path", () => {
    process.env[JSON_VAR] = SA_JSON;
    process.env[KEYFILE] = "/tmp/key.json";
    const out = googleCredentials();
    assert.ok(out.credentials);
    assert.strictEqual(out.keyFilename, undefined);
  });

  it("(3) GOOGLE_APPLICATION_CREDENTIALS — key-file path → { keyFilename }", () => {
    process.env[KEYFILE] = "/secrets/sa.json";
    const out = googleCredentials();
    assert.deepStrictEqual(out, { keyFilename: "/secrets/sa.json" });
  });

  it("trims surrounding whitespace on the key-file path", () => {
    process.env[KEYFILE] = "  /secrets/sa.json  ";
    assert.deepStrictEqual(googleCredentials(), {
      keyFilename: "/secrets/sa.json",
    });
  });
});

describe("googleCredentials — projectId derivation", () => {
  it("omits projectId when the SA JSON has no project_id", () => {
    process.env[JSON_VAR] = JSON.stringify({
      type: "service_account",
      client_email: "x@y.iam.gserviceaccount.com",
    });
    const out = googleCredentials();
    assert.ok(out.credentials);
    assert.strictEqual("projectId" in out, false);
  });

  it("omits projectId when project_id is a non-string", () => {
    process.env[JSON_VAR] = JSON.stringify({ project_id: 12345 });
    const out = googleCredentials();
    assert.ok(out.credentials);
    assert.strictEqual(out.projectId, undefined);
  });
});

describe("googleCredentials — malformed input falls through + never throws", () => {
  it("malformed base64 var falls through to the JSON var", () => {
    const { restore } = captureWarn();
    try {
      // Not JSON, not valid base64-of-JSON → parse fails → fall through.
      process.env[BASE64] = "%%%not-base64-or-json%%%";
      process.env[JSON_VAR] = SA_JSON;
      const out = googleCredentials();
      assert.deepStrictEqual(out.credentials, SA_OBJECT);
    } finally {
      restore();
    }
  });

  it("malformed-everywhere falls all the way through to ADC ({})", () => {
    const { restore } = captureWarn();
    try {
      process.env[BASE64] = "{ not json";
      // No JSON var, no key file → ADC. The SPREADABLE resolution stays exactly
      // {} (no diagnostic key leaks into client constructors); the
      // malformed-ADC signal is exposed via the separate accessor below.
      const out = googleCredentials();
      assert.deepStrictEqual(out, {});
      // MONEY-806: but we reached ADC only via an unparseable var → flagged.
      assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), true);
    } finally {
      restore();
    }
  });

  it("never throws on any malformed credential blob", () => {
    const { restore } = captureWarn();
    try {
      for (const bad of [
        "{",
        "{ broken",
        "not base64 ☃",
        Buffer.from("not json at all", "utf-8").toString("base64"),
        "",
      ]) {
        clearEnv();
        resetGoogleCredentials();
        process.env[BASE64] = bad;
        assert.doesNotThrow(() => googleCredentials());
      }
    } finally {
      restore();
    }
  });

  it("warns ONCE PER VAR — a second malformed source is NOT silenced (MONEY-806)", () => {
    const { lines, restore } = captureWarn();
    try {
      // Both the base64 var AND the JSON var fail to parse in a SINGLE
      // resolution → two parse failures → ONE warn per offending var (the old
      // single global latch silenced the second; MONEY-806 surfaces both).
      process.env[BASE64] = "{ broken";
      process.env[JSON_VAR] = "{ also broken";
      googleCredentials();
      assert.strictEqual(lines.length, 2, "each malformed var warns once");
      const joined = lines.join("\n");
      assert.ok(joined.includes(BASE64), "warns about the base64 var");
      assert.ok(joined.includes(JSON_VAR), "warns about the JSON var too");
    } finally {
      restore();
    }
  });

  it("does NOT re-warn the SAME var within a single resolution (per-var once)", () => {
    const { lines, restore } = captureWarn();
    try {
      // Only one malformed var → exactly one warn, naming that var.
      process.env[BASE64] = "{ broken";
      googleCredentials();
      assert.strictEqual(lines.length, 1, "one malformed var → one warn");
      assert.ok(lines[0]!.includes(BASE64));
    } finally {
      restore();
    }
  });
});

describe("credentialsFellBackToAdcAfterMalformed — flag (MONEY-806)", () => {
  it("flags ADC when a creds var was present-but-unparseable", () => {
    const { restore } = captureWarn();
    try {
      // Malformed base64, no JSON var, no key file → ADC, but reached only
      // because the var was unparseable → the flag must be set.
      process.env[BASE64] = "{ not json";
      const out = googleCredentials();
      // Spreadable resolution stays a clean {} — NO diagnostic key leaks.
      assert.deepStrictEqual(out, {});
      assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), true);
    } finally {
      restore();
    }
  });

  it("flags ADC when BOTH creds vars are malformed and fall through", () => {
    const { restore } = captureWarn();
    try {
      process.env[BASE64] = "{ broken";
      process.env[JSON_VAR] = "also { broken";
      googleCredentials();
      assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), true);
    } finally {
      restore();
    }
  });

  it("does NOT flag genuine creds-free ADC (no var set → plain {})", () => {
    const out = googleCredentials();
    assert.deepStrictEqual(out, {});
    assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), false);
  });

  it("does NOT flag when a later source rescues a malformed earlier var", () => {
    const { restore } = captureWarn();
    try {
      // base64 malformed (warns) but the JSON var parses → real creds, NOT ADC,
      // so the flag must be false (resolution did not end at ADC).
      process.env[BASE64] = "%%%bad%%%";
      process.env[JSON_VAR] = SA_JSON;
      const out = googleCredentials();
      assert.ok(out.credentials, "rescued by the JSON var");
      assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), false);
    } finally {
      restore();
    }
  });

  it("does NOT flag when a malformed var falls through to a key-file path", () => {
    const { restore } = captureWarn();
    try {
      process.env[BASE64] = "{ broken";
      process.env[KEYFILE] = "/secrets/sa.json";
      const out = googleCredentials();
      assert.strictEqual(out.keyFilename, "/secrets/sa.json");
      assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), false);
    } finally {
      restore();
    }
  });

  it("reset clears the malformed record so a fresh genuine ADC is unflagged", () => {
    const { restore } = captureWarn();
    try {
      process.env[BASE64] = "{ broken";
      googleCredentials();
      assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), true);
      // Fresh process state: clear env + reset → plain ADC, no stale flag.
      resetGoogleCredentials();
      clearEnv();
      assert.deepStrictEqual(googleCredentials(), {});
      assert.strictEqual(credentialsFellBackToAdcAfterMalformed(), false);
    } finally {
      restore();
    }
  });
});

describe("googleCredentials — secret hygiene (NO leak to logs/errors)", () => {
  it("never writes the SA private key / base64 / JSON bytes to console.warn", () => {
    const { lines, restore } = captureWarn();
    try {
      // Feed a value that LOOKS base64 (so it is attempted) but decodes to
      // non-JSON, forcing the warn path while carrying secret-shaped bytes.
      const secretishBase64 = Buffer.from(FAKE_PRIVATE_KEY, "utf-8").toString(
        "base64",
      );
      process.env[BASE64] = secretishBase64;
      googleCredentials();
      const joined = lines.join("\n");
      assert.ok(lines.length >= 1, "the malformed blob should warn once");
      // The raw env value, the decoded secret, and the key sentinel must all
      // be ABSENT from anything logged.
      assert.ok(
        !joined.includes(secretishBase64),
        "raw base64 must not appear in logs",
      );
      assert.ok(
        !joined.includes(FAKE_PRIVATE_KEY.trim()),
        "decoded private key must not appear in logs",
      );
      assert.ok(
        !joined.includes("SUPERSECRETKEYBYTES"),
        "private-key bytes must not appear in logs",
      );
      // Only the var NAME is allowed.
      assert.ok(joined.includes(BASE64));
    } finally {
      restore();
    }
  });

  it("a valid SA resolution logs NOTHING (no accidental success-path leak)", () => {
    const { lines, restore } = captureWarn();
    try {
      process.env[BASE64] = SA_BASE64;
      const out = googleCredentials();
      assert.ok(out.credentials);
      assert.strictEqual(lines.length, 0, "success path must be silent");
    } finally {
      restore();
    }
  });
});

describe("googleCredentials — memoization + reset seam", () => {
  it("memoizes: a later env change is ignored until reset", () => {
    process.env[KEYFILE] = "/first.json";
    const first = googleCredentials();
    assert.strictEqual(first.keyFilename, "/first.json");

    // Mutate env WITHOUT reset → stale cached value returned.
    process.env[KEYFILE] = "/second.json";
    const second = googleCredentials();
    assert.strictEqual(second.keyFilename, "/first.json");
    assert.strictEqual(first, second, "same cached object reference");
  });

  it("resetGoogleCredentials() re-resolves from the current env", () => {
    process.env[KEYFILE] = "/first.json";
    googleCredentials();
    process.env[KEYFILE] = "/second.json";
    resetGoogleCredentials();
    assert.strictEqual(googleCredentials().keyFilename, "/second.json");
  });

  it("reset clears the per-var warn latch so a fresh malformed blob warns again", () => {
    const { lines, restore } = captureWarn();
    try {
      process.env[BASE64] = "{ broken";
      googleCredentials();
      const afterFirst = lines.length;
      assert.ok(afterFirst >= 1);

      resetGoogleCredentials();
      clearEnv();
      process.env[BASE64] = "{ still broken";
      googleCredentials();
      assert.ok(
        lines.length > afterFirst,
        "reset should allow the per-var warn latch to fire again",
      );
    } finally {
      restore();
    }
  });
});
