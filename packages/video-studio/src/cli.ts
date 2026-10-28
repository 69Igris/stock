#!/usr/bin/env node
/** Local CLI: render a Timeline JSON file to MP4 without the MCP layer.
 *  Usage:  node --import tsx src/cli.ts path/to/timeline.json [out.mp4] */
import { readFileSync } from "node:fs";
import { Timeline } from "./types.js";
import { composeTimeline } from "./editor/compose.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: studio <timeline.json> [out.mp4]");
  process.exit(1);
}
const tl = Timeline.parse(JSON.parse(readFileSync(file, "utf8")));
const r = await composeTimeline(tl, { outFile: process.argv[3] });
console.log(
  `✓ ${r.path}  ${r.durationSec}s  ${r.width}x${r.height}  (${r.note ?? ""})`,
);
