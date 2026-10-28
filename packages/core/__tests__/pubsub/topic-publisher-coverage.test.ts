/**
 * Every declared Pub/Sub topic must have at least one publisher — MONEY-1205.
 *
 * ## Why this exists
 *
 * A topic in `PUBSUB_TOPICS` that nothing publishes to is invisible. The
 * infra scripts create it, a processor and a route consume it, the docs list it
 * with a trigger — and it never fires. Nothing errors, nothing is logged, and
 * the feature it was supposed to power silently falls back to whatever else
 * happens to call the same code. This class has now bitten twice:
 *
 *   - `fund-composition-sync` — topic created by workers/scripts/setup-pubsub.sh,
 *     consumed by workers/src/processors/fund-composition.ts, documented in
 *     workers/ARCHITECTURE.md as triggered by "Cloud Scheduler". No publisher,
 *     no scheduler entry. Fund composition refresh was therefore 100%
 *     page-view-driven: a user opening an ETF page WAS the cron. Deleted in
 *     MONEY-1205.
 *   - `proactive-analysis` — declared, topic-created, message type exported.
 *     No publisher, no route, no processor at all. Deleted in MONEY-1205.
 *
 * ## What counts as a publisher
 *
 * Two things publish to a topic in this repo, and both are checked:
 *
 *   1. CODE — `getTopicName(PUBSUB_TOPICS.X)` handed to `client.topic(...)`,
 *      i.e. the helpers in `packages/pubsub/src/publish.ts` (and anywhere else
 *      that publishes directly).
 *   2. CLOUD SCHEDULER — a `SCHEDULER_DEFS` entry in
 *      `scripts/ops/setup-scheduler.sh`, whose format is
 *      `NAME|SCHEDULE|TOPIC_BASE|MESSAGE|DESCRIPTION`. Most system jobs have no
 *      code publisher at all; the scheduler publishes straight to the topic.
 *
 * Test files are deliberately excluded from the code scan — a topic whose only
 * "publisher" is a test is exactly the dead topic this guard is looking for.
 *
 * CWD is packages/core (the package's test script runs from there).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { PUBSUB_TOPICS } from "@usemoney/types/pubsub";

/**
 * Walk up from the CWD to the monorepo root. `packages/core` is an ESM package
 * so there is no `__dirname`, and the package test script sets CWD to
 * `packages/core` — but a root-relative anchor is what this guard needs, and an
 * anchor that silently resolves to the wrong directory would make the scan
 * find nothing and pass. Hence: find it, then assert it.
 */
function findRepoRoot(from: string = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(join(dir, "turbo.json")) &&
      existsSync(join(dir, "packages"))
    ) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root from ${from}`);
}

const REPO_ROOT = findRepoRoot();
const SCHEDULER_SCRIPT = join(
  REPO_ROOT,
  "scripts",
  "ops",
  "setup-scheduler.sh",
);

/** Where publishers can live. `scripts/` included: ops scripts publish too. */
const SCAN_ROOTS = ["apps", "packages", "workers", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  "vendor",
  "__tests__",
]);

/** The declaration itself is not a publisher. */
const TOPIC_DECLARATION = join("packages", "types", "src", "pubsub.ts");

function collectSources(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, out);
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
}

const sourceFiles: string[] = [];
for (const root of SCAN_ROOTS)
  collectSources(join(REPO_ROOT, root), sourceFiles);

/**
 * TypeScript source with comments removed — LINE comments BEFORE block ones.
 *
 * Reversed, a `//` line that contains a `/*` opens a phantom block comment that
 * runs to the next terminator hundreds of lines away, and the code in between
 * disappears from the corpus (MONEY-1143 — this repo has now burned seven
 * occurrences of that ordering).
 *
 * It is applied PER FILE, not to the joined corpus, so an unterminated block
 * comment at the end of one file cannot swallow the beginning of the next.
 *
 * Why it is needed at all: `hasCodePublisher` is a raw text match, so
 * `// see getTopicName(PUBSUB_TOPICS.STRATEGY_SCAN)` in any prose anywhere
 * would credit a topic nothing publishes to. Measured on the tree at the time
 * of writing, no topic's verdict changes — this is the guard against the next
 * comment, not a repair of a live miscount.
 */
function stripTsComments(src: string): string {
  return src
    .replace(/^[^\S\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""));
}

const publisherCorpus = sourceFiles
  .filter((f) => !f.endsWith(TOPIC_DECLARATION))
  .map((f) => stripTsComments(readFileSync(f, "utf8")))
  .join("\n");

export interface SchedulerScan {
  /** Every TOPIC_BASE spelled by a SCHEDULER_DEFS entry, verbatim. */
  readonly topics: Set<string>;
  /** Quoted entry lines inside the array this parser could NOT read. */
  readonly unparseable: readonly string[];
  /** Total quoted entry lines inside the array. */
  readonly entryCount: number;
}

/**
 * Topic bases published by a Cloud Scheduler job.
 *
 * ## The mount-path hole this replaces (MONEY-1326)
 *
 * The previous version was one regex run over the WHOLE FILE:
 *
 *     /^\s*"[^|"]+\|[^|]+\|([a-z0-9-]+)\|/gm
 *
 * and the topic field was `[a-z0-9-]+`. A TOPIC_BASE spelled with anything
 * outside that class simply did not match, and a line that does not match is
 * not an error — it is absent. So the entry vanished, silently, and the case
 * named "every Cloud Scheduler entry targets a DECLARED topic (a typo
 * publishes into the void)" had nothing to judge.
 *
 * That is not a theoretical class. A Pub/Sub topic id legally contains
 * underscores and periods, `IFS='|' read -r NAME SCHEDULE TOPIC_BASE …`
 * (setup-scheduler.sh) takes the field verbatim with no charset check, and
 * `gcloud scheduler jobs create pubsub --topic=…` accepts it. MEASURED: adding
 *
 *     "probe-mutation-daily|0 4 * * *|mf_sync|{}|…"
 *
 * left this suite at 22 pass / 0 fail, while the same typo spelled `mf-snyc`
 * turned it red. The guard could see one spelling of the defect and not the
 * other — and the spelling it could not see is the one that reaches production,
 * because `mf_sync` is a VALID topic id that gcloud will happily create a job
 * against.
 *
 * Two changes, and the second is the one that matters:
 *
 *   1. The scan is BOUNDED to the `SCHEDULER_DEFS=( … )` array, so widening the
 *      field cannot start harvesting `MONITOR_DEFS` (`NAME|ENV|SCHEDULE|WHY`),
 *      whose third field is a cron expression and would present as a topic.
 *   2. The topic field is `[^|]+` — ANY spelling — and any quoted entry line
 *      the parser cannot read is REPORTED in `unparseable` rather than dropped.
 *      An unreadable mount path must never read as "no scheduler entry".
 *
 * Measured on the tree at the time of writing: 74 entry lines, 0 unparseable,
 * 53 distinct topic bases, all of them still within `[a-z0-9-]`. So this is a
 * pure strengthening — the verdict for every topic is unchanged.
 *
 * Pure, and taking its source as an argument, so the discrimination can be
 * driven with a synthetic array instead of by editing the real ops script.
 */
export function scanSchedulerDefs(src: string): SchedulerScan {
  const topics = new Set<string>();
  const unparseable: string[] = [];

  const block = /^SCHEDULER_DEFS=\(\n([\s\S]*?)^\)/m.exec(src);
  if (!block) return { topics, unparseable, entryCount: 0 };

  // Format: "NAME|SCHEDULE|TOPIC_BASE|MESSAGE|DESCRIPTION"
  const ENTRY = /^\s*"([^|"]+)\|([^|]+)\|([^|]+)\|/;
  let entryCount = 0;
  for (const line of block[1]!.split("\n")) {
    if (!/^\s*"/.test(line)) continue; // comment, blank, or array close
    entryCount++;
    const m = ENTRY.exec(line);
    if (!m) {
      unparseable.push(line.trim());
      continue;
    }
    topics.add(m[3]!.trim());
  }
  return { topics, unparseable, entryCount };
}

const schedulerScan = scanSchedulerDefs(readFileSync(SCHEDULER_SCRIPT, "utf8"));

function schedulerTopics(): Set<string> {
  return schedulerScan.topics;
}

/* ═════════════════════════════════════════════════════════════════════════
   Python publishers — `services/*` (MONEY-979)
   ════════════════════════════════════════════════════════════════════════ */

/**
 * The TypeScript corpus above looks for `getTopicName(PUBSUB_TOPICS.X)`, which
 * is a TypeScript idiom. That was the whole population until a Python Cloud Run
 * service arrived: `services/us-fundamentals` publishes to the five
 * `edgar-parse-*` topics and to `edgar-evict`, and none of it is TypeScript.
 *
 * ## Two earlier versions of this scan, and why both proved nothing
 *
 *   1. **Whole-corpus substring.** Join every Python file and ask whether the
 *      topic name appears anywhere. `edgar-parse-13f` also appears in
 *      `app/main.py`'s ROUTE table and in `app/jobs/parse_13f.py` — both
 *      CONSUMERS — so deleting the name from the real publishing table left the
 *      guard green.
 *   2. **Per-file, gated on `/\bpublish\b|\btopic_for\b/`.** Measured on the
 *      real tree, all five `edgar-parse-*` topics were credited by EXACTLY ONE
 *      file: `app/classify.py`. That file is a MAPPING TABLE
 *      (`TOPIC_BY_PARSE_CLASS`) plus the lookup function `topic_for`. It issues
 *      no publish and imports no client. It matched only because the word
 *      `topic_for` appears in it — its own definition. The actual publisher,
 *      `app/jobs/detect.py`, names no topic literal at all, so deleting
 *      `publisher.publish(topic, message)` outright would have left this suite
 *      green. A guard satisfied by the wrong file is the same defect as an
 *      unpublished topic, one level up.
 *
 * ## What this version asserts
 *
 * A topic is credited only when a real PUBLISH CALL SITE, in a module reachable
 * from a job entry point, has a first argument that RESOLVES to that topic. The
 * chain is followed across modules:
 *
 *     app/jobs/detect.py   publisher.publish(topic, message)
 *                          topic = topic_for(parse_class)
 *                          from app.classify import topic_for
 *     app/classify.py      def topic_for(...) -> TOPIC_BY_PARSE_CLASS[...]
 *                          TOPIC_BY_PARSE_CLASS = { ...: "edgar-parse-13f", ...}
 *
 * ## What it does NOT do, stated rather than implied
 *
 * This is a text walk, not a Python interpreter. It is deliberately PERMISSIVE
 * about what a name resolves to — it collects every quoted string reachable
 * from the expression and intersects with the declared topic values — because
 * over-collecting can only credit a topic that some publish call site can plausibly
 * reach, while under-collecting would report a live topic as an orphan. The
 * STRICT half is the starting point: the walk begins only at an actual
 * `x.publish(...)` inside `app/jobs/`, which is what the previous version got
 * wrong. Resolution depth is bounded, and each service's `app/publish.py` — the
 * transport, whose `client.publish(topic_path, data)` is the wrapper itself and
 * not a caller — is not a job module and is never a starting point.
 *
 * (That sentence used to spell the path with a glob. A block comment ends at
 * the first `*` followed by `/`, so the docblock terminated mid-prose and the
 * file stopped parsing. Same trap `codeOnly` in candle-cold-store.test.ts
 * documents from the other direction.)
 *
 * ## PROSE IS NOT CODE — the third version of this scan, and why
 *
 * Everything above was true of a walk that read Python as RAW TEXT, and a raw
 * text walk credits a topic that only a COMMENT mentions. Three false greens
 * were measured on the real tree:
 *
 *   (a) Replacing `publisher.publish(topic, message)` in `app/jobs/detect.py`
 *       with a `#` comment quoting the same line left all five
 *       `edgar-parse-*` topics credited and the suite at 7 pass / 0 fail —
 *       with the fan-out gone. The docstring spelling behaved identically.
 *   (b) A bare `# e.g. publisher.publish("stock-document-extract", payload)`
 *       anywhere under `jobs/` credited a completely unrelated topic that has
 *       no Python publisher at all.
 *   (c) Deleting `THIRTEENF: "edgar-parse-13f"` from `app/classify.py` and
 *       mentioning it in a comment left the topic credited, because the
 *       resolver harvests every quoted string in the function body.
 *
 * So every Python file is read through `pythonCodeOnly` first. The permissive
 * half of the design survives — over-collecting inside CODE can only credit a
 * topic some publish call site can plausibly reach — but prose is not code and
 * never gets a vote.
 *
 * `.venv` is skipped: third-party packages, tens of MB, none of it ours.
 */

/**
 * Python source with COMMENTS and DOCSTRINGS blanked out, byte offsets and
 * line breaks preserved.
 *
 * ## Why one pass and not two regexes
 *
 * The repo rule for TypeScript is "LINE comments before BLOCK comments"
 * (MONEY-1143): reversed, a `//` mentioning `/*` opens a phantom block. Python
 * has the SAME trap in BOTH directions — a `#` line mentioning `"""` opens a
 * phantom docstring, and `x = """a # b"""` puts a `#` inside a string — so
 * there is no ordering of two regexes that is right for both. A single
 * left-to-right pass has no ordering to get wrong: whichever delimiter is
 * reached first wins, which is exactly what the interpreter does.
 *
 * Blanked, not deleted: every removed character becomes a space and every
 * newline is kept, so offsets and line numbers are identical to the original.
 * `bindingTexts` and `functionTexts` slice by offset, and a shifting index is
 * how a scan silently starts reading the wrong region.
 *
 * SINGLE-LINE string literals are PRESERVED — they are where the topic names
 * live. Triple-quoted strings are blanked: a docstring is prose, and (a) above
 * is the same false green whether it is spelled with a `#` or with `"""`.
 */
function pythonCodeOnly(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "#") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfStringLiteral(src, i);
      if (src.startsWith(ch + ch + ch, i)) blank(i, end);
      i = Math.max(end, i + 1);
      continue;
    }
    i++;
  }
  return out.join("");
}

/**
 * Index one past the string literal that STARTS at `from`.
 *
 * Handles both quote characters and both widths. A single-quoted literal that
 * is never closed ends at the newline, as Python's own tokenizer does — the
 * alternative (running to end of file) turns one typo into a scan that reads
 * nothing.
 */
function endOfStringLiteral(src: string, from: number): number {
  const ch = src[from]!;
  const triple = ch + ch + ch;
  const isTriple = src.startsWith(triple, from);
  const delim = isTriple ? triple : ch;
  let j = from + delim.length;
  while (j < src.length) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src.startsWith(delim, j)) return j + delim.length;
    if (!isTriple && src[j] === "\n") return j;
    j++;
  }
  return src.length;
}

/**
 * `pythonCodeOnly(readFileSync(file))`, memoised.
 *
 * `resolveSymbol` re-reads the same handful of modules at every depth, and the
 * blanking pass is a character walk over the whole file. Keys are absolute
 * paths and every fixture tree is a fresh `mkdtemp`, so no two trees in one run
 * can collide on a key.
 */
const pythonCodeCache = new Map<string, string>();
function readPythonCode(file: string): string {
  const cached = pythonCodeCache.get(file);
  if (cached !== undefined) return cached;
  let code: string;
  try {
    code = pythonCodeOnly(readFileSync(file, "utf8"));
  } catch {
    code = "";
  }
  pythonCodeCache.set(file, code);
  return code;
}
function collectPythonSources(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name === ".venv") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectPythonSources(full, out);
    else if (/\.py$/.test(entry.name) && !/^test_/.test(entry.name)) {
      out.push(full);
    }
  }
}

/** Anything under a `jobs/` directory: the modules `main.py` routes to. */
const isJobModule = (file: string): boolean =>
  file.includes(`${sep}jobs${sep}`);

/** `services/<name>` for a file inside it, so `app.x` resolves per service. */
function serviceRootOf(file: string, servicesDir: string): string | null {
  if (!file.startsWith(servicesDir + sep)) return null;
  const rest = file.slice(servicesDir.length + 1);
  const svc = rest.split(sep)[0];
  return svc ? join(servicesDir, svc) : null;
}

/** `app.classify` -> `<service>/app/classify.py`, or null. */
function modulePathFor(
  fromFile: string,
  dotted: string,
  servicesDir: string,
): string | null {
  const root = serviceRootOf(fromFile, servicesDir);
  if (!root) return null;
  const candidate = join(root, ...dotted.split(".")) + ".py";
  return existsSync(candidate) ? candidate : null;
}

/** Every double- or single-quoted string in a fragment. */
const quotedStrings = (text: string): string[] => [
  ...[...text.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]!),
  ...[...text.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]!),
];

/** The module a `from X import (... name ...)` line binds `name` from. */
function importedModuleFor(
  src: string,
  name: string,
  fromFile: string,
  servicesDir: string,
): string | null {
  const re = /^from\s+([\w.]+)\s+import\s+(?:\(([\s\S]*?)\)|(.+))$/gm;
  for (const m of src.matchAll(re)) {
    const names = (m[2] ?? m[3] ?? "")
      .split(",")
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter(Boolean);
    if (names.includes(name)) {
      return modulePathFor(fromFile, m[1]!, servicesDir);
    }
  }
  return null;
}

/**
 * Index of the newline that ends the expression starting at `start`.
 *
 * Newlines inside brackets do not end it, which keeps a multi-line dict literal
 * whole and stops at the end of a one-line assignment. String literals are
 * SKIPPED WHOLE: a bracket inside a quoted string is a character, not nesting,
 * and counting it leaves `depth` permanently unbalanced so the walk swallows
 * the rest of the file.
 *
 * That was not hypothetical for comments. `topic = topic_for(parse_class)  #
 * None for OTHER (see classify.py` — an ordinary unclosed parenthesis in an
 * ordinary trailing comment — took the binding from 8 resolved strings to 36
 * and ate the remaining ~200 lines of `_fan_out`, which is the exact
 * over-swallow the paragraph below claims to have fixed. Comments are gone by
 * the time this runs (`pythonCodeOnly`); strings are handled here.
 *
 * An earlier version ended at "the next line starting in column 0" instead.
 * That is right for a module-level constant and catastrophically wrong for a
 * binding inside a function: `topic = topic_for(parse_class)` swallowed the
 * remaining ~40 lines of `_fan_out`, whose comments happen to quote
 * `"OTHER"` — so the resolver found literals, stopped, and never followed the
 * call. Every `edgar-parse-*` topic reported as an orphan.
 */
function endOfExpression(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      i = endOfStringLiteral(src, i) - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "\n" && depth <= 0) return i;
  }
  return src.length;
}

/**
 * EVERY right-hand side that binds `name` in this module, not the first one.
 *
 * "The first `name =` in the file" is not a scope, and treating it as one is a
 * FALSE RED that reads exactly like a missing publisher: inserting an unrelated
 * `topic = None` anywhere above `_fan_out` collapsed `detect.py` from five
 * topics to ZERO, and the failure message then sends the reader to
 * `setup-scheduler.sh` to wire a publisher that already exists.
 *
 * Unioning every binding is the permissive answer the header argues for — a
 * name that is assigned in three branches can evaluate to any of the three, and
 * a walk that guesses which one costs a live topic. Following only the nearest
 * preceding binding would need real scope analysis, which is a Python parser.
 *
 * `=(?!=)` so `topic == x` is not read as a binding whose value is `= x`.
 * Augmented assignments (`+=`, `!=`, `<=`) cannot match at all: the character
 * before the `=` has to be whitespace or the end of the annotation.
 */
function bindingTexts(src: string, name: string): string[] {
  const re = new RegExp(`^[ \\t]*${name}\\s*(?::[^=\\n]+)?=(?!=)\\s*`, "gm");
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    const start = m.index + m[0].length;
    out.push(src.slice(start, endOfExpression(src, start)));
  }
  return out;
}

/**
 * Every `def name(...)` body in the module, each up to the next top-level
 * statement. Plural for the same reason `bindingTexts` is: a name defined twice
 * (a `try`/`except ImportError` pair, a platform branch) must not resolve to
 * whichever copy happens to be first in the file.
 */
function functionTexts(src: string, name: string): string[] {
  const re = new RegExp(`^def ${name}\\s*\\(`, "gm");
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    const rest = src.slice(m.index + m[0].length);
    const end = rest.search(/\n(?=\S)/);
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

const MAX_RESOLVE_DEPTH = 4;

/** Every quoted string an expression could evaluate to. Permissive by design. */
function resolveExpression(
  file: string,
  expr: string,
  servicesDir: string,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  const trimmed = expr.trim();
  if (trimmed === "" || depth > MAX_RESOLVE_DEPTH) return [];

  const literal = /^["']([^"']*)["']$/.exec(trimmed);
  if (literal) return [literal[1]!];

  const call = /^([A-Za-z_]\w*)\s*\(/.exec(trimmed);
  if (call) return resolveSymbol(file, call[1]!, servicesDir, depth, seen);

  const name = /^([A-Za-z_]\w*)$/.exec(trimmed);
  if (name) return resolveSymbol(file, name[1]!, servicesDir, depth, seen);

  // Anything else (a subscript, an f-string, an attribute chain): whatever it
  // spells directly, plus whatever its identifiers resolve to. Bounded by
  // `seen` and by MAX_RESOLVE_DEPTH.
  const out = quotedStrings(trimmed);
  for (const id of new Set(
    [...trimmed.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((m) => m[1]!),
  )) {
    out.push(...resolveSymbol(file, id, servicesDir, depth + 1, seen));
  }
  return out;
}

/** Resolve a NAME: a binding here, a function here, or an import. */
function resolveSymbol(
  file: string,
  name: string,
  servicesDir: string,
  depth: number,
  seen: Set<string>,
): string[] {
  const key = `${file}::${name}`;
  if (seen.has(key) || depth > MAX_RESOLVE_DEPTH) return [];
  seen.add(key);

  // Code only. A topic named nowhere but in a comment or a docstring must not
  // be reachable from here — see the header's (a), (b) and (c).
  const src = readPythonCode(file);
  if (src === "") return [];

  const out: string[] = [];

  for (const binding of bindingTexts(src, name)) {
    // Both, not either: `X = PREFIX + "-13f"` spells a literal AND needs the
    // name followed. Deduplication happens at the call site.
    out.push(...quotedStrings(binding));
    out.push(...resolveExpression(file, binding, servicesDir, depth + 1, seen));
  }

  for (const body of functionTexts(src, name)) {
    out.push(...quotedStrings(body));
    // Module-level constants the function reads — the mapping table case.
    for (const ref of new Set(
      [...body.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]!),
    )) {
      out.push(...resolveSymbol(file, ref, servicesDir, depth + 1, seen));
    }
  }

  const imported = importedModuleFor(src, name, file, servicesDir);
  if (imported) {
    out.push(...resolveSymbol(imported, name, servicesDir, depth + 1, seen));
  }

  return out;
}

interface PythonPublishSite {
  /** Repo-relative path of the job module holding the call. */
  readonly file: string;
  /** The first argument, verbatim. */
  readonly expr: string;
  /** Every topic-shaped string that argument could resolve to. */
  readonly topics: readonly string[];
}

/**
 * Every `x.publish(FIRST_ARG, ...)` inside a `jobs/` module, with FIRST_ARG
 * resolved.
 */
function pythonPublishSites(servicesDir: string): PythonPublishSite[] {
  const files: string[] = [];
  collectPythonSources(servicesDir, files);

  const sites: PythonPublishSite[] = [];
  for (const file of files.filter(isJobModule)) {
    // `readPythonCode`, never `readFileSync`. A `#`-commented or docstring-
    // quoted `publisher.publish(...)` is not a call site, and reading it as one
    // is false green (a) and (b) in the header — measured, not theorised.
    const src = readPythonCode(file);
    for (const m of src.matchAll(/\b\w+\.publish\s*\(\s*([^,)]+)/g)) {
      const expr = m[1]!.trim();
      sites.push({
        file: file.slice(servicesDir.length - "services".length),
        expr,
        topics: [...new Set(resolveExpression(file, expr, servicesDir))],
      });
    }
  }
  return sites;
}

const SERVICES_DIR = join(REPO_ROOT, "services");
const publishSites = pythonPublishSites(SERVICES_DIR);

/** Every declared topic BASE name, for intersecting a permissive resolution. */
const DECLARED_TOPIC_VALUES = new Set(Object.values(PUBSUB_TOPICS) as string[]);

/**
 * Topic base names a real Python publish call site can reach.
 *
 * INTERSECTED with the declared values, and that is not tidying. The resolver
 * is permissive on purpose, so its raw output also contains `""`, `"OTHER"` and
 * a KeyError message — nine strings for six topics on the real tree. A premise
 * asserting `size > 0` over the raw set is therefore satisfied by the EMPTY
 * STRING alone: both resolution chains could be broken and the premise would
 * still pass, sending the reader to "wire a publisher" for six topics that have
 * one.
 */
const pythonPublishedTopics = new Set(
  publishSites
    .flatMap((s) => s.topics)
    .filter((t) => DECLARED_TOPIC_VALUES.has(t)),
);

/**
 * The topics a Python job module is REQUIRED to reach, derived rather than
 * listed so the two cannot drift.
 *
 * Deleting `EDGAR_PARSE_8K` from `PUBSUB_TOPICS` shrinks this set with it;
 * ADDING an `edgar-parse-*` topic makes the premise demand a publisher for it,
 * which is the whole point. `edgar-detect` is excluded because it is published
 * by Cloud Scheduler, not by the service.
 */
const PYTHON_PUBLISHED_TOPICS_EXPECTED = (
  Object.values(PUBSUB_TOPICS) as string[]
)
  .filter((v) => v.startsWith("edgar-parse-") || v === "edgar-evict")
  .sort();

/**
 * Names that ALIAS a topic — `export const X_TOPIC = PUBSUB_TOPICS.Y;`
 *
 * MONEY-1314. Without this the scan is blind to a publish that goes through
 * the alias, and the blindness is invisible: a topic with a scheduler entry AND
 * an aliased code publisher passes on the scheduler alone, so the hole only
 * opens on the day the schedule is retired — which is exactly when the guard is
 * being relied on to say whether anything still publishes.
 *
 * One alias exists in the repo today (`STOCK_DOCUMENT_PARSE_TOPIC`), and it is
 * the parse lane's self-chain. Resolving the pattern rather than special-casing
 * that name means a second alias is covered on the day it is written.
 */
export function collectTopicAliases(corpus: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const [, alias, key] of corpus.matchAll(
    /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::\s*[^=]+)?=\s*PUBSUB_TOPICS\.([A-Z0-9_]+)\s*;/g,
  )) {
    m.set(alias, key);
  }
  return m;
}

/**
 * Does `corpus` publish to `topicKey` through an ALIAS?
 *
 * Pure, and taking its corpus as an argument, so the discrimination can be
 * driven with a SYNTHETIC two-alias corpus. The repo currently holds exactly
 * one alias, which means an implementation that resolved ANY alias instead of
 * the right one would behave identically on real input — a mutation proved it
 * survives. n=1 cannot test a mapping.
 */
export function publishesViaAlias(
  corpus: string,
  aliases: Map<string, string>,
  topicKey: string,
): boolean {
  for (const [alias, key] of aliases) {
    if (key !== topicKey) continue;
    if (new RegExp(`getTopicName\\(\\s*${alias}\\s*[,)]`).test(corpus)) {
      return true;
    }
  }
  return false;
}

const TOPIC_ALIASES: Map<string, string> = collectTopicAliases(publisherCorpus);

function hasCodePublisher(topicKey: string): boolean {
  if (
    new RegExp(`getTopicName\\(\\s*PUBSUB_TOPICS\\.${topicKey}\\s*[,)]`).test(
      publisherCorpus,
    )
  ) {
    return true;
  }
  return publishesViaAlias(publisherCorpus, TOPIC_ALIASES, topicKey);
}

/** A Python job module whose publish call resolves to this topic. */
function hasPythonPublisher(topicValue: string): boolean {
  return pythonPublishedTopics.has(topicValue);
}

describe("MONEY-1205 — every declared Pub/Sub topic has a publisher", () => {
  const scheduled = schedulerTopics();
  const entries = Object.entries(PUBSUB_TOPICS) as Array<[string, string]>;

  it("the scan actually found the sources it is scanning", () => {
    // A guard that silently scans nothing is worse than no guard, because it is
    // cited as proof (see no-feed-fetch-bypass.test.ts).
    assert.ok(existsSync(SCHEDULER_SCRIPT), "setup-scheduler.sh must exist");

    // PER ROOT, not just the total. Measured 2026-08-29: apps 1417,
    // packages 834, workers 198, scripts 84 = 2533 files. Against the old
    // single `> 500` floor, THREE of the four roots could vanish entirely and
    // still pass — `apps` alone clears it by 900. Each floor here is ~65% of
    // the measured count: low enough to survive ordinary deletion, high enough
    // that a root that stops being scanned (a rename, a new SKIP_DIRS entry, a
    // move out of the workspace) fails by name instead of shrinking the corpus
    // silently. A floor with no verified ceiling is not a premise.
    const MIN_PER_ROOT: Readonly<Record<string, number>> = {
      apps: 900,
      packages: 540,
      workers: 120,
      scripts: 50,
    };
    const thin: string[] = [];
    for (const root of SCAN_ROOTS) {
      const prefix = join(REPO_ROOT, root) + sep;
      const n = sourceFiles.filter((f) => f.startsWith(prefix)).length;
      const floor = MIN_PER_ROOT[root] ?? 1;
      if (n < floor) thin.push(`${root}: ${n} files (expected >= ${floor})`);
    }
    assert.deepStrictEqual(
      thin,
      [],
      "a scan root is contributing far fewer files than measured, so topics " +
        "published from it would report as orphans (or, worse, a topic " +
        "deleted from it would stop being checked):\n  " +
        thin.join("\n  "),
    );
    assert.ok(
      sourceFiles.length > 2000,
      `expected the monorepo source scan to find ~2533 files, got ${sourceFiles.length}`,
    );

    // The Python half. An empty result here does NOT make this suite vacuous —
    // it makes the six edgar-* topics report as orphans, i.e. it fails loudly.
    // It is asserted anyway so that failure says "the services/ tree moved"
    // instead of "six topics have no publisher", which would send the reader to
    // the wrong file.
    assert.ok(
      publishSites.length > 0,
      "expected at least one `x.publish(...)` inside a services/*/app/jobs/ " +
        "module — the tree moved, and the edgar-* topics will report as " +
        "orphans for the wrong reason",
    );

    // The SET, not the size. `size > 0` is satisfied by the empty string the
    // permissive resolver emits from `stats.unrouted`'s neighbourhood, so both
    // resolution chains could be broken with the premise still green — which is
    // exactly the misdirection this block exists to prevent.
    const reachable = [...pythonPublishedTopics].sort();
    const unreachable = PYTHON_PUBLISHED_TOPICS_EXPECTED.filter(
      (t) => !pythonPublishedTopics.has(t),
    );
    assert.deepStrictEqual(
      unreachable,
      [],
      "declared edgar topics that NO Python publish call site can reach. The " +
        "chain `publish(topic) -> topic_for() -> TOPIC_BY_PARSE_CLASS` was " +
        "restructured; teach the resolver rather than widening it back to a " +
        "substring scan.\n  missing: " +
        unreachable.join(", ") +
        "\n  reachable: [" +
        reachable.join(", ") +
        "]\n  " +
        publishSites
          .map(
            (s) => `${s.file}: publish(${s.expr}) -> [${s.topics.join(", ")}]`,
          )
          .join("\n  "),
    );

    // Measured 2026-08-29: 52 scheduler entries, 69 declared topics. The old
    // `> 20` / `> 40` would have survived losing half of either list.
    assert.ok(
      scheduled.size > 40,
      `expected ~52 scheduler entries, got ${scheduled.size}`,
    );

    // An entry line the parser cannot read must FAIL, never vanish. Dropping it
    // silently is the whole mount-path hole: the entry stops existing as far as
    // "every scheduler entry targets a DECLARED topic" is concerned, so a
    // TOPIC_BASE that publishes into the void passes as though it were absent.
    assert.deepStrictEqual(
      [...schedulerScan.unparseable],
      [],
      "SCHEDULER_DEFS entry lines this scan could not parse. Each one is a " +
        "scheduler job whose TOPIC_BASE is NOT being checked against " +
        "PUBSUB_TOPICS — teach the parser rather than leaving them silent:\n  " +
        schedulerScan.unparseable.join("\n  "),
    );
    // Measured 2026-09-02: 74 entry lines -> 53 distinct topic bases. The
    // DISTINCT floor above cannot see this: many jobs share one topic, so a
    // dozen entries could be dropped without `scheduled.size` moving.
    assert.ok(
      schedulerScan.entryCount > 60,
      `expected ~74 SCHEDULER_DEFS entry lines, got ${schedulerScan.entryCount} — ` +
        "the array moved or its bounds stopped matching, and a bounded scan " +
        "that finds nothing reports every topic as unscheduled",
    );
    assert.ok(
      entries.length > 60,
      `expected ~69 topics, got ${entries.length}`,
    );
  });

  it("the TypeScript corpus `hasCodePublisher` reads is comment-free", () => {
    // Asserting the HELPER works proves nothing about whether it is WIRED —
    // that gap is this repo's most-repeated finding. So this reads the actual
    // corpus. Measured 2026-08-29 over 777,855 lines: zero survivors of either
    // shape. Deleting `stripTsComments` from the corpus pipeline turns this red
    // by the tens of thousands.
    const lines = publisherCorpus.split("\n");
    const slashes = lines.filter((l) => /^\s*\/\//.test(l));
    const stars = lines.filter((l) => /^\s*\*[\s/]/.test(l));
    assert.equal(
      slashes.length,
      0,
      `${slashes.length} line comments survived into the corpus, e.g. ` +
        slashes.slice(0, 3).join(" | "),
    );
    assert.equal(
      stars.length,
      0,
      `${stars.length} block-comment lines survived into the corpus, e.g. ` +
        stars.slice(0, 3).join(" | "),
    );
  });

  it("the permissive Python resolution is intersected with the DECLARED topics", () => {
    // The premise above asks "is every expected topic reachable". This asks the
    // other half: does anything the resolver spat out that is NOT a topic get
    // to act as one? The resolver is permissive by design and its raw output on
    // the real tree carries a KeyError message alongside the six real topics —
    // and before this intersection, a `size > 0` premise was satisfied by that
    // noise alone, so both resolution chains could be dead with the premise
    // green and the failure pointing at "wire a publisher".
    const raw = new Set(publishSites.flatMap((s) => s.topics));
    const noise = [...raw].filter((t) => !DECLARED_TOPIC_VALUES.has(t));
    assert.ok(
      noise.length > 0,
      "the resolver stopped emitting non-topic strings, so this case no " +
        "longer proves the intersection does anything. Either the resolver " +
        "became strict (good — say so here) or the walk found nothing at all.",
    );
    const leaked = noise.filter((t) => pythonPublishedTopics.has(t));
    assert.deepStrictEqual(
      leaked,
      [],
      "non-topic strings reached the credit set, so `hasPythonPublisher` can " +
        "be satisfied by something that is not a topic:\n  " +
        leaked.join("\n  "),
    );
  });

  it("[regression] no topic is declared, created and consumed but never published to", () => {
    const orphans: string[] = [];
    for (const [key, value] of entries) {
      if (hasCodePublisher(key)) continue;
      if (hasPythonPublisher(value)) continue;
      if (scheduled.has(value)) continue;
      orphans.push(`${key} ("${value}")`);
    }
    assert.deepStrictEqual(
      orphans,
      [],
      "These topics have NO code publisher and NO Cloud Scheduler entry, so " +
        "nothing can ever put a message on them. Either wire a publisher " +
        "(packages/pubsub/src/publish.ts) or a scheduler entry " +
        "(scripts/ops/setup-scheduler.sh SCHEDULER_DEFS), or delete the topic " +
        "along with its processor, route and message type:\n  " +
        orphans.join("\n  "),
    );
  });

  it("[regression] fund-composition-sync and proactive-analysis stay deleted", () => {
    const values = entries.map(([, v]) => v);
    assert.ok(
      !values.includes("fund-composition-sync"),
      "re-declaring it without a publisher re-creates MONEY-1205",
    );
    assert.ok(!values.includes("proactive-analysis"));
  });

  it("a MAPPING TABLE alone does not count as a Python publisher", () => {
    // The defect this rewrite fixes, pinned. `app/classify.py` holds every
    // `edgar-parse-*` literal and the `topic_for` lookup, and issues no
    // publish; it was the ONLY file crediting all five topics under the old
    // gate. It must not be a publish call site now.
    const fromClassify = publishSites.filter((s) =>
      s.file.includes("classify.py"),
    );
    assert.deepEqual(
      fromClassify,
      [],
      "classify.py is a mapping table, not a publisher — it must never be a " +
        "starting point for the walk",
    );
    assert.ok(
      publishSites.some((s) => s.file.includes(join("jobs", "detect.py"))),
      "the real fan-out publisher is app/jobs/detect.py; if it moved, the " +
        "walk is starting somewhere else",
    );
  });

  /* ── The guard must be able to FAIL ────────────────────────────────────── */

  /**
   * A fixture tree in the same shape as the real one, so the resolver is
   * exercised in both directions on every run.
   *
   * The alternative — mutating `services/` by hand, once — proves the guard
   * could fail on the day someone did it, and nothing afterwards. Two versions
   * of this scan have already passed against a tree that proved nothing; the
   * negative case belongs in CI.
   */
  /**
   * How `detect.py`'s fan-out is spelled in the fixture. Each variant after
   * `publish` is a mutation that was MEASURED green against the previous
   * version of this scan on the real `services/` tree.
   */
  type FanOut =
    /** The real thing. */
    | "publish"
    /** No publish at all — the mapping table is still fully spelled. */
    | "none"
    /** (a) The call, quoted in a `#` comment. */
    | "commented"
    /** (a') The call, quoted in a docstring. */
    | "docstring"
    /** (b) A comment naming a DIFFERENT topic, and no publish of it. */
    | "comment-names-foreign-topic"
    /** An unbalanced `(` in a trailing comment — the over-swallow. */
    | "unbalanced-comment"
    /** An unmatched `(` inside a STRING literal on the binding line. */
    | "bracket-in-string"
    /** An earlier, unrelated `topic = None` above the real binding. */
    | "shadowed-binding";

  const FAN_OUT_LINES: Readonly<Record<FanOut, readonly string[]>> = {
    publish: ["        publisher.publish(topic, {})"],
    none: ["        record(topic)"],
    commented: [
      "        # MONEY-9999: the fan-out moved to the ledger writer; this used to be",
      "        #   publisher.publish(topic, message)",
      "        record_only(topic, {})",
    ],
    docstring: [
      '        """Historic behaviour: publisher.publish(topic, message)."""',
      "        record_only(topic, {})",
    ],
    "comment-names-foreign-topic": [
      '        # e.g. publisher.publish("fixture-topic-foreign", payload)',
      "        record_only(topic, {})",
    ],
    "unbalanced-comment": ["        publisher.publish(topic, {})"],
    // The marker sits AFTER the binding. It can only be harvested if the
    // binding swallowed past its own line — which is exactly what a
    // string-blind bracket counter does.
    "bracket-in-string": [
      "        publisher.publish(topic, {})",
      '        audit("swallow-marker")',
    ],
    "shadowed-binding": ["        publisher.publish(topic, {})"],
  };

  /** The `topic = …` line, per variant. */
  function bindingLine(fanOut: FanOut): string {
    if (fanOut === "unbalanced-comment") {
      return '        topic = topic_for(row["cls"])  # None for OTHER (see classify.py';
    }
    if (fanOut === "bracket-in-string") {
      // A format/label string carrying an unmatched bracket. Synthetic, and
      // deliberately so: the point is that a bracket inside a STRING is a
      // character, not nesting. Counted as nesting, `depth` never returns to
      // zero and the binding swallows the rest of the module — the same
      // over-swallow the comment variant produces, from the one source
      // `pythonCodeOnly` cannot remove.
      return '        topic = topic_for(row["cls"], default="edgar (unrouted")';
    }
    return '        topic = topic_for(row["cls"])';
  }

  function fixtureTree(
    fanOut: FanOut,
    /** (c) the table entry deleted and mentioned only in a comment. */
    opts: { tableEntryCommentedOut?: boolean } = {},
  ): string {
    const root = mkdtempSync(join(tmpdir(), "topic-guard-"));
    const services = join(root, "services");
    const app = join(services, "svc", "app");
    mkdirSync(join(app, "jobs"), { recursive: true });
    writeFileSync(
      join(app, "classify.py"),
      [
        '"""Routing table. Historically B mapped to "fixture-topic-docstring"."""',
        "TOPIC_BY_PARSE_CLASS: dict[str, str] = {",
        '    "A": "fixture-topic-a",',
        ...(opts.tableEntryCommentedOut
          ? ['    # "B" used to map to "fixture-topic-b"; routing moved.']
          : ['    "B": "fixture-topic-b",']),
        "}",
        "",
        "",
        "def topic_for(parse_class: str) -> str | None:",
        "    return TOPIC_BY_PARSE_CLASS.get(parse_class)",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(app, "jobs", "detect.py"),
      [
        "from app.classify import topic_for",
        "",
        "",
        "def run(publisher, rows):",
        ...(fanOut === "shadowed-binding" ? ["    topic = None"] : []),
        "    for row in rows:",
        bindingLine(fanOut),
        ...FAN_OUT_LINES[fanOut],
        "",
      ].join("\n"),
    );
    return services;
  }

  /** Topics a fixture tree credits, and the sites it found, in one call. */
  function scanFixture(
    fanOut: FanOut,
    opts?: { tableEntryCommentedOut?: boolean },
  ): { sites: string[]; topics: string[] } {
    const services = fixtureTree(fanOut, opts);
    try {
      const sites = pythonPublishSites(services);
      return {
        sites: sites.map((s) => `publish(${s.expr})`),
        topics: [...new Set(sites.flatMap((s) => s.topics))].sort(),
      };
    } finally {
      rmSync(join(services, ".."), { recursive: true, force: true });
    }
  }

  it("[falsifiability] the resolver follows publish -> resolver -> mapping table", () => {
    const { topics } = scanFixture("publish");
    assert.ok(topics.includes("fixture-topic-a"), topics.join(", "));
    assert.ok(topics.includes("fixture-topic-b"), topics.join(", "));
  });

  it("[falsifiability] deleting the publish CALL credits nothing, though the table is untouched", () => {
    // This is the exact mutation the old guard survived: `classify.py` still
    // spells all the topics, `topic_for` is still imported and still called —
    // and nothing publishes. The scan must go empty.
    const { sites, topics } = scanFixture("none");
    assert.deepEqual(sites, [], "no publish call site should be found");
    assert.deepEqual(
      topics,
      [],
      "a topic credited here would mean the guard is reading the mapping " +
        "table rather than the publisher — the defect this file was rewritten for",
    );
  });

  it("[falsifiability] a publish quoted in a COMMENT is not a publisher", () => {
    // False green (a), measured on the real tree: replacing
    // services/us-fundamentals/app/jobs/detect.py:1292 with a `#` comment
    // quoting the same line left all five edgar-parse-* topics credited and
    // this suite at 7 pass / 0 fail, with the fan-out gone.
    const { sites, topics } = scanFixture("commented");
    assert.deepEqual(sites, [], "a `#` comment is not a call site");
    assert.deepEqual(topics, []);
  });

  it("[falsifiability] a publish quoted in a DOCSTRING is not a publisher", () => {
    const { sites, topics } = scanFixture("docstring");
    assert.deepEqual(sites, [], "a docstring is not a call site");
    assert.deepEqual(topics, []);
  });

  it("[falsifiability] a comment naming a topic credits NOTHING", () => {
    // False green (b): `# e.g. publisher.publish("stock-document-extract", …)`
    // anywhere under jobs/ credited a topic with no Python publisher at all.
    const { sites, topics } = scanFixture("comment-names-foreign-topic");
    assert.deepEqual(sites, [], "a commented example is not a call site");
    assert.ok(
      !topics.includes("fixture-topic-foreign"),
      `a comment credited ${topics.join(", ")}`,
    );
  });

  it("[falsifiability] a table entry moved into a COMMENT stops crediting its topic", () => {
    // False green (c): the resolver harvests every quoted string in the
    // resolver's body and its module constants, docstring and comments
    // included, so deleting `THIRTEENF: "edgar-parse-13f"` from classify.py and
    // mentioning it in a comment left the topic credited.
    const { sites, topics } = scanFixture("publish", {
      tableEntryCommentedOut: true,
    });
    assert.deepEqual(sites, ["publish(topic)"], "the publish itself is intact");
    assert.ok(topics.includes("fixture-topic-a"), "A is still mapped");
    assert.ok(
      !topics.includes("fixture-topic-b"),
      `B is only mentioned in a comment, yet the scan credited: ${topics.join(", ")}`,
    );
    assert.ok(
      !topics.includes("fixture-topic-docstring"),
      `a classify.py DOCSTRING credited a topic: ${topics.join(", ")}`,
    );
  });

  it("[falsifiability] an unbalanced bracket in a comment does not swallow the function", () => {
    // The over-swallow the `bindingTexts` docblock claims to have fixed, as an
    // executable check rather than a note: on the real tree this one comment
    // took `publish(topic)` from 8 resolved strings to 36. The result must be
    // IDENTICAL to the un-commented tree.
    assert.deepEqual(
      scanFixture("unbalanced-comment"),
      scanFixture("publish"),
      "a trailing comment changed what the resolver sees",
    );
  });

  it("[falsifiability] an unmatched bracket inside a STRING does not swallow the module", () => {
    // The half `pythonCodeOnly` cannot fix: a `(` inside a quoted string is a
    // character. Counting it as nesting leaves `depth` permanently positive and
    // the binding runs to end of file, which is the same over-swallow by
    // another route.
    const { sites, topics } = scanFixture("bracket-in-string");
    assert.deepEqual(sites, ["publish(topic)"]);
    assert.ok(topics.includes("fixture-topic-a"), topics.join(", "));
    assert.ok(topics.includes("fixture-topic-b"), topics.join(", "));
    assert.ok(
      !topics.includes("swallow-marker"),
      "the binding swallowed a literal from a LATER line, so a bracket " +
        `inside a string is being counted as nesting: ${topics.join(", ")}`,
    );
  });

  it("[falsifiability] an earlier binding of the same name does not blank the real one", () => {
    // `bindingText` took the FIRST `topic =` in the file regardless of scope,
    // so an unrelated `topic = None` above the loop collapsed detect.py from
    // five topics to ZERO — a false RED that reads exactly like a missing
    // publisher and points at the wrong file.
    const { topics } = scanFixture("shadowed-binding");
    assert.ok(topics.includes("fixture-topic-a"), topics.join(", "));
    assert.ok(topics.includes("fixture-topic-b"), topics.join(", "));
  });

  it("[falsifiability] a TypeScript publisher quoted in a comment credits nothing", () => {
    // The same class on the TS side. `hasCodePublisher` is a raw text match
    // over the corpus, so prose mentioning the call would credit a dead topic.
    const key = "STRATEGY_SCAN";
    const call = `getTopicName(PUBSUB_TOPICS.${key})`;
    const pattern = new RegExp(
      `getTopicName\\(\\s*PUBSUB_TOPICS\\.${key}\\s*[,)]`,
    );
    assert.ok(
      pattern.test(`const t = client.topic(${call});`),
      "the matcher must still see a real call",
    );
    for (const prose of [
      `// see ${call} for the suffixing rule`,
      `  /* ${call} */`,
      `/**\n * ${call}\n */`,
    ]) {
      assert.ok(
        !pattern.test(stripTsComments(prose)),
        `a comment survived stripTsComments and would credit ${key}: ${prose}`,
      );
    }
    // LINE before BLOCK (MONEY-1143): reversed, this `//` opens a phantom block
    // that eats the real call below it.
    assert.ok(
      pattern.test(
        stripTsComments(
          `// a block starts with /* like this\nconst t = ${call};`,
        ),
      ),
      "a `//` mentioning a block opener must not swallow the code after it",
    );
  });

  it("every Cloud Scheduler entry targets a DECLARED topic (a typo publishes into the void)", () => {
    const declared = new Set(entries.map(([, v]) => v));
    const unknown = [...scheduled].filter((t) => !declared.has(t));
    assert.deepStrictEqual(
      unknown,
      [],
      "scheduler entries whose TOPIC_BASE is not in PUBSUB_TOPICS: " +
        unknown.join(", "),
    );
  });
});

describe("MONEY-1314 — alias resolution in the publisher scan", () => {
  // The repo holds ONE topic alias, so a mutation that resolves ANY alias
  // instead of the correct one behaves identically on real input. These cases
  // supply a synthetic corpus with TWO, which is the smallest input that can
  // tell a mapping from a wildcard.
  const CORPUS = [
    "export const ALPHA_TOPIC = PUBSUB_TOPICS.ALPHA;",
    "export const BETA_TOPIC = PUBSUB_TOPICS.BETA;",
    "const t = pubsub.topic(getTopicName(ALPHA_TOPIC));",
  ].join("\n");

  it("collects every alias with its target", () => {
    const m = collectTopicAliases(CORPUS);
    assert.equal(m.get("ALPHA_TOPIC"), "ALPHA");
    assert.equal(m.get("BETA_TOPIC"), "BETA");
    assert.equal(m.size, 2);
  });

  it("resolves the alias that IS published", () => {
    const m = collectTopicAliases(CORPUS);
    assert.equal(publishesViaAlias(CORPUS, m, "ALPHA"), true);
  });

  it("[control] does NOT credit a topic whose alias is never published", () => {
    // THE case n=1 cannot express. BETA_TOPIC is declared but never handed to
    // getTopicName, so BETA has no publisher — a wildcard implementation would
    // say it does, and would then vouch for a genuinely dead topic.
    const m = collectTopicAliases(CORPUS);
    assert.equal(publishesViaAlias(CORPUS, m, "BETA"), false);
  });

  it("[control] a corpus with no aliases resolves nothing", () => {
    const m = collectTopicAliases("const x = 1;");
    assert.equal(m.size, 0);
    assert.equal(publishesViaAlias(CORPUS, m, "ALPHA"), false);
  });

  it("the real repo alias is found and resolves the parse lane's self-chain", () => {
    // STOCK_DOCUMENT_PARSE_TOPIC, published by the lane's own self-chain. That
    // is the only thing keeping the topic alive now its four crons are retired.
    assert.equal(
      TOPIC_ALIASES.get("STOCK_DOCUMENT_PARSE_TOPIC"),
      "STOCK_DOCUMENT_PARSE",
    );
  });
});

describe("MONEY-1326 — the scheduler scan reads EVERY entry's TOPIC_BASE", () => {
  // A synthetic array, so the discrimination runs on every CI pass instead of
  // on the day somebody hand-edits the real ops script. `mf_sync` below is the
  // measured mutation: it is a LEGAL Pub/Sub topic id, `IFS='|' read` takes it
  // verbatim, gcloud creates the job — and the old `[a-z0-9-]+` field could not
  // see it, so the case named "a typo publishes into the void" passed.
  const DEFS = [
    "# a comment inside the array",
    "SCHEDULER_DEFS=(",
    '    "alpha-daily|0 1 * * *|alpha-sync|{}|Alpha"',
    '    # "beta-daily|0 2 * * *|beta-sync|{}|retired, commented out"',
    '    "gamma-daily|0 3 * * *|mf_sync|{}|UNDERSCORE — a legal topic id"',
    "",
    ")",
    // OUTSIDE the array: MONITOR_DEFS is NAME|ENV|SCHEDULE|WHY, whose third
    // field is a cron. A whole-file scan with a widened field would harvest
    // `0 22 * * *` as a topic and fail the declared-topic case for it.
    "MONITOR_DEFS=(",
    '    "stock-document-extract|prod|0 22 * * *|nightly"',
    ")",
  ].join("\n");

  it("captures a topic base OUTSIDE [a-z0-9-] instead of dropping it", () => {
    const scan = scanSchedulerDefs(DEFS);
    assert.ok(
      scan.topics.has("mf_sync"),
      `an underscore topic base was dropped: [${[...scan.topics].join(", ")}]`,
    );
    assert.ok(scan.topics.has("alpha-sync"));
  });

  it("[control] stays bounded to the array — MONITOR_DEFS is not a topic list", () => {
    const scan = scanSchedulerDefs(DEFS);
    assert.deepStrictEqual([...scan.topics].sort(), ["alpha-sync", "mf_sync"]);
    assert.equal(scan.entryCount, 2, "commented-out entries are not entries");
  });

  it("[control] an unreadable entry line is REPORTED, never silently absent", () => {
    // The property the whole rewrite turns on: a mount path the scan cannot
    // parse must fail loudly. Read as "no scheduler entry", it is indefensible —
    // that is precisely how a void-publishing job passes as absent.
    const broken = ["SCHEDULER_DEFS=(", '    "no-pipes-at-all"', ")"].join(
      "\n",
    );
    const scan = scanSchedulerDefs(broken);
    assert.equal(scan.entryCount, 1);
    assert.equal(scan.topics.size, 0);
    assert.deepStrictEqual(scan.unparseable, ['"no-pipes-at-all"']);
  });

  it("[control] a missing array yields zero entries, not a silent pass", () => {
    const scan = scanSchedulerDefs("nothing to see here\n");
    assert.equal(scan.entryCount, 0);
    // entryCount 0 trips the premise floor above, so a moved array fails by
    // name instead of reporting every topic as unscheduled.
    assert.equal(scan.topics.size, 0);
  });

  it("the real script parses completely", () => {
    assert.deepStrictEqual([...schedulerScan.unparseable], []);
    assert.ok(schedulerScan.entryCount >= schedulerScan.topics.size);
  });
});
