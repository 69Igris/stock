/**
 * Image prompt builder + SEBI guardrail for the Studio image generator
 * (Nano Banana Pro). Pure/deterministic — no network, no model call.
 *
 * Source under test: apps/content/app/api/ai/generate-image/nano-banana.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildImagePrompt,
  SEBI_IMAGE_GUARDRAIL,
} from "../../app/api/ai/generate-image/nano-banana";

describe("buildImagePrompt", () => {
  test("always includes the subject and the SEBI guardrail", () => {
    const p = buildImagePrompt({
      prompt: "a calm portfolio dashboard concept",
    });
    assert.ok(p.includes("a calm portfolio dashboard concept"));
    assert.ok(p.includes(SEBI_IMAGE_GUARDRAIL));
  });

  test("guardrail forbids tickers / prices / returns / advice", () => {
    assert.match(SEBI_IMAGE_GUARDRAIL, /ticker/i);
    assert.match(SEBI_IMAGE_GUARDRAIL, /price/i);
    assert.match(SEBI_IMAGE_GUARDRAIL, /return/i);
    assert.match(SEBI_IMAGE_GUARDRAIL, /advice/i);
  });

  test("cream brand injects the v3 palette; 'none' injects no brand", () => {
    const cream = buildImagePrompt({ prompt: "x", brandTheme: "cream" });
    assert.ok(cream.includes("#f7f3e6")); // cream paper
    assert.ok(cream.includes("#16a34a")); // emerald
    const none = buildImagePrompt({ prompt: "x", brandTheme: "none" });
    assert.ok(!none.includes("#f7f3e6"));
  });

  test("dark brand injects Terminal Luxe palette", () => {
    const dark = buildImagePrompt({ prompt: "x", brandTheme: "dark" });
    assert.ok(dark.includes("#060b18"));
    assert.ok(dark.includes("#34d399"));
  });

  test("style + aspect are reflected; defaults are minimalist + 1:1", () => {
    assert.match(buildImagePrompt({ prompt: "x" }), /minimalist/);
    assert.match(buildImagePrompt({ prompt: "x" }), /1:1/);
    assert.match(
      buildImagePrompt({
        prompt: "x",
        style: "photorealistic",
        aspect: "16:9",
      }),
      /photograph/,
    );
    assert.match(buildImagePrompt({ prompt: "x", aspect: "9:16" }), /9:16/);
  });
});
