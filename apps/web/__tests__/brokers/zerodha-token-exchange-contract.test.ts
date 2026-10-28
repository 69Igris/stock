/**
 * CONTRACT TEST — Zerodha (Kite Connect) token exchange.
 *
 * Pins the EXTERNAL wire contract of `POST https://api.kite.trade/session/token`
 * as implemented by the REAL `ZerodhaClient.exchangeToken`
 * (apps/web/lib/brokers/clients/zerodha.ts). This is the broker-auth step that
 * turns a one-time request_token into a durable access_token; if its request
 * body or response parsing drifts, every Zerodha connection silently breaks.
 *
 * This is NOT a shadow: it imports and executes the real exported
 * `ZerodhaClient.exchangeToken` and asserts BOTH directions of the contract:
 *
 *   Request  — the body MUST carry `api_key`, `request_token`, and a `checksum`
 *              that is exactly SHA256(apiKey + requestToken + apiSecret); the
 *              content-type MUST be application/x-www-form-urlencoded and the
 *              `X-Kite-Version: 3` header MUST be present (Kite rejects v<3).
 *   Response — a recorded `{ status, data: { access_token, user_id, ... } }`
 *              success body normalizes to `{ accessToken, userId }`; a recorded
 *              4xx error body (`{ message: "Invalid \`checksum\`." }`) surfaces
 *              as a thrown Error carrying the upstream message.
 *
 * No live network: undici `MockAgent` intercepts `fetch` and `disableNetConnect`
 * makes any un-mocked host throw, so the test is pure and exits clean.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ZerodhaClient } from "@/lib/brokers/clients/zerodha";
import { installMockAgent } from "../_contracts/mock-agent";

const KITE_ORIGIN = "https://api.kite.trade";
const TOKEN_PATH = "/session/token";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "_contracts",
  "__fixtures__"
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

/** Independent re-computation of the Kite checksum to cross-check the wire. */
function expectedChecksum(
  apiKey: string,
  requestToken: string,
  apiSecret: string
): string {
  return createHash("sha256")
    .update(apiKey + requestToken + apiSecret)
    .digest("hex");
}

describe("CONTRACT: Zerodha token exchange (POST /session/token)", () => {
  const apiKey = "kiteapikey123";
  const apiSecret = "kiteapisecret456";
  const requestToken = "reqtok789";

  it("sends api_key + request_token + SHA256 checksum and normalizes the recorded success response", async () => {
    const mock = installMockAgent();
    try {
      const captured = mock.interceptJson({
        origin: KITE_ORIGIN,
        path: TOKEN_PATH,
        method: "POST",
        statusCode: 200,
        body: loadFixture("zerodha-token-success.json"),
      });

      const result = await ZerodhaClient.exchangeToken(
        apiKey,
        apiSecret,
        requestToken
      );

      // ── Response contract: recorded {data:{access_token,user_id}} → normalized
      assert.deepEqual(result, {
        accessToken: "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
        userId: "AB1234",
      });

      // ── Request contract: exactly one outbound POST to the token endpoint
      assert.equal(captured.calls.length, 1);
      const req = captured.calls[0]!;
      assert.equal(req.method, "POST");
      assert.equal(req.path, TOKEN_PATH);
      assert.equal(
        req.headers["content-type"],
        "application/x-www-form-urlencoded"
      );
      // Kite rejects any request below API version 3.
      assert.equal(req.headers["x-kite-version"], "3");

      // Body is a urlencoded form — parse it back and assert each field.
      const form = new URLSearchParams(req.body);
      assert.equal(form.get("api_key"), apiKey);
      assert.equal(form.get("request_token"), requestToken);

      // The load-bearing security assertion: the checksum on the wire is
      // exactly SHA256(apiKey + requestToken + apiSecret), and the apiSecret
      // itself is NEVER transmitted.
      const checksum = form.get("checksum");
      assert.equal(checksum, expectedChecksum(apiKey, requestToken, apiSecret));
      // Cross-check against the client's own exposed helper (same algorithm).
      assert.equal(
        checksum,
        ZerodhaClient.generateChecksum(apiKey, requestToken, apiSecret)
      );
      // The secret must not leak into the request body in any form.
      assert.equal(req.body.includes(apiSecret), false);
    } finally {
      await mock.close();
    }
  });

  it("throws the upstream message on a 4xx invalid-checksum response", async () => {
    const mock = installMockAgent();
    try {
      mock.interceptJson({
        origin: KITE_ORIGIN,
        path: TOKEN_PATH,
        method: "POST",
        statusCode: 400,
        body: loadFixture("zerodha-token-error.json"),
      });

      await assert.rejects(
        () => ZerodhaClient.exchangeToken(apiKey, apiSecret, requestToken),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          // The client prefixes the upstream Kite message: "Zerodha: <message>".
          assert.match(err.message, /Zerodha: Invalid `checksum`\./);
          return true;
        }
      );
    } finally {
      await mock.close();
    }
  });

  it("falls back to a generic error when a 5xx body has no message", async () => {
    const mock = installMockAgent();
    try {
      // A bare 5xx with an empty JSON object — no `message` field to surface.
      mock.interceptJson({
        origin: KITE_ORIGIN,
        path: TOKEN_PATH,
        method: "POST",
        statusCode: 502,
        body: {},
      });

      await assert.rejects(
        () => ZerodhaClient.exchangeToken(apiKey, apiSecret, requestToken),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.equal(err.message, "Failed to exchange token");
          return true;
        }
      );
    } finally {
      await mock.close();
    }
  });
});
