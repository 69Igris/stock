/**
 * MONEY-543 - Synthesizer Prompt: sections-required hardening + Validator gate
 *
 * The advanced synthesizer prompt was hardened with explicit `sections`
 * REQUIRED clauses to prevent the SEBI compliance tail block (MONEY-457)
 * from drifting the LLM into omitting the sections array. These tests:
 *
 *   1. Pin the four prompt edits to their exact wording so a silent revert
 *      or rewrite fails CI.
 *   2. Extract and JSON.parse the OUTPUT FORMAT example so any future edit
 *      that breaks the example's JSON validity gets caught.
 *   3. Assert ordering invariants (schema rule must appear BEFORE the SEBI
 *      block so the LLM reads it as authoritative on schema).
 *   4. Regression sentinels for the MONEY-457 (`recommendation: "N/A"`) and
 *      MONEY-445 (`disclaimer` field) compliance locks.
 *   5. Validator prompt gets a sections-array gate clause.
 *
 * Imports via a relative path because the @usemoney/research package does
 * not currently expose `./prompts` in its barrel. The relative path
 * resolves to the source file in *this* worktree, not the main checkout,
 * which is what we want — these tests pin THIS branch's prompt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getAdvancedSynthesizerPrompt,
  getFastSynthesizerPrompt,
  getStrategySynthesizerPrompt,
  getEmergencySynthesizerPrompt,
  getValidatorPrompt,
  getSynthesizerPrompt,
  buildPlannerUserPrompt,
} from "../../../../packages/research/src/prompts";
import { SKILL_TOOL_ALLOWLIST } from "../../../../packages/research/src/skills/skill-tool-map";

// ─── Helpers ────────────────────────────────────────────────

interface StructuredReportExample {
  score: unknown;
  recommendation: unknown;
  confidence: unknown;
  summary: unknown;
  sections: unknown;
  keyMetrics: unknown;
  strengths: unknown;
  risks: unknown;
  disclaimer: unknown;
  [key: string]: unknown;
}

/**
 * Extract the OUTPUT FORMAT example JSON object from a synthesizer prompt.
 *
 * Strategy: find "OUTPUT FORMAT", then find the first `{` after it, then
 * walk forward counting braces (respecting strings) until matching `}`.
 *
 * NOTE: the prompt's example uses template-literal `\n` which becomes a
 * real newline character in the runtime string. Raw JSON forbids
 * unescaped control characters in string values, so we sanitize them
 * before JSON.parse (replace real newlines/tabs/etc. INSIDE strings with
 * their escape sequences). The `raw` we return is the un-sanitized region
 * so other tests can assert against the original text.
 */
function extractOutputFormatJson(prompt: string): {
  raw: string;
  sanitized: string;
  parsed: StructuredReportExample;
} {
  const marker = "OUTPUT FORMAT";
  const markerIdx = prompt.indexOf(marker);
  assert.notEqual(
    markerIdx,
    -1,
    `prompt is missing the "${marker}" header — cannot extract example`
  );

  const startBrace = prompt.indexOf("{", markerIdx);
  assert.notEqual(
    startBrace,
    -1,
    `no opening brace after "${marker}" — cannot extract example`
  );

  // Walk braces, ignore those inside strings.
  let depth = 0;
  let inString = false;
  let escape = false;
  let endBrace = -1;
  for (let i = startBrace; i < prompt.length; i++) {
    const ch = prompt[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        endBrace = i;
        break;
      }
    }
  }
  assert.notEqual(endBrace, -1, "unbalanced braces in OUTPUT FORMAT example");

  const raw = prompt.slice(startBrace, endBrace + 1);

  // Sanitize: escape real control characters that appear INSIDE strings
  // so JSON.parse accepts the example. Walk the string state again.
  let sanitized = "";
  inString = false;
  escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (inString) {
      if (escape) {
        sanitized += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        sanitized += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        sanitized += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") sanitized += "\\n";
      else if (ch === "\r") sanitized += "\\r";
      else if (ch === "\t") sanitized += "\\t";
      else if (ch === "\b") sanitized += "\\b";
      else if (ch === "\f") sanitized += "\\f";
      else sanitized += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    sanitized += ch;
  }

  const parsed = JSON.parse(sanitized) as StructuredReportExample;
  return { raw, sanitized, parsed };
}

// ═══════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════

describe("MONEY-543 - getAdvancedSynthesizerPrompt: sections-required hardening", () => {
  // ── 1. CRITICAL SCHEMA RULE block ──────────────────────────

  describe("CRITICAL SCHEMA RULE block (anti-drift from SEBI tail)", () => {
    it("contains the 'sections\" IS REQUIRED' clause header", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`sections" IS REQUIRED`),
        `Expected "sections\" IS REQUIRED" header to anchor the schema-rule block`
      );
    });

    it("contains the 'CRITICAL SCHEMA RULE' header literal", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("CRITICAL SCHEMA RULE"),
        "Expected the CRITICAL SCHEMA RULE header to be present"
      );
    });

    it("explicitly says the rule overrides the SEBI compliance block", () => {
      // This is the anti-drift clause — without it, the SEBI block at the
      // tail (with its "OVERRIDE any conflicting instruction above"
      // language) was successfully tricking the LLM into dropping sections.
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("overrides"),
        "Expected the schema rule to declare it overrides later instructions"
      );
      assert.ok(
        prompt.includes("SEBI compliance block"),
        "Expected the rule to call out the SEBI compliance block by name"
      );
    });

    it("contains 'Never drop the \"sections\" key' clause", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`Never drop the`),
        "Expected explicit 'Never drop the' clause"
      );
    });

    it("contains 'Never return an empty sections array' clause", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("Never return an empty sections array"),
        "Expected explicit 'Never return an empty sections array' clause"
      );
    });

    it("documents the placeholder content for missing-data sections", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      // The hardening tells the LLM to emit a placeholder section instead
      // of dropping it. Pin the placeholder wording so anyone removing it
      // gets flagged.
      assert.ok(
        prompt.includes(
          `"No data\navailable from the upstream tools for this section."`
        ) ||
          prompt.includes(
            `"No data available from the upstream tools for this section."`
          ),
        "Expected placeholder content string to be quoted in the prompt"
      );
    });
  });

  // ── 2. REQUIRED SECTIONS header rewrite ────────────────────

  describe("REQUIRED SECTIONS header still present after rewrite", () => {
    it("retains the 'REQUIRED SECTIONS' header", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("REQUIRED SECTIONS"),
        "REQUIRED SECTIONS header must still be in the prompt"
      );
    });

    it("includes the 'Never omit / non-empty' language in the header context", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      const headerIdx = prompt.indexOf("REQUIRED SECTIONS");
      // Look at the 400 chars following the header — that's the rewritten body.
      const headerWindow = prompt.slice(headerIdx, headerIdx + 400);
      assert.ok(
        headerWindow.includes("NEVER omitted") ||
          headerWindow.includes("Never omit"),
        "Header rewrite should say sections are never omitted"
      );
      assert.ok(
        headerWindow.includes("non-empty"),
        "Header rewrite should mandate a non-empty array"
      );
    });

    it("lists all 12 required sections by number (1. through 12.)", () => {
      // The header rewrite kept the numbered section list. Sanity check
      // that all 12 sections are still there.
      const prompt = getAdvancedSynthesizerPrompt();
      for (let i = 1; i <= 12; i++) {
        assert.ok(
          prompt.includes(`${i}. `),
          `Required-sections list is missing entry "${i}."`
        );
      }
    });
  });

  // ── 3. RULES block sections enforcement ────────────────────

  describe("RULES block sections clause", () => {
    it("contains 'sections: REQUIRED, non-empty array' rule line", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("sections: REQUIRED, non-empty array"),
        "Expected exact 'sections: REQUIRED, non-empty array' line in RULES block"
      );
    });

    it("contains 'Never omit the key' phrase", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("Never omit the key"),
        "Expected 'Never omit the key' phrase"
      );
    });

    it("contains 'Never return []' phrase", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("Never return []"),
        "Expected exact 'Never return []' phrase"
      );
    });
  });

  // ── 4. Ordering invariant ──────────────────────────────────

  describe("Ordering: CRITICAL SCHEMA RULE comes BEFORE the SEBI block", () => {
    it("'CRITICAL SCHEMA RULE' index is greater than -1 (present)", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(prompt.indexOf("CRITICAL SCHEMA RULE") > -1);
    });

    it("SEBI block appears AFTER CRITICAL SCHEMA RULE in the prompt body", () => {
      // The SEBI compliance block uses the marker
      // "CRITICAL SEBI COMPLIANCE" (see SEBI_COMPLIANCE_RULES constant).
      const prompt = getAdvancedSynthesizerPrompt();
      const schemaIdx = prompt.indexOf("CRITICAL SCHEMA RULE");
      const sebiIdx = prompt.indexOf("CRITICAL SEBI COMPLIANCE");
      assert.notEqual(schemaIdx, -1, "schema rule must be present");
      assert.notEqual(sebiIdx, -1, "SEBI block must be present");
      assert.ok(
        sebiIdx > schemaIdx,
        `Expected SEBI block (idx ${sebiIdx}) to appear AFTER CRITICAL SCHEMA RULE (idx ${schemaIdx}) so the schema rule's "overrides later instructions" language is meaningful`
      );
    });

    it("CRITICAL SCHEMA RULE appears BEFORE the OUTPUT FORMAT block", () => {
      // Strongest guarantee: the schema rule must precede the example JSON
      // so the LLM reads the rule first.
      const prompt = getAdvancedSynthesizerPrompt();
      const schemaIdx = prompt.indexOf("CRITICAL SCHEMA RULE");
      const outputFormatIdx = prompt.indexOf("OUTPUT FORMAT");
      assert.ok(
        schemaIdx < outputFormatIdx,
        `Expected CRITICAL SCHEMA RULE (idx ${schemaIdx}) to precede OUTPUT FORMAT (idx ${outputFormatIdx})`
      );
    });
  });

  // ── 5. OUTPUT FORMAT example structural shape ──────────────

  describe("OUTPUT FORMAT example JSON shape (parses + has required keys)", () => {
    it("contains '\"sections\"' as a key in the example region", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      // Quick sanity: substring before parse step.
      assert.ok(
        prompt.includes(`"sections"`),
        "OUTPUT FORMAT example must reference sections key"
      );
    });

    it("the OUTPUT FORMAT example JSON parses successfully", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.equal(typeof parsed, "object");
      assert.notEqual(parsed, null);
    });

    it("parsed example has all required StructuredReport keys", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      const required = [
        "score",
        "recommendation",
        "summary",
        "sections",
        "keyMetrics",
        "strengths",
        "risks",
        "disclaimer",
      ];
      for (const key of required) {
        assert.ok(
          key in parsed,
          `OUTPUT FORMAT example is missing required key: ${key}`
        );
      }
    });

    it("parsed example's sections is a non-empty array", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.ok(
        Array.isArray(parsed.sections),
        "OUTPUT FORMAT example's sections must be an array"
      );
      const sectionsArr = parsed.sections as unknown[];
      assert.ok(
        sectionsArr.length > 0,
        "OUTPUT FORMAT example's sections must be non-empty so the LLM sees what a section looks like"
      );
    });

    it("each section entry in the example has at least 'title' + 'type'", () => {
      // Renderer-contract sanity check — the section shape must be
      // demonstrated correctly.
      const prompt = getAdvancedSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      const sectionsArr = parsed.sections as Array<Record<string, unknown>>;
      for (let i = 0; i < sectionsArr.length; i++) {
        const section = sectionsArr[i] as Record<string, unknown>;
        assert.ok(
          "title" in section,
          `Example section[${i}] is missing 'title'`
        );
        assert.ok("type" in section, `Example section[${i}] is missing 'type'`);
      }
    });

    // BUG: the OUTPUT FORMAT example uses real newline characters inside
    // MONEY-543 fixed: the SWOT section's `content` field now uses
    // `\\n` in the source template so the runtime string contains
    // literal backslash-n (a valid JSON escape sequence). Strict
    // JSON.parse on the raw example region now succeeds with no
    // sanitizer workaround. This test is retained as a regression
    // sentinel — flipping the assertion catches any future
    // re-introduction of unescaped control characters in the example.
    it("MONEY-543 fixed: raw OUTPUT FORMAT example parses with strict JSON.parse (no sanitizer)", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      const { raw } = extractOutputFormatJson(prompt);
      // Strict parse must succeed — no sanitizer involved.
      const parsed = JSON.parse(raw) as StructuredReportExample;
      assert.ok(parsed && typeof parsed === "object");
      // Confirm the SWOT section is present in the parsed payload and
      // its `content` came back with real newlines (proves the `\\n`
      // in source round-tripped correctly through JSON.parse).
      const sections = parsed.sections as Array<Record<string, unknown>>;
      const swot = sections.find(
        (s) => (s.title as string) === "SWOT Analysis"
      );
      assert.ok(swot, "SWOT Analysis section must be present in example");
      const content = (swot as Record<string, unknown>).content as string;
      assert.ok(
        content.includes("\n"),
        "SWOT content should have real newlines after JSON.parse"
      );
      assert.ok(
        content.includes("**Strengths:**") &&
          content.includes("**Weaknesses:**") &&
          content.includes("**Opportunities:**") &&
          content.includes("**Threats:**"),
        "SWOT content should retain all four headers"
      );
    });

    it("the example's section types are from the renderer's allowed set", () => {
      // The prompt's RULES section restricts type to
      // "text" | "table" | "news" | "risks". The example must comply.
      const prompt = getAdvancedSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      const sectionsArr = parsed.sections as Array<Record<string, unknown>>;
      const allowedTypes: readonly string[] = [
        "text",
        "table",
        "news",
        "risks",
      ];
      for (let i = 0; i < sectionsArr.length; i++) {
        const section = sectionsArr[i] as Record<string, unknown>;
        const t = section.type as string;
        assert.ok(
          allowedTypes.includes(t),
          `Example section[${i}] has invalid type "${t}" — must be one of ${allowedTypes.join(", ")}`
        );
      }
    });
  });

  // ── 6. Regression sentinels for SEBI/disclaimer locks ──────

  describe("Regression sentinels (MONEY-457, MONEY-445)", () => {
    it("MONEY-457: example 'recommendation' field is literal 'N/A'", () => {
      // Anyone reverting MONEY-457's compliance fix would hit this.
      const prompt = getAdvancedSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.equal(
        parsed.recommendation,
        "N/A",
        `recommendation field must be the literal string "N/A" — found ${JSON.stringify(parsed.recommendation)}`
      );
    });

    it("MONEY-457: RULES block specifies recommendation MUST be 'N/A'", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`recommendation: ALWAYS the literal string "N/A"`),
        "RULES block must mandate recommendation = 'N/A'"
      );
    });

    it("MONEY-457: prompt has zero 'BUY' / 'SELL' / 'HOLD' as scaffolded values", () => {
      // Make sure no scaffold accidentally re-introduces them as JSON
      // example values. The SEBI block lists them as FORBIDDEN words, so
      // those are intentional occurrences inside the rules text — but
      // there must be no quoted "BUY" / "SELL" / "HOLD" used as JSON
      // string values in the example.
      const prompt = getAdvancedSynthesizerPrompt();
      const { raw } = extractOutputFormatJson(prompt);
      for (const word of ["BUY", "SELL", "HOLD", "STRONG_BUY", "STRONG_SELL"]) {
        assert.ok(
          !raw.includes(`"${word}"`),
          `OUTPUT FORMAT example has forbidden recommendation token "${word}" as a JSON string value`
        );
      }
    });

    it("MONEY-445: 'disclaimer' field stays in the schema", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.ok(
        typeof parsed.disclaimer === "string" && parsed.disclaimer.length > 0,
        "disclaimer field must remain in the schema with non-empty example text"
      );
      // The mandatory disclaimer wording lives in the SEBI block — sanity
      // that the example disclaimer is in the same family.
      const disc = parsed.disclaimer as string;
      assert.ok(
        disc.includes("AI-generated") && disc.includes("Not financial advice"),
        "Disclaimer example must include 'AI-generated' and 'Not financial advice'"
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════
// VALIDATOR
// ═══════════════════════════════════════════════════════════

describe("MONEY-543 - getValidatorPrompt: sections-array gate", () => {
  it("returns a non-empty string", () => {
    const prompt = getValidatorPrompt();
    assert.equal(typeof prompt, "string");
    assert.ok(prompt.length > 100);
  });

  it("contains the 'sections array gate' clause header", () => {
    const prompt = getValidatorPrompt();
    assert.ok(
      prompt.includes("sections array gate"),
      "Expected the 'sections array gate' header phrase"
    );
  });

  it("validator notes the gate is advanced-mode only", () => {
    // "(advanced mode)" appears in the gate's introduction.
    const prompt = getValidatorPrompt();
    assert.ok(
      prompt.includes("advanced mode"),
      "Expected the validator to scope the sections gate to advanced mode"
    );
  });

  it("validator's gate mandates a non-empty sections array", () => {
    const prompt = getValidatorPrompt();
    assert.ok(
      prompt.includes("non-empty"),
      "Validator gate must mandate non-empty sections array"
    );
    assert.ok(
      prompt.includes(`"sections" array`),
      "Validator gate must reference the 'sections' array by name"
    );
  });

  it("validator says missing/empty sections leads to passed=false", () => {
    const prompt = getValidatorPrompt();
    assert.ok(
      prompt.includes("passed=false"),
      "Validator gate must set passed=false when sections is absent/empty"
    );
  });

  it("validator pins the gap-message wording 'Missing sections array'", () => {
    const prompt = getValidatorPrompt();
    assert.ok(
      prompt.includes("Missing sections array"),
      "Expected pinned gap message wording"
    );
  });

  // BUG: the validator's sections gate currently treats "missing" and
  // "empty []" identically (single passed=false branch with one gap
  // message). That matches the synthesizer's "never empty" contract, so
  // it's not strictly a bug — but the gap message lumps both into
  // "Missing sections array — report body will not render", which is
  // misleading for the empty-array case where the key WAS emitted.
  // Pinning current behaviour:
  it("BUG: validator gate uses same gap message for missing-key vs empty-array (lumped)", () => {
    const prompt = getValidatorPrompt();
    // Only one gap message exists; we pin that as current behaviour.
    const occurrences = prompt.split("Missing sections array").length - 1;
    assert.equal(
      occurrences,
      1,
      "Currently a single 'Missing sections array' message covers both cases — flagged for parent to queue a refinement"
    );
  });
});

// ═══════════════════════════════════════════════════════════
// PARALLEL HARDENING AUDIT (regression pin only — do NOT fix)
// ═══════════════════════════════════════════════════════════

describe("MONEY-543 audit - other synthesizer entry points", () => {
  describe("getFastSynthesizerPrompt (L1 Quick)", () => {
    it("does NOT include a 'sections' key in its example schema", () => {
      // Fast synth uses a flat schema with keyMetrics/strengths/risks/
      // newsHighlights — no sections. The sections-required hardening
      // therefore does NOT apply.
      const prompt = getFastSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.ok(
        !("sections" in parsed),
        "Fast synth example should NOT have 'sections' key — schema is flat"
      );
    });

    it("does NOT need the CRITICAL SCHEMA RULE block (no sections to lose)", () => {
      const prompt = getFastSynthesizerPrompt();
      // Affirmative absence: confirms intentional omission, not drift.
      assert.ok(
        !prompt.includes("CRITICAL SCHEMA RULE"),
        "Fast synth has no sections, so the schema rule block should not be present"
      );
    });

    it("keeps the MONEY-457 recommendation:'N/A' lock", () => {
      const prompt = getFastSynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.equal(parsed.recommendation, "N/A");
    });
  });

  describe("getStrategySynthesizerPrompt", () => {
    it("DOES include 'sections' in its example schema", () => {
      const prompt = getStrategySynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.ok(
        "sections" in parsed,
        "Strategy synth has sections in its example"
      );
      assert.ok(Array.isArray(parsed.sections));
    });

    // MONEY-543 fixed: strategy synth hardened with the same 4-edit pattern
    // as the advanced synth — CRITICAL SCHEMA RULE block, REQUIRED SECTIONS
    // header, and a sections clause in the RULES block. The "OUTPUT FORMAT
    // example contains a non-empty sections array" sentinel is also
    // verified here so the regression net survives a future schema rewrite.
    it("MONEY-543 fixed: getStrategySynthesizerPrompt carries the CRITICAL SCHEMA RULE block", () => {
      const prompt = getStrategySynthesizerPrompt();
      assert.ok(
        prompt.includes("CRITICAL SCHEMA RULE"),
        "Strategy synth must include the CRITICAL SCHEMA RULE block (hardened in MONEY-543 BUG-5)"
      );
    });

    it("MONEY-543 fixed: strategy synth's schema rule contains 'Never omit the key' / 'Never return []'", () => {
      const prompt = getStrategySynthesizerPrompt();
      assert.ok(
        prompt.includes("Never omit the key"),
        "Strategy synth must include the 'Never omit the key' RULES clause"
      );
      assert.ok(
        prompt.includes("Never return []"),
        "Strategy synth must include the 'Never return []' RULES clause"
      );
    });

    it("MONEY-543 fixed: getStrategySynthesizerPrompt RULES block contains 'sections: REQUIRED, non-empty array' clause", () => {
      const prompt = getStrategySynthesizerPrompt();
      assert.ok(
        prompt.includes("sections: REQUIRED, non-empty array"),
        "Strategy synth RULES block must mandate sections: REQUIRED, non-empty array"
      );
    });

    it("MONEY-543 fixed: strategy synth OUTPUT FORMAT example contains a 'sections' array", () => {
      const prompt = getStrategySynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.ok(
        Array.isArray(parsed.sections),
        "Strategy synth OUTPUT FORMAT example's 'sections' must be an array"
      );
    });

    it("MONEY-543 fixed: strategy synth OUTPUT FORMAT example's sections array is non-empty", () => {
      const prompt = getStrategySynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      const sectionsArr = parsed.sections as unknown[];
      assert.ok(
        sectionsArr.length > 0,
        "Strategy synth OUTPUT FORMAT example's sections array must be non-empty"
      );
    });
  });

  describe("getEmergencySynthesizerPrompt", () => {
    it("does NOT include 'sections' in its (partial-data) schema", () => {
      // Emergency mode is intentionally minimal — no sections to defend.
      const prompt = getEmergencySynthesizerPrompt();
      const { parsed } = extractOutputFormatJson(prompt);
      assert.ok(
        !("sections" in parsed),
        "Emergency synth has a minimal flat schema — no sections expected"
      );
    });
  });

  describe("MF / ETF / Comparison routing (composed from advanced)", () => {
    it("queryType='mf' inherits the advanced synth's CRITICAL SCHEMA RULE", () => {
      // MF mode dispatches via getSynthesizerPrompt and APPENDS to the
      // advanced synth prompt. Therefore CRITICAL SCHEMA RULE is present.
      const prompt = getSynthesizerPrompt("advanced", "mf");
      assert.ok(prompt.includes("CRITICAL SCHEMA RULE"));
      assert.ok(prompt.includes(`sections" IS REQUIRED`));
    });

    it("queryType='etf' inherits the advanced synth's CRITICAL SCHEMA RULE", () => {
      const prompt = getSynthesizerPrompt("advanced", "etf");
      assert.ok(prompt.includes("CRITICAL SCHEMA RULE"));
    });

    it("queryType='comparison' inherits the advanced synth's CRITICAL SCHEMA RULE", () => {
      const prompt = getSynthesizerPrompt("advanced", "comparison");
      assert.ok(prompt.includes("CRITICAL SCHEMA RULE"));
    });

    it("queryType='strategy' uses its own prompt body (not the advanced synth)", () => {
      // Confirms the routing — strategy gets its own prompt body. Post
      // MONEY-543 BUG-5 hardening the strategy synth ALSO carries the
      // CRITICAL SCHEMA RULE block, so use a strategy-only header marker
      // instead: the strategy prompt opens with "You are a technical
      // analyst creating a strategy evaluation report" which the advanced
      // prompt never says.
      const prompt = getSynthesizerPrompt("advanced", "strategy");
      assert.ok(
        prompt.includes(
          "You are a technical analyst creating a strategy evaluation report"
        ),
        "Strategy router must return the strategy synth body"
      );
      assert.ok(
        !prompt.includes(
          "You are a senior financial analyst creating a COMPREHENSIVE stock research report"
        ),
        "Strategy router must NOT return the advanced synth body"
      );
    });

    it("queryType='emergency' does NOT inherit (uses its own prompt)", () => {
      const prompt = getSynthesizerPrompt("advanced", "emergency");
      assert.ok(!prompt.includes("CRITICAL SCHEMA RULE"));
    });

    it("mode='fast' (no queryType) does NOT inherit (uses fast prompt)", () => {
      const prompt = getSynthesizerPrompt("fast");
      assert.ok(!prompt.includes("CRITICAL SCHEMA RULE"));
    });
  });
});

// ═══════════════════════════════════════════════════════════
// MONEY-490 — DESIGN-FIDELITY PROMPT EXTENSIONS
// (chart payloads · sections 13-15 · plainSummary · planner map)
// ═══════════════════════════════════════════════════════════
//
// The StockSage v2 design handoff (MONEY-490) extended the synthesizer +
// planner prompts. These cases pin each addition's exact wording the same
// way the MONEY-543 cases above pin the sections-required hardening:
//
//   1. A "DESIGN CHART PAYLOADS" rules block teaching the LLM the optional
//      per-section chart payloads the new renderer understands (radar,
//      range, heatmap, fan, underwater, indicators, kv, bars, flags,
//      composite, contribution, badge).
//   2. REQUIRED SECTIONS grew entries 13-15 (Quant Factor Profile /
//      Regime & Risk / Macro Environment & Flows).
//   3. The OUTPUT FORMAT example gained a "plainSummary" plain-English
//      field (MONEY-669's plain-English layer).
//   4. buildPlannerUserPrompt maps the quant/regime/risk skills to the L4
//      compute tools that DO exist now — MONEY-669 killed the stale
//      "no dedicated compute tool yet" copy that made the LLM skip them.

// ─── MONEY-490 helpers ──────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const MONEY490_SKILLS = [
  "quant-factor-scores",
  "regime-volatility",
  "risk-portfolio-impact",
  "risk-var-stress",
] as const;

/** Planner user prompt with the four MONEY-490 quant/regime/risk skills. */
function buildSkillPlannerPrompt(): string {
  return buildPlannerUserPrompt(
    "Analyze TCS comprehensively",
    undefined,
    MONEY490_SKILLS
  );
}

/**
 * Find the `<skill> → <tools>` mapping line in the planner user prompt.
 * The selected-skill bullet lines start with "• " after trim, so
 * startsWith(skillName) uniquely matches the mapping-table line.
 */
function getMappingLine(prompt: string, skillName: string): string {
  const line = prompt
    .split("\n")
    .find((l) => l.trimStart().startsWith(skillName));
  assert.ok(
    line,
    `Skill → tool mapping line for "${skillName}" not found in planner user prompt`
  );
  return line as string;
}

// ─── 1. DESIGN CHART PAYLOADS block ─────────────────────────

describe("MONEY-490 - getAdvancedSynthesizerPrompt: DESIGN CHART PAYLOADS block", () => {
  describe("block presence + placement", () => {
    it("contains the 'DESIGN CHART PAYLOADS' header literal", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("DESIGN CHART PAYLOADS"),
        "Expected the DESIGN CHART PAYLOADS header in the RULES block"
      );
    });

    it("block sits INSIDE the RULES section: after the sections-required rule, before NEWS SECTION", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      const rulesIdx = prompt.indexOf("sections: REQUIRED, non-empty array");
      const blockIdx = prompt.indexOf("DESIGN CHART PAYLOADS");
      const newsIdx = prompt.indexOf("NEWS SECTION (REQUIRED");
      assert.notEqual(rulesIdx, -1, "sections-required rule must be present");
      assert.notEqual(blockIdx, -1, "payload block must be present");
      assert.notEqual(newsIdx, -1, "NEWS SECTION block must be present");
      assert.ok(
        rulesIdx < blockIdx && blockIdx < newsIdx,
        `Expected DESIGN CHART PAYLOADS (idx ${blockIdx}) between the sections rule (idx ${rulesIdx}) and NEWS SECTION (idx ${newsIdx})`
      );
    });

    it("intro declares payloads optional + tool-gated ('ONLY when' the compute-tool result is present)", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`(type stays "text") MAY ALSO carry`),
        "Payloads must be declared as additive to type:'text' sections"
      );
      assert.ok(
        prompt.includes(
          "these OPTIONAL fields when (and ONLY when) the matching compute-tool result is"
        ),
        "Payloads must be gated on the matching compute-tool result"
      );
    });

    it("intro mandates exact tool numbers + equal-length arrays", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("Use the EXACT numbers from the tool result"),
        "Intro must mandate exact numbers from the tool result"
      );
      assert.ok(
        prompt.includes("Equal-length arrays where noted"),
        "Intro must mandate equal-length arrays"
      );
    });

    it("intro says to OMIT a payload entirely if its tool did not run", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("OMIT a payload entirely if its tool did not run"),
        "Missing-tool behaviour must be omit-payload, not fabricate"
      );
    });
  });

  describe("payload kind keywords (renderer contract)", () => {
    it("radar payload pins the five factor axes", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(
          `"radar": {"axes":["Value","Quality","Growth","Momentum","Low-vol"]`
        ),
        "Quant Factor Profile must carry the radar payload with the 5 design axes"
      );
    });

    it("range payload (valuation bear/base/bull band) present", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"range": {"low":<bear`),
        "Valuation must carry the range payload (low=bear / mid=base / high=bull)"
      );
    });

    it("heatmap payload present with the WACC × terminal-growth grid labels", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"heatmap": {"rows":`),
        "Valuation must carry the heatmap payload"
      );
      assert.ok(
        prompt.includes(`"rowLabel":"WACC","colLabel":"terminal g"`),
        "Heatmap axes must be labelled WACC × terminal g"
      );
    });

    it("fan payload pins the Monte-Carlo percentile keys p10..p90", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"fan": {"p10":`),
        "Regime & Risk must carry the fan payload starting at p10"
      );
      assert.ok(
        prompt.includes(`"p90":[...]`),
        "Fan payload must run through p90"
      );
    });

    it("underwater payload pins the negative drawdown series", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"underwater": [<drawdown`),
        "Regime & Risk must carry the underwater drawdown payload"
      );
    });

    it("indicators payload pins the per-indicator entry shape (RSI example)", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"indicators": [{"name":"RSI (14)"`),
        "Technical Analysis must carry the indicators payload with the RSI example"
      );
    });

    it("kv payload appears for BOTH Business Overview and Macro sections", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"kv": [{"k":"Model"`),
        "Business Overview must carry a kv payload (Model/Moat/Mix/...)"
      );
      assert.ok(
        prompt.includes(`"kv": [{"k":"Rate sensitivity"`),
        "Macro Environment & Flows must carry a kv payload (Rate sensitivity/USD-INR/...)"
      );
      assert.equal(
        countOccurrences(prompt, `"kv": [`),
        2,
        "Exactly two kv payload specs (Business Overview + Macro)"
      );
    });

    it("bars payload pins the shareholding FII example", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"bars": [{"label":"FII"`),
        "Shareholding Pattern must carry the bars payload with the FII example"
      );
    });

    it("flags payload pins the green-tone governance example", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"flags": [{"tone":"green"`),
        "Shareholding Pattern must carry the flags payload with the green-tone example"
      );
    });

    it("composite payload pins the 0-100 score shape", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"composite": {"score":<0-100>,"label":"Composite"`),
        "Quant Factor Profile must carry the composite payload"
      );
    });

    it("contribution payload pins the per-factor % example", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes(`"contribution": [{"label":"Quality","value":32}`),
        "Quant Factor Profile must carry the contribution payload"
      );
    });

    it("SECTION BADGE bullet pins the 'badge' key + factual examples", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("SECTION BADGE"),
        "Expected the SECTION BADGE bullet"
      );
      assert.ok(
        prompt.includes(`"badge":`),
        "Badge payload key must be quoted in the bullet"
      );
      assert.ok(
        prompt.includes("Piotroski 8/9"),
        "Badge examples must include the Financial Health Piotroski scorelet"
      );
      assert.ok(
        prompt.includes("High-Quality Momentum"),
        "Badge examples must include the quant style label"
      );
    });
  });

  describe("SEBI guard language inside the payload specs", () => {
    it("indicators 'signal' is scoped to the indicator's technical reading — never advice", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("never advice"),
        "Indicators signal vocabulary must be scoped away from advice"
      );
    });

    it("indicators 'group' taxonomy is TREND|MOMENTUM|VOLATILITY|VOLUME", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("group = TREND|MOMENTUM|VOLATILITY|VOLUME"),
        "Indicator group taxonomy must be pinned to the 4 renderer groups"
      );
    });

    it("flags tone encodes data quality, NEVER buy/sell sentiment", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("NEVER buy/sell sentiment"),
        "Flags tone must be locked away from buy/sell sentiment"
      );
    });

    it("badges are descriptive only — never action words", () => {
      const prompt = getAdvancedSynthesizerPrompt();
      assert.ok(
        prompt.includes("never action words"),
        "Badge guard must forbid action words"
      );
    });
  });

  describe("payload block routing across prompt variants", () => {
    it("fast / strategy / emergency prompts do NOT carry the payload block", () => {
      // The design payloads belong to the comprehensive (advanced-family)
      // report only — affirmative absence everywhere else.
      assert.ok(
        !getFastSynthesizerPrompt().includes("DESIGN CHART PAYLOADS"),
        "Fast synth must not carry the payload block"
      );
      assert.ok(
        !getStrategySynthesizerPrompt().includes("DESIGN CHART PAYLOADS"),
        "Strategy synth must not carry the payload block"
      );
      assert.ok(
        !getEmergencySynthesizerPrompt().includes("DESIGN CHART PAYLOADS"),
        "Emergency synth must not carry the payload block"
      );
    });

    it("mf / etf / comparison prompts inherit the payload block from the advanced synth", () => {
      for (const queryType of ["mf", "etf", "comparison"]) {
        const prompt = getSynthesizerPrompt("advanced", queryType);
        assert.ok(
          prompt.includes("DESIGN CHART PAYLOADS"),
          `queryType='${queryType}' must inherit DESIGN CHART PAYLOADS via composition`
        );
      }
    });
  });
});

// ─── 2. REQUIRED SECTIONS 13-15 ─────────────────────────────

describe("MONEY-490 - REQUIRED SECTIONS 13-15 (Quant / Regime / Macro)", () => {
  it("section 13 title: '13. Quant Factor Profile'", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes("13. Quant Factor Profile"),
      "Expected required-section entry 13. Quant Factor Profile"
    );
  });

  it("section 14 title: '14. Regime & Risk'", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes("14. Regime & Risk"),
      "Expected required-section entry 14. Regime & Risk"
    );
  });

  it("section 15 title: '15. Macro Environment & Flows'", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes("15. Macro Environment & Flows"),
      "Expected required-section entry 15. Macro Environment & Flows"
    );
  });

  it("13-15 live INSIDE the REQUIRED SECTIONS list (after 12, before the peer-table mandate)", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const reqIdx = prompt.indexOf("REQUIRED SECTIONS");
    const s12 = prompt.indexOf("12. Risks & Catalysts");
    const s13 = prompt.indexOf("13. Quant Factor Profile");
    const s14 = prompt.indexOf("14. Regime & Risk");
    const s15 = prompt.indexOf("15. Macro Environment & Flows");
    const peerIdx = prompt.indexOf("MANDATORY PEER COMPARISON TABLE");
    assert.ok(reqIdx > -1 && s12 > -1 && peerIdx > -1, "anchors must exist");
    assert.ok(
      reqIdx < s12 && s12 < s13 && s13 < s14 && s14 < s15 && s15 < peerIdx,
      `Expected 13-15 (idx ${s13}/${s14}/${s15}) inside the REQUIRED SECTIONS list — after 12. (idx ${s12}), before the peer-table mandate (idx ${peerIdx})`
    );
  });

  it("section 13 cross-links the 'radar' payload with the five factor axes", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes(
        `the "radar" payload: Value/Quality/Growth/Momentum/Low-vol`
      ),
      "Section 13 must point at the radar payload + axis order"
    );
  });

  it("section 14 cross-links the 'fan' and 'underwater' payloads", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes(`the "fan" and "underwater" payloads`),
      "Section 14 must point at the fan + underwater payloads"
    );
  });

  it("sections 13-15 are data-gated (emit only when the matching tools ran)", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes("(when compute_factor_profile / quant data ran"),
      "Section 13 must be gated on quant data"
    );
    assert.ok(
      prompt.includes(
        "(when the risk / Monte-Carlo / forward-scenario tools ran"
      ),
      "Section 14 must be gated on risk-tool data"
    );
    assert.ok(
      prompt.includes("when macro data is present"),
      "Section 15 must be gated on macro data"
    );
  });

  it("section 15 covers rate sensitivity, USD/INR, sector rotation, FII/DII flows", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes(
        "rate sensitivity, USD/INR, sector rotation, FII/DII flows"
      ),
      "Section 15 scope must list the four macro dimensions"
    );
  });

  it("legacy STRATEGY-RELATED numbering ('13. Strategy Evaluation') still present AFTER the required list (no renumber collision)", () => {
    // The conditional STRATEGY-RELATED SECTIONS block keeps its own 13-16
    // numbering. Pin that both families coexist and the required-list 13
    // comes first, so a future renumber that merges/drops either fails.
    const prompt = getAdvancedSynthesizerPrompt();
    const quant13 = prompt.indexOf("13. Quant Factor Profile");
    const strat13 = prompt.indexOf("13. Strategy Evaluation");
    assert.notEqual(strat13, -1, "strategy-conditional 13 must still exist");
    assert.ok(
      quant13 < strat13,
      `Required-list 13 (idx ${quant13}) must precede the strategy-conditional 13 (idx ${strat13})`
    );
  });
});

// ─── 3. plainSummary plain-English layer ────────────────────

describe("MONEY-490 - plainSummary plain-English layer", () => {
  it("'plainSummary' key present in the advanced prompt", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes(`"plainSummary"`),
      "Expected the plainSummary key in the advanced prompt"
    );
  });

  it("plainSummary lives INSIDE the OUTPUT FORMAT example region", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const { raw } = extractOutputFormatJson(prompt);
    assert.ok(
      raw.includes(`"plainSummary"`),
      "plainSummary must be part of the extracted example JSON"
    );
  });

  it("OUTPUT FORMAT example still parses strictly WITH plainSummary (raw JSON.parse, no sanitizer)", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const { raw } = extractOutputFormatJson(prompt);
    const parsed = JSON.parse(raw) as StructuredReportExample;
    assert.ok(
      "plainSummary" in parsed,
      "Strictly-parsed example must contain the plainSummary key"
    );
  });

  it("parsed example's plainSummary is a non-empty string", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const { parsed } = extractOutputFormatJson(prompt);
    assert.equal(typeof parsed.plainSummary, "string");
    assert.ok(
      (parsed.plainSummary as string).length > 0,
      "plainSummary example text must be non-empty"
    );
  });

  it("example key order: summary → plainSummary → sections", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const { raw } = extractOutputFormatJson(prompt);
    const sIdx = raw.indexOf(`"summary"`);
    const pIdx = raw.indexOf(`"plainSummary"`);
    const secIdx = raw.indexOf(`"sections"`);
    assert.ok(
      sIdx > -1 && sIdx < pIdx && pIdx < secIdx,
      `Expected summary (idx ${sIdx}) < plainSummary (idx ${pIdx}) < sections (idx ${secIdx}) in the example`
    );
  });

  it("spec mandates PLAIN English + jargon translation (P/E example)", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const { parsed } = extractOutputFormatJson(prompt);
    const spec = parsed.plainSummary as string;
    assert.ok(
      spec.includes("PLAIN English"),
      "plainSummary spec must mandate PLAIN English"
    );
    assert.ok(
      spec.includes("the price you pay per rupee of profit"),
      "plainSummary spec must keep the P/E jargon-translation example"
    );
  });

  it("spec is STRICTLY educational — never tells the reader what to do", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const { parsed } = extractOutputFormatJson(prompt);
    const spec = parsed.plainSummary as string;
    assert.ok(
      spec.includes("STRICTLY educational"),
      "plainSummary spec must say STRICTLY educational"
    );
    assert.ok(
      spec.includes("never what the reader should do"),
      "plainSummary spec must forbid telling the reader what to do"
    );
    assert.ok(
      spec.includes("no buy/sell/hold/add/avoid/wait language"),
      "plainSummary spec must list the forbidden action vocabulary"
    );
  });

  it("plainSummary is advanced-family only: absent from fast / strategy / emergency", () => {
    assert.ok(
      !getFastSynthesizerPrompt().includes(`"plainSummary"`),
      "Fast synth example must not carry plainSummary"
    );
    assert.ok(
      !getStrategySynthesizerPrompt().includes(`"plainSummary"`),
      "Strategy synth example must not carry plainSummary"
    );
    assert.ok(
      !getEmergencySynthesizerPrompt().includes(`"plainSummary"`),
      "Emergency synth example must not carry plainSummary"
    );
  });

  it("mf / etf / comparison inherit plainSummary via composition", () => {
    for (const queryType of ["mf", "etf", "comparison"]) {
      const prompt = getSynthesizerPrompt("advanced", queryType);
      assert.ok(
        prompt.includes(`"plainSummary"`),
        `queryType='${queryType}' must inherit the plainSummary example field`
      );
    }
  });
});

// ─── 4. Anti-fabrication language ───────────────────────────

describe("MONEY-490 - anti-fabrication language", () => {
  it("'NEVER fabricate' present with exact casing", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes("NEVER fabricate"),
      "Expected the upper-case 'NEVER fabricate' anti-fabrication clause"
    );
  });

  it("exactly 2 'NEVER fabricate' occurrences (MONEY-498 depth signals + MONEY-490 chart payloads)", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.equal(
      countOccurrences(prompt, "NEVER fabricate"),
      2,
      "Pin: one clause in INSTITUTIONAL DEPTH SIGNALS, one in DESIGN CHART PAYLOADS"
    );
  });

  it("depth-signals variant: render \"—\" for unavailable data, 'NEVER fabricate a value'", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes(`render "—"; NEVER fabricate a value`),
      "Depth-signals block must mandate the em-dash placeholder over fabrication"
    );
  });

  it("chart-payload variant: 'NEVER fabricate the' arrays clause sits inside the payload block", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    const headerIdx = prompt.indexOf("DESIGN CHART PAYLOADS");
    const firstIdx = prompt.indexOf("NEVER fabricate");
    const lastIdx = prompt.lastIndexOf("NEVER fabricate");
    assert.ok(
      prompt.includes("NEVER fabricate the"),
      "Payload intro must carry the 'NEVER fabricate the' arrays clause"
    );
    assert.ok(
      firstIdx < headerIdx && lastIdx > headerIdx,
      `Expected one clause before the payload header (idx ${headerIdx}) and one after — got first ${firstIdx}, last ${lastIdx}`
    );
  });

  it("RULES retain 'NEVER invent numbers'", () => {
    const prompt = getAdvancedSynthesizerPrompt();
    assert.ok(
      prompt.includes("NEVER invent numbers"),
      "RULES must keep the NEVER invent numbers clause"
    );
  });
});

// ─── 5. Planner skill → tool mappings ───────────────────────

describe("MONEY-490 - buildPlannerUserPrompt: skill → tool mappings", () => {
  describe("skill-driven path (customSkills present)", () => {
    it("emits the SKILL-DRIVEN PLAN - STRICT REQUIREMENT header", () => {
      const prompt = buildSkillPlannerPrompt();
      assert.ok(
        prompt.includes("SKILL-DRIVEN PLAN - STRICT REQUIREMENT"),
        "Expected the skill-driven plan header"
      );
    });

    it("lists each selected skill as a bullet", () => {
      const prompt = buildSkillPlannerPrompt();
      for (const skill of MONEY490_SKILLS) {
        assert.ok(
          prompt.includes(`\n  • ${skill}`),
          `Selected skill "${skill}" must be listed as a bullet`
        );
      }
    });

    it("emits the 'Skill → tool mapping:' directive with the do-not-invent guard", () => {
      const prompt = buildSkillPlannerPrompt();
      assert.ok(
        prompt.includes(
          "For EACH skill above, emit the matching compute task(s)."
        ),
        "Mapping directive must mandate one compute task per skill"
      );
      assert.ok(
        prompt.includes("Skill → tool mapping:"),
        "Expected the mapping-table introducer"
      );
      assert.ok(
        prompt.includes(
          "Use ONLY tools from the AVAILABLE TOOLS list above - do not invent names."
        ),
        "Mapping directive must forbid invented tool names"
      );
    });

    it("maps quant-factor-scores → compute_factor_scores (+ zscore + composite, with data deps)", () => {
      const line = getMappingLine(
        buildSkillPlannerPrompt(),
        "quant-factor-scores"
      );
      assert.ok(line.includes("→"), "mapping line must use the → arrow");
      assert.ok(
        line.includes("compute_factor_scores"),
        "quant-factor-scores must map to compute_factor_scores"
      );
      assert.ok(
        line.includes("compute_factor_zscore"),
        "quant-factor-scores must also map to compute_factor_zscore"
      );
      assert.ok(
        line.includes("compute_composite_quant_score"),
        "quant-factor-scores must also map to compute_composite_quant_score"
      );
      assert.ok(
        line.includes("needs fetch_price_history + financials"),
        "quant mapping must carry its data dependencies"
      );
    });

    it("maps regime-volatility → compute_volatility_regime (+ drawdown profile + beta decomposition)", () => {
      const line = getMappingLine(
        buildSkillPlannerPrompt(),
        "regime-volatility"
      );
      assert.ok(
        line.includes("compute_volatility_regime"),
        "regime-volatility must map to compute_volatility_regime"
      );
      assert.ok(
        line.includes("compute_drawdown_profile"),
        "regime-volatility must also map to compute_drawdown_profile"
      );
      assert.ok(
        line.includes("compute_beta_decomposition"),
        "regime-volatility must also map to compute_beta_decomposition"
      );
      assert.ok(
        line.includes("(needs fetch_price_history)"),
        "regime mapping must carry its price-history dependency"
      );
    });

    it("maps risk-portfolio-impact → compute_position_var (+ concentration delta + beta drift)", () => {
      const line = getMappingLine(
        buildSkillPlannerPrompt(),
        "risk-portfolio-impact"
      );
      assert.ok(
        line.includes("compute_position_var"),
        "risk-portfolio-impact must map to compute_position_var"
      );
      assert.ok(
        line.includes("compute_concentration_delta"),
        "risk-portfolio-impact must also map to compute_concentration_delta"
      );
      assert.ok(
        line.includes("compute_portfolio_beta_drift"),
        "risk-portfolio-impact must also map to compute_portfolio_beta_drift"
      );
    });

    it("maps risk-var-stress → compute_var (+ the L4 stress pack)", () => {
      const line = getMappingLine(buildSkillPlannerPrompt(), "risk-var-stress");
      assert.ok(
        line.includes("compute_var,"),
        "risk-var-stress must map to compute_var"
      );
      assert.ok(
        line.includes("compute_drawdown,"),
        "risk-var-stress must also map to compute_drawdown"
      );
      assert.ok(
        line.includes("compute_beta,"),
        "risk-var-stress must also map to compute_beta"
      );
      assert.ok(
        line.includes("compute_risk_adjusted_returns"),
        "risk-var-stress must also map to compute_risk_adjusted_returns"
      );
      assert.ok(
        line.includes("compute_correlation_matrix"),
        "risk-var-stress must also map to compute_correlation_matrix"
      );
      assert.ok(
        line.includes("L4 stress pack"),
        "risk-var-stress mapping must be labelled as the L4 stress pack"
      );
    });

    it("MONEY-669 regression: the stale 'no dedicated compute tool yet' copy is gone", () => {
      // That phrase made the LLM skip planning the quant/regime/risk
      // compute tasks entirely — factor scores, volatility regime and VaR
      // never appeared in reports. It must never come back.
      const prompt = buildSkillPlannerPrompt();
      assert.ok(
        !prompt.includes("no dedicated compute tool yet"),
        "Stale 'no dedicated compute tool yet' copy must not be emitted"
      );
    });

    it("MINIMUM TASK COUNT for the 4 quant/regime/risk skills → 16", () => {
      // Title used to name the old `min(28, 8 + 2×skills)` formula. MONEY-1120
      // derives the floor from the selection's tools instead; these four skills
      // happen to land on 16 under both, so the number is unchanged — but the
      // formula in the name was no longer true.
      const prompt = buildSkillPlannerPrompt();
      assert.ok(
        prompt.includes("MINIMUM TASK COUNT: 16"),
        "4 selected skills must yield MINIMUM TASK COUNT: 16"
      );
    });

    it("MINIMUM TASK COUNT: 1 focused skill → 8, many skills → capped at 28", () => {
      // CONTRACT CHANGE (MONEY-1120). This asserted `1 skill → 10`, from the
      // old `min(28, 8 + 2 × skills)` formula. That baseline of 8 was
      // unrelated to the selection, so a single focused skill still demanded
      // >= 10 tasks — which pushed /dcf into a 14-task plan that overran the
      // 480s budget and died before synthesis, returning a generic partial
      // report instead of a DCF (MONEY-1095 item 5). The floor is now derived
      // from the tools the selection actually needs.
      const one = buildPlannerUserPrompt("q", undefined, ["dcf-valuation"]);
      assert.ok(
        one.includes("MINIMUM TASK COUNT: 8"),
        "1 focused skill must size from its own tools, not a fixed baseline"
      );

      // The cap is exercised with REAL skill ids. The previous version passed
      // 12 synthetic `skill-N` strings, which the allow-list does not know —
      // under a tool-derived floor those resolve to nothing, so they measured
      // the unknown-id path rather than the cap.
      const many = buildPlannerUserPrompt(
        "q",
        undefined,
        Object.keys(SKILL_TOOL_ALLOWLIST).slice(0, 12)
      );
      assert.ok(
        many.includes("MINIMUM TASK COUNT: 28"),
        "a large real selection must cap at MINIMUM TASK COUNT: 28"
      );
    });

    it("unrecognised skill ids are never under-planned (MONEY-1120)", () => {
      // Guards the hole the tool-derived floor opened: expandSkillAliases
      // DROPS ids it does not know, so an unknown selection resolved to zero
      // tools and floored at 4 — while the prompt still told the model "you
      // selected 12 skills". Unresolved ids fall back to a proportional
      // estimate instead.
      const unknown = buildPlannerUserPrompt(
        "q",
        undefined,
        Array.from({ length: 12 }, (_, i) => `skill-${i}`)
      );
      const n = Number(unknown.match(/MINIMUM TASK COUNT: (\d+)/)?.[1]);
      assert.ok(
        n >= 20,
        `12 unrecognised skills must still plan a substantial run, got ${n}`
      );
    });
  });

  describe("default path (no customSkills)", () => {
    it("emits the DEFAULT COMPREHENSIVE PLAN header with MINIMUM TASK COUNT: 22", () => {
      const prompt = buildPlannerUserPrompt("Analyze TCS");
      assert.ok(
        prompt.includes("DEFAULT COMPREHENSIVE PLAN - STRICT REQUIREMENT"),
        "Default path must emit the comprehensive-plan header"
      );
      assert.ok(
        prompt.includes("MINIMUM TASK COUNT: 22"),
        "Default path must mandate at least 22 tasks"
      );
    });

    it("default path also carries no 'no dedicated compute tool yet' copy", () => {
      const prompt = buildPlannerUserPrompt("Analyze TCS");
      assert.ok(
        !prompt.includes("no dedicated compute tool yet"),
        "Stale copy must be absent from the default path too"
      );
    });
  });
});
