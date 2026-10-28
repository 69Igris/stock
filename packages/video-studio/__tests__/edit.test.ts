/**
 * Edit layer — the offline "direct edit tools" (applyOps) and the offline
 * natural-language parser (parseInstruction).
 *
 * De-shadow: imports and runs the REAL exported functions and asserts their
 * output. No Gemini / network — this whole layer is deterministic.
 *
 * Source under test:
 *   packages/video-studio/src/editor/ops.ts
 *   packages/video-studio/src/editor/parse.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { applyOps, resolveScenes } from "../src/editor/ops";
import { parseInstruction } from "../src/editor/parse";
import { Timeline } from "../src/types";

const base = () =>
  Timeline.parse({
    title: "Test reel",
    aspect: "9:16",
    brandTheme: "cream",
    music: { track: "corporate-lofi", gainDb: -22 },
    scenes: [
      {
        id: "hook",
        type: "hook",
        durationSec: 4,
        headline: "Hi",
        voiceover: { text: "namaste", lang: "hi-IN" },
      },
      {
        id: "p1",
        type: "point",
        durationSec: 4.5,
        headline: "Point",
        disclaimer: true,
        voiceover: { text: "baat", lang: "hi-IN" },
      },
      { id: "broll", type: "veo", durationSec: 6, veoPrompt: "abstract" },
      { id: "cta", type: "cta", durationSec: 3.5, headline: "End" },
    ],
  });

describe("resolveScenes", () => {
  test("resolves id, 1-based index, first/last/all", () => {
    const tl = base();
    assert.deepEqual(resolveScenes(tl, "hook"), [0]);
    assert.deepEqual(resolveScenes(tl, 3), [2]);
    assert.deepEqual(resolveScenes(tl, "first"), [0]);
    assert.deepEqual(resolveScenes(tl, "last"), [3]);
    assert.deepEqual(resolveScenes(tl, "all"), [0, 1, 2, 3]);
    assert.deepEqual(resolveScenes(tl, undefined), [0, 1, 2, 3]);
  });
  test("throws on a miss", () => {
    assert.throws(() => resolveScenes(base(), "nope"));
    assert.throws(() => resolveScenes(base(), 99));
  });
});

describe("applyOps", () => {
  test("does not mutate the input", () => {
    const tl = base();
    const before = JSON.stringify(tl);
    applyOps(tl, [{ op: "remove_audio" }]);
    assert.equal(JSON.stringify(tl), before);
  });

  test("set / add / scale duration with clamping", () => {
    const tl = base();
    assert.equal(
      applyOps(tl, [{ op: "set_duration", scene: "hook", seconds: 5 }])
        .scenes[0]!.durationSec,
      5,
    );
    assert.equal(
      applyOps(tl, [{ op: "add_duration", scene: "cta", deltaSec: 2 }])
        .scenes[3]!.durationSec,
      5.5,
    );
    // clamp to min 0.8
    assert.equal(
      applyOps(tl, [{ op: "add_duration", scene: "hook", deltaSec: -100 }])
        .scenes[0]!.durationSec,
      0.8,
    );
    // scale all
    const scaled = applyOps(tl, [{ op: "scale_duration", factor: 2 }]);
    assert.equal(scaled.scenes[0]!.durationSec, 8);
    assert.equal(scaled.scenes[2]!.durationSec, 12);
  });

  test("remove_scene / move_scene", () => {
    const tl = base();
    const removed = applyOps(tl, [{ op: "remove_scene", scene: "broll" }]);
    assert.deepEqual(
      removed.scenes.map((s) => s.id),
      ["hook", "p1", "cta"],
    );
    const moved = applyOps(tl, [
      { op: "move_scene", scene: "cta", toIndex: 1 },
    ]);
    assert.deepEqual(
      moved.scenes.map((s) => s.id),
      ["cta", "hook", "p1", "broll"],
    );
    assert.throws(() =>
      applyOps(
        Timeline.parse({
          title: "x",
          scenes: [{ id: "only", type: "cta", durationSec: 3 }],
        }),
        [{ op: "remove_scene", scene: "only" }],
      ),
    );
  });

  test("music ops", () => {
    const tl = base();
    assert.equal(applyOps(tl, [{ op: "remove_music" }]).music, undefined);
    const swapped = applyOps(tl, [{ op: "set_music", track: "ambient-pad" }]);
    assert.equal(swapped.music!.track, "ambient-pad");
    assert.equal(swapped.music!.gainDb, -22); // preserved
  });

  test("voiceover ops + remove_audio", () => {
    const tl = base();
    const en = applyOps(tl, [
      { op: "set_voiceover", scene: "hook", text: "Hello", lang: "en-IN" },
    ]);
    assert.equal(en.scenes[0]!.voiceover!.text, "Hello");
    assert.equal(en.scenes[0]!.voiceover!.lang, "en-IN");
    const noVo = applyOps(tl, [{ op: "remove_voiceover", scene: "hook" }]);
    assert.equal(noVo.scenes[0]!.voiceover, undefined);
    assert.equal(noVo.scenes[1]!.voiceover!.text, "baat"); // others untouched
    const silent = applyOps(tl, [{ op: "remove_audio" }]);
    assert.equal(silent.music, undefined);
    assert.equal(
      silent.scenes.every((s) => !s.voiceover),
      true,
    );
  });

  test("captions / disclaimer / aspect / theme / title", () => {
    const tl = base();
    assert.equal(
      applyOps(tl, [{ op: "set_captions", enabled: false }]).captions.enabled,
      false,
    );
    assert.equal(
      applyOps(tl, [{ op: "set_disclaimer", value: true }]).scenes.every(
        (s) => s.disclaimer,
      ),
      true,
    );
    assert.equal(
      applyOps(tl, [{ op: "set_aspect", aspect: "1:1" }]).aspect,
      "1:1",
    );
    assert.equal(
      applyOps(tl, [{ op: "set_theme", theme: "dark" }]).brandTheme,
      "dark",
    );
    assert.equal(
      applyOps(tl, [{ op: "set_title", title: "New" }]).title,
      "New",
    );
  });
});

describe("parseInstruction (offline NL)", () => {
  const p = (s: string) => parseInstruction(s, base());

  test("single commands map to the right op", () => {
    assert.deepEqual(p("make the hook 5 seconds").ops, [
      { op: "set_duration", scene: "hook", seconds: 5 },
    ]);
    assert.deepEqual(p("swap the music to corporate-lofi").ops, [
      { op: "set_music", track: "corporate-lofi" },
    ]);
    assert.deepEqual(p("remove captions").ops, [
      { op: "set_captions", enabled: false },
    ]);
    assert.deepEqual(p("make it silent").ops, [{ op: "remove_audio" }]);
    assert.deepEqual(p("drop the last scene").ops, [
      { op: "remove_scene", scene: "cta" },
    ]);
    assert.deepEqual(p("make the cta longer by 2 seconds").ops, [
      { op: "add_duration", scene: "cta", deltaSec: 2 },
    ]);
    assert.deepEqual(p("remove the music").ops, [{ op: "remove_music" }]);
  });

  test("b-roll alias resolves to the veo scene", () => {
    assert.deepEqual(p("remove the b-roll").ops, [
      { op: "remove_scene", scene: "broll" },
    ]);
  });

  test("compound instruction yields multiple ops, nothing unmatched", () => {
    const r = p("make the hook 5s, remove captions and drop the last scene");
    assert.equal(r.unmatched.length, 0);
    assert.deepEqual(r.ops, [
      { op: "set_duration", scene: "hook", seconds: 5 },
      { op: "set_captions", enabled: false },
      { op: "remove_scene", scene: "cta" },
    ]);
  });

  test("freeform / creative text is reported as unmatched (=> Gemini fallback)", () => {
    const r = p("make it feel more cinematic and emotional");
    assert.equal(r.ops.length, 0);
    assert.ok(r.unmatched.length > 0);
  });

  test("unknown scene reference does not emit a bad op", () => {
    const r = p("make the outro2 7 seconds");
    assert.equal(r.ops.length, 0);
    assert.ok(r.unmatched.length > 0);
  });

  test("parsed ops actually apply end-to-end", () => {
    const tl = base();
    const r = p("make the hook 6s, remove the music");
    const next = applyOps(tl, r.ops);
    assert.equal(next.scenes[0]!.durationSec, 6);
    assert.equal(next.music, undefined);
  });
});
