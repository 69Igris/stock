/**
 * Broker failure classifier — MONEY-502 (ZA-4)
 *
 * Tests `classifyBrokerError`, the pure mapper from a raw broker error message
 * to a stable {errorClass, errorCode, recoveryAction} that the failure log
 * groups by. Inline mirror of `lib/brokers/failure-log.ts` (+ the
 * `mapKnownBrokerError` USER_NOT_ENABLED case it reuses) — same convention as
 * the other broker/api tests (avoids the `@/` alias + the prisma import that
 * failure-log.ts pulls in via `recordBrokerFailure`).
 *
 * Source: apps/web/lib/brokers/failure-log.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

type BrokerErrorClass =
  | "AUTH_EXPIRED"
  | "USER_NOT_ENABLED"
  | "RATE_LIMIT"
  | "NETWORK"
  | "UPSTREAM_5XX"
  | "VALIDATION"
  | "UNKNOWN";

// Inlined from lib/brokers/known-errors.ts (USER_NOT_ENABLED case only).
function mapKnownBrokerError(raw: string): { code: string } | null {
  const msg = raw.toLowerCase();
  if (
    msg.includes("not enabled for the app") ||
    msg.includes("zerodha: the user is not enabled")
  ) {
    return { code: "ZERODHA_USER_NOT_ENABLED" };
  }
  return null;
}

// Inlined from lib/brokers/failure-log.ts → classifyBrokerError.
function classifyBrokerError(raw: string): {
  errorClass: BrokerErrorClass;
  errorCode?: string;
  recoveryAction?: string;
} {
  const msg = (raw || "").toLowerCase();
  const known = mapKnownBrokerError(raw);
  if (known?.code === "ZERODHA_USER_NOT_ENABLED") {
    return {
      errorClass: "USER_NOT_ENABLED",
      errorCode: known.code,
      recoveryAction: "switch_broker",
    };
  }
  const statusMatch = raw.match(/API Error:\s*(\d{3})/);
  const status = statusMatch ? parseInt(statusMatch[1]!, 10) : undefined;
  const httpCode = status ? `HTTP_${status}` : undefined;
  if (
    status === 401 ||
    msg.includes("token") ||
    msg.includes("session") ||
    msg.includes("expired") ||
    msg.includes("unauthor")
  ) {
    return {
      errorClass: "AUTH_EXPIRED",
      errorCode: httpCode,
      recoveryAction: "reauth",
    };
  }
  if (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("rate") ||
    msg.includes("too many")
  ) {
    return {
      errorClass: "RATE_LIMIT",
      errorCode: httpCode ?? "HTTP_429",
      recoveryAction: "retry",
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      errorClass: "UPSTREAM_5XX",
      errorCode: httpCode,
      recoveryAction: "retry",
    };
  }
  if (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  ) {
    return {
      errorClass: "NETWORK",
      errorCode: httpCode,
      recoveryAction: "retry",
    };
  }
  if (status === 400 || msg.includes("invalid") || msg.includes("validation")) {
    return { errorClass: "VALIDATION", errorCode: httpCode ?? "HTTP_400" };
  }
  return { errorClass: "UNKNOWN", errorCode: httpCode };
}

describe("classifyBrokerError (MONEY-502 failure log)", () => {
  it("classifies the Zerodha user-not-enabled whitelist error", () => {
    const r = classifyBrokerError(
      "ZERODHA: The user is not enabled for the app"
    );
    assert.equal(r.errorClass, "USER_NOT_ENABLED");
    assert.equal(r.errorCode, "ZERODHA_USER_NOT_ENABLED");
    assert.equal(r.recoveryAction, "switch_broker");
  });

  it("classifies auth/token expiry → AUTH_EXPIRED + reauth", () => {
    assert.equal(
      classifyBrokerError("ZERODHA API Error: 403 - access_token invalid")
        .errorClass,
      "AUTH_EXPIRED"
    );
    assert.equal(
      classifyBrokerError("ZERODHA API Error: 401 - unauthorized").errorClass,
      "AUTH_EXPIRED"
    );
    assert.equal(
      classifyBrokerError("Token has expired").recoveryAction,
      "reauth"
    );
  });

  it("extracts the HTTP status into errorCode", () => {
    assert.equal(
      classifyBrokerError("ZERODHA API Error: 403 - token expired").errorCode,
      "HTTP_403"
    );
  });

  it("classifies rate limiting → RATE_LIMIT + retry", () => {
    assert.equal(
      classifyBrokerError("ZERODHA API Error: 429 - too many requests")
        .errorClass,
      "RATE_LIMIT"
    );
    assert.equal(
      classifyBrokerError("rate limit exceeded").recoveryAction,
      "retry"
    );
  });

  it("classifies 5xx → UPSTREAM_5XX + retry", () => {
    assert.equal(
      classifyBrokerError("ZERODHA API Error: 502 - bad gateway").errorClass,
      "UPSTREAM_5XX"
    );
    assert.equal(
      classifyBrokerError("ZERODHA API Error: 503 - service unavailable")
        .recoveryAction,
      "retry"
    );
  });

  it("classifies network errors → NETWORK + retry", () => {
    assert.equal(
      classifyBrokerError("connect ECONNREFUSED 127.0.0.1:443").errorClass,
      "NETWORK"
    );
    assert.equal(classifyBrokerError("fetch failed").errorClass, "NETWORK");
  });

  it("classifies a 400 / invalid params → VALIDATION", () => {
    assert.equal(
      classifyBrokerError("ZERODHA API Error: 400 - invalid params").errorClass,
      "VALIDATION"
    );
  });

  it("defaults to UNKNOWN with no status / pattern", () => {
    const r = classifyBrokerError("something weird happened");
    assert.equal(r.errorClass, "UNKNOWN");
    assert.equal(r.errorCode, undefined);
  });
});
