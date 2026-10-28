/**
 * MONEY-620 — broker-connection-logic.ts pure unit tests (REAL exports, no shadow).
 *
 * Imports the REAL exported pure helpers from the broker-connection SERVICE
 * logic module (`packages/services/src/broker-connection-logic.ts`) — the exact
 * code that `packages/services/src/broker-connection.service.ts` (the LIVE
 * brokers-page path: `apps/web/lib/actions/broker-connection.ts` →
 * `getBrokerConnectionsAction` / `disconnectBrokerAction`) CALLS. No inline
 * reimplementation: the production mapping/derivation and these assertions run
 * the same bytes (the prior `__tests__/actions/broker-connection*.test.ts`
 * files RE-DECLARED `mapConnectionToInfo` and asserted the copy — a shadow).
 *
 * The module imports only a TYPE from `@usemoney/types`, so importing it never
 * opens a DB/Redis handle — the test stays pure and exits clean (no orphan).
 *
 * Covers the blind spots for this surface:
 *   - CREDENTIAL LEAK (highest priority): the mapped shape NEVER contains an
 *     encrypted credential / token / secret field, even when the input row
 *     carries `encryptedCreds`/`iv`/`authTag`/`accessToken`/`apiSecret`.
 *   - INVALID DATE: a corrupt tokenExpiry/lastSync/connectedAt never throws on
 *     .toISOString() and never renders "Invalid Date"; null lastSync →
 *     "Never synced", not a crash.
 *   - STATE MACHINE: expired token (incl. Invalid-Date) → needsReauth
 *     deterministically; an unknown/missing status → safe default (not active /
 *     not connected).
 *   - BEHAVIOUR-PRESERVING: a clean healthy connection maps to the exact prior
 *     ISO strings + flags.
 *
 * Source: packages/services/src/broker-connection-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isValidDate,
  safeISOString,
  safeISOStringOrNull,
  isTokenExpired,
  deriveNeedsReauth,
  isConnectionActive,
  formatLastSyncedRelative,
  toBrokerConnectionInfo,
  toBrokerSyncStatus,
  findLeakedSecretField,
  allowedConnectionInfoKeys,
  SECRET_FIELD_NAMES,
  type BrokerConnectionRow,
  type BrokerSyncStatusRow,
} from "../../../../packages/services/src/broker-connection-logic";

// ── fixtures ──────────────────────────────────────────────────────────────

const NOW = new Date("2024-06-15T10:00:00.000Z");
const INVALID = new Date("not-a-real-date");

function connRow(
  overrides: Partial<BrokerConnectionRow> = {}
): BrokerConnectionRow {
  return {
    id: "conn-1",
    broker: "ZERODHA",
    brokerUserId: "ZR1234",
    accountName: "My Zerodha",
    status: "CONNECTED",
    connectedAt: new Date("2024-01-10T08:00:00.000Z"),
    lastSync: new Date("2024-06-15T09:30:00.000Z"),
    tokenExpiry: new Date("2024-06-16T03:30:00.000Z"),
    ...overrides,
  };
}

function syncRow(
  overrides: Partial<BrokerSyncStatusRow> = {}
): BrokerSyncStatusRow {
  return {
    id: "conn-1",
    broker: "ZERODHA",
    brokerUserId: "ZR1234",
    accountName: "My Zerodha",
    status: "CONNECTED",
    lastSync: new Date("2024-06-15T09:30:00.000Z"),
    tokenExpiry: new Date("2024-06-16T03:30:00.000Z"),
    ...overrides,
  };
}

// =============================================================================
// isValidDate / safeISOString — the RangeError guard
// =============================================================================

describe("broker-connection-logic isValidDate()", () => {
  it("true only for a real finite Date", () => {
    assert.equal(isValidDate(new Date("2024-06-15T00:00:00Z")), true);
    assert.equal(isValidDate(new Date(0)), true);
  });

  it("false for null / undefined / Invalid Date", () => {
    assert.equal(isValidDate(null), false);
    assert.equal(isValidDate(undefined), false);
    // Invalid Date is a NON-null Date — optional chaining would NOT catch it.
    assert.equal(isValidDate(INVALID), false);
    assert.equal(isValidDate(new Date(NaN)), false);
  });
});

describe("broker-connection-logic safeISOString()", () => {
  it("serialises a valid Date", () => {
    assert.equal(
      safeISOString(new Date("2024-06-15T10:00:00.000Z")),
      "2024-06-15T10:00:00.000Z"
    );
  });

  it("returns undefined for null / undefined (never throws)", () => {
    assert.equal(safeISOString(null), undefined);
    assert.equal(safeISOString(undefined), undefined);
  });

  it("returns undefined for an Invalid Date instead of throwing RangeError", () => {
    // Direct proof the underlying call WOULD throw, so the guard matters.
    assert.throws(() => INVALID.toISOString(), RangeError);
    assert.doesNotThrow(() => safeISOString(INVALID));
    assert.equal(safeISOString(INVALID), undefined);
  });

  it("never renders the literal string 'Invalid Date'", () => {
    assert.notEqual(safeISOString(INVALID), "Invalid Date");
  });
});

describe("broker-connection-logic safeISOStringOrNull()", () => {
  it("returns null (not undefined) for absent/invalid", () => {
    assert.equal(safeISOStringOrNull(null), null);
    assert.equal(safeISOStringOrNull(undefined), null);
    assert.equal(safeISOStringOrNull(INVALID), null);
  });

  it("serialises a valid Date", () => {
    assert.equal(
      safeISOStringOrNull(new Date("2024-06-15T10:00:00.000Z")),
      "2024-06-15T10:00:00.000Z"
    );
  });
});

// =============================================================================
// isTokenExpired — Invalid-Date fail-safe + boundaries
// =============================================================================

describe("broker-connection-logic isTokenExpired()", () => {
  it("null/undefined expiry → NOT expired (no expiry recorded)", () => {
    assert.equal(isTokenExpired(null, NOW), false);
    assert.equal(isTokenExpired(undefined, NOW), false);
  });

  it("valid expiry strictly before now → expired", () => {
    assert.equal(
      isTokenExpired(new Date("2024-06-15T09:59:59.999Z"), NOW),
      true
    );
  });

  it("valid expiry equal to now → NOT expired (strict <)", () => {
    assert.equal(isTokenExpired(new Date(NOW.getTime()), NOW), false);
  });

  it("valid expiry after now → NOT expired", () => {
    assert.equal(
      isTokenExpired(new Date("2024-06-15T10:00:00.001Z"), NOW),
      false
    );
  });

  it("INVALID-DATE expiry → EXPIRED (fail-safe; old `NaN < now` was false)", () => {
    // The old inline `tokenExpiry < now` evaluated `Invalid < now` === false,
    // silently marking a corrupt-expiry connection as healthy. Fail safe.
    assert.equal(INVALID.getTime() < NOW.getTime(), false); // documents the trap
    assert.equal(isTokenExpired(INVALID, NOW), true);
  });
});

// =============================================================================
// deriveNeedsReauth — state machine
// =============================================================================

describe("broker-connection-logic deriveNeedsReauth()", () => {
  it("EXPIRED status → reauth (even with a valid future token)", () => {
    const future = new Date("2024-06-16T00:00:00Z");
    assert.equal(deriveNeedsReauth("EXPIRED", future, NOW), true);
  });

  it("NEEDS_REAUTH status → reauth", () => {
    assert.equal(deriveNeedsReauth("NEEDS_REAUTH", null, NOW), true);
  });

  it("CONNECTED + expired token → reauth (token drives it)", () => {
    assert.equal(
      deriveNeedsReauth("CONNECTED", new Date("2024-06-15T00:00:00Z"), NOW),
      true
    );
  });

  it("CONNECTED + valid token → NO reauth", () => {
    assert.equal(
      deriveNeedsReauth("CONNECTED", new Date("2024-06-16T00:00:00Z"), NOW),
      false
    );
  });

  it("CONNECTED + Invalid-Date token → reauth (fail-safe)", () => {
    assert.equal(deriveNeedsReauth("CONNECTED", INVALID, NOW), true);
  });

  it("ERROR status with a valid token → NO reauth (preserves prior behaviour)", () => {
    // The source only treats EXPIRED/NEEDS_REAUTH (or an expired token) as
    // reauth; ERROR with a live token is left as-is.
    assert.equal(
      deriveNeedsReauth("ERROR", new Date("2024-06-16T00:00:00Z"), NOW),
      false
    );
  });

  it("unknown / empty / null status with a valid token → NO reauth", () => {
    const future = new Date("2024-06-16T00:00:00Z");
    assert.equal(deriveNeedsReauth("WEIRD", future, NOW), false);
    assert.equal(deriveNeedsReauth("", future, NOW), false);
    assert.equal(deriveNeedsReauth(null, future, NOW), false);
    assert.equal(deriveNeedsReauth(undefined, future, NOW), false);
  });
});

// =============================================================================
// isConnectionActive — never defaults unknown status to active
// =============================================================================

describe("broker-connection-logic isConnectionActive()", () => {
  it("exactly CONNECTED + non-expired token → active", () => {
    assert.equal(
      isConnectionActive("CONNECTED", new Date("2024-06-16T00:00:00Z"), NOW),
      true
    );
    // null expiry = no expiry recorded = still active
    assert.equal(isConnectionActive("CONNECTED", null, NOW), true);
  });

  it("CONNECTED + expired token → NOT active", () => {
    assert.equal(
      isConnectionActive("CONNECTED", new Date("2024-06-15T00:00:00Z"), NOW),
      false
    );
  });

  it("CONNECTED + Invalid-Date token → NOT active (fail-safe)", () => {
    assert.equal(isConnectionActive("CONNECTED", INVALID, NOW), false);
  });

  it("unknown / EXPIRED / lowercase / empty / null status → NOT active (no default-to-connected)", () => {
    const future = new Date("2024-06-16T00:00:00Z");
    assert.equal(isConnectionActive("EXPIRED", future, NOW), false);
    assert.equal(isConnectionActive("connected", future, NOW), false); // case-sensitive
    assert.equal(isConnectionActive("WEIRD", future, NOW), false);
    assert.equal(isConnectionActive("", future, NOW), false);
    assert.equal(isConnectionActive(null, future, NOW), false);
    assert.equal(isConnectionActive(undefined, future, NOW), false);
  });
});

// =============================================================================
// formatLastSyncedRelative — never "Invalid Date", null → "Never synced"
// =============================================================================

describe("broker-connection-logic formatLastSyncedRelative()", () => {
  it("null / undefined → 'Never synced' (not a crash)", () => {
    assert.equal(formatLastSyncedRelative(null, NOW), "Never synced");
    assert.equal(formatLastSyncedRelative(undefined, NOW), "Never synced");
  });

  it("Invalid Date → 'Never synced' (never throws, never 'Invalid Date')", () => {
    assert.doesNotThrow(() => formatLastSyncedRelative(INVALID, NOW));
    assert.equal(formatLastSyncedRelative(INVALID, NOW), "Never synced");
    assert.notEqual(formatLastSyncedRelative(INVALID, NOW), "Invalid Date");
  });

  it("future timestamp (clock skew) → 'Just now' (no negative age)", () => {
    assert.equal(
      formatLastSyncedRelative(new Date("2024-06-15T11:00:00Z"), NOW),
      "Just now"
    );
  });

  it("coarse buckets: <1m / minutes / hours / days", () => {
    assert.equal(
      formatLastSyncedRelative(new Date("2024-06-15T09:59:30Z"), NOW),
      "Just now"
    );
    assert.equal(
      formatLastSyncedRelative(new Date("2024-06-15T09:30:00Z"), NOW),
      "30m ago"
    );
    assert.equal(
      formatLastSyncedRelative(new Date("2024-06-15T05:00:00Z"), NOW),
      "5h ago"
    );
    assert.equal(
      formatLastSyncedRelative(new Date("2024-06-12T10:00:00Z"), NOW),
      "3d ago"
    );
  });
});

// =============================================================================
// toBrokerConnectionInfo — CREDENTIAL LEAK guard (highest priority)
// =============================================================================

describe("broker-connection-logic toBrokerConnectionInfo() — credential leak", () => {
  it("maps a clean connection to the exact prior shape (behaviour preserved)", () => {
    const info = toBrokerConnectionInfo(connRow(), NOW);
    assert.deepEqual(info, {
      id: "conn-1",
      broker: "ZERODHA",
      brokerUserId: "ZR1234",
      accountName: "My Zerodha",
      status: "CONNECTED",
      connectedAt: "2024-01-10T08:00:00.000Z",
      lastSync: "2024-06-15T09:30:00.000Z",
      tokenExpiry: "2024-06-16T03:30:00.000Z",
      isExpired: false,
      needsReauth: false,
    });
  });

  it("NEVER leaks encryptedCreds / iv / authTag / accessToken / refreshToken / apiSecret even when present on the row", () => {
    // Simulate a careless `select` widening or a no-`select` findUnique that
    // pulls the encrypted blob + raw tokens into the row.
    const leakyRow: BrokerConnectionRow = {
      ...connRow(),
      // internal + secret fields that must be dropped:
      userId: "internal-mongo-id",
      encryptedCreds: "BASE64_AES_GCM_CIPHERTEXT",
      iv: "BASE64_IV",
      authTag: "BASE64_AUTH_TAG",
      accessToken: "kite_access_token_PLAINTEXT",
      refreshToken: "kite_refresh_token_PLAINTEXT",
      apiSecret: "ZERODHA_API_SECRET",
      apiKey: "ZERODHA_API_KEY",
      brokerMetadata: { userId: "x" },
    };
    const info = toBrokerConnectionInfo(leakyRow, NOW);

    // 1) No secret field name appears as an own key.
    assert.equal(
      findLeakedSecretField(info as unknown as Record<string, unknown>),
      null
    );

    // 2) Belt-and-suspenders: explicitly assert each secret key is absent.
    const keys = Object.keys(info);
    for (const secret of SECRET_FIELD_NAMES) {
      assert.equal(
        keys.includes(secret),
        false,
        `mapped shape must not expose '${secret}'`
      );
    }
    assert.equal(
      keys.includes("userId"),
      false,
      "internal userId must not leak"
    );

    // 3) The serialised JSON the client/api receives contains no secret VALUE.
    const json = JSON.stringify(info);
    assert.equal(json.includes("PLAINTEXT"), false);
    assert.equal(json.includes("CIPHERTEXT"), false);
    assert.equal(json.includes("AUTH_TAG"), false);
    assert.equal(json.includes("API_SECRET"), false);
    assert.equal(json.includes("internal-mongo-id"), false);

    // 4) Output keys are EXACTLY the allowed whitelist (nothing extra rode in).
    assert.deepEqual(keys.sort(), [...allowedConnectionInfoKeys()].sort());
  });

  it("INVALID-DATE tokenExpiry/lastSync/connectedAt → no throw, undefined ISO, expired+reauth", () => {
    const row = connRow({
      status: "CONNECTED",
      connectedAt: INVALID,
      lastSync: INVALID,
      tokenExpiry: INVALID,
    });
    let info!: ReturnType<typeof toBrokerConnectionInfo>;
    assert.doesNotThrow(() => {
      info = toBrokerConnectionInfo(row, NOW);
    });
    assert.equal(info.connectedAt, undefined);
    assert.equal(info.lastSync, undefined);
    assert.equal(info.tokenExpiry, undefined);
    // Invalid expiry is treated as expired → reauth (fail-safe).
    assert.equal(info.isExpired, true);
    assert.equal(info.needsReauth, true);
    // Never the literal "Invalid Date".
    assert.equal(JSON.stringify(info).includes("Invalid Date"), false);
  });

  it("null dates → omitted ISO + not expired, status drives reauth", () => {
    const info = toBrokerConnectionInfo(
      connRow({
        status: "EXPIRED",
        connectedAt: null,
        lastSync: null,
        tokenExpiry: null,
      }),
      NOW
    );
    assert.equal(info.connectedAt, undefined);
    assert.equal(info.lastSync, undefined);
    assert.equal(info.tokenExpiry, undefined);
    assert.equal(info.isExpired, false); // no expiry recorded
    assert.equal(info.needsReauth, true); // EXPIRED status
  });

  it("expired-by-1ms token → isExpired + needsReauth", () => {
    const info = toBrokerConnectionInfo(
      connRow({
        status: "CONNECTED",
        tokenExpiry: new Date(NOW.getTime() - 1),
      }),
      NOW
    );
    assert.equal(info.isExpired, true);
    assert.equal(info.needsReauth, true);
  });
});

// =============================================================================
// toBrokerSyncStatus — leak guard + isActive + Invalid-Date
// =============================================================================

describe("broker-connection-logic toBrokerSyncStatus()", () => {
  it("clean CONNECTED + valid token → active, lastSync serialised", () => {
    const s = toBrokerSyncStatus(syncRow(), NOW);
    assert.deepEqual(s, {
      id: "conn-1",
      broker: "ZERODHA",
      brokerUserId: "ZR1234",
      accountName: "My Zerodha",
      isActive: true,
      lastSync: "2024-06-15T09:30:00.000Z",
    });
  });

  it("never leaks a secret field even if present on the row", () => {
    const s = toBrokerSyncStatus(
      {
        ...syncRow(),
        encryptedCreds: "CIPHERTEXT",
        accessToken: "PLAINTEXT",
        userId: "internal-id",
      },
      NOW
    );
    assert.equal(
      findLeakedSecretField(s as unknown as Record<string, unknown>),
      null
    );
    const json = JSON.stringify(s);
    assert.equal(json.includes("PLAINTEXT"), false);
    assert.equal(json.includes("CIPHERTEXT"), false);
    assert.equal(json.includes("internal-id"), false);
  });

  it("EXPIRED status → not active; null lastSync → null (not crash)", () => {
    const s = toBrokerSyncStatus(
      syncRow({ status: "EXPIRED", lastSync: null }),
      NOW
    );
    assert.equal(s.isActive, false);
    assert.equal(s.lastSync, null);
  });

  it("Invalid-Date lastSync → null, never throws", () => {
    let s!: ReturnType<typeof toBrokerSyncStatus>;
    assert.doesNotThrow(() => {
      s = toBrokerSyncStatus(syncRow({ lastSync: INVALID }), NOW);
    });
    assert.equal(s.lastSync, null);
  });

  it("CONNECTED + expired token → not active", () => {
    const s = toBrokerSyncStatus(
      syncRow({
        status: "CONNECTED",
        tokenExpiry: new Date("2024-06-15T00:00:00Z"),
      }),
      NOW
    );
    assert.equal(s.isActive, false);
  });
});
