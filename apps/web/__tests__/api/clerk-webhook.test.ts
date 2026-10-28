/**
 * Clerk Webhook Handler CONTRACT tests.
 *
 * Exercises the REAL exported helpers from the route's sibling logic module
 * (`app/api/webhooks/clerk/clerk-webhook-logic.ts`) that the route imports and
 * calls — NOT inline copies. Plus a real-`svix` signature contract test that
 * proves a correctly-signed payload verifies and that tampered body / wrong
 * signature / stale timestamp are rejected, using the SAME `svix` `Webhook` the
 * route uses (never mocked).
 *
 * (Replaces the previous shadow version, which reimplemented validateSvixHeaders
 * / parseWebhookEvent / mapClerkEventToAction / getPrimaryEmail / getFullName
 * inline and asserted the copies.)
 *
 * Source: apps/web/app/api/webhooks/clerk/route.ts
 *       + apps/web/app/api/webhooks/clerk/clerk-webhook-logic.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Webhook, WebhookVerificationError } from "svix";
import {
  validateSvixHeaders,
  parseWebhookEvent,
  mapClerkEventToAction,
  isSupportedEvent,
  getPrimaryEmail,
  getFullName,
  shouldSyncContactToResend,
  buildContentAuthorImageSyncUpdate,
  CLERK_SVIX_HEADERS,
  type ClerkUserData,
  type WebhookEvent,
  welcomeClaimWhere,
  shouldQueueBriefing,
  BRIEFING_FAILED_RETRY_COOLDOWN_MINUTES,
  BRIEFING_MAX_FAILED_PER_DAY,
  WELCOME_BACKFILL_MAX_AGE_DAYS,
} from "@/app/api/webhooks/clerk/clerk-webhook-logic";

// --- Mock Data Generators ---

function createMockClerkUser(
  overrides: Partial<ClerkUserData> = {}
): ClerkUserData {
  return {
    id: "user_clerk_abc123",
    email_addresses: [
      { email_address: "trader@example.com", id: "email_primary" },
    ],
    primary_email_address_id: "email_primary",
    first_name: "John",
    last_name: "Doe",
    image_url: "https://img.clerk.com/abc.jpg",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

function createMockWebhookEvent(
  overrides: Partial<WebhookEvent> = {}
): WebhookEvent {
  return {
    data: createMockClerkUser(),
    type: "user.created",
    object: "event",
    ...overrides,
  };
}

function createSvixHeaders(
  overrides: Record<string, string | null> = {}
): Record<string, string | null> {
  return {
    "svix-id": "msg_abc123",
    "svix-timestamp": "1700000000",
    "svix-signature": "v1,signature_here",
    ...overrides,
  };
}

// A valid svix signing secret is base64 after the `whsec_` prefix.
const TEST_SECRET =
  "whsec_" + Buffer.from("clerk-webhook-test-secret").toString("base64");

describe("Clerk Webhook Handler (real exported helpers)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe("CLERK_SVIX_HEADERS", () => {
    it("pins the three Svix header names the route reads", () => {
      assert.deepStrictEqual(
        [...CLERK_SVIX_HEADERS],
        ["svix-id", "svix-timestamp", "svix-signature"]
      );
    });
  });

  describe("validateSvixHeaders", () => {
    it("should pass with all three valid headers", () => {
      const result = validateSvixHeaders(createSvixHeaders());
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.error, undefined);
    });

    it("should fail when svix-id is missing", () => {
      const result = validateSvixHeaders(
        createSvixHeaders({ "svix-id": null })
      );
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "Missing svix headers");
    });

    it("should fail when svix-timestamp is missing", () => {
      const result = validateSvixHeaders(
        createSvixHeaders({ "svix-timestamp": null })
      );
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error, "Missing svix headers");
    });

    it("should fail when svix-signature is missing", () => {
      const result = validateSvixHeaders(
        createSvixHeaders({ "svix-signature": null })
      );
      assert.strictEqual(result.valid, false);
    });

    it("should fail when all headers are null", () => {
      const result = validateSvixHeaders(
        createSvixHeaders({
          "svix-id": null,
          "svix-timestamp": null,
          "svix-signature": null,
        })
      );
      assert.strictEqual(result.valid, false);
    });

    it("should fail when svix-id is empty string", () => {
      const result = validateSvixHeaders(createSvixHeaders({ "svix-id": "" }));
      assert.strictEqual(result.valid, false);
    });

    it("should fail when svix-timestamp is empty string", () => {
      const result = validateSvixHeaders(
        createSvixHeaders({ "svix-timestamp": "" })
      );
      assert.strictEqual(result.valid, false);
    });

    it("should fail when svix-signature is empty string", () => {
      const result = validateSvixHeaders(
        createSvixHeaders({ "svix-signature": "" })
      );
      assert.strictEqual(result.valid, false);
    });

    it("should pass with very long header values", () => {
      const result = validateSvixHeaders(
        createSvixHeaders({
          "svix-id": "msg_" + "a".repeat(200),
          "svix-signature": "v1," + "b".repeat(500),
        })
      );
      assert.strictEqual(result.valid, true);
    });
  });

  describe("parseWebhookEvent", () => {
    it("should parse valid event payload", () => {
      const result = parseWebhookEvent(createMockWebhookEvent());
      assert.ok(result !== null);
      assert.strictEqual(result!.type, "user.created");
      assert.ok(typeof result!.data === "object");
    });

    it("should parse user.updated event", () => {
      const result = parseWebhookEvent(
        createMockWebhookEvent({ type: "user.updated" })
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.type, "user.updated");
    });

    it("should parse user.deleted event", () => {
      const result = parseWebhookEvent(
        createMockWebhookEvent({ type: "user.deleted" })
      );
      assert.ok(result !== null);
      assert.strictEqual(result!.type, "user.deleted");
    });

    it("should return null for null payload", () => {
      assert.strictEqual(parseWebhookEvent(null), null);
    });

    it("should return null for undefined payload", () => {
      assert.strictEqual(parseWebhookEvent(undefined), null);
    });

    it("should return null for string payload", () => {
      assert.strictEqual(parseWebhookEvent("not an object"), null);
    });

    it("should return null for number payload", () => {
      assert.strictEqual(parseWebhookEvent(42), null);
    });

    it("should return null for boolean payload", () => {
      assert.strictEqual(parseWebhookEvent(true), null);
    });

    it("should return null when type is missing", () => {
      assert.strictEqual(parseWebhookEvent({ data: { id: "user_123" } }), null);
    });

    it("should return null when type is empty string", () => {
      assert.strictEqual(
        parseWebhookEvent({ type: "", data: { id: "user_123" } }),
        null
      );
    });

    it("should return null when type is not a string", () => {
      assert.strictEqual(
        parseWebhookEvent({ type: 123, data: { id: "user_123" } }),
        null
      );
    });

    it("should return null when data is missing", () => {
      assert.strictEqual(parseWebhookEvent({ type: "user.created" }), null);
    });

    it("should return null when data is null", () => {
      assert.strictEqual(
        parseWebhookEvent({ type: "user.created", data: null }),
        null
      );
    });

    it("should return null when data is a string", () => {
      assert.strictEqual(
        parseWebhookEvent({ type: "user.created", data: "invalid" }),
        null
      );
    });

    it("should parse event with minimal data object", () => {
      const result = parseWebhookEvent({
        type: "user.created",
        data: { id: "user_123" },
      });
      assert.ok(result !== null);
      assert.strictEqual(result!.type, "user.created");
    });
  });

  describe("mapClerkEventToAction", () => {
    it("should map user.created to createUser", () => {
      assert.strictEqual(mapClerkEventToAction("user.created"), "createUser");
    });

    it("should map user.updated to updateUser", () => {
      assert.strictEqual(mapClerkEventToAction("user.updated"), "updateUser");
    });

    it("should map user.deleted to deleteUser", () => {
      assert.strictEqual(mapClerkEventToAction("user.deleted"), "deleteUser");
    });

    it("should return null for session.created", () => {
      assert.strictEqual(mapClerkEventToAction("session.created"), null);
    });

    it("should return null for organization.created", () => {
      assert.strictEqual(mapClerkEventToAction("organization.created"), null);
    });

    it("should return null for empty string", () => {
      assert.strictEqual(mapClerkEventToAction(""), null);
    });

    it("should return null for partial match (user.)", () => {
      assert.strictEqual(mapClerkEventToAction("user."), null);
    });

    it("should be case-sensitive (User.Created)", () => {
      assert.strictEqual(mapClerkEventToAction("User.Created"), null);
    });

    it("should return null for unknown event prefix", () => {
      assert.strictEqual(mapClerkEventToAction("webhook.test"), null);
    });
  });

  describe("isSupportedEvent", () => {
    it("should support user.created", () => {
      assert.strictEqual(isSupportedEvent("user.created"), true);
    });

    it("should support user.updated", () => {
      assert.strictEqual(isSupportedEvent("user.updated"), true);
    });

    it("should support user.deleted", () => {
      assert.strictEqual(isSupportedEvent("user.deleted"), true);
    });

    it("should not support session.created", () => {
      assert.strictEqual(isSupportedEvent("session.created"), false);
    });

    it("should not support empty string", () => {
      assert.strictEqual(isSupportedEvent(""), false);
    });

    it("should not support random string", () => {
      assert.strictEqual(isSupportedEvent("random.event.type"), false);
    });
  });

  describe("getPrimaryEmail", () => {
    it("should return primary email by primary_email_address_id", () => {
      const data = createMockClerkUser({
        email_addresses: [
          { email_address: "secondary@example.com", id: "email_sec" },
          { email_address: "primary@example.com", id: "email_pri" },
        ],
        primary_email_address_id: "email_pri",
      });
      assert.strictEqual(getPrimaryEmail(data), "primary@example.com");
    });

    it("should fallback to first email when primary_email_address_id not found", () => {
      const data = createMockClerkUser({
        email_addresses: [
          { email_address: "first@example.com", id: "email_1" },
          { email_address: "second@example.com", id: "email_2" },
        ],
        primary_email_address_id: "email_nonexistent",
      });
      assert.strictEqual(getPrimaryEmail(data), "first@example.com");
    });

    it("should fallback to first email when primary_email_address_id is undefined", () => {
      const data = createMockClerkUser({
        email_addresses: [
          { email_address: "only@example.com", id: "email_only" },
        ],
        primary_email_address_id: undefined,
      });
      assert.strictEqual(getPrimaryEmail(data), "only@example.com");
    });

    it("should return null when email_addresses is empty", () => {
      const data = createMockClerkUser({ email_addresses: [] });
      assert.strictEqual(getPrimaryEmail(data), null);
    });

    it("should return null when email_addresses is undefined", () => {
      const data = createMockClerkUser({ email_addresses: undefined });
      assert.strictEqual(getPrimaryEmail(data), null);
    });

    it("should handle single email entry", () => {
      const data = createMockClerkUser({
        email_addresses: [
          { email_address: "solo@example.com", id: "email_solo" },
        ],
        primary_email_address_id: "email_solo",
      });
      assert.strictEqual(getPrimaryEmail(data), "solo@example.com");
    });

    it("should match email by exact id", () => {
      const data = createMockClerkUser({
        email_addresses: [
          { email_address: "a@example.com", id: "email_a" },
          { email_address: "b@example.com", id: "email_ab" },
        ],
        primary_email_address_id: "email_a",
      });
      assert.strictEqual(getPrimaryEmail(data), "a@example.com");
    });
  });

  describe("getFullName", () => {
    it("should combine first and last name", () => {
      assert.strictEqual(
        getFullName(
          createMockClerkUser({ first_name: "John", last_name: "Doe" })
        ),
        "John Doe"
      );
    });

    it("should use only first name when last is null", () => {
      assert.strictEqual(
        getFullName(
          createMockClerkUser({ first_name: "John", last_name: null })
        ),
        "John"
      );
    });

    it("should use only last name when first is null", () => {
      assert.strictEqual(
        getFullName(
          createMockClerkUser({ first_name: null, last_name: "Doe" })
        ),
        "Doe"
      );
    });

    it("should return 'Trader' when both are null", () => {
      assert.strictEqual(
        getFullName(createMockClerkUser({ first_name: null, last_name: null })),
        "Trader"
      );
    });

    it("should return 'Trader' when both are empty strings", () => {
      assert.strictEqual(
        getFullName(createMockClerkUser({ first_name: "", last_name: "" })),
        "Trader"
      );
    });

    it("should trim whitespace from combined name", () => {
      assert.strictEqual(
        getFullName(createMockClerkUser({ first_name: "John", last_name: "" })),
        "John"
      );
    });

    it("should handle names with spaces", () => {
      assert.strictEqual(
        getFullName(
          createMockClerkUser({
            first_name: "John Paul",
            last_name: "Smith Jr",
          })
        ),
        "John Paul Smith Jr"
      );
    });

    it("should use only first name when last is undefined", () => {
      const data = createMockClerkUser({ first_name: "Alice" });
      const modified: ClerkUserData = {
        ...data,
        last_name: undefined as unknown as string | null,
      };
      assert.strictEqual(getFullName(modified), "Alice");
    });
  });

  describe("shouldSyncContactToResend (MONEY-523)", () => {
    it("should sync a never-synced user (lastResendSyncAt = null)", () => {
      assert.strictEqual(shouldSyncContactToResend(null), true);
    });

    it("should skip a user already synced to Resend", () => {
      assert.strictEqual(shouldSyncContactToResend(new Date()), false);
    });

    it("should skip regardless of how old the sync watermark is", () => {
      assert.strictEqual(shouldSyncContactToResend(new Date(0)), false);
      assert.strictEqual(
        shouldSyncContactToResend(new Date("2020-01-01T00:00:00Z")),
        false
      );
    });

    it("regression: lazy-create race — row created by getOrCreateUser still onboards", () => {
      const createdByWebhook = false; // lazy path won the race
      const lastResendSyncAt: Date | null = null; // fresh row, never synced
      assert.strictEqual(createdByWebhook, false);
      assert.strictEqual(shouldSyncContactToResend(lastResendSyncAt), true);
    });

    it("idempotency: once stamped, repeat webhooks (Svix retry / user.updated) skip", () => {
      assert.strictEqual(shouldSyncContactToResend(new Date()), false);
    });
  });

  describe("Full event processing simulation (real helpers)", () => {
    it("should process user.created with valid data", () => {
      const headers = createSvixHeaders();
      assert.strictEqual(validateSvixHeaders(headers).valid, true);

      const event = createMockWebhookEvent({ type: "user.created" });
      const parsed = parseWebhookEvent(event);
      assert.ok(parsed !== null);
      assert.strictEqual(mapClerkEventToAction(parsed!.type), "createUser");
      assert.strictEqual(getPrimaryEmail(event.data), "trader@example.com");
      assert.strictEqual(getFullName(event.data), "John Doe");
    });

    it("should process user.updated with changed email", () => {
      const event = createMockWebhookEvent({
        type: "user.updated",
        data: createMockClerkUser({
          email_addresses: [
            { email_address: "new@example.com", id: "email_new" },
          ],
          primary_email_address_id: "email_new",
        }),
      });
      const parsed = parseWebhookEvent(event);
      assert.ok(parsed !== null);
      assert.strictEqual(mapClerkEventToAction(parsed!.type), "updateUser");
      assert.strictEqual(getPrimaryEmail(event.data), "new@example.com");
    });

    it("should process user.deleted with minimal data", () => {
      const event = createMockWebhookEvent({
        type: "user.deleted",
        data: createMockClerkUser({
          email_addresses: [],
          first_name: null,
          last_name: null,
        }),
      });
      const parsed = parseWebhookEvent(event);
      assert.ok(parsed !== null);
      assert.strictEqual(mapClerkEventToAction(parsed!.type), "deleteUser");
      assert.strictEqual(getPrimaryEmail(event.data), null);
    });

    it("should reject event with invalid headers", () => {
      assert.strictEqual(
        validateSvixHeaders(createSvixHeaders({ "svix-signature": null }))
          .valid,
        false
      );
    });

    it("should skip unrecognized event types gracefully", () => {
      const event = createMockWebhookEvent({ type: "organization.created" });
      const parsed = parseWebhookEvent(event);
      assert.ok(parsed !== null);
      assert.strictEqual(mapClerkEventToAction(parsed!.type), null);
    });

    it("should handle user with no email for created event", () => {
      const event = createMockWebhookEvent({
        type: "user.created",
        data: createMockClerkUser({ email_addresses: undefined }),
      });
      assert.strictEqual(getPrimaryEmail(event.data), null);
    });
  });

  // ==========================================================================
  // Real svix signature CONTRACT test — the route verifies Clerk webhooks with
  // `new Webhook(secret).verify(body, { "svix-id", "svix-timestamp",
  // "svix-signature" })`. We sign a payload with the SAME library and prove:
  //   - a correctly-signed payload VERIFIES (and round-trips the parsed body)
  //   - a TAMPERED body is REJECTED
  //   - a WRONG signature is REJECTED
  //   - a STALE timestamp is REJECTED
  //   - a payload signed with a DIFFERENT secret is REJECTED
  // `Webhook.verify` is NEVER mocked.
  // ==========================================================================
  describe("svix signature contract (real Webhook, never mocked)", () => {
    const wh = new Webhook(TEST_SECRET);

    /** Build the three Clerk headers for `body` signed at `tsSeconds`. */
    function sign(body: string, tsSeconds: number, msgId = "msg_2contract") {
      const signature = wh.sign(msgId, new Date(tsSeconds * 1000), body);
      return {
        "svix-id": msgId,
        "svix-timestamp": String(tsSeconds),
        "svix-signature": signature,
      };
    }

    it("a correctly-signed Clerk payload VERIFIES and returns the parsed body", () => {
      const event = createMockWebhookEvent({ type: "user.created" });
      const body = JSON.stringify(event);
      const ts = Math.floor(Date.now() / 1000);
      const headers = sign(body, ts);

      const verified = wh.verify(body, headers) as WebhookEvent;
      assert.strictEqual(verified.type, "user.created");
      assert.strictEqual(verified.data.id, event.data.id);

      // And the real route helpers consume the verified payload.
      const parsed = parseWebhookEvent(verified);
      assert.ok(parsed !== null);
      assert.strictEqual(mapClerkEventToAction(parsed!.type), "createUser");
    });

    it("REJECTS a tampered body (signature no longer matches)", () => {
      const body = JSON.stringify(createMockWebhookEvent());
      const ts = Math.floor(Date.now() / 1000);
      const headers = sign(body, ts);
      const tamperedBody = body.replace("user.created", "user.deleted");
      assert.notStrictEqual(tamperedBody, body);

      assert.throws(
        () => wh.verify(tamperedBody, headers),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });

    it("REJECTS a wrong / forged signature", () => {
      const body = JSON.stringify(createMockWebhookEvent());
      const ts = Math.floor(Date.now() / 1000);
      assert.throws(
        () =>
          wh.verify(body, {
            "svix-id": "msg_2contract",
            "svix-timestamp": String(ts),
            "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          }),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });

    it("REJECTS a stale timestamp (outside svix tolerance), even if signed", () => {
      const body = JSON.stringify(createMockWebhookEvent());
      const staleTs = Math.floor(Date.now() / 1000) - 60 * 60; // 1h ago
      const headers = sign(body, staleTs); // correctly signed for the stale ts
      assert.throws(
        () => wh.verify(body, headers),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });

    it("REJECTS a payload signed with a DIFFERENT secret", () => {
      const otherWh = new Webhook(
        "whsec_" + Buffer.from("a-totally-different-secret").toString("base64")
      );
      const body = JSON.stringify(createMockWebhookEvent());
      const ts = Math.floor(Date.now() / 1000);
      const headers = {
        "svix-id": "msg_2contract",
        "svix-timestamp": String(ts),
        "svix-signature": otherWh.sign(
          "msg_2contract",
          new Date(ts * 1000),
          body
        ),
      };
      // The route's `wh` (TEST_SECRET) must reject a foreign-signed payload.
      assert.throws(
        () => wh.verify(body, headers),
        (err: unknown) => err instanceof WebhookVerificationError
      );
    });
  });
});

// MONEY-1050 — the webhook keeps the CMS ContentAuthor avatar fresh from the
// Clerk photo, so a changed profile picture no longer leaves a dead
// img.clerk.com URL on the public blog/newsletter byline.
describe("buildContentAuthorImageSyncUpdate", () => {
  it("returns null when there is no incoming image URL", () => {
    assert.strictEqual(
      buildContentAuthorImageSyncUpdate("clerk_1", undefined),
      null
    );
    assert.strictEqual(
      buildContentAuthorImageSyncUpdate("clerk_1", null),
      null
    );
    assert.strictEqual(buildContentAuthorImageSyncUpdate("clerk_1", ""), null);
  });

  it("targets the author by clerkId and sets the new image", () => {
    const upd = buildContentAuthorImageSyncUpdate(
      "clerk_42",
      "https://img.clerk.com/new-photo"
    );
    assert.ok(upd);
    assert.strictEqual(upd!.where.clerkId, "clerk_42");
    assert.strictEqual(upd!.data.imageUrl, "https://img.clerk.com/new-photo");
  });

  it("only overwrites empty or Clerk-hosted avatars (preserves custom uploads)", () => {
    const upd = buildContentAuthorImageSyncUpdate(
      "clerk_42",
      "https://img.clerk.com/x"
    );
    // The guard OR must match: null, img.clerk.com, images.clerk.dev — and
    // NOTHING else (a custom CMS avatar on any other host is left untouched).
    const or = upd!.where.OR;
    assert.deepStrictEqual(or, [
      { imageUrl: null },
      { imageUrl: { contains: "img.clerk.com" } },
      { imageUrl: { contains: "images.clerk.dev" } },
    ]);
  });
});

describe("MONEY-1236 — the welcome-email claim matched nothing at all", () => {
  const NOW = new Date("2026-08-21T12:00:00.000Z");

  it("matches BOTH an absent field and an explicit null", () => {
    // THE DEFECT. `welcomeEmailSentAt` is optional and no create path writes
    // it, so on MongoDB it is ABSENT — and Prisma does not match an absent
    // field with `null`. Measured on prod 2026-08-21: 653 of 653 users absent,
    // 0 null, 0 set. The claim returned `count: 0` for every signup since
    // 2026-06-26, `sendWelcome` was always false, and NOBODY was emailed —
    // silently, because `count: 0` is what "already sent" looks like too.
    //
    // Both shapes are required. ABSENT = never attempted. EXPLICIT NULL =
    // attempted and failed, which is what the MONEY-877 unwind writes so the
    // next event retries; that retry is the only path the old filter served.
    //
    // The two arms carry DIFFERENT bounds — see the age-gate cases below — so
    // this asserts that both null shapes are reachable, not that they are
    // spelled identically.
    const where = welcomeClaimWhere("user-1", NOW);
    const absent = where.OR.find((o) => "AND" in o);
    const explicitNull = where.OR.find((o) => !("AND" in o));
    assert.ok(absent && "AND" in absent, "the ABSENT arm must exist");
    assert.deepEqual(absent.AND[0], {
      welcomeEmailSentAt: { isSet: false },
    });
    assert.deepEqual(
      explicitNull,
      { welcomeEmailSentAt: null },
      "the EXPLICIT-NULL retry arm must exist"
    );
  });

  it("REGRESSION: never a bare `welcomeEmailSentAt: null` at the top level", () => {
    // The exact shape that shipped broken. A top-level scalar null here would
    // silently exclude every absent row again.
    const where = welcomeClaimWhere("user-1", NOW) as Record<string, unknown>;
    assert.equal(
      Object.prototype.hasOwnProperty.call(where, "welcomeEmailSentAt"),
      false,
      "the null test must live inside the OR, never as a bare top-level filter"
    );
  });

  /**
   * The age bound lives on the ABSENT arm ONLY — the two arms mean different
   * things and only one of them is a backfill.
   */
  function absentArm(where: ReturnType<typeof welcomeClaimWhere>) {
    const arm = where.OR.find((o) => "AND" in o);
    assert.ok(arm && "AND" in arm, "expected an AND-ed absent arm");
    return arm.AND;
  }

  it("bounds the ABSENT arm by ACCOUNT AGE, so old users cannot be emailed late", () => {
    // NOT decoration. The claim runs from `user.updated` as well as
    // `user.created`, and `user.updated` fires on any Clerk profile change — so
    // repairing the filter alone would let the next profile edit by any of the
    // 653 existing users win the claim and send them a welcome months after
    // signup. That is an irreversible outward-facing action, so the bound is
    // what makes the repair safe to deploy WITHOUT a backfill landing first.
    const [absent, age] = absentArm(welcomeClaimWhere("user-1", NOW, 30));
    assert.deepEqual(absent, { welcomeEmailSentAt: { isSet: false } });
    const expected = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    assert.equal(age.createdAt.gte.getTime(), expected.getTime());
  });

  it("REGRESSION: the EXPLICIT-NULL arm is NOT age-bounded", () => {
    // MONEY-877 resets the watermark to an explicit null so a FAILED send
    // retries on the next webhook. An earlier revision ANDed `createdAt` across
    // BOTH arms, which killed that retry silently: a user whose welcome failed
    // at day 29 could never win the claim again, and the explicit null they
    // were left holding reads as "attempted, will retry" forever.
    //
    // A top-level `createdAt` is exactly how that regression looks, so assert
    // its ABSENCE as well as the arm's shape.
    const where = welcomeClaimWhere("user-1", NOW, 30) as Record<
      string,
      unknown
    >;
    assert.equal(
      Object.prototype.hasOwnProperty.call(where, "createdAt"),
      false,
      "an age bound at the top level would apply to the retry arm too"
    );
    const retryArm = welcomeClaimWhere("user-1", NOW, 30).OR.find(
      (o) => !("AND" in o)
    );
    assert.deepEqual(
      retryArm,
      { welcomeEmailSentAt: null },
      "the attempted-and-failed arm must carry no age bound at all"
    );
  });

  it("the two arms are DISJOINT — absent and stored-null are different rows", () => {
    // This is what makes the un-bounded retry arm safe: on MongoDB
    // `{ field: null }` matches only a STORED null, never an absent key, so
    // that arm can only ever match a row some code deliberately reset. If the
    // arms overlapped, the retry arm would re-open the whole 653-user backfill.
    const where = welcomeClaimWhere("user-1", NOW, 30);
    assert.equal(where.OR.length, 2);
    const shapes = where.OR.map((o) => ("AND" in o ? "absent+age" : "null"));
    assert.deepEqual(shapes.sort(), ["absent+age", "null"]);
  });

  it("maxAgeDays = 0 is a pure go-forward cutover", () => {
    // The escape hatch the comment promises: nobody who already exists can win
    // the ABSENT arm, because every existing account was created before `now`.
    const [, age] = absentArm(welcomeClaimWhere("user-1", NOW, 0));
    assert.equal(age.createdAt.gte.getTime(), NOW.getTime());
  });

  it("defaults to the measured 30-day window", () => {
    // Prod: 22 of 653 users fall inside 30 days. Pinned so a later widening is
    // a deliberate edit rather than a drift — the constant decides how many
    // real people receive an email.
    assert.equal(WELCOME_BACKFILL_MAX_AGE_DAYS, 30);
    assert.deepEqual(
      absentArm(welcomeClaimWhere("u", NOW))[1],
      absentArm(welcomeClaimWhere("u", NOW, 30))[1]
    );
  });

  it("scopes to the ONE user — a claim is per-signup, never a broadcast", () => {
    assert.equal(welcomeClaimWhere("user-42", NOW).id, "user-42");
  });
});

describe("shouldQueueBriefing — a FAILED briefing retries, but BOUNDED", () => {
  const NOW_B = new Date("2026-08-22T10:00:00.000Z");
  const agoMin = (m: number) => new Date(NOW_B.getTime() - m * 60 * 1000);

  it("queues when there is nothing in the window", () => {
    const d = shouldQueueBriefing([], NOW_B);
    assert.equal(d.queue, true);
    assert.equal(d.reason, "no-recent-briefing");
  });

  for (const status of ["QUEUED", "PROCESSING", "COMPLETED", "SKIPPED"]) {
    it(`holds off on a standing ${status} briefing`, () => {
      // Each is a real reason: in flight, delivered, or a deliberate no-op that
      // re-queueing on every login would only repeat.
      const d = shouldQueueBriefing([{ status, createdAt: agoMin(30) }], NOW_B);
      assert.equal(d.queue, false, `${status} must suppress`);
      assert.equal(d.reason, "recent-briefing-stands");
    });
  }

  it("REGRESSION: a FAILED briefing does NOT withhold the feature for a day", () => {
    // The original defect. FAILED counted as "already have one", so a single
    // transient blip cost a PAID user their briefing for 24h, with a row in the
    // table that looked like a reason.
    const d = shouldQueueBriefing(
      [{ status: "FAILED", createdAt: agoMin(180) }],
      NOW_B
    );
    assert.equal(d.queue, true);
    assert.equal(d.reason, "retry-after-failure");
  });

  it("REGRESSION: a FAILED briefing does NOT re-queue on every sign-in", () => {
    // The FIRST fix excluded FAILED from the dedup entirely, which removed the
    // only bound: a deterministic failure then re-queued on EVERY
    // session.created — 3 devices = 3 rows x 5 Pub/Sub attempts each, repeating
    // forever. Within the cooldown, a retry must be refused.
    const d = shouldQueueBriefing(
      [{ status: "FAILED", createdAt: agoMin(5) }],
      NOW_B
    );
    assert.equal(d.queue, false);
    assert.equal(d.reason, "failed-retry-cooldown");
  });

  it("stops entirely once the per-day attempt cap is reached", () => {
    // A deterministic failure cannot be fixed by trying harder. Cap it.
    const failures = Array.from(
      { length: BRIEFING_MAX_FAILED_PER_DAY },
      (_, i) => ({
        status: "FAILED",
        createdAt: agoMin(120 + i * 60),
      })
    );
    const d = shouldQueueBriefing(failures, NOW_B);
    assert.equal(d.queue, false);
    assert.equal(d.reason, "failed-attempt-cap-reached");
  });

  it("the cap wins over an expired cooldown", () => {
    // Ordering matters: an old-enough failure must not slip past the cap.
    const failures = Array.from(
      { length: BRIEFING_MAX_FAILED_PER_DAY + 2 },
      () => ({
        status: "FAILED",
        createdAt: agoMin(600),
      })
    );
    assert.equal(shouldQueueBriefing(failures, NOW_B).queue, false);
  });

  it("a standing briefing wins over any number of failures", () => {
    const d = shouldQueueBriefing(
      [
        { status: "FAILED", createdAt: agoMin(300) },
        { status: "COMPLETED", createdAt: agoMin(10) },
      ],
      NOW_B
    );
    assert.equal(d.queue, false);
    assert.equal(d.reason, "recent-briefing-stands");
  });

  it("measures the cooldown from the NEWEST failure, not the oldest", () => {
    // An out-of-order list must not let a stale row unlock an immediate retry.
    const d = shouldQueueBriefing(
      [
        { status: "FAILED", createdAt: agoMin(600) },
        { status: "FAILED", createdAt: agoMin(1) },
      ],
      NOW_B
    );
    assert.equal(d.queue, false);
    assert.equal(d.reason, "failed-retry-cooldown");
  });

  it("pins the bounds so a later widening is deliberate", () => {
    assert.equal(BRIEFING_FAILED_RETRY_COOLDOWN_MINUTES, 60);
    assert.equal(BRIEFING_MAX_FAILED_PER_DAY, 3);
  });
});
