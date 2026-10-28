/**
 * parseLLMJson + sanitizeRoastErrorMessage tests (MONEY-543)
 *
 * Direct unit tests for the resilient JSON parsing and error-sanitization
 * helpers landed in `packages/roast/src/lib/parse-llm-json.ts` under
 * MONEY-488. These functions are imported directly (relative path) since
 * they're pure utilities with only a `geminiLogger` dependency — no DB,
 * no network, no Prisma — and don't need the agent-test re-implementation
 * pattern.
 *
 * Logger note: `parseLLMJson` writes via the shared `geminiLogger` (pino)
 * on warn/info paths. We do NOT assert on logger calls — mocking pino's
 * `globalThis` singleton is invasive vs. value. Logger output is noise
 * during the run but doesn't affect TAP. See comment on the "logging"
 * group below.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseLLMJson,
  sanitizeRoastErrorMessage,
} from "../../../../packages/roast/src/lib/parse-llm-json";

// ---------------------------------------------------------------------------
// Shared fallback shapes
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const FB: Json = { fallback: true };
const STEP = "test-step";

// ---------------------------------------------------------------------------
// parseLLMJson — strict parse paths
// ---------------------------------------------------------------------------

describe("parseLLMJson — strict parse", () => {
  it("returns parsed object for plain valid JSON", () => {
    const out = parseLLMJson<Json>('{"a": 1, "b": "two"}', FB, STEP);
    assert.deepEqual(out, { a: 1, b: "two" });
  });

  it("returns parsed object whose values include an array", () => {
    const out = parseLLMJson<Json>('{"foo":[1,2,3]}', FB, STEP);
    assert.deepEqual(out, { foo: [1, 2, 3] });
  });

  it("returns the fallback for empty string input", () => {
    const out = parseLLMJson<Json>("", FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("returns the fallback for null input", () => {
    const out = parseLLMJson<Json>(null, FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("returns the fallback for undefined input", () => {
    const out = parseLLMJson<Json>(undefined, FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("returns the fallback for non-string input (number) via defensive guard", () => {
    // The function takes `string | null | undefined` but the runtime guard
    // `typeof text !== "string"` also catches accidental non-string callers
    // (e.g. raw provider responses) — assert that defensive path holds.
    const out = parseLLMJson<Json>(123 as unknown as string, FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("returns the fallback for non-string input (object) via defensive guard", () => {
    const out = parseLLMJson<Json>(
      { already: "parsed" } as unknown as string,
      FB,
      STEP
    );
    assert.deepEqual(out, FB);
  });

  it("returns the fallback for whitespace-only input", () => {
    const out = parseLLMJson<Json>("   \n\t  ", FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("returns the fallback when strict-parse yields the JS null literal (parsed === null guard)", () => {
    // The implementation requires `typeof parsed === "object" && parsed !== null`,
    // so a bare "null" payload — though technically valid JSON — falls through
    // every step and ends at the fallback. Pin this behaviour.
    const out = parseLLMJson<Json>("null", FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("returns the fallback for primitive-root JSON (number, string, bool)", () => {
    assert.deepEqual(parseLLMJson<Json>("42", FB, STEP), FB);
    assert.deepEqual(parseLLMJson<Json>('"hello"', FB, STEP), FB);
    assert.deepEqual(parseLLMJson<Json>("true", FB, STEP), FB);
  });

  it("accepts a top-level array as a valid parsed structure (typeof array === 'object')", () => {
    // Documenting behaviour: although the helper is typed as `T` and most
    // call sites expect an object, an array root passes the `typeof object`
    // guard and is returned as-is. Callers downstream that assume an object
    // shape may need an extra check — see roast steps for example use.
    const out = parseLLMJson<unknown>("[1,2,3]", [], "array-root");
    assert.deepEqual(out, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// parseLLMJson — markdown fence handling
// ---------------------------------------------------------------------------

describe("parseLLMJson — markdown fence stripping", () => {
  it("strips ```json fence and parses the inner payload", () => {
    const input = '```json\n{"foo": 1}\n```';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { foo: 1 });
  });

  it("strips bare ``` fence (no `json` tag) and parses the inner payload", () => {
    const input = '```\n{"foo": 1}\n```';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { foo: 1 });
  });

  it("handles an unclosed fence (no trailing ```)", () => {
    // Open-fence regex grabs everything after the opening ``` and parses it.
    const input = '```json\n{"foo": 1}';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { foo: 1 });
  });

  it("recovers when prose precedes a closed ```json fence", () => {
    // Closed-fence regex is anchored only by ``` … ```, so a prose prefix
    // like "Here's the JSON:\n" is consumed/ignored — the inner JSON parses
    // cleanly. Documented as "the function is not designed to handle prose
    // prefix" in the function docblock, but the fence regex incidentally
    // covers this case.
    const input = 'Here\'s the JSON:\n```json\n{"foo": 1}\n```';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { foo: 1 });
  });
});

// ---------------------------------------------------------------------------
// parseLLMJson — greedy {...} recovery
// ---------------------------------------------------------------------------

describe("parseLLMJson — greedy {...} recovery", () => {
  it("extracts and parses an object embedded after prose", () => {
    const input = 'Sure, here\'s: {"foo": 1}';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { foo: 1 });
  });

  it("returns the fallback when there's no braced object anywhere", () => {
    const input = "Some prose without braces";
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("greedy match grabs the largest enclosing {...}, which here is the full string of two concatenated objects → falls back", () => {
    // `/{[\s\S]*}/` is greedy and matches from the first `{` to the last `}`,
    // so `{"a":1}{"b":2}` is matched as a single span that fails to parse.
    // Bracket-balance then sees a stack that closes cleanly (both objects
    // balanced) so it doesn't repair anything, and the final JSON.parse
    // still fails on the two adjacent objects. Result: fallback.
    const input = '{"a":1}{"b":2}';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, FB);
  });
});

// ---------------------------------------------------------------------------
// parseLLMJson — bracket-balance recovery (the new + interesting path)
// ---------------------------------------------------------------------------

describe("parseLLMJson — bracket-balance recovery", () => {
  it("recovers a truncated array of strings (cut mid-string in the last element)", () => {
    // The model ran out of tokens partway through "c". Bracket-balance
    // closes the open string and the open array+object. Because the
    // truncation is INSIDE a nested array (stack depth > 1), the per-comma
    // `lastSafe` is never recorded, so the partial element survives as the
    // closed string "c". Pin this behaviour: the helper preserves whatever
    // it can salvage, even partial leaf values.
    const input = '{"items": ["a", "b", "c';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { items: ["a", "b", "c"] });
  });

  it("drops a truncated mid-property fragment at the top level", () => {
    // Here the truncation is at the OBJECT's top level (stack depth 1),
    // so the trailing `, "c"` (a partial key with no value) gets sliced
    // off back to the last top-level comma, then the object is closed.
    const input = '{"a": 1, "b": 2, "c"';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { a: 1, b: 2 });
  });

  it("closes deeply nested truncations (object → object → array)", () => {
    const input = '{"outer": {"inner": [1, 2, 3';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { outer: { inner: [1, 2, 3] } });
  });

  it("handles a truncation inside an escaped-quote string", () => {
    // Source: `{"foo": "she said \"hello`  (the JSON string contains an
    // escaped `\"`, and the model cut off mid-value). Bracket-balance must
    // honour the escape so it doesn't mis-toggle `inString` and produce a
    // malformed repair.
    const input = '{"foo": "she said \\"hello';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { foo: 'she said "hello' });
  });

  it("is a no-op on already-balanced complete JSON (still parses)", () => {
    const input = '{"a": 1}';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { a: 1 });
  });

  it("recovers a top-level array truncated mid-element by closing and slicing back to the last top-level comma", () => {
    // `[1, 2, 3` → the stray `3` after the last top-level comma is
    // truncated off, leaving `[1, 2]`. Pin: bracket-balance accepts a
    // top-level `[` (not just `{`).
    const out = parseLLMJson<unknown>("[1, 2, 3", [], "array-trunc");
    assert.deepEqual(out, [1, 2]);
  });

  it("returns the fallback when the payload starts with neither '{' nor '['", () => {
    // bracket-balance's first guard returns null in this case → fallback.
    const out = parseLLMJson<Json>("foo bar", FB, STEP);
    assert.deepEqual(out, FB);
  });

  it("recovers from a truncated array of objects (nested), preserving the salvageable child object", () => {
    const input = '{"items": [{"a":1},{"b":2';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { items: [{ a: 1 }, { b: 2 }] });
  });

  it("recovers when a fence opens but the content truncates without a closing fence", () => {
    // The open-fence branch strips the leading ```json, then bracket-balance
    // closes the still-open array and object.
    const input = '```json\n{"items":[1,2';
    const out = parseLLMJson<Json>(input, FB, STEP);
    assert.deepEqual(out, { items: [1, 2] });
  });
});

// ---------------------------------------------------------------------------
// Logging observations (documentary, not asserted)
// ---------------------------------------------------------------------------

describe("parseLLMJson — logging side effects (documentary only)", () => {
  it("does not throw when stepName is passed through warn/info paths", () => {
    // We intentionally don't mock the pino singleton here — it's a
    // globalThis-cached instance and mocking it has cross-test side
    // effects. Instead we assert that the public contract holds: the
    // function never throws, the stepName is accepted as a string, and
    // logger noise during the run is acceptable. See the file docblock.
    assert.doesNotThrow(() => {
      parseLLMJson<Json>("not json", FB, "step-with-context");
      parseLLMJson<Json>('{"truncated":', FB, "another-step");
    });
  });
});

// ---------------------------------------------------------------------------
// sanitizeRoastErrorMessage
// ---------------------------------------------------------------------------

describe("sanitizeRoastErrorMessage — empty / passthrough", () => {
  it("returns the generic 'Something went wrong' default for empty string", () => {
    assert.equal(
      sanitizeRoastErrorMessage(""),
      "Something went wrong. Please try again."
    );
  });

  it("returns the generic default for null-as-string (defensive)", () => {
    // The signature is `string`, but real callers pass `error?.message` —
    // which can be undefined. The function's first `if (!raw)` guard
    // catches null/undefined/empty all the same.
    assert.equal(
      sanitizeRoastErrorMessage(null as unknown as string),
      "Something went wrong. Please try again."
    );
  });

  it("passes 'Cancelled by user' through unchanged (UI keys off this exact string)", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Cancelled by user"),
      "Cancelled by user"
    );
  });

  // MONEY-543 fixed: case-insensitive cancel sentinel. Any case variant
  // collapses to the canonical "Cancelled by user" — the UI uses strict
  // equality on the DB-stored value, so we must NOT echo the user's input
  // case back. These tests pin the canonical-form return path.
  it("MONEY-543 fixed: case-variant 'Cancelled By User' returns the canonical 'Cancelled by user'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Cancelled By User"),
      "Cancelled by user"
    );
  });

  it("MONEY-543 fixed: lowercase 'cancelled by user' returns the canonical 'Cancelled by user'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("cancelled by user"),
      "Cancelled by user"
    );
  });

  it("MONEY-543 fixed: uppercase 'CANCELLED BY USER' returns the canonical 'Cancelled by user'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("CANCELLED BY USER"),
      "Cancelled by user"
    );
  });

  it("MONEY-543 fixed: mixed case 'CancELLED bY UseR' returns the canonical 'Cancelled by user'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("CancELLED bY UseR"),
      "Cancelled by user"
    );
  });

  it("MONEY-543 fixed: leading whitespace before cancel sentinel still matches and returns canonical form", () => {
    assert.equal(
      sanitizeRoastErrorMessage("  Cancelled by user"),
      "Cancelled by user"
    );
  });

  it("MONEY-543 fixed: trailing whitespace after cancel sentinel still matches and returns canonical form", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Cancelled by user  "),
      "Cancelled by user"
    );
  });

  it("MONEY-543 fixed: trailing newline + whitespace still matches and returns canonical form", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Cancelled by user\n\t"),
      "Cancelled by user"
    );
  });

  it("MONEY-543 fixed: case variant + surrounding whitespace still matches and returns canonical form", () => {
    assert.equal(
      sanitizeRoastErrorMessage("  cancelled BY USER \n"),
      "Cancelled by user"
    );
  });

  it("MONEY-543: does NOT match a substring 'cancelled by user something' — strict equality after normalization", () => {
    // The fix is a normalized equality compare (`trim+toLowerCase ===`),
    // NOT a substring match. A message that merely contains the cancel
    // phrase as a prefix is a real error string and should NOT be swallowed
    // into the cancel branch. Pin this so a future "fuzzy match" refactor
    // doesn't accidentally hide real cancel-adjacent errors.
    assert.equal(
      sanitizeRoastErrorMessage("Cancelled by user before step 3"),
      "Something went wrong while generating your roast. Please try again."
    );
  });

  it("MONEY-543: internal whitespace variants (multiple spaces) do NOT match — pinned", () => {
    // `trim()` only strips edges, not collapses internal whitespace. So
    // "Cancelled  by  user" (double space) is not the cancel sentinel and
    // routes to the generic default. Pin to prevent over-normalization that
    // would mask other "cancelled" prose errors.
    assert.equal(
      sanitizeRoastErrorMessage("Cancelled  by  user"),
      "Something went wrong while generating your roast. Please try again."
    );
  });
});

describe("sanitizeRoastErrorMessage — JSON / parse errors", () => {
  const expected = "We had trouble reading the AI response. Please try again.";

  it("maps the user-reported 'Unterminated string in JSON at position N'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Unterminated string in JSON at position 245"),
      expected
    );
  });

  it("maps 'Unexpected token } in JSON at position N'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Unexpected token } in JSON at position 12"),
      expected
    );
  });

  it("maps a SpiderMonkey-style 'JSON.parse: ...' message", () => {
    assert.equal(
      sanitizeRoastErrorMessage("JSON.parse: unexpected character"),
      expected
    );
  });

  it("maps a generic 'Failed to parse response' (lowercased 'parse' substring)", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Failed to parse response"),
      expected
    );
  });
});

describe("sanitizeRoastErrorMessage — timeouts", () => {
  const expected =
    "Roast generation took longer than expected. Please try again.";

  it("maps 'Operation timed out after 60000ms'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Operation timed out after 60000ms"),
      expected
    );
  });

  it("maps the bare word 'Request timeout'", () => {
    assert.equal(sanitizeRoastErrorMessage("Request timeout"), expected);
  });

  it("maps 'Score generation timed out'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Score generation timed out"),
      expected
    );
  });
});

describe("sanitizeRoastErrorMessage — network", () => {
  const expected = "Network issue while generating roast. Please try again.";

  it("maps a bare 'fetch failed' (undici / Node fetch)", () => {
    assert.equal(sanitizeRoastErrorMessage("fetch failed"), expected);
  });

  it("maps 'Network error: ECONNRESET'", () => {
    assert.equal(
      sanitizeRoastErrorMessage("Network error: ECONNRESET"),
      expected
    );
  });

  it("maps 'network connection refused' (lowercase 'network' substring)", () => {
    assert.equal(
      sanitizeRoastErrorMessage("network connection refused"),
      expected
    );
  });
});

describe("sanitizeRoastErrorMessage — default category", () => {
  const expected =
    "Something went wrong while generating your roast. Please try again.";

  it("maps an unrecognised technical error", () => {
    assert.equal(sanitizeRoastErrorMessage("Something exploded"), expected);
  });

  it("maps random gibberish", () => {
    assert.equal(sanitizeRoastErrorMessage("foo bar baz"), expected);
  });
});
