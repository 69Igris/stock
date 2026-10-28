/**
 * The source scanner both job-outcome guards read — MONEY-1325.
 *
 * ## Why this is a module and not two copies
 *
 * `job-outcome-coverage.test.ts` asks "does this processor CALL the reporter";
 * `job-outcome-reachability.test.ts` asks "can the call actually EXECUTE". Both
 * questions are answered off the same blanked source text, and the blanker is
 * the part with the sharp edges — so it is written once. A second copy is the
 * drift this package keeps paying for (MONEY-1238's monitor list, MONEY-1250's
 * `PROD_ONLY_JOBS`).
 *
 * Not a `.test.ts`, so the workspace glob `__tests__/**\/*.test.ts` never runs
 * it as a suite. Same shape as `packages/core/__tests__/ops/test-lane-harness.ts`.
 *
 * ## The blanker had a hole, and it was the mirror of MONEY-1143
 *
 * The regex pair it replaces stripped LINE comments before BLOCK comments,
 * deliberately, so a `//` mentioning `/*` could not open a phantom block. The
 * hole was one layer over: a `/*` inside a STRING LITERAL opens one just as
 * well, and this repo has three of them —
 *
 *     document-process.ts:288   Accept: "application/pdf,text/html,*\/*"
 *     mf-portfolio-sync.ts:123  accept: "*\/*"
 *     xbrl-sync.ts:331          accept: "application/xml,text/xml,*\/*"
 *
 * — every one an HTTP `Accept` header, which is where `*\/*` lives. Each opened
 * a block comment that ran to the next `*\/` in the file, blanking real code
 * (including the string's own closing quote) on the way. Measured on the tree
 * this landed on, no `prisma.` write and no `reportJobOutcome(` call happened to
 * fall inside those three spans, so no VERDICT changed — verified by running
 * both blankers over all 115 processor files and diffing: 0 differences. That is
 * luck, not safety: the spans are ~40 lines each and the next `Accept` header
 * added above a write silently drops that file out of the scan, which is the
 * exact "a writer that silently leaves the scan" failure the coverage guard
 * exists to prevent.
 *
 * A regex pair cannot fix this, because comments-inside-strings and
 * strings-inside-comments are mutually recursive. {@link blankNonCode} is a
 * single left-to-right pass instead, which is the only thing that composes.
 */

/**
 * Blank comments, string bodies, template-literal text and regex bodies —
 * preserving every offset and newline, so a line number computed on the result
 * is the line number in the file.
 *
 * Template literals keep their `${…}` EXPRESSIONS as live code (a reporter call
 * never appears there, but a brace does, and the brace matching below is what
 * every placement verdict rests on). The interpolation walker counts ALL braces
 * inside `${…}`, not just the outer pair: `${x.toLocaleString("en-IN", { … })}`
 * has a nested object literal, and a walker that stops at the first `}` treats
 * the real closing brace as template TEXT and blanks it — which desynchronises
 * the whole file from that point. That is not hypothetical; it is
 * `login-briefing.ts:199`, and it left two processor files unbalanced.
 */
export interface BlankOptions {
  /**
   * Keep string and template-literal CONTENT, blanking only comments and regex
   * bodies.
   *
   * The coverage guard reads `reportJobOutcome({ job: "price-sync" })` literals
   * straight out of the blanked text, so blanking string bodies would empty the
   * job-id set and make its monitor comparison vacuous — a scan that finds
   * nothing reports every assertion green. It does not need brace matching, so
   * it can afford the braces a string may contain; the reachability guard is
   * the opposite on both counts.
   *
   * The phantom-comment fix survives either way: a `/*` inside a string is
   * consumed as string CONTENT by the same pass, whether or not the content is
   * then blanked.
   */
  preserveStringBodies?: boolean;
}

export function blankNonCode(src: string, opts: BlankOptions = {}): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  let i = 0;
  /**
   * The last significant token, letters accumulated — enough to tell a DIVISION
   * from the start of a REGEX literal. `a / b` after an identifier is division;
   * `.replace(/x/g)` after `(` is a literal. Getting this wrong in the
   * permissive direction only over-blanks a few characters of an arithmetic
   * expression, which no rule here reads.
   */
  let prev = "";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];

    if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && n === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j < 0 ? src.length : j + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      // Stop at a newline as well as at the quote: an UNTERMINATED quote must
      // cost one line, never the rest of the file. That is how the old blanker
      // turned one `Accept: "*\/*"` into forty blank lines.
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        j += src[j] === "\\" ? 2 : 1;
      }
      if (!opts.preserveStringBodies) blank(i + 1, j);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let interp = 0;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (interp === 0 && src[j] === "$" && src[j + 1] === "{") {
          interp = 1;
          j += 2;
          continue;
        }
        if (interp > 0) {
          // A brace inside a STRING or a COMMENT within `${…}` is TEXT, not
          // structure — and counting it is the same defect as the phantom
          // block comment this whole function exists to fix, one level in.
          // `${x ?? "{"}` left the file unbalanced from that point on, which
          // silently reports the wrong scope for every call site after it.
          //
          // Measured on the tree this landed on: the only live instance is
          // `document-process.ts:94` (`` `"${doc?.title || "Document"}"` ``),
          // whose braces happen to balance, so no verdict changed. That is
          // luck. `every processor file is brace-BALANCED after blanking`
          // catches an unbalanced one, but only because it is unbalanced — a
          // desync that cancels out is invisible to it, so the walker is fixed
          // rather than relied on to fail loudly.
          //
          // A nested template literal is deliberately NOT handled: its own
          // `${…}` braces balance, so it composes, and an unbalanced brace in
          // nested template TEXT is left to the balance case.
          const q = src[j];
          if (q === '"' || q === "'") {
            let k = j + 1;
            while (k < src.length && src[k] !== q && src[k] !== "\n") {
              k += src[k] === "\\" ? 2 : 1;
            }
            if (!opts.preserveStringBodies) blank(j + 1, k);
            j = k + 1;
            continue;
          }
          if (q === "/" && src[j + 1] === "/") {
            let k = j;
            while (k < src.length && src[k] !== "\n") k++;
            blank(j, k);
            j = k;
            continue;
          }
          if (q === "/" && src[j + 1] === "*") {
            const k = src.indexOf("*/", j + 2);
            const end = k < 0 ? src.length : k + 2;
            blank(j, end);
            j = end;
            continue;
          }
          if (q === "{") interp++;
          else if (q === "}") interp--;
          j++;
          continue;
        }
        if (src[j] === "`") break;
        if (!opts.preserveStringBodies && out[j] !== "\n") out[j] = " ";
        j++;
      }
      i = j + 1;
      prev = "`";
      continue;
    }
    if (
      c === "/" &&
      /[=(,:[!&|?{};+\-*%<>~^]$|^$|\breturn$|\btypeof$/.test(prev)
    ) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        blank(i + 1, j);
        i = j + 1;
        prev = "/";
        continue;
      }
    }
    if (!/\s/.test(c)) {
      prev = /[A-Za-z_$]/.test(c)
        ? (/[A-Za-z_$]/.test(prev.slice(-1)) ? prev : "") + c
        : c;
    }
    i++;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// brace navigation
// ---------------------------------------------------------------------------

/** The `{` matching the `}` at `close`, or -1. */
export function matchingOpen(code: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === "}") depth++;
    else if (code[i] === "{") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `}` matching the `{` at `open`. */
export function matchingClose(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** The `{` of the innermost block containing `at`, or -1 at top level. */
export function enclosingBlockOpen(code: string, at: number): number {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = code[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/**
 * The text immediately before a `{`, with balanced `{…}` groups collapsed.
 *
 * The collapse is what makes a TypeScript return type readable. A processor
 * signature is routinely
 *
 *     export async function processIndexConstituentSync(
 *       message: IndexConstituentSyncMessage,
 *     ): Promise<{ ok: boolean; results: IndexSyncResult[] }> {
 *
 * and the raw 300 characters before the body's `{` end in `]; }> `, which no
 * function-header pattern matches — so the body reads as a plain block and the
 * processor reads as having no enclosing function at all. Collapsing the type
 * object to `{}` leaves `): Promise<{}> `, which does match.
 */
export function headerBefore(code: string, open: number, budget = 400): string {
  let out = "";
  let i = open - 1;
  while (i >= 0 && out.length < budget) {
    if (code[i] === "}") {
      const m = matchingOpen(code, i);
      if (m < 0) break;
      i = m - 1;
      out = "{}" + out;
      continue;
    }
    // TWO structural stops, and both are load-bearing.
    //
    // An UNMATCHED `{` is the ENCLOSING block's brace — everything before it
    // belongs to an outer scope, not to this header. Without the stop, a small
    // function's `try {` reads back past its own signature and picks up
    // `function processThing(…): Promise<void>`, which satisfies the
    // function-header pattern — so the `try` body is mistaken for a nested
    // function and SKIPPED WHOLE, taking every report call in it out of the
    // analysis. That is a silent PASS on the shape this guard exists for, and
    // it only shows up in files short enough for the budget to reach.
    //
    // A `;` ends the previous statement. Both are impossible inside a real
    // header once `{…}` groups are collapsed and strings are blanked.
    if (code[i] === "{" || code[i] === ";") break;
    out = code[i]! + out;
    i--;
  }
  return out;
}

/** `} finally {` — the header of a finally block. */
export const FINALLY_HEADER = /\bfinally\s*$/;

/**
 * `if (…) {` / `for (…) {` / `catch (e) {` — a block that ends in `)` and is
 * NOT a function body. Listed explicitly because the function test below is
 * "ends in a parameter list", which these also satisfy.
 */
const CONTROL_HEADER =
  /\b(?:if|for|while|switch|catch|with)\s*\((?:[^()]|\([^()]*\))*\)\s*$/;
const ARROW_HEADER = /=>\s*$/;
const FUNCTION_KEYWORD_HEADER = /\bfunction\b[\s\S]*\)\s*(?::[\s\S]*)?$/;
/** Object/class method shorthand, and a typed function expression. */
const METHOD_HEADER =
  /(?:^|[;{}\s])(?:async\s+)?[A-Za-z_$][\w$]*\s*(?:<[^<>]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?::[\s\S]*)?$/;

/** Does this collapsed header open a FUNCTION BODY (rather than a plain block)? */
export function isFunctionBody(header: string): boolean {
  if (ARROW_HEADER.test(header)) return true;
  if (CONTROL_HEADER.test(header)) return false;
  if (FUNCTION_KEYWORD_HEADER.test(header)) return true;
  return METHOD_HEADER.test(header);
}

/** The name of the function a header opens, or null for an anonymous one. */
export function functionNameOf(header: string): string | null {
  const kw = header.lastIndexOf("function");
  if (kw >= 0) {
    const m = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(header.slice(kw));
    if (m) return m[1]!;
  }
  // An arrow assigned to a binding: `const emitOutcome = (r: string): void => {`.
  // Cutting at the LAST `=>` first is what makes this tractable — the fat arrow
  // contains an `=`, so a single pattern anchored on `=` either stops before the
  // binding name or runs past it. `price-sync.ts` reports through exactly this
  // shape, and leaving it anonymous drops it out of the helper fixpoint: the
  // processor then reads as reporting from a nested function it never calls.
  const arrow = header.lastIndexOf("=>");
  const beforeArrow = arrow >= 0 ? header.slice(0, arrow) : header;
  const assigned =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=[^=]*$/.exec(
      beforeArrow,
    );
  if (assigned) return assigned[1]!;
  const method =
    /(?:^|[;{}\s])(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*(?::[\s\S]*)?$/.exec(
      header,
    );
  return method ? method[1]! : null;
}

/**
 * The innermost function body (or `finally` block) containing `at`.
 *
 * Walks OUT through plain blocks — an `if`, a `for`, a bare `{}` scope — because
 * a report call three `if`s deep still belongs to the function, and a `finally`
 * found on the way out settles the question before any function does.
 */
export function enclosingScope(
  code: string,
  at: number,
): { open: number; name: string | null; inFinally: boolean } | null {
  let cursor = at;
  for (;;) {
    const open = enclosingBlockOpen(code, cursor);
    if (open < 0) return null;
    const header = headerBefore(code, open);
    if (FINALLY_HEADER.test(header)) {
      return { open, name: null, inFinally: true };
    }
    if (isFunctionBody(header)) {
      return { open, name: functionNameOf(header), inFinally: false };
    }
    cursor = open;
  }
}

/**
 * The OUTERMOST function body containing `at` — the top-level one.
 *
 * Anchoring on the innermost is what made an orphaned helper look compliant:
 * `function emitOutcome() { reportJobOutcome(…) }` judged on its own has no
 * early return and so is perfectly "guarded", while the processor that declares
 * it never calls it. The question is only ever about the JOB's control flow, so
 * the analysis has to start at the job.
 */
export function outermostFunction(
  code: string,
  at: number,
): { open: number; name: string | null } | null {
  let cursor = at;
  let outer: { open: number; name: string | null } | null = null;
  for (;;) {
    const open = enclosingBlockOpen(code, cursor);
    if (open < 0) return outer;
    const header = headerBefore(code, open);
    if (isFunctionBody(header)) outer = { open, name: functionNameOf(header) };
    cursor = open;
  }
}

/**
 * Is the function body at `open` declared with `export`?
 *
 * The one thing that separates a JOB from a promoted HELPER when neither is
 * called anywhere in the file. A processor's caller is a route in another file,
 * so "zero call sites here" is its normal state; a non-exported helper with
 * zero call sites is dead code holding the only reporter the job has.
 */
export function isExportedFunction(code: string, open: number): boolean {
  const header = headerBefore(code, open, 420);
  const kw = header.lastIndexOf("function");
  if (kw >= 0) {
    return /\bexport\s+(?:default\s+)?(?:async\s+)?\s*$/.test(
      header.slice(0, kw),
    );
  }
  // `export const processThing = async (m: Message): Promise<void> => {`
  //
  // MONEY-1325 required the literal `function` KEYWORD, so an arrow-declared
  // processor read as NOT exported. That is not a cosmetic miss: the orphan
  // branch below is `!isExportedFunction(...) && no call sites in this file`,
  // and a processor's caller is a ROUTE IN ANOTHER FILE — zero local call sites
  // is its NORMAL state. So the first `export const processX = async () => {}`
  // to land would be graded `bypassed` / `never-called`, claiming the reporter
  // can never run when it plainly does. A FALSE FAILURE on a real processor is
  // how a baseline turns into a regeneration ritual, which is the outcome this
  // file argues against at length. Zero such processors exist today; the point
  // is that the guard must not go red on the day one does.
  const arrow = header.lastIndexOf("=>");
  if (arrow < 0) return false;
  return /\bexport\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]*)?=/.test(
    header.slice(0, arrow),
  );
}

// ---------------------------------------------------------------------------
// the reporter, and where it can run
// ---------------------------------------------------------------------------

/**
 * Local names a file has bound `reportJobOutcome` to.
 *
 * MAKING A COLLABORATOR INJECTABLE IS HOW A SOURCE-TEXT GUARD IN THIS REPO GOES
 * QUIET. `corporate-actions-sync.ts` grew
 * `const report = deps?.reportOutcome ?? reportJobOutcome` and calls `report(…)`,
 * so the literal spelling stopped appearing anywhere in the file and the scan
 * silently stopped seeing a job that reports perfectly well.
 */
export function outcomeReporterNames(code: string): string[] {
  const names = ["reportJobOutcome"];
  for (const m of code.matchAll(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:[^;]*\?\?\s*)?reportJobOutcome\b/g,
  )) {
    names.push(m[1]!);
  }
  return names;
}

/**
 * Byte offsets of every `name(` CALL, ascending — declarations excluded.
 *
 * `function emitOutcome(): void {` contains the text `emitOutcome(`, and once
 * the fixpoint below promotes a helper to a reporter its own declaration starts
 * matching. Counted as a call it lands at the enclosing function's own level
 * and vouches for a path that never runs — an uncalled helper reads as fully
 * wired, which is this ticket's defect one level down.
 */
function callSites(code: string, names: readonly string[]): number[] {
  return names
    .flatMap((n) =>
      [...code.matchAll(new RegExp(`\\b${n}\\s*\\(`, "g"))].map(
        (m) => m.index!,
      ),
    )
    .filter(
      (idx) =>
        !/\bfunction\s*\*?\s*$/.test(code.slice(Math.max(0, idx - 40), idx)),
    )
    .sort((a, b) => a - b);
}

export interface Placement {
  /**
   * `finally`   a call sits in a `finally`, so EVERY exit emits — throws too.
   * `guarded`   every `return` in the reporting function is preceded by a call
   *             inside its own block, and one call precedes the fall-through
   *             exit. The house's second acceptable shape.
   * `bypassed`  at least one `return` leaves the function having emitted
   *             nothing. This is the defect.
   * `absent`    the file never calls the reporter. Handled by the COVERAGE
   *             guard, not this one.
   */
  verdict: "finally" | "guarded" | "bypassed" | "absent";
  /** The reporting function the verdict is about. */
  fn: string | null;
  /** `return`s that emit nothing, as `<fn>:return` — one entry per site. */
  unguardedReturns: string[];
  /**
   * `throw`s that emit nothing. TRACKED, NEVER FAILED — see the note in
   * `job-outcome-reachability.test.ts`. A throw is loud through four other
   * channels; a `return` is silent, and silence is the whole defect class.
   */
  unguardedThrows: string[];
}

/**
 * Where can this file's `reportJobOutcome` actually execute?
 *
 * ## The fixpoint, and why presence is not placement
 *
 * Seven processors do not call the reporter from the processor at all — they
 * call a helper (`finish`, `emitOutcome`, `reportBhavcopyOutcome`,
 * `reportMoversOutcome`, `reportXbrlSyncOutcome`, `reportOutcome`) that calls
 * it. Judged naively, every one of those helpers is "guarded": it is three lines
 * long and has no early return. That verdict says nothing at all about whether
 * the PROCESSOR reaches it, which is the only question worth asking — a helper
 * with zero call sites would pass.
 *
 * So a named function containing a call IS a reporter, and its own call sites
 * are report sites. Iterated to a fixpoint, the analysis then lands on the
 * OUTERMOST reporting function — the processor — and `return finish();` counts
 * as an emitting exit because the site lies inside the return STATEMENT.
 */
export function classifyReportPlacement(code: string): Placement {
  const aliases = outcomeReporterNames(code);
  if (callSites(code, aliases).length === 0) {
    return {
      verdict: "absent",
      fn: null,
      unguardedReturns: [],
      unguardedThrows: [],
    };
  }

  // THE FIXPOINT DECIDES NOTHING. It used to return `finally` the moment ANY
  // call site anywhere in the file sat in a `finally` — see the note on
  // `judgeAnchor` for why that is the strongest verdict handed out on the
  // weakest evidence.
  const names = new Set(aliases);
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const idx of callSites(code, [...names])) {
      const scope = enclosingScope(code, idx);
      if (scope?.name && !names.has(scope.name)) {
        names.add(scope.name);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const sites = callSites(code, [...names]);
  const anchors = new Map<number, { name: string | null; close: number }>();
  for (const idx of sites) {
    const outer = outermostFunction(code, idx);
    if (outer) {
      anchors.set(outer.open, {
        name: outer.name,
        close: matchingClose(code, outer.open),
      });
    }
  }

  // A top-level REPORTING HELPER (`reportXbrlSyncOutcome`, `reportMoversOutcome`,
  // `reportBhavcopyOutcome`) is a means, not a job: judging it answers "does
  // this three-line function return early", which nothing depends on. It is
  // recognised by being CALLED FROM another anchor, and dropped — the fixpoint
  // has already turned its call sites into report sites inside the processor,
  // so the processor is judged instead, on whether it reaches the helper.
  //
  // The test is "called by another anchor" rather than "is a reporter name",
  // because the fixpoint promotes the PROCESSOR too — every function holding a
  // site becomes a reporter, so a name test drops the job along with the helper
  // and every file reads as having nothing left to judge.
  const anchorList = [...anchors.entries()];
  const calledByAnotherAnchor = (name: string | null, open: number): boolean =>
    name !== null &&
    callSites(code, [name]).some((c) =>
      anchorList.some(([o, m]) => o !== open && c > o && c < m.close),
    );
  const jobs = anchorList.filter(
    ([open, meta]) => !calledByAnotherAnchor(meta.name, open),
  );

  // A reporting helper NOTHING calls — a reporter that can never run at all,
  // which is strictly worse than a misplaced one and reads identically from
  // the coverage guard's point of view.
  const orphan = jobs.find(
    ([open, meta]) =>
      meta.name !== null &&
      !aliases.includes(meta.name) &&
      names.has(meta.name) &&
      !isExportedFunction(code, open) &&
      callSites(code, [meta.name]).length === 0,
  );
  if (orphan) {
    return {
      verdict: "bypassed",
      fn: orphan[1].name,
      unguardedReturns: [`${orphan[1].name}:never-called`],
      unguardedThrows: [],
    };
  }
  if (jobs.length === 0) {
    return {
      verdict: "bypassed",
      fn: anchorList[0]?.[1].name ?? null,
      unguardedReturns: [
        `${anchorList[0]?.[1].name ?? "<anonymous>"}:unreachable`,
      ],
      unguardedThrows: [],
    };
  }

  // EVERY anchor is judged, and the WORST verdict is the file's.
  //
  // This used to `return` on the first `guarded` job, so in a file with two job
  // anchors the first compliant one exonerated the rest — and the variable
  // holding the fallback was called `worst` while actually holding the LAST
  // non-guarded placement, which is not the same thing and reads as if it were.
  // Latent today (no file in this tree has two job anchors) and load-bearing
  // the moment one does: a guard whose answer depends on declaration order is a
  // guard that stops guarding without changing its mind about anything.
  let worst: Placement | null = null;
  for (const [open, meta] of jobs) {
    const placement = judgeAnchor(code, open, meta.close, meta.name, sites);
    if (
      worst === null ||
      VERDICT_RANK[placement.verdict] > VERDICT_RANK[worst.verdict]
    ) {
      worst = placement;
    }
  }
  return (
    worst ?? {
      verdict: "bypassed",
      fn: null,
      unguardedReturns: ["<no enclosing function>"],
      unguardedThrows: [],
    }
  );
}

/** Weakest first. The file's verdict is its worst anchor's. */
const VERDICT_RANK: Record<Placement["verdict"], number> = {
  finally: 0,
  guarded: 1,
  absent: 2,
  bypassed: 3,
};

/**
 * One anchor's verdict — the `finally` test first, then the return analysis.
 *
 * ## Why the `finally` test is scoped, and was not
 *
 * `classifyReportPlacement` used to short-circuit to `finally` at the FIRST
 * call site found inside ANY `finally`, in ANY function, and return that as the
 * whole FILE's verdict. Two things are wrong with it and both hand out the
 * STRONGEST verdict — the one `mustBeFinally` in the reachability guard accepts
 * as proof an outage cannot recur — on the weakest evidence:
 *
 *   IT WAS NOT SCOPED TO THE JOB. A `finally` in a helper, or in a second
 *   function that is not the anchor being judged, graded the processor.
 *
 *   IT DID NOT ASK WHETHER THE `try` RUNS. A `finally` only executes if its
 *   `try` is ENTERED, so one nested inside a loop or an `if` is exactly as
 *   conditional as the branch around it:
 *
 *       for (const r of rows) {
 *         try { await one(r); } finally { reportJobOutcome({…}); }
 *       }
 *       if (rows.length === 0) return;   // emits NOTHING on an idle night
 *
 *   That graded `finally` while reintroducing MONEY-1255 exactly — the empty
 *   queue emitting no metric at all, under a `notify_no_data` monitor that
 *   cannot tell a silent job from a quiet market.
 *
 * So the `finally` verdict now requires the `try` statement to sit at THIS
 * anchor's own statement level, which is what makes entry unconditional.
 * `enclosingBlockOpen(finallyOpen)` is the block holding the whole `try`/
 * `finally` construct — the walk passes the try block's braces as a matched
 * pair — so comparing it against the anchor's body brace is the entire test.
 * Measured across the 115 processors before this landed: all 9 `finally` files
 * satisfy it, so the tightening costs no verdict today.
 */
function judgeAnchor(
  code: string,
  open: number,
  close: number,
  name: string | null,
  sites: readonly number[],
): Placement {
  for (const idx of sites) {
    if (idx <= open || idx >= close) continue;
    const scope = enclosingScope(code, idx);
    if (!scope?.inFinally) continue;
    if (enclosingBlockOpen(code, scope.open) !== open) continue;
    return {
      verdict: "finally",
      fn: name,
      unguardedReturns: [],
      unguardedThrows: [],
    };
  }
  return judgeFunction(code, open, close, name, sites);
}

/**
 * Every block `{` enclosing `at`, from the innermost out to `fnOpen` inclusive.
 *
 * The set an emitting call must land in to be certain to have run before `at`.
 */
function blockAncestors(code: string, at: number, fnOpen: number): Set<number> {
  const out = new Set<number>();
  let cursor = at;
  for (;;) {
    const open = enclosingBlockOpen(code, cursor);
    if (open < 0) break;
    out.add(open);
    if (open === fnOpen) break;
    cursor = open;
  }
  return out;
}

function judgeFunction(
  code: string,
  open: number,
  close: number,
  name: string | null,
  sites: readonly number[],
): Placement {
  const fn = name ?? "<anonymous>";
  const unguardedReturns: string[] = [];
  const unguardedThrows: string[] = [];

  /**
   * Sites at THIS function's own level — nested function bodies excluded.
   *
   * The distinction is the whole orphan-helper case. A `reportJobOutcome`
   * sitting inside a `function emitOutcome()` that nothing calls IS lexically
   * between this function's braces, so counting raw offsets would say the
   * ordinary fall-through path emits. It does not: declaring a function is not
   * running it. An own-level site is one the linear walk below actually passes
   * over, which is the same thing as one that executes.
   *
   * Blocks are NOT nesting for this purpose — a call inside an `if` runs when
   * the `if` is taken, and that is precisely what the per-branch shape relies
   * on. Only a function BODY hides a call from its enclosing scope.
   */
  const ownSites: number[] = [];
  for (let s = open + 1; s < close; ) {
    if (code[s] === "{" && isFunctionBody(headerBefore(code, s))) {
      s = matchingClose(code, s) + 1;
      continue;
    }
    const hit = sites.find((x) => x === s);
    if (hit !== undefined) ownSites.push(hit);
    s++;
  }

  let i = open + 1;
  while (i < close) {
    // Nested functions are their own control-flow problem: a `return` inside a
    // `.map(row => { … })` callback exits the callback, not the job.
    if (code[i] === "{" && isFunctionBody(headerBefore(code, i))) {
      i = matchingClose(code, i) + 1;
      continue;
    }
    let matched = false;
    for (const keyword of ["return", "throw"] as const) {
      if (
        code.startsWith(keyword, i) &&
        /\W/.test(code[i - 1] ?? " ") &&
        /\W/.test(code[i + keyword.length] ?? " ")
      ) {
        // Up to the end of the EXIT STATEMENT, not up to the keyword: the
        // house's exit-helper shape is `return finish();`, where the emitting
        // call sits after the keyword and still runs before the function ends.
        let semi = code.indexOf(";", i);
        if (semi < 0 || semi > close) semi = close;
        // DOMINANCE, not mere precedence. A site dominates this exit when it
        // lies in a block that ENCLOSES the exit (or in the exit's own block)
        // and comes before it — which is what makes it certain to have run.
        //
        // Precedence alone is unsound in one direction and dominance-by-own-
        // block alone is imprecise in the other:
        //
        //   if (a) { report(…); }        does NOT cover the return — the branch
        //   if (rows.length === 0) return;   may not have been taken
        //
        //   report(…);                   DOES cover the throw — it is at
        //   if (allFailed) throw new Error(…);   function level and already ran
        //
        // The second is `corporate-actions-sync`'s total-failure throw, which a
        // block-scoped test reports as silent when it is not.
        const ancestors = blockAncestors(code, i, open);
        const emits = ownSites.some(
          (s) => s < semi && ancestors.has(enclosingBlockOpen(code, s)),
        );
        if (!emits)
          (keyword === "return" ? unguardedReturns : unguardedThrows).push(
            `${fn}:${keyword}`,
          );
        i += keyword.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }

  // The implicit fall-through exit. A function whose only call sites are inside
  // `if` blocks — or inside a helper nobody calls — emits nothing on the
  // ordinary path, which for most of these jobs is every night.
  const fallThroughEmits = ownSites.length > 0;
  if (!fallThroughEmits) unguardedReturns.push(`${fn}:fall-through`);

  return {
    verdict: unguardedReturns.length === 0 ? "guarded" : "bypassed",
    fn: name,
    unguardedReturns,
    unguardedThrows,
  };
}
