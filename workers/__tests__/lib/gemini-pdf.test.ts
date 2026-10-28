/**
 * The Gemini PDF transport — MONEY-1255.
 *
 * Everything here is the REAL export `stock-document-parse.ts` calls. The
 * model call itself is not exercised (that needs a live key), but every
 * decision AROUND it is, because those are the parts that fail silently or
 * environment-dependently:
 *
 *   - which TRANSPORT an environment can use (the Files API THROWS on a Vertex
 *     client, so picking wrong is a hard failure, not a degradation)
 *   - the size ceiling, which is a COUNTED skip rather than a silent one
 *   - the shared deadline, whose timer must never outlive the call
 *   - the response reader, which must never let a NaN token count through
 */

import { describe, it, afterEach } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { GEMINI_MODELS } from "@usemoney/core/gemini/model-registry";
import {
  DOC_PARSE_TOO_LARGE,
  DOC_PARSE_UNCONFIGURED,
  DOC_PARSE_UNPARSEABLE,
  DEFAULT_DOC_PARSE_BUDGET_MS,
  FILES_API_MAX_BYTES,
  MAX_PDF_BYTES,
  classifyFileState,
  createDeadline,
  docParseBudgetMs,
  extractResponseText,
  geminiPdfReady,
  parseDocFinancialsJson,
  parsePdfFinancials,
  parseMarkdownFinancials,
  assembleParseResult,
  readFinishReason,
  DOC_PARSE_TRUNCATED,
  readUsage,
  resetGeminiPdfClients,
  resolveDocParseModel,
  resolveTransport,
  withDeadline,
} from "../../src/lib/gemini-pdf";

/** Run `fn` with a patched environment, restoring it whatever happens. */
async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetGeminiPdfClients();
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetGeminiPdfClients();
  }
}

afterEach(() => resetGeminiPdfClients());

// ══════════════════════════════════════════════════════════════════════
// TRANSPORT ROUTING
// ══════════════════════════════════════════════════════════════════════

describe("transport routing", () => {
  it("Developer API key → the Files API", () => {
    assert.equal(
      resolveTransport({ GOOGLE_GENAI_API_KEY: "k" }, null),
      "files-api",
    );
    // The key wins even with a project set — `files.upload` THROWS on a Vertex
    // client, so the two are not interchangeable.
    assert.equal(
      resolveTransport(
        { GOOGLE_GENAI_API_KEY: "k", GCP_PROJECT_ID: "p" },
        "gs://b/o.pdf",
      ),
      "files-api",
    );
  });

  it("Vertex project + a gs:// URI → the object read directly", () => {
    assert.equal(
      resolveTransport({ GCP_PROJECT_ID: "p" }, "gs://b/o.pdf"),
      "gcs-uri",
    );
  });

  it("Vertex project WITHOUT a gs:// URI has no way to send the bytes", () => {
    // Vertex cannot take an upload and cannot take inline at this size, so this
    // has to be an explicit "none" rather than a hopeful attempt.
    assert.equal(resolveTransport({ GCP_PROJECT_ID: "p" }, null), "none");
    assert.equal(resolveTransport({ GCP_PROJECT_ID: "p" }, "  "), "none");
  });

  it("nothing configured → none", () => {
    assert.equal(resolveTransport({}, "gs://b/o.pdf"), "none");
    assert.equal(resolveTransport({ GOOGLE_GENAI_API_KEY: "  " }, null), "none");
  });

  it("geminiPdfReady reflects the same two backends", async () => {
    await withEnv(
      { GOOGLE_GENAI_API_KEY: undefined, GCP_PROJECT_ID: undefined },
      () => assert.equal(geminiPdfReady(), false),
    );
    await withEnv({ GOOGLE_GENAI_API_KEY: "k" }, () =>
      assert.equal(geminiPdfReady(), true),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// MODEL SELECTION
// ══════════════════════════════════════════════════════════════════════

describe("the model comes from the registry, not from a string literal", () => {
  it("CEILING: the registry is populated", () => {
    assert.ok(GEMINI_MODELS.length > 3, "the registry import is broken");
  });

  it("defaults to a REGISTERED Flash-tier Gemini model", async () => {
    await withEnv({ DOC_PARSE_MODEL: undefined }, () => {
      const picked = resolveDocParseModel();
      const def = GEMINI_MODELS.find((m) => m.id === picked);
      assert.ok(def, `${picked} must exist in the registry`);
      assert.equal(def.tier, "L1", "decision D-c: this lane runs on Flash");
      assert.equal(def.provider, "google");
      assert.match(picked, /flash/i);
    });
  });

  it("honours a registered override", async () => {
    await withEnv({ DOC_PARSE_MODEL: "gemini-2.5-flash" }, () =>
      assert.equal(resolveDocParseModel(), "gemini-2.5-flash"),
    );
  });

  it("IGNORES an unregistered override rather than 404ing every document", async () => {
    await withEnv({ DOC_PARSE_MODEL: "gemini-9-turbo" }, () => {
      const picked = resolveDocParseModel();
      assert.notEqual(picked, "gemini-9-turbo");
      assert.ok(GEMINI_MODELS.some((m) => m.id === picked));
    });
  });

  it("an explicit argument beats the env var", async () => {
    await withEnv({ DOC_PARSE_MODEL: "gemini-2.5-flash" }, () =>
      assert.equal(
        resolveDocParseModel("gemini-2.5-flash-lite"),
        "gemini-2.5-flash-lite",
      ),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// SIZE CEILING
// ══════════════════════════════════════════════════════════════════════

describe("the size ceiling", () => {
  it("is OURS, and visibly not the Files API's own 2 GiB limit", () => {
    assert.equal(FILES_API_MAX_BYTES, 2 * 1024 * 1024 * 1024);
    assert.ok(
      MAX_PDF_BYTES < FILES_API_MAX_BYTES,
      "the binding constraint is latency + page count, not the transport",
    );
    assert.equal(MAX_PDF_BYTES, 50 * 1024 * 1024);
  });

  it("clears the production tail an inline ceiling would have cut", () => {
    // 15,705 financial-statement PDFs: 12.2% exceed 12 MiB, 3.7% exceed 20 MiB.
    // A ceiling under 20 MiB drops a biased slice — the largest companies.
    assert.ok(MAX_PDF_BYTES > 20 * 1024 * 1024);
  });

  it("an oversized document degrades to TOO_LARGE without calling anything", async () => {
    await withEnv({ GOOGLE_GENAI_API_KEY: "not-a-real-key" }, async () => {
      const result = await parsePdfFinancials({
        bytes: Buffer.alloc(MAX_PDF_BYTES + 1),
        prompt: "p",
        label: "HUGE (annual_report/2025)",
      });
      assert.equal(result.ok, false);
      assert.equal(result.failure, DOC_PARSE_TOO_LARGE);
      assert.equal(result.data, null);
      assert.match(result.error ?? "", /above the .* ceiling/);
      // The counter is what turns the gap into a number rather than an anecdote.
      assert.deepEqual(result.usage, {
        promptTokens: 0,
        candidatesTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        thinkingTokens: 0,
      });
    });
  });

  it("empty bytes are UNPARSEABLE, not TOO_LARGE and not a crash", async () => {
    await withEnv({ GOOGLE_GENAI_API_KEY: "not-a-real-key" }, async () => {
      const result = await parsePdfFinancials({
        bytes: Buffer.alloc(0),
        prompt: "p",
        label: "EMPTY",
      });
      assert.equal(result.failure, DOC_PARSE_UNPARSEABLE);
    });
  });

  it("an unconfigured environment degrades instead of throwing", async () => {
    await withEnv(
      { GOOGLE_GENAI_API_KEY: undefined, GCP_PROJECT_ID: undefined },
      async () => {
        const result = await parsePdfFinancials({
          bytes: Buffer.from("%PDF-1.7"),
          prompt: "p",
          label: "TCS (annual_report/2025)",
        });
        assert.equal(result.ok, false);
        assert.equal(result.failure, DOC_PARSE_UNCONFIGURED);
        assert.equal(result.transport, "none");
      },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE SHARED DEADLINE
// ══════════════════════════════════════════════════════════════════════

describe("one deadline shared by upload, activation and generation", () => {
  it("counts down and expires", () => {
    let clock = 1000;
    const d = createDeadline(500, () => clock);
    assert.equal(d.remaining(), 500);
    assert.equal(d.expired(), false);
    clock = 1400;
    assert.equal(d.remaining(), 100);
    clock = 1500;
    assert.equal(d.expired(), true);
    clock = 9999;
    assert.equal(d.remaining(), 0, "never negative");
  });

  it("resolves a fast promise and CLEARS its timer", async () => {
    // The orphan check, made observable. A 5s deadline whose timer is not
    // cleared stays on the event loop for 5s after the call returns and keeps
    // the worker process alive — this repo's standing rule is that tests must
    // never orphan, and the source is where that is won.
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const out = await withDeadline(
      Promise.resolve("done"),
      createDeadline(5_000),
      "fast",
    );
    const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    assert.equal(out, "done");
    assert.ok(
      after <= before,
      `a Timeout survived the call (${before} → ${after}) — the finally did not clear it`,
    );
  });

  it("rejects when the promise outlives the budget", async () => {
    await assert.rejects(
      () =>
        withDeadline(
          new Promise((resolve) => {
            const t = setTimeout(resolve, 5_000);
            if (typeof t === "object" && "unref" in t) t.unref();
          }),
          createDeadline(20),
          "slow stage",
        ),
      /slow stage timed out after 20ms/,
    );
  });

  it("refuses to start a stage with no budget left", async () => {
    // Without this the third stage would race against a 0ms timer and reject
    // with a confusing "timed out after 0ms" instead of saying what happened.
    let clock = 0;
    const d = createDeadline(100, () => clock);
    clock = 999;
    await assert.rejects(
      () => withDeadline(Promise.resolve(1), d, "third stage"),
      /budget exhausted before it started/,
    );
  });

  it("reads the budget from the env, falling back to the documented default", async () => {
    await withEnv({ DOC_PARSE_BUDGET_MS: undefined }, () =>
      assert.equal(docParseBudgetMs(), DEFAULT_DOC_PARSE_BUDGET_MS),
    );
    await withEnv({ DOC_PARSE_BUDGET_MS: "1234" }, () =>
      assert.equal(docParseBudgetMs(), 1234),
    );
    for (const bad of ["", "0", "-5", "abc"]) {
      await withEnv({ DOC_PARSE_BUDGET_MS: bad }, () =>
        assert.equal(
          docParseBudgetMs(),
          DEFAULT_DOC_PARSE_BUDGET_MS,
          `"${bad}" must not become the budget`,
        ),
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// FILE ACTIVATION
// ══════════════════════════════════════════════════════════════════════

describe("classifyFileState separates FAILED from SLOW", () => {
  it("ACTIVE is ready, PROCESSING waits, FAILED fails", () => {
    assert.equal(classifyFileState("ACTIVE"), "ready");
    assert.equal(classifyFileState("PROCESSING"), "wait");
    assert.equal(classifyFileState("FAILED"), "failed");
  });

  it("an absent state is ready, not an infinite poll", () => {
    // A permanently-unusable file that polled until the budget died would be
    // reported as a TIMEOUT — which reads as transient and gets retried forever.
    assert.equal(classifyFileState(undefined), "ready");
    assert.equal(classifyFileState(""), "ready");
    assert.equal(classifyFileState("STATE_UNSPECIFIED"), "ready");
  });
});

// ══════════════════════════════════════════════════════════════════════
// THE MARKDOWN LANE — MONEY-1314
// ══════════════════════════════════════════════════════════════════════

describe("parseMarkdownFinancials guards", () => {
  const CTX = {
    symbol: "TCS",
    docType: "annual_report",
    period: "FY2025",
    title: null,
  };

  it("no Gemini backend at all degrades to UNCONFIGURED", async () => {
    await withEnv(
      { GOOGLE_GENAI_API_KEY: undefined, GCP_PROJECT_ID: undefined },
      async () => {
        const r = await parseMarkdownFinancials({
          markdown: "# TCS\n| Revenue | 1,000 |",
          ctx: CTX,
          label: "TCS",
        });
        assert.equal(r.ok, false);
        assert.equal(r.failure, DOC_PARSE_UNCONFIGURED);
        assert.equal(r.data, null);
      },
    );
  });

  it("the markdown lane needs NO gs:// URI and NO Files API", async () => {
    // The distinction from parsePdfFinancials that makes 222 MB documents
    // reachable: `resolveTransport` answers "none" for a Developer-API-less
    // env with no URI, but this lane only needs A backend. Asserting the
    // POSITIVE direction — GCP_PROJECT_ID alone, no URI, no API key — is what
    // catches someone "tidying" this back onto resolveTransport().
    await withEnv(
      { GOOGLE_GENAI_API_KEY: undefined, GCP_PROJECT_ID: "p" },
      async () => {
        assert.equal(resolveTransport({ GCP_PROJECT_ID: "p" }, null), "none");
        const r = await parseMarkdownFinancials({
          markdown: "",
          ctx: CTX,
          label: "TCS",
        });
        // It got PAST the configuration gate — the failure it reports is the
        // empty-markdown one, not UNCONFIGURED.
        assert.equal(r.failure, DOC_PARSE_UNPARSEABLE);
        assert.equal(r.transport, "inline-text");
      },
    );
  });

  it("empty markdown is UNPARSEABLE, never an empty success", async () => {
    // A zero-page selection and a converter that produced nothing arrive here
    // looking identical to a document that genuinely holds no statements. A
    // silent `ok: true, periods: []` would write "we read it and found
    // nothing" over a document nobody read — and that verdict is terminal.
    await withEnv({ GOOGLE_GENAI_API_KEY: "not-a-real-key" }, async () => {
      for (const md of ["", "   ", "\n\n\t\n"]) {
        const r = await parseMarkdownFinancials({
          markdown: md,
          ctx: CTX,
          label: "TCS",
        });
        assert.equal(r.ok, false, `"${md}" must not parse as a success`);
        assert.equal(r.failure, DOC_PARSE_UNPARSEABLE);
        assert.equal(r.data, null);
        assert.match(r.error ?? "", /converter or the page selector/);
      }
    });
  });

  it("[control] non-empty markdown gets PAST the empty guard", async () => {
    // Proves the guard discriminates. Without this it could reject everything
    // and all three assertions above would still pass.
    await withEnv({ GOOGLE_GENAI_API_KEY: "not-a-real-key" }, async () => {
      const r = await parseMarkdownFinancials({
        markdown: "# TCS\n| Revenue | 1,000 |",
        ctx: CTX,
        label: "TCS",
      });
      // It reached the API with a bogus key, so it fails — but as a CALL
      // failure, which is the transient class, not the deterministic one.
      assert.notEqual(
        r.failure,
        DOC_PARSE_UNPARSEABLE,
        "real markdown was rejected by the empty-input guard",
      );
    });
  });

  it("no size ceiling exists in the markdown lane — checked in the SOURCE", () => {
    // MAX_PDF_BYTES is Gemini's DOCUMENT limit and our largest PDF is 222.3 MB.
    // Those documents are markdown-or-nothing; a size gate copied over from the
    // vision path would make them unreachable in BOTH lanes.
    //
    // This reads the file rather than passing oversized input, because the
    // behavioural version could not kill the mutation it exists to catch: a
    // test feeding 1.8 MB of markdown passes just as happily with a 50 MB gate
    // in place, and feeding a genuinely >50 MB string costs ~110 MB of heap to
    // prove one branch.
    const src = readFileSync(
      new URL("../../src/lib/gemini-pdf.ts", import.meta.url),
      "utf8",
    );
    const start = src.indexOf("export async function parseMarkdownFinancials");
    assert.ok(start > 0, "parseMarkdownFinancials not found — rename?");
    const body = src.slice(start);
    assert.ok(
      !body.includes("MAX_PDF_BYTES"),
      "parseMarkdownFinancials references MAX_PDF_BYTES — the markdown lane " +
        "must have no size ceiling, or 222 MB documents are unreachable in " +
        "both lanes",
    );
    assert.ok(
      !body.includes("DOC_PARSE_TOO_LARGE"),
      "the markdown lane can never legitimately return TOO_LARGE",
    );
  });

  it("[control] the SAME scan finds the ceiling in the vision lane", () => {
    // Proves the scan can find what it looks for. Without this, a wrong slice
    // offset or a renamed constant makes both assertions above vacuously true.
    const src = readFileSync(
      new URL("../../src/lib/gemini-pdf.ts", import.meta.url),
      "utf8",
    );
    const start = src.indexOf("export async function parsePdfFinancials");
    const end = src.indexOf("export async function parseMarkdownFinancials");
    assert.ok(start > 0 && end > start);
    const body = src.slice(start, end);
    assert.ok(body.includes("MAX_PDF_BYTES"));
    assert.ok(body.includes("DOC_PARSE_TOO_LARGE"));
  });
});

describe("assembleParseResult — the success/failure classification", () => {
  const okResponse = {
    usageMetadata: {
      promptTokenCount: 10_000,
      candidatesTokenCount: 1_728,
      totalTokenCount: 11_728,
      cachedContentTokenCount: 4_506,
    },
    candidates: [
      { content: { parts: [{ text: '{"periods":[{"fiscalYear":"FY2025"}]}' }] } },
    ],
  };

  it("schema-shaped JSON becomes ok:true with the data attached", () => {
    const r = assembleParseResult({
      response: okResponse,
      model: "m",
      transport: "inline-text",
      elapsedMs: 42,
    });
    assert.equal(r.ok, true);
    assert.equal(r.failure, null);
    assert.equal(r.error, null);
    assert.equal(r.transport, "inline-text");
    assert.equal(r.elapsedMs, 42);
    assert.equal(r.usage.cachedTokens, 4_506);
    assert.ok(r.data);
  });

  it("UNREADABLE JSON is a FAILURE, never ok:true with empty periods", () => {
    // The mutation this kills: returning `{ ok: true, data: { periods: [] } }`
    // when the response cannot be parsed. That writes "we read this document
    // and it holds no statements" over a document nobody read — and the
    // verdict is terminal, so the row is never revisited.
    for (const bad of [
      { candidates: [{ content: { parts: [{ text: "I could not read that." }] } }] },
      { candidates: [{ content: { parts: [{ text: "" }] } }] },
      { candidates: [] },
      {},
      null,
    ]) {
      const r = assembleParseResult({
        response: bad,
        model: "m",
        transport: "inline-text",
        elapsedMs: 1,
      });
      assert.equal(r.ok, false, `${JSON.stringify(bad)} must not read as ok`);
      assert.equal(r.data, null, "a failed parse must carry NO data");
      assert.equal(r.failure, DOC_PARSE_UNPARSEABLE);
      assert.match(r.error ?? "", /schema-shaped/);
    }
  });

  it("usage is reported on BOTH outcomes — a failed call still cost money", () => {
    const r = assembleParseResult({
      response: {
        usageMetadata: { promptTokenCount: 9_000, totalTokenCount: 9_000 },
        candidates: [{ content: { parts: [{ text: "nope" }] } }],
      },
      model: "m",
      transport: "inline-text",
      elapsedMs: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.usage.promptTokens, 9_000);
  });

  it("both lanes route through it — checked in the SOURCE", () => {
    // The duplication it replaced is what let the ok/failure mutation survive.
    const src = readFileSync(
      new URL("../../src/lib/gemini-pdf.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      (src.match(/assembleParseResult\(\{/g) ?? []).length,
      2,
      "exactly two call sites expected — one per lane; a third copy of this " +
        "classification is how the branches drift apart again",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// READING THE RESPONSE
// ══════════════════════════════════════════════════════════════════════

describe("usage accounting never lets a non-finite through", () => {
  it("reads the five counters", () => {
    assert.deepEqual(
      readUsage({
        usageMetadata: {
          promptTokenCount: 120_000,
          candidatesTokenCount: 4_000,
          totalTokenCount: 124_000,
          cachedContentTokenCount: 4_506,
          thoughtsTokenCount: 6_400,
        },
      }),
      {
        promptTokens: 120_000,
        candidatesTokens: 4_000,
        totalTokens: 124_000,
        cachedTokens: 4_506,
        thinkingTokens: 6_400,
      },
    );
  });

  it("cachedTokens reads `cachedContentTokenCount`, not `cachedTokenCount`", () => {
    // MONEY-1314 — the near-miss spelling is what most write-ups of this field
    // use, and it fails INVISIBLY: a wrong key reads 0 through the same
    // finite-guard that protects a genuinely absent one, so the single
    // observable proving implicit caching engaged would read zero forever
    // while ~48,000 batch requests quietly paid full price.
    assert.equal(
      readUsage({ usageMetadata: { cachedContentTokenCount: 4_506 } }).cachedTokens,
      4_506,
    );
    assert.equal(
      readUsage({ usageMetadata: { cachedTokenCount: 4_506 } }).cachedTokens,
      0,
      "the wrong spelling must not accidentally work — if it does, the two " +
        "keys have been conflated and a real zero is now unobservable",
    );
  });

  it("coerces NaN / Infinity / missing / non-numeric to 0", () => {
    // A NaN token count summed across a nightly batch makes the whole cost
    // report NaN — a cost nobody can read is a cost nobody controls.
    assert.deepEqual(
      readUsage({
        usageMetadata: {
          promptTokenCount: NaN,
          candidatesTokenCount: Infinity,
          totalTokenCount: "124000",
        },
      }),
      {
        promptTokens: 0,
        candidatesTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        thinkingTokens: 0,
      },
    );
    for (const bad of [null, undefined, {}, { usageMetadata: null }, 7]) {
      assert.deepEqual(readUsage(bad), {
        promptTokens: 0,
        candidatesTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        thinkingTokens: 0,
      });
    }
  });
});

describe("extractResponseText / parseDocFinancialsJson", () => {
  it("concatenates the first candidate's text parts", () => {
    assert.equal(
      extractResponseText({
        candidates: [
          { content: { parts: [{ text: '{"per' }, { text: 'iods":[]}' }] } },
        ],
      }),
      '{"periods":[]}',
    );
    for (const bad of [null, undefined, {}, { candidates: [] }]) {
      assert.equal(extractResponseText(bad), "");
    }
  });

  it("parses plain and fenced JSON objects", () => {
    assert.deepEqual(parseDocFinancialsJson('{"periods":[]}'), { periods: [] });
    assert.deepEqual(
      parseDocFinancialsJson('```json\n{"periods":[{"basis":"X"}]}\n```'),
      { periods: [{ basis: "X" }] },
    );
    assert.deepEqual(parseDocFinancialsJson('```\n{"periods":[]}\n```'), {
      periods: [],
    });
  });

  it("returns null — never throws — for anything that is not an object", () => {
    // An unparseable answer is a PROMPT signal and must stay distinguishable
    // from a failed call, so it cannot arrive as an exception.
    for (const bad of ["", "   ", "not json", "[1,2]", "null", "42", '"str"']) {
      assert.equal(
        parseDocFinancialsJson(bad),
        null,
        `${JSON.stringify(bad)} must not parse to an object`,
      );
    }
  });
});

/**
 * TRUNCATION IS A DIFFERENT FAILURE FROM UNREADABILITY — MONEY-1334.
 *
 * Both arrive as text that will not parse. Only one is ours. A response cut off
 * at the output ceiling used to be classified UNPARSEABLE, which on a first
 * attempt buys a whole-PDF vision retry — under the SAME ceiling, so it hits the
 * identical wall after a GCS download of up to 50 MiB, a Files API upload and a
 * second paid generation.
 *
 * These tests were written after mutation testing: removing the MAX_TOKENS
 * detection and reading finishReason off the wrong object BOTH survived the
 * suite, because nothing here exercised either.
 */
describe("MONEY-1334 — truncated answers are classified apart", () => {
  const truncated = {
    candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"periods":[{"fisc' }] } }],
    usageMetadata: { candidatesTokenCount: 1_400, thoughtsTokenCount: 6_400 },
  };
  const garbage = {
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: "I cannot help with that." }] } }],
  };

  it("reads finishReason from the CANDIDATE, not the response", () => {
    assert.equal(readFinishReason(truncated), "MAX_TOKENS");
    // A level up yields undefined for EVERY answer, healthy or not, which is
    // indistinguishable from "the vendor does not send this field".
    assert.equal(readFinishReason({ finishReason: "MAX_TOKENS" }), null);
    assert.equal(readFinishReason(null), null);
    assert.equal(readFinishReason({ candidates: [] }), null);
  });

  it("classifies a MAX_TOKENS cut-off as TRUNCATED, not UNPARSEABLE", () => {
    const r = assembleParseResult({
      response: truncated,
      model: "gemini-3.7-flash",
      transport: "inline-text",
      elapsedMs: 10,
    });
    assert.equal(r.ok, false);
    assert.equal(r.failure, DOC_PARSE_TRUNCATED);
    // The error names the split so an operator can act without re-deriving it.
    assert.match(String(r.error), /MAX_TOKENS/);
    assert.match(String(r.error), /6400 thinking/);
  });

  it("still classifies genuinely unreadable text as UNPARSEABLE", () => {
    // The control: without it, "everything is TRUNCATED" would pass the test
    // above and silently remove every vision retry in the pipeline.
    const r = assembleParseResult({
      response: garbage,
      model: "gemini-3.7-flash",
      transport: "inline-text",
      elapsedMs: 10,
    });
    assert.equal(r.failure, DOC_PARSE_UNPARSEABLE);
    assert.match(String(r.error), /finishReason=STOP/);
  });

  it("surfaces the thinking spend that shares the output ceiling", () => {
    const r = assembleParseResult({
      response: truncated,
      model: "gemini-3.7-flash",
      transport: "inline-text",
      elapsedMs: 10,
    });
    assert.equal(
      r.usage.thinkingTokens,
      6_400,
      "thinking bills at the OUTPUT rate and is drawn from the same ceiling; " +
        "unrecorded, the largest component of the bill is invisible and the " +
        "ceiling can only be re-chosen by guessing",
    );
  });
});

