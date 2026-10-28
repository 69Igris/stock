/**
 * The request core — MONEY-1314.
 *
 * Two properties here cost real money if they break and nothing at runtime
 * would report either one:
 *
 *   1. FIXED_PREFIX must clear 4,096 tokens, or implicit caching does not
 *      engage and ~48,000 batch requests pay full price for a prefix that is
 *      byte-identical every time. The requests still succeed. The only symptom
 *      is the bill.
 *   2. The prefix must come FIRST. Implicit caching matches on a leading span,
 *      so a request that opens with this document's symbol shares no prefix
 *      with the next one — which is exactly what the LEGACY
 *      `buildDocumentFinancialsPrompt` does, and why it was not simply reused.
 *
 * Neither is checkable from a response: a cache hit shows up in
 * `usageMetadata.cachedContentTokenCount` on a live call, and by then the
 * money is spent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  FIXED_PREFIX,
  MEASURED_FIXED_PREFIX,
  IMPLICIT_CACHE_MIN_TOKENS,
  DOC_REQUEST_TEMPERATURE,
  fixedPrefixClearsCacheThreshold,
  buildPromptText,
  buildOnlineRequest,
  buildBatchRequestLine,
  buildGenerationConfig,
  DOC_REQUEST_MAX_OUTPUT_TOKENS,
  DOC_REQUEST_THINKING_BUDGET,
  DOC_REQUEST_VISIBLE_OUTPUT_TOKENS,
  buildDocumentContext,
} from "../../src/lib/gemini-doc-request-logic";

const CTX = {
  symbol: "TCS",
  docType: "annual_report",
  period: "FY2025",
  title: "Annual Report 2024-25",
} as const;

const digestOf = (s: string) =>
  createHash("sha256").update(s, "utf8").digest("hex");

describe("MONEY-1314 — the cached prefix", () => {
  it("[tripwire] FIXED_PREFIX still matches the bytes that were measured", () => {
    // If this fails, the prefix was EDITED and the recorded token count below
    // describes different bytes. Re-measure before trusting it:
    //   POST https://generativelanguage.googleapis.com/v1beta/models/
    //        gemini-3.7-flash:countTokens?key=$GOOGLE_GENAI_API_KEY_PROD
    //   { "contents": [{ "role": "user", "parts": [{ "text": FIXED_PREFIX }] }] }
    // then update MEASURED_FIXED_PREFIX.{tokens,sha256,chars,measuredAt}.
    assert.equal(
      digestOf(FIXED_PREFIX),
      MEASURED_FIXED_PREFIX.sha256,
      "FIXED_PREFIX changed since it was measured — re-run countTokens and " +
        "update MEASURED_FIXED_PREFIX (see the comment in this test)",
    );
  });

  it("[tripwire] the recorded char count also still matches", () => {
    // A second, independent witness. Cheap, and it localises the failure: a
    // digest mismatch with the SAME length is a content edit, a mismatch with a
    // different length is an addition or deletion.
    assert.equal(FIXED_PREFIX.length, MEASURED_FIXED_PREFIX.chars);
  });

  it("the measured prefix clears the implicit-caching threshold", () => {
    assert.ok(
      MEASURED_FIXED_PREFIX.tokens >= IMPLICIT_CACHE_MIN_TOKENS,
      `measured ${MEASURED_FIXED_PREFIX.tokens} tokens, need ` +
        `${IMPLICIT_CACHE_MIN_TOKENS} — pad with worked examples, not junk`,
    );
    const v = fixedPrefixClearsCacheThreshold(digestOf(FIXED_PREFIX));
    assert.equal(v.ok, true);
    assert.equal(v.stale, false);
  });

  it("[control] a digest that does NOT match is reported stale, not ok", () => {
    // Proves the check can fail. Without this the tripwire could be comparing
    // a value to itself and would vouch for anything.
    const v = fixedPrefixClearsCacheThreshold("0".repeat(64));
    assert.equal(v.stale, true);
    assert.equal(v.ok, false, "a stale digest must never report ok");
  });

  it("[control] the char heuristic is NOT the basis of the assertion", () => {
    // approxTokens() returns ~4,018 for a prefix that really is 4,506 tokens.
    // If someone ever rewires fixedPrefixClearsCacheThreshold back onto the
    // heuristic, this documents why that fails a healthy prefix.
    assert.ok(
      Math.ceil(FIXED_PREFIX.length / 4) < MEASURED_FIXED_PREFIX.tokens,
      "the /4 heuristic no longer UNDER-counts this prefix — recheck that " +
        "nothing depends on it, since it may now over-count instead",
    );
  });
});

describe("MONEY-1314 — prefix-first ordering", () => {
  it("buildPromptText opens with the cacheable prefix, not the document", () => {
    const text = buildPromptText(CTX);
    assert.ok(
      text.startsWith(FIXED_PREFIX),
      "the variable document context moved ahead of the fixed prefix — " +
        "implicit caching matches a LEADING span, so this silently disables it",
    );
  });

  it("the document's identity appears ONLY after the prefix ends", () => {
    // The sharp version of the check above: a symbol interpolated anywhere
    // inside the cached span makes every request's prefix unique.
    const text = buildPromptText(CTX);
    assert.equal(
      text.indexOf(CTX.title),
      text.lastIndexOf(CTX.title),
      "the document title appears more than once — one of them is inside the " +
        "cached prefix",
    );
    assert.ok(
      text.indexOf(CTX.title) >= FIXED_PREFIX.length,
      "document-specific text landed inside the cached prefix span",
    );
  });

  it("two DIFFERENT documents share a leading span of exactly FIXED_PREFIX", () => {
    // THE caching property, stated directly. Implicit caching engages on the
    // span two consecutive requests have in common, so what matters is not
    // which literals live in the prefix (the worked examples legitimately
    // contain symbols and period strings — they are stable text) but that the
    // shared span is long enough and comes first.
    //
    // Interpolating anything per-document into FIXED_PREFIX collapses this
    // number to the position of the interpolation, and nothing else in the
    // suite would notice.
    const a = buildPromptText(CTX);
    const b = buildPromptText({
      symbol: "INFY",
      docType: "quarterly_result",
      period: "Q1-FY2026",
      title: "Unaudited Results Q1",
    });

    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared])
      shared++;

    // >= not ==. The shared run legitimately overshoots by the fixed header
    // buildDocumentContext prints before its varying fields (~184 chars), and
    // a LONGER shared prefix is strictly better for caching. The direction
    // that must never regress is SHORTER.
    assert.ok(
      shared >= FIXED_PREFIX.length,
      `two documents share only ${shared} leading chars but FIXED_PREFIX is ` +
        `${FIXED_PREFIX.length} — something per-document leaked into the ` +
        "cached span, which defeats implicit caching on every request",
    );
    assert.equal(
      a.slice(0, FIXED_PREFIX.length),
      FIXED_PREFIX,
      "the shared span does not begin with FIXED_PREFIX",
    );
    // And it must still actually diverge — two contexts producing an identical
    // prompt would satisfy everything above while sending the wrong document
    // identity.
    assert.notEqual(a, b, "different documents produced the same prompt");
  });

  it("buildOnlineRequest puts the prompt in parts[0] in BOTH modes", () => {
    for (const input of [
      { ctx: CTX, markdown: "# TCS\n| Revenue | 1,000 |" },
      {
        ctx: CTX,
        file: { fileUri: "gs://b/x.pdf", mimeType: "application/pdf" },
      },
    ]) {
      const req = buildOnlineRequest(input) as {
        contents: { parts: { text?: string }[] }[];
      };
      const first = req.contents[0].parts[0];
      assert.ok(
        typeof first.text === "string" && first.text.startsWith(FIXED_PREFIX),
        "parts[0] must be the prompt, opening with the cached prefix",
      );
      assert.equal(req.contents[0].parts.length, 2);
    }
  });

  it("buildOnlineRequest refuses both-or-neither of markdown/file", () => {
    assert.throws(() => buildOnlineRequest({ ctx: CTX }), /exactly one/);
    assert.throws(
      () =>
        buildOnlineRequest({
          ctx: CTX,
          markdown: "x",
          file: { fileUri: "gs://b/x.pdf", mimeType: "application/pdf" },
        }),
      /exactly one/,
    );
  });
});

describe("MONEY-1314 — batch line dialects", () => {
  it("developer: the correlation key rides at metadata.key", () => {
    // PROBED 2026-09-01 — a live batchGenerateContent accepted exactly this
    // shape. Sources placing the key at the top level describe another
    // revision; a wrong key location loses the row→document correlation for
    // the whole job, and the job still succeeds.
    const line = JSON.parse(
      buildBatchRequestLine({
        shape: "developer",
        documentId: "doc123",
        ctx: CTX,
        markdown: "# x",
      }),
    );
    assert.deepEqual(Object.keys(line).sort(), ["metadata", "request"]);
    assert.equal(line.metadata.key, "doc123");
    assert.equal(
      line.key,
      undefined,
      "no top-level key in the developer shape",
    );
  });

  it("vertex: NO key field anywhere", () => {
    const line = JSON.parse(
      buildBatchRequestLine({
        shape: "vertex",
        documentId: "doc123",
        ctx: CTX,
        markdown: "# x",
      }),
    );
    assert.deepEqual(Object.keys(line), ["request"]);
    assert.equal(line.metadata, undefined);
  });

  it("both dialects wrap the SAME request body", () => {
    const args = { documentId: "d", ctx: CTX, markdown: "# x" } as const;
    const dev = JSON.parse(
      buildBatchRequestLine({ ...args, shape: "developer" }),
    );
    const vtx = JSON.parse(buildBatchRequestLine({ ...args, shape: "vertex" }));
    assert.deepEqual(dev.request, vtx.request);
  });

  it("a batch line is ONE line — no embedded newline can split it", () => {
    // JSONL: a raw newline inside the payload would turn one request into two
    // malformed ones. JSON.stringify escapes them; this asserts nothing
    // downstream un-escapes.
    const line = buildBatchRequestLine({
      shape: "developer",
      documentId: "d",
      ctx: CTX,
      markdown: "# heading\n\n| a | b |\nmulti\nline",
    });
    assert.equal(line.includes("\n"), false);
    assert.ok(JSON.parse(line));
  });
});

describe("MONEY-1314 — generation config", () => {
  it("temperature is 0 and the response is schema-constrained JSON", () => {
    const g = buildGenerationConfig() as Record<string, unknown>;
    assert.equal(g.temperature, DOC_REQUEST_TEMPERATURE);
    assert.equal(DOC_REQUEST_TEMPERATURE, 0);
    assert.equal(g.responseMimeType, "application/json");
    assert.ok(
      g.responseSchema,
      "a free-text response cannot be parsed reliably",
    );
  });

  it("thinking is ON by default, and BOUNDED rather than dynamic", () => {
    // This test used to assert `thinkingConfig === undefined` — i.e. DYNAMIC
    // thinking — on the reasoning that "the pilot decides, and until then the
    // safer arm ships". The pilot has now decided BOTH halves (MONEY-1332/1334):
    //
    //   ON  — thinking carries accuracy: 17 vs 13 extracted, 45 vs 40 periods,
    //         6 vs 7 real conflicts against the no-thinking arm.
    //   BOUNDED — dynamic was never the safer arm. On Gemini 2.5/3.x,
    //         maxOutputTokens caps thinking + visible output COMBINED, so an
    //         unset budget makes the ceiling the ONLY bound on thinking, and
    //         thinking bills at the OUTPUT rate. In the pilot ~78% of an 8,192
    //         budget went to thinking, truncating 15 of 22 answers mid-JSON.
    assert.deepEqual(
      (buildGenerationConfig() as Record<string, unknown>).thinkingConfig,
      { thinkingBudget: DOC_REQUEST_THINKING_BUDGET },
      "thinking must be BOUNDED — an absent thinkingConfig is dynamic, which " +
        "lets thinking consume the whole ceiling and truncate the answer",
    );
    assert.deepEqual(
      (
        buildGenerationConfig({ disableThinking: true }) as Record<
          string,
          unknown
        >
      ).thinkingConfig,
      { thinkingBudget: 0 },
    );
  });

  it("guarantees the visible answer budget WHATEVER thinking is set to", () => {
    // The MONEY-587 property: budget visible output as a constant ON TOP of the
    // thinking budget, so the two never compete. A flat ceiling shared between
    // them is what truncated the research JSON there and the statements here.
    for (const disableThinking of [false, true]) {
      const cfg = buildGenerationConfig({ disableThinking }) as {
        maxOutputTokens: number;
        thinkingConfig: { thinkingBudget: number };
      };
      assert.equal(
        cfg.maxOutputTokens - cfg.thinkingConfig.thinkingBudget,
        DOC_REQUEST_VISIBLE_OUTPUT_TOKENS,
        `visible headroom must be exactly ${DOC_REQUEST_VISIBLE_OUTPUT_TOKENS} ` +
          `with thinking ${disableThinking ? "off" : "on"}`,
      );
    }
  });

  it("keeps the whole request inside the online lane's 240s deadline", () => {
    // parseMarkdownFinancials runs inside withDeadline(240_000). A ceiling the
    // generation cannot finish under turns a MAX_TOKENS failure into a TIMEOUT
    // failure — still billed in full, and misattributed to the transport.
    // 100 tok/s is the pessimistic Flash rate the review used.
    const SLOW_TOKENS_PER_SEC = 100;
    const ONLINE_DEADLINE_S = 240;
    assert.ok(
      DOC_REQUEST_MAX_OUTPUT_TOKENS / SLOW_TOKENS_PER_SEC < ONLINE_DEADLINE_S,
      `${DOC_REQUEST_MAX_OUTPUT_TOKENS} tokens at ${SLOW_TOKENS_PER_SEC}/s is ` +
        `${(DOC_REQUEST_MAX_OUTPUT_TOKENS / SLOW_TOKENS_PER_SEC).toFixed(0)}s, ` +
        `which does not fit the ${ONLINE_DEADLINE_S}s online deadline`,
    );
  });

  it("buildDocumentContext omits an absent title rather than printing null", () => {
    const withTitle = buildDocumentContext(CTX);
    const without = buildDocumentContext({ ...CTX, title: null });
    assert.ok(withTitle.includes("Document title:"));
    assert.ok(!without.includes("Document title:"));
    assert.ok(!without.includes("null"));
  });
});

/**
 * THE OUTPUT CEILING — MONEY-1332.
 *
 * The first graded pilot finished `MAX_TOKENS` on 15 of 22 responses and 14 of
 * those were cut off mid-JSON, i.e. unparseable — a 64% failure rate against a
 * ceiling that a 2026-09-01 probe had called generous. The probe was not wrong
 * about output; it measured OUTPUT against a budget that also funds THINKING.
 *
 * These assert the RELATIONSHIP, never the literal. A test that says
 * `assert.equal(ceiling, 24_576)` fails when someone tunes it and passes when
 * someone breaks it, which is backwards — it pins the number and protects
 * nothing about why the number is that.
 */
describe("MONEY-1332 — the output ceiling funds thinking as well as output", () => {
  /**
   * The value the pilot PROVED insufficient.
   *
   * This is the anchor, and it is deliberately a measurement rather than a
   * derivation. An earlier version of this test reasoned the requirement from
   * the largest complete answer (7,100 chars ~ 1,775 tokens) plus observed
   * thinking (~6,400) = 8,175 — and then asserted `ceiling > 8_175`, which
   * 8,192 SATISFIES. So the test passed against the exact value that had just
   * truncated 15 of 22 responses. Mutation-testing caught it; reading it did
   * not.
   *
   * The lesson is the general one: when a measurement and a derivation
   * disagree, the derivation is the thing that is wrong. 8,192 did not fail
   * because a formula says it should have — it failed because it was run.
   */
  const MEASURED_INSUFFICIENT_TOKENS = 8_192;
  // NOTE 15 of 22 responses finished MAX_TOKENS at the value above — a
  // MAJORITY, which is what makes it a floor on the requirement rather than an
  // estimate of it. That figure is deliberately NOT asserted: it is a record of
  // a measurement, and `assert.ok(15 / 22 > 0.5)` compares two literals in this
  // file and can never fail for any state of the source.
  /** The model's hard maximum. Asking past it is refused by the vendor. */
  const MODEL_MAX_OUTPUT_TOKENS = 32_768;

  it("is materially above the ceiling that truncated most of a real sample", () => {
    // Not `> 8_192`. A ceiling of 8,193 would satisfy that and would have
    // truncated essentially the same 68% — the margin is the point, because the
    // failing value is a floor on the requirement and not an estimate of it.
    assert.ok(
      DOC_REQUEST_MAX_OUTPUT_TOKENS >= MEASURED_INSUFFICIENT_TOKENS * 2,
      `ceiling ${DOC_REQUEST_MAX_OUTPUT_TOKENS} must be at least double the ` +
        `${MEASURED_INSUFFICIENT_TOKENS} that truncated 68% of a real sample; a ` +
        "marginal increase over a value that failed the majority is not a fix",
    );
  });

  it("stays within the model's hard maximum", () => {
    assert.ok(
      DOC_REQUEST_MAX_OUTPUT_TOKENS <= MODEL_MAX_OUTPUT_TOKENS,
      "a ceiling above the model maximum is refused by the vendor per line, " +
        "after the input file has already been uploaded",
    );
  });

  it("is OVERRIDABLE per request, and the override actually reaches the config", () => {
    // `createMissing` (MONEY-1235) was documented as opt-in, declared on the
    // type, forwarded by nobody, and therefore false in every production run
    // that ever executed. This asserts the wire, not the declaration.
    const line = JSON.parse(
      buildBatchRequestLine({
        shape: "developer",
        documentId: "d1",
        ctx: { symbol: "TCS", docType: "annual_report", period: "FY2025" },
        markdown: "# balance sheet",
        maxOutputTokens: 12_345,
      }),
    ) as { request: { generationConfig: { maxOutputTokens: number } } };
    assert.equal(line.request.generationConfig.maxOutputTokens, 12_345);
  });

  it("falls back to the shipped default when no override is given", () => {
    const line = JSON.parse(
      buildBatchRequestLine({
        shape: "developer",
        documentId: "d1",
        ctx: { symbol: "TCS", docType: "annual_report", period: "FY2025" },
        markdown: "# balance sheet",
      }),
    ) as { request: { generationConfig: { maxOutputTokens: number } } };
    assert.equal(
      line.request.generationConfig.maxOutputTokens,
      DOC_REQUEST_MAX_OUTPUT_TOKENS,
    );
  });

  /* ── MONEY-1346: an override under the thinking budget is REFUSED ───────── */

  it("refuses a ceiling that leaves no room for visible output", () => {
    // `thinkingConfig` is emitted unconditionally and `maxOutputTokens` caps
    // thinking and visible output COMBINED, so an override at or below the
    // thinking budget describes a request that cannot emit a single visible
    // token. Unrefused, that does not fail — it reports DOC_PARSE_TRUNCATED
    // for 100% of the run, which reads like a model that cannot answer rather
    // than a flag that cannot work.
    for (const bad of [1, 4_000, DOC_REQUEST_THINKING_BUDGET]) {
      assert.throws(
        () => buildGenerationConfig({ maxOutputTokens: bad }),
        /leaves no room for visible output/,
        `maxOutputTokens=${bad} must be refused`,
      );
    }
  });

  it("allows the first ceiling that CAN produce output", () => {
    // The boundary, on the passing side. Without it, a mutation refusing every
    // override passes the case above and removes the flag entirely.
    const cfg = buildGenerationConfig({
      maxOutputTokens: DOC_REQUEST_THINKING_BUDGET + 1,
    }) as { maxOutputTokens: number };
    assert.equal(cfg.maxOutputTokens, DOC_REQUEST_THINKING_BUDGET + 1);
  });

  it("a small ceiling is fine once thinking is disabled", () => {
    // The refusal is against the ACTUAL budget, not the constant — so the
    // operator who turns thinking off gets the whole ceiling for output and a
    // 4,000-token cap becomes a legitimate request.
    const cfg = buildGenerationConfig({
      maxOutputTokens: 4_000,
      disableThinking: true,
    }) as {
      maxOutputTokens: number;
      thinkingConfig: { thinkingBudget: number };
    };
    assert.equal(cfg.maxOutputTokens, 4_000);
    assert.equal(cfg.thinkingConfig.thinkingBudget, 0);
  });
});
