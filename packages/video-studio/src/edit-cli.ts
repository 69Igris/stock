#!/usr/bin/env node
/**
 * Edit a Timeline from the command line.
 *
 * Natural language (offline-first; Gemini fallback if GCP creds are set):
 *   node --import tsx src/edit-cli.ts in.json "make the hook 5s, remove captions" [out.json]
 *
 * Structured ops file (always offline, deterministic — the direct edit tools):
 *   node --import tsx src/edit-cli.ts in.json --ops edits.json [out.json]
 *   where edits.json is a JSON array of EditOp, e.g.
 *   [{"op":"set_duration","scene":"hook","seconds":5},{"op":"remove_music"}]
 *
 * Writes <in>.edited.json unless an out path is given.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Timeline } from "./types.js";
import { editTimeline } from "./director.js";
import { applyOps, EditOp } from "./editor/ops.js";
import { z } from "zod";

const argv = process.argv.slice(2);
const inFile = argv[0];
if (!inFile) {
  console.error('usage: edit-cli <in.json> "<instruction>" [out.json]');
  console.error("       edit-cli <in.json> --ops <edits.json> [out.json]");
  process.exit(1);
}

const tl = Timeline.parse(JSON.parse(readFileSync(inFile, "utf8")));

let next: Timeline;
let outFile: string | undefined;
if (argv[1] === "--ops" || argv[1] === "-o") {
  const edits = z
    .array(EditOp)
    .parse(JSON.parse(readFileSync(argv[2]!, "utf8")));
  next = applyOps(tl, edits);
  outFile = argv[3];
} else {
  const instruction = argv[1];
  if (!instruction) {
    console.error("error: provide an instruction or --ops <file>");
    process.exit(1);
  }
  next = await editTimeline(tl, instruction);
  outFile = argv[2];
}

const out = outFile ?? inFile.replace(/\.json$/, "") + ".edited.json";
writeFileSync(out, JSON.stringify(next, null, 2) + "\n");
console.log(
  `✓ ${out}  (${next.scenes.length} scenes, ${next.scenes.reduce((s, x) => s + x.durationSec, 0)}s)`,
);
