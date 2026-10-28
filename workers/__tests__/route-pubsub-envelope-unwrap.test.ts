/**
 * A route that reads MESSAGE FIELDS must decode the envelope — MONEY-1490.
 *
 * ## The defect
 *
 * A Pub/Sub PUSH subscription delivers
 *
 *     {"message": {"data": "<base64 of the payload>", "messageId": "..."},
 *      "subscription": "..."}
 *
 * because the subscriptions in `workers/scripts/setup-pubsub.sh` are created
 * WITHOUT `--push-no-wrapper`. So `body.only` is `undefined` — always, on every
 * environment, for every message. Not an error; just silence.
 *
 * `mf-portfolio-sync` read `month` and `only` straight off `body`. In an
 * ordinary job that degrades to "ran with defaults". In a SELF-CHAINING job the
 * payload IS the continuation cursor, so it degraded to a perpetual chain:
 * every hop threw away the remainder it was handed, re-ran the full house table
 * from the top, re-fetched and re-upserted the same first four or five houses,
 * and published the same tail again. Measured on prod 2026-09-21 over 1h40m the
 * deferred count oscillated 14 <-> 15 and never reached 13 — a steady state,
 * not a converging one. Seven days; the fourteen houses from ABSL to HDFC were
 * never fetched once.
 *
 * ## Why the existing tests did not catch it
 *
 * `mf-portfolio-route-only.test.ts` tests this route's `only` handling
 * thoroughly and correctly, and says of itself:
 *
 *     "The route body is exercised structurally rather than over HTTP ...
 *      what failed here was never the request plumbing."
 *
 * The request plumbing was the entire bug. The validation logic was right and
 * well covered; it simply never ran on the real transport. Test the JOIN, not
 * just the halves.
 *
 * ## Why this is a SCAN and not one route's unit test
 *
 * `xbrl-projection.ts` already carries a full written diagnosis of this exact
 * class — it was found there, fixed there, and the sweep stopped before
 * reaching the one route whose payload cannot be defaulted. A scan is what
 * makes the NEXT route pay for it on the day it is written rather than months
 * later in a log nobody is reading.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "./_support/repo-root";
import { parsePubSubMessage, getMessageId } from "../src/lib/message";

const ROUTES_DIR = join(repoRoot(), "workers", "src", "routes");

/** Build the envelope Pub/Sub actually sends for a given payload. */
function pushEnvelope(payload: unknown, messageId = "9876543210"): unknown {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      messageId,
      publishTime: "2026-09-21T16:00:00Z",
    },
    subscription: "projects/p/subscriptions/mf-portfolio-sync-prod-push",
  };
}

/**
 * Strip comments before scanning.
 *
 * NOT cosmetic — found by mutation. The exemption below is "this file mentions
 * the decoder", and a file that only mentions it IN PROSE satisfied that while
 * being fully broken: reverting `xbrl-sync.ts` to the defective shape left the
 * sentence "`parsePubSubMessage` falls back to the body..." in a comment, and
 * the scan went green on a real defect sitting on disk.
 */
function stripComments(src: string): string {
  // LINE comments are stripped BEFORE block comments (MONEY-1143) — the same
  // order every other source scan in this repo uses, and for the same reason:
  // these files' own prose quotes the code the scan forbids, so a line comment
  // containing an unclosed `/*` would otherwise swallow live code up to the
  // next `*/` and silently hide an offender.
  return src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the Pub/Sub push envelope is what routes actually receive", () => {
  it("reading a field off the raw envelope yields undefined — the defect itself", () => {
    const body = pushEnvelope({ month: "2026-08", only: ["KOTAK"] }) as Record<
      string,
      unknown
    >;

    // This is precisely what the broken routes did.
    const raw = (body ?? {}) as { month?: unknown; only?: unknown };
    assert.equal(
      raw.month,
      undefined,
      "if this is ever defined, the envelope shape changed and this whole " +
        "test file needs revisiting",
    );
    assert.equal(raw.only, undefined);
  });

  it("decoding first recovers every field", () => {
    const body = pushEnvelope({
      month: "2026-08",
      only: ["KOTAK", "SBI"],
      chainDepth: 7,
    });

    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ??
      {}) as Record<string, unknown>;

    assert.equal(raw.month, "2026-08");
    assert.deepEqual(raw.only, ["KOTAK", "SBI"]);
    assert.equal(raw.chainDepth, 7);
  });

  it("a direct JSON body still works, so local dev and curl are unchanged", () => {
    const raw = (parsePubSubMessage<Record<string, unknown>>({
      month: "2026-08",
      only: ["SBI"],
    }) ?? {}) as Record<string, unknown>;

    assert.equal(raw.month, "2026-08");
    assert.deepEqual(raw.only, ["SBI"]);
  });

  it("getMessageId reads the real id from the envelope", () => {
    assert.equal(getMessageId(pushEnvelope({}, "42")), "42");
  });
});

describe("no route may read payload fields off the undecoded body", () => {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));

  it("resolves the routes it reasons over", () => {
    assert.ok(files.length > 50, `only found ${files.length} route files`);
  });

  /**
   * PREMISE — the scan must be able to SEE a real route file's body handling.
   *
   * Without this the suite is vacuous today: every offender is fixed, so the
   * `castsRawBody` filter matches zero files and `offenders === []` is an
   * assertion over an empty set. A repo-wide rename of `body`, or a regex that
   * silently stopped matching, would leave all cases green while guarding
   * nothing. `files.length > 50` does not cover it — that counts FILES, not
   * CANDIDATES, which is the two-counts-with->= shape that makes an empty
   * population read OK forever.
   */
  it("[premise] the scan sees real routes that take a body at all", () => {
    const takeBody = files.filter((f) =>
      stripComments(readFileSync(join(ROUTES_DIR, f), "utf8")).includes(
        "c.req.json()",
      ),
    );
    assert.ok(
      takeBody.length > 30,
      `only ${takeBody.length} routes appear to read a request body — the ` +
        `scan's subject matter has moved and its regex is probably stale`,
    );
  });

  /**
   * PREMISE — the decoder must be REACHED by real routes, not merely named.
   *
   * This is the other half: if `parsePubSubMessage` were renamed, every file
   * would fall out of the exemption and the scan would flag ~58 routes, which
   * is loud. The dangerous direction is the reverse — the token surviving only
   * in prose. Counting CODE-level hits proves the exemption is measuring code.
   */
  it("[premise] most routes reach the decoder IN CODE, not in a comment", () => {
    const decodesInCode = files.filter((f) =>
      stripComments(readFileSync(join(ROUTES_DIR, f), "utf8")).includes(
        "parsePubSubMessage",
      ),
    );
    assert.ok(
      decodesInCode.length > 50,
      `only ${decodesInCode.length} routes decode the envelope in code`,
    );
  });

  it("REGRESSION: every route that casts `body` also decodes it", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = stripComments(readFileSync(join(ROUTES_DIR, file), "utf8"));

      // The hazardous shape: treating the envelope AS the payload. Matches
      // `(body ?? {}) as {...}`, `body as {...}` and `(body || {}) as {...}`.
      const castsRawBody =
        /\(?\bbody\b\s*(\?\?|\|\|)?\s*(\{\})?\)?\s+as\s/.test(src);
      if (!castsRawBody) continue;

      // ...is only safe when the cast target came through the decoder.
      if (src.includes("parsePubSubMessage")) continue;

      offenders.push(file);
    }

    assert.deepEqual(
      offenders,
      [],
      `These routes read message fields off the raw Pub/Sub envelope, so every ` +
        `field is undefined on a real push:\n  ${offenders.join("\n  ")}\n\n` +
        `Fix: import parsePubSubMessage from "../lib/message" and read fields ` +
        `off its result. It falls back to the body itself when the body is not ` +
        `an envelope, so manual invocation keeps working. See MONEY-1490.`,
    );
  });

  it("the scan FIRES on the shape it forbids (mutation check)", () => {
    // Without this, a regex that matches nothing would pass forever.
    const brokenShape = stripComments(`
      import { getMessageId } from "../lib/message";
      // \`parsePubSubMessage\` falls back to the body when it is not an envelope
      const raw = (body ?? {}) as { windowDays?: unknown };
    `);
    const castsRawBody = /\(?\bbody\b\s*(\?\?|\|\|)?\s*(\{\})?\)?\s+as\s/.test(
      brokenShape,
    );
    assert.ok(castsRawBody, "the scan cannot see its own target shape");
    assert.ok(
      !brokenShape.includes("parsePubSubMessage"),
      "the exemption must not swallow the offending sample",
    );
  });

  it("mf-portfolio-sync specifically decodes before reading (the incident)", () => {
    const src = readFileSync(join(ROUTES_DIR, "mf-portfolio-sync.ts"), "utf8");
    assert.match(
      src,
      /parsePubSubMessage<[^(]+\(body\)/,
      "mf-portfolio-sync must decode the envelope — MONEY-1490",
    );
    assert.match(
      src,
      /chainDepth/,
      "the chain-depth cursor must be read and forwarded",
    );
  });
});
