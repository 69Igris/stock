/**
 * MONEY-979 — `schema.prisma` and the Python writers must describe ONE shape.
 *
 * `services/us-fundamentals/` writes eleven `us_*` collections through pymongo.
 * There is NO ORM between the two sides: the physical document key is whatever
 * the Python row model spelled, and Prisma reads whatever key it declared. A
 * field spelled `fiscal_year_end` in Python and `fiscalYearEnd` in Prisma
 * raises nothing anywhere — the writer writes, the reader reads null, forever.
 *
 * The two drift in two directions and NEITHER IS LOUD:
 *
 *   Prisma has a field Python does not
 *     -> a column that is ALWAYS ABSENT. On Mongo absent is not null, so
 *        `{f: null}` and `{f: {not: null}}` BOTH return zero rows — a filter
 *        that looks exhaustive and selects nothing. That one confusion has now
 *        produced MONEY-1050, MONEY-1234, MONEY-1235 and MONEY-1236.
 *   Python has a field Prisma does not
 *     -> an undeclared attribute with no type and no index. It works perfectly
 *        until the first query that needs the index, and nothing names it.
 *
 * WHY THIS READS A COMMITTED FILE RATHER THAN RUNNING PYTHON.
 * `services/us-fundamentals/tests/_schema_snapshot.json` is emitted by
 * `tests/test_store_models.py` on every pytest run and committed. The Python
 * suite compares the LIVE models against this schema; this file compares the
 * COMMITTED snapshot, so the guard also runs in the TypeScript build, in CI's
 * `yarn test`, and on any machine with no interpreter and no service deps
 * installed. `services/` sits outside the Yarn workspace globs on purpose, so
 * importing it from here is not an option.
 *
 * That choice creates one failure mode of its own, and the last two cases here
 * exist for it: a generated file that is READ but never REGENERATED is a
 * contract that rots in place while every assertion above it stays green. So
 * the snapshot is also checked against the model registry actually declared in
 * `models.py` — parsed as TEXT, never executed.
 *
 * `id` IS DELIBERATELY NOT COMPARED. Prisma declares it
 * `@id @default(auto()) @map("_id") @db.ObjectId`: the physical key is `_id`
 * and MongoDB owns it. Nothing in Python may write it, so its absence from the
 * Python side is the contract rather than a violation of it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved from this file, not from `process.cwd()`, so the runner's working
 * directory cannot turn a path into a silent miss. */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..");

const SCHEMA = join(ROOT, "packages", "database", "prisma", "schema.prisma");
const SERVICE = join(ROOT, "services", "us-fundamentals");
const SNAPSHOT = join(SERVICE, "tests", "_schema_snapshot.json");
const MODELS_PY = join(SERVICE, "app", "store", "models.py");
const COLLECTIONS_PY = join(SERVICE, "app", "store", "collections.py");

/**
 * The comment that opens the block. Everything after it is MONEY-979's; the
 * `us_*` models ABOVE it (`us_instruments`, `us_fund_nav`,
 * `us_corporate_actions`, `us_stock_news`) are Tiingo's and are not written by
 * this service — matching on the `us_` prefix instead would pull four foreign
 * models into the comparison and report them all as missing from Python.
 */
const BLOCK_MARKER = "US FUNDAMENTALS — SEC EDGAR (MONEY-979)";

/**
 * The eleven, named. A count alone is not a premise: a regex that matched the
 * wrong eleven things would satisfy `length === 11` and make everything below
 * it vacuous.
 */
const EXPECTED_MODELS: readonly string[] = [
  "UsBeneficialOwnership",
  "UsCompanyFact",
  "UsCusipMap",
  "UsEdgarCursor",
  "UsFiler",
  "UsFiling",
  "UsFilingDocument",
  "UsFundamentals",
  "UsInsiderTransaction",
  "UsThirteenFFiling",
  "UsThirteenFHolding",
];

/**
 * Prisma fields the Python side must NOT carry, spelled as they are STORED.
 *
 * `_id`, not `id`: the comparison below runs on physical keys, because that is
 * the only name both sides can be said to agree or disagree about. `id
 * @map("_id")` is the one declared/physical split in the block today.
 */
const PRISMA_OWNED_FIELDS = new Set(["_id"]);

/** The smallest model here declares 11 columns; anything under this is a broken
 * parse rather than a small table. */
const MIN_FIELDS = 5;

const SNAPSHOT_REMEDY =
  "It is GENERATED, not hand-written: services/us-fundamentals/tests/" +
  "test_store_models.py emits it on every pytest run. Regenerate it with " +
  "`yarn test:python` from the repo root and commit the result. Do not " +
  "delete this check and do not write the file by hand — a missing contract " +
  "file has to FAIL, not skip, or the parity guard silently stops guarding.";

const TWELFTH_MODEL_REMEDY =
  "Adding or removing a model here is not a one-file change. All five have to " +
  "move together: (1) the model in packages/database/prisma/schema.prisma, " +
  "(2) the row model in services/us-fundamentals/app/store/models.py AND its " +
  "entry in that file's MODELS registry, (3) its @@map in " +
  "services/us-fundamentals/app/store/collections.py, (4) the regenerated " +
  "snapshot (`yarn test:python`), and (5) REFERENCE_COLLECTIONS in " +
  "scripts/ops/sync-prod-to-qa.sh — or QA_DIRECT in " +
  "prod-only-sync-coverage.test.ts, with a written reason. Then update " +
  "EXPECTED_MODELS here.";

/** `String?` -> `{base:"String", optional:true, list:false}`. */
interface PrismaFieldType {
  readonly base: string;
  readonly optional: boolean;
  readonly list: boolean;
  /** The name as declared in schema.prisma. */
  readonly declared: string;
  /**
   * The key actually stored in MongoDB: the field-level `@map("…")` when there
   * is one, otherwise the declared name.
   *
   * This is the ONLY name that can be compared to the Python side. Prisma reads
   * and writes the mapped key; pymongo writes whatever the row model spelled;
   * the declared name exists only inside `schema.prisma`. A parser that records
   * the declared name and discards `@map` therefore compares a name that is not
   * in the document against a name that is — which is precisely the invisible
   * drift this file's header names as its reason to exist. `@map` appears 11
   * times in the block today (all `id -> _id`), so the defect is latent, and
   * the first `@map("fiscal_year_end")` anyone adds would pass silently.
   */
  readonly physical: string;
  /** The token as written, for error messages. */
  readonly token: string;
}

interface PrismaModel {
  /** Names as DECLARED, for the `id` premise and for error messages. */
  readonly fields: ReadonlySet<string>;
  /** Names as STORED. This is what the Python side is compared against. */
  readonly physicalFields: ReadonlySet<string>;
  /** PHYSICAL field name -> its declared type. Same keys as `physicalFields`. */
  readonly types: ReadonlyMap<string, PrismaFieldType>;
  /** The `@@map` name, i.e. the physical MongoDB collection. */
  readonly collection: string | null;
}

interface PrismaBlock {
  readonly models: ReadonlyMap<string, PrismaModel>;
  /** Lines inside a model body that are neither comment, block attribute, nor
   * a recognisable field declaration. Must always be empty — see the case. */
  readonly unparsed: readonly string[];
}

function readOrFail(path: string, remedy: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    assert.fail(`${path} is missing or unreadable. ${remedy}`);
  }
}

function parsePrismaBlock(schema: string): PrismaBlock {
  const at = schema.indexOf(BLOCK_MARKER);
  assert.notEqual(
    at,
    -1,
    `schema.prisma no longer contains the marker "${BLOCK_MARKER}". This ` +
      "test slices the file at that comment to scope itself to MONEY-979's " +
      "models. If the block moved or was retitled, update BLOCK_MARKER — " +
      "matching on the `us_` prefix instead would sweep in Tiingo's four " +
      "unrelated models.",
  );

  const models = new Map<string, PrismaModel>();
  const unparsed: string[] = [];

  for (const match of schema
    .slice(at)
    .matchAll(/^model (\w+) \{$([\s\S]*?)^\}$/gm)) {
    const name = match[1]!;
    const fields = new Set<string>();
    const physicalFields = new Set<string>();
    const types = new Map<string, PrismaFieldType>();
    let collection: string | null = null;

    for (const raw of match[2]!.split("\n")) {
      const line = raw.trim();
      // `///` doc comments start with `//` too.
      if (line === "" || line.startsWith("//")) continue;
      if (line.startsWith("@@")) {
        const mapped = /^@@map\("([a-z0-9_]+)"\)/.exec(line);
        if (mapped) collection = mapped[1]!;
        continue;
      }
      const field = /^(\w+)\s+(\S+)/.exec(line);
      if (field) {
        const token = field[2]!;
        const declared = field[1]!;
        // `@map("…")` renames the STORED key. Anything after `//` on the line
        // is a doc comment and must not be searched for one.
        const code = line.split("//")[0]!;
        const physical = /@map\("([^"]+)"\)/.exec(code)?.[1] ?? declared;
        fields.add(declared);
        physicalFields.add(physical);
        types.set(physical, {
          base: token.replace(/[?\[\]]/g, ""),
          optional: token.endsWith("?"),
          list: token.includes("[]"),
          declared,
          physical,
          token,
        });
      } else unparsed.push(`${name}: ${line}`);
    }

    models.set(name, { fields, physicalFields, types, collection });
  }

  return { models, unparsed };
}

/* ─────────────────────────────────────────────────────────────────────────
   The Python side's TYPES — parsed from models.py as text
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `sic: str | None = None` -> `{base:"str", optional:true, list:false}`.
 *
 * WHY THIS READS `models.py` AND NOT THE SNAPSHOT. The committed snapshot is
 * `{model: [fieldName, ...]}` — names only, by construction, so it cannot
 * answer a question about types at all. Regenerating it with types would mean
 * editing `services/`, and the snapshot's real job (proving the LIVE pydantic
 * models were introspected rather than hand-transcribed) is unchanged. So names
 * keep coming from the snapshot, types come from the committed source text, and
 * the first case below asserts the two agree on the field set — otherwise a
 * models.py parse that silently missed a class would narrow this comparison to
 * nothing while every assertion stayed green.
 */
interface PyFieldType {
  readonly base: string;
  readonly optional: boolean;
  readonly list: boolean;
  /** The annotation as written, for error messages. */
  readonly annotation: string;
}

/**
 * Everything on a Python line that is CODE — the first `#` outside a string
 * literal ends it.
 *
 * A trailing comment is the single most ordinary edit anyone will ever make to
 * `models.py`, whose siblings are dense with prose, and before this the parser
 * fed the comment straight into the type. Measured, all three wrong, all three
 * silent because the field SET is unchanged and only the recorded TYPE is:
 *
 *   `str | None  # SEC spells share classes with a slash` -> optional FALSE
 *   `Optional[str]  # trailing note`                      -> base "Optional"
 *   `Annotated[str, Field(max_length=10)] = None`         -> base "Annotated"
 *
 * The first is the dangerous one: a nullable Python field recorded as REQUIRED
 * is exactly the case "a field Prisma declares REQUIRED is never one Python may
 * write as None" exists to catch, so a comment disables that check for the
 * field it is attached to.
 *
 * The `#` is found by walking rather than by regex because `sep: str = "#"` is
 * a legal default and cutting there would truncate the line.
 */
function stripPyLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/**
 * Index of the first `text[i] === sep` at BRACKET DEPTH ZERO, or -1.
 *
 * `Annotated[str, Field(max_length=10)] = None` is why: the annotation itself
 * legally contains `=` and `,`, so splitting on the first occurrence anywhere
 * cuts the type in half. The old `[^=]+?` did exactly that and recorded
 * `Annotated[str, Field(max_length` as the annotation.
 */
function indexOfTopLevel(text: string, sep: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && text.startsWith(sep, i)) {
      // `=` must not match `==`, `<=`, `>=`, `!=` — none of which can open a
      // default, and all of which would cut the annotation at the wrong place.
      if (
        sep === "=" &&
        (text[i + 1] === "=" || /[=!<>+\-*/%&|^]/.test(text[i - 1] ?? ""))
      ) {
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** Split at top-level occurrences of `sep`, brackets and strings respected. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let rest = text;
  for (;;) {
    const at = indexOfTopLevel(rest, sep);
    if (at === -1) break;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + sep.length);
  }
  parts.push(rest);
  return parts.map((p) => p.trim());
}

/** `(None)` -> `None`. Redundant parens are legal and carry no meaning. */
function unwrapParens(text: string): string {
  let out = text.trim();
  while (/^\(.*\)$/s.test(out)) {
    const inner = out.slice(1, -1);
    // Only strip when the pair actually wraps the whole thing: `(a) | (b)`
    // opens and closes twice and must be left alone.
    if (indexOfTopLevel(inner, ")") !== -1) break;
    out = inner.trim();
  }
  return out;
}

/**
 * `sic: str | None` -> `{base:"str", optional:true, list:false}`.
 *
 * `defaultExpr` is the right-hand side when the field declares one. A default
 * of `None` makes the field optional NO MATTER what the annotation says: it is
 * a value the writer can hold, and `to_doc()` OMITS a None, so `x: str = None`
 * produces a document with the key missing exactly as `x: str | None = None`
 * does. Recording it as REQUIRED is the same false green in a shorter spelling.
 */
function parsePyAnnotation(
  annotation: string,
  defaultExpr?: string | null,
): PyFieldType {
  const written = stripPyLineComment(annotation).trim();
  let rest = unwrapParens(written);
  let optional =
    defaultExpr !== undefined &&
    defaultExpr !== null &&
    unwrapParens(stripPyLineComment(defaultExpr)) === "None";

  // `Annotated[X, ...]` carries metadata, not a type: the type is X.
  for (;;) {
    const ann = /^Annotated\[([\s\S]+)\]$/.exec(rest);
    if (!ann) break;
    rest = splitTopLevel(ann[1]!, ",")[0] ?? "";
    rest = unwrapParens(rest);
  }

  // `X | None`, `None | X`, `Optional[X]`. Split at top level so a `|` inside
  // `Literal["a|b"]` or a nested generic does not tear the annotation apart,
  // and unwrap each arm so `str | (None)` is still a None.
  const union = splitTopLevel(rest, "|").map(unwrapParens);
  if (union.length > 1 && union.includes("None")) {
    optional = true;
    rest = union.filter((p) => p !== "None").join(" | ");
  }
  const opt = /^Optional\[([\s\S]+)\]$/.exec(rest);
  if (opt) {
    optional = true;
    rest = unwrapParens(opt[1]!);
  }
  let list = false;
  const listed = /^(?:list|List|Sequence)\[([\s\S]+)\]$/.exec(rest);
  if (listed) {
    list = true;
    rest = unwrapParens(listed[1]!);
  }
  const base = /^([A-Za-z_]\w*)/.exec(rest)?.[1] ?? rest;
  return { base, optional, list, annotation: written };
}

/** `{RowClassName: {field: PyFieldType}}`, parsed from `models.py` text. */
function parseRowFieldTypes(
  src: string,
): Map<string, Map<string, PyFieldType>> {
  const out = new Map<string, Map<string, PyFieldType>>();
  const lines = src.split("\n");
  let current: Map<string, PyFieldType> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opened = /^class (\w+)\(Row\):/.exec(line);
    if (opened) {
      current = new Map();
      out.set(opened[1]!, current);
      continue;
    }
    // A class body ends at the next line that begins in column 0.
    if (current && line !== "" && !/^[ \t]/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;

    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Docstrings: skip to the closing delimiter so their prose is never parsed
    // as a field. A one-line docstring closes on the same line.
    const quote = /^("""|''')/.exec(trimmed);
    if (quote) {
      if (!(trimmed.length > 3 && trimmed.endsWith(quote[1]!))) {
        i++;
        while (i < lines.length && !lines[i]!.includes(quote[1]!)) i++;
      }
      continue;
    }

    // `name: annotation` or `name: annotation = default`.
    //
    // The comment this replaces said "the annotation never contains `=`", and
    // `Annotated[str, Field(max_length=10)]` is the counter-example — a normal
    // pydantic constraint. The split is therefore at the first `=` at BRACKET
    // DEPTH ZERO, not at the first `=` anywhere.
    const code = stripPyLineComment(trimmed).trim();
    const head = /^([A-Za-z_]\w*)\s*:\s*/.exec(code);
    if (!head) continue;
    const body = code.slice(head[0].length);
    const eq = indexOfTopLevel(body, "=");
    const annotation = (eq === -1 ? body : body.slice(0, eq)).trim();
    const defaultExpr = eq === -1 ? null : body.slice(eq + 1).trim();
    if (annotation !== "") {
      current.set(head[1]!, parsePyAnnotation(annotation, defaultExpr));
    }
  }
  return out;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** `{PrismaModel: [field, ...]}` as the Python test emits it. */
function readSnapshot(): Map<string, Set<string>> {
  const raw = readOrFail(SNAPSHOT, SNAPSHOT_REMEDY);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    assert.fail(
      `${SNAPSHOT} is not valid JSON (${String(err)}). ${SNAPSHOT_REMEDY}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    assert.fail(
      `${SNAPSHOT} is not a {model: [field, ...]} object. ${SNAPSHOT_REMEDY}`,
    );
  }

  const out = new Map<string, Set<string>>();
  for (const [name, fields] of Object.entries(parsed)) {
    if (!isStringArray(fields)) {
      assert.fail(
        `${SNAPSHOT} entry ${name} is not an array of field-name strings. ` +
          SNAPSHOT_REMEDY,
      );
    }
    out.set(name, new Set(fields));
  }
  return out;
}

/** `class UsFilerRow(Row):` -> `UsFilerRow`. Parsed as text; Python is never run. */
function parseRowClasses(src: string): string[] {
  return [...src.matchAll(/^class (\w+)\(Row\):/gm)].map((m) => m[1]!);
}

/** The `MODELS: dict[str, type[Row]]` registry: Prisma name -> row class. */
function parseModelsRegistry(
  src: string,
): Array<{ prisma: string; rowClass: string }> {
  const start = src.indexOf("MODELS: dict[str, type[Row]] = {");
  if (start === -1) return [];
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/"(\w+)"\s*:\s*(\w+Row)\s*,/g)].map((m) => ({
    prisma: m[1]!,
    rowClass: m[2]!,
  }));
}

/** The `COLLECTIONS` literal: logical name -> physical collection. */
function parseCollections(
  src: string,
): Array<{ logical: string; physical: string }> {
  const start = src.indexOf("COLLECTIONS: dict[str, str] = {");
  if (start === -1) return [];
  const end = src.indexOf("\n}", start);
  const body = src.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/"([a-z0-9_]+)"\s*:\s*"([a-z0-9_]+)"/g)].map(
    (m) => ({
      logical: m[1]!,
      physical: m[2]!,
    }),
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   `UsFiling.status`'s VOCABULARY — MONEY-1303

   Everything above compares FIELDS and TYPES. `status` is a plain Prisma
   `String`, so its permitted VALUES are declared only in prose — a `///`
   comment on the Prisma side, the `STATUS_*` constants on the Python side — and
   until MONEY-1303 nothing compared the two.

   That gap is not cosmetic. The vocabulary is what every reader keys on:
   `{status: "DETECTED"}` is how a backed-up parse queue is measured, and the
   comment is what the next person writing such a query reads. A value the
   writer emits and the schema does not name is a population no reader knows to
   ask about; a value the schema names and the writer never emits is a query
   that returns zero forever and reads as "nothing to do".

   Not a Prisma `enum`, deliberately — the WRITER is pymongo, and Prisma
   validates nothing on read, so an enum would check the half that does not
   write. This comparison checks the half that does.
   ──────────────────────────────────────────────────────────────────────── */

/** Every `STATUS_… = "…"` constant declared at module scope in models.py. */
function pythonStatusVocabulary(modelsPy: string): string[] {
  return [...modelsPy.matchAll(/^STATUS_\w+ = "([A-Z_]+)"$/gm)].map(
    (m) => m[1]!,
  );
}

/**
 * The `A | B | C.` enumeration opening `status`'s doc comment in schema.prisma.
 *
 * Read from the comment block IMMEDIATELY ABOVE the field rather than from
 * anywhere in the model, and stopped at the first blank `///` line, so the
 * prose underneath — which names individual statuses while explaining them —
 * cannot leak tokens into the vocabulary and make the comparison pass on words.
 */
function prismaStatusVocabulary(schema: string): string[] {
  const model = /^model UsFiling \{$([\s\S]*?)^\}$/m.exec(schema)?.[1];
  assert.ok(model, "schema.prisma no longer declares `model UsFiling`");

  const lines = model.split("\n").map((l) => l.trim());
  const field = lines.findIndex((l) => /^status\s+String\b/.test(l));
  assert.notEqual(field, -1, "`UsFiling.status` is no longer declared");

  const comment: string[] = [];
  for (let i = field - 1; i >= 0 && lines[i]!.startsWith("///"); i--) {
    comment.unshift(lines[i]!.replace(/^\/\/\/\s?/, ""));
  }
  const blank = comment.findIndex((l) => l.trim() === "");
  const heading = (blank === -1 ? comment : comment.slice(0, blank)).join(" ");

  return heading
    .replace(/\.\s*$/, "")
    .split("|")
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

describe("US fundamentals schema parity — Prisma vs the Python writers (MONEY-979)", () => {
  // ── Premise ───────────────────────────────────────────────────────────────
  //
  // A parse that silently yields nothing makes every comparison below it a
  // comparison of two empty sets. That is the most-repeated test failure in
  // this repo, so the reachability of the data comes first.

  it("the MONEY-979 block parses to exactly the eleven declared models", () => {
    const { models } = parsePrismaBlock(readOrFail(SCHEMA, ""));
    assert.deepEqual(
      [...models.keys()].sort(),
      [...EXPECTED_MODELS].sort(),
      "the MONEY-979 block in schema.prisma no longer declares the eleven " +
        `models this test expects (parsed ${models.size}). ` +
        TWELFTH_MODEL_REMEDY,
    );
  });

  it("every line inside those models parses as a comment, an attribute or a field", () => {
    const { unparsed } = parsePrismaBlock(readOrFail(SCHEMA, ""));
    assert.deepEqual(
      unparsed,
      [],
      "the field parser no longer accounts for every line in the block. This " +
        "is not cosmetic: a line the parser drops disappears from the PRISMA " +
        "side, and the field comparison below then reports it as a field " +
        "'Python writes and Prisma does not declare' — pointing at the wrong " +
        "file and the wrong fix. Update the regex in this test; do not delete " +
        "the case.\n  " +
        unparsed.join("\n  "),
    );
  });

  it("every model declares a non-trivial field set including the Mongo-owned `id`", () => {
    const { models } = parsePrismaBlock(readOrFail(SCHEMA, ""));
    const problems: string[] = [];

    for (const [name, model] of [...models].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (model.fields.size < MIN_FIELDS) {
        problems.push(
          `${name}: parsed only ${model.fields.size} fields (expected >= ` +
            `${MIN_FIELDS}) — the parse is broken, not the model`,
        );
      }
      if (!model.fields.has("id")) {
        problems.push(
          `${name}: does not declare \`id String @id @map("_id")\`. Every ` +
            "model in this block must, and it is the ONE field the Python " +
            "writers deliberately omit — MongoDB owns `_id`. A model without " +
            "it means the exemption below is hiding a real missing column.",
        );
      }
    }

    assert.deepEqual(problems, [], problems.join("\n  "));
  });

  it("the committed Python snapshot exists and covers all eleven models", () => {
    const snapshot = readSnapshot();
    assert.deepEqual(
      [...snapshot.keys()].sort(),
      [...EXPECTED_MODELS].sort(),
      `${SNAPSHOT} does not name the eleven models this test expects ` +
        `(found ${snapshot.size}). ${SNAPSHOT_REMEDY}`,
    );

    const thin = [...snapshot]
      .filter(([, fields]) => fields.size < MIN_FIELDS)
      .map(([name, fields]) => `${name}: ${fields.size} fields`);
    assert.deepEqual(
      thin,
      [],
      `${SNAPSHOT} has models with almost no fields, which would let the ` +
        `comparison below pass on nothing. ${SNAPSHOT_REMEDY}\n  ` +
        thin.join("\n  "),
    );
  });

  // ── The parity itself ─────────────────────────────────────────────────────

  it("every model's field set matches Prisma exactly, in both directions", () => {
    const { models } = parsePrismaBlock(readOrFail(SCHEMA, ""));
    const snapshot = readSnapshot();
    const problems: string[] = [];

    const names = [...new Set([...models.keys(), ...snapshot.keys()])].sort();

    for (const name of names) {
      const declared = models.get(name);
      const written = snapshot.get(name);

      if (!declared) {
        problems.push(
          `${name}: in the Python snapshot but NOT declared in schema.prisma ` +
            "— an entire collection with no schema and no indexes",
        );
        continue;
      }
      if (!written) {
        problems.push(
          `${name}: declared in schema.prisma but absent from the Python ` +
            "snapshot — either no writer produces it, or the snapshot is " +
            "stale (`yarn test:python`)",
        );
        continue;
      }

      // PHYSICAL names on both sides. Python writes the stored key; Prisma
      // stores the `@map` name when there is one. Comparing DECLARED names
      // would compare something that is not in the document.
      const label = (physical: string): string => {
        const t = declared.types.get(physical);
        return t && t.declared !== physical
          ? `${physical} (declared ${t.declared})`
          : physical;
      };
      const prismaOnly = [...declared.physicalFields]
        .filter((f) => !PRISMA_OWNED_FIELDS.has(f) && !written.has(f))
        .sort()
        .map(label);
      const pythonOnly = [...written]
        .filter((f) => !declared.physicalFields.has(f))
        .sort();

      if (prismaOnly.length > 0) {
        problems.push(
          `${name}: declared in Prisma, never written by Python -> columns ` +
            `that are ALWAYS ABSENT (not null — absent, so neither ` +
            `{f: null} nor {f: {not: null}} finds them): ` +
            prismaOnly.join(", "),
        );
      }
      if (pythonOnly.length > 0) {
        problems.push(
          `${name}: written by Python, not declared in Prisma -> undeclared ` +
            "attributes with no type and no index: " +
            pythonOnly.join(", "),
        );
      }
    }

    assert.deepEqual(
      problems,
      [],
      "packages/database/prisma/schema.prisma and " +
        "services/us-fundamentals/app/store/models.py disagree about the " +
        "stored document. Nothing at runtime will tell you: pymongo writes " +
        "the key the Python model spelled and Prisma reads the key it " +
        "declared, so the field is simply always null. Fix whichever side is " +
        "wrong, then re-run `yarn test:python` to regenerate the snapshot.\n  " +
        problems.join("\n  "),
    );
  });

  /* ── Types and nullability ────────────────────────────────────────────────
   *
   * NAMES ARE NOT THE CONTRACT, only half of it. The cases above prove both
   * sides spell the same keys; a writer emitting a string into an `Int`, or
   * omitting a field Prisma declares required, agrees with every one of them
   * and still breaks the read.
   *
   * ## WHAT THIS SECTION DOES NOT COVER — stated, not implied
   *
   *   - **`Json` is not narrowed.** Prisma's `Json` cell accepts any BSON
   *     value, scalar or array, so `Json` vs `Json[]` is not a read failure.
   *     It is a real inconsistency and it exists today:
   *     `UsFundamentals.asReported` is declared `Json` while the writer emits
   *     `list[dict[str, Any]]`, whereas the two structurally identical fields
   *     `UsFiler.formerNames` and `UsCompanyFact.values` are declared `Json[]`.
   *     Named here rather than enforced, because narrowing it would fail on a
   *     difference that costs nothing and neither file is this test's to edit.
   *   - **Numeric WIDTH.** BSON int32 vs int64 vs double is not visible in
   *     either declaration.
   *   - **Value domains.** `statementType` is `String` and `str`; that it must
   *     be one of INCOME / BALANCE_SHEET / CASH_FLOW is enforced nowhere here.
   *   - **Runtime coercion.** `to_doc()`'s `date` -> midnight-UTC widening is
   *     read as a fact about the annotation, not verified by executing it. The
   *     Python suite owns that.
   *   - **Defaults.** A pydantic default and a Prisma `@default` may disagree;
   *     only the writer's is ever stored, so the comparison would be noise.
   */

  /** Prisma scalar -> the Python annotations that produce a compatible BSON. */
  const TYPE_COMPAT: Readonly<Record<string, readonly string[]>> = {
    String: ["str"],
    Int: ["int"],
    Float: ["float"],
    Boolean: ["bool"],
    // pymongo cannot encode `datetime.date` at all; `to_doc()` widens it to
    // midnight UTC, so both annotations land as a BSON Date.
    DateTime: ["datetime", "date"],
    // See "does not cover" above.
    Json: ["dict", "list", "Any", "str", "int", "float", "bool"],
  };

  it("models.py parses to the SAME field set the committed snapshot names", () => {
    // The premise for the two cases below. This file's whole method is reading
    // committed text, and a text parser that quietly matched fewer fields would
    // make a type comparison over the survivors pass on almost nothing.
    const parsed = parseRowFieldTypes(readOrFail(MODELS_PY, SNAPSHOT_REMEDY));
    const registry = parseModelsRegistry(readOrFail(MODELS_PY, ""));
    const snapshot = readSnapshot();
    const problems: string[] = [];

    for (const { prisma: prismaName, rowClass } of registry) {
      const fields = parsed.get(rowClass);
      const written = snapshot.get(prismaName);
      if (!fields) {
        problems.push(`${rowClass}: no field block parsed out of models.py`);
        continue;
      }
      if (!written) continue; // already reported by the snapshot cases above
      const missing = [...written].filter((f) => !fields.has(f)).sort();
      const extra = [...fields.keys()].filter((f) => !written.has(f)).sort();
      if (missing.length > 0) {
        problems.push(
          `${rowClass}: the snapshot names fields the models.py text parse ` +
            `did not find (${missing.join(", ")}) — the parser is broken, ` +
            "not the model",
        );
      }
      if (extra.length > 0) {
        problems.push(
          `${rowClass}: the text parse found fields the snapshot does not ` +
            `name (${extra.join(", ")}) — either the snapshot is stale ` +
            "(`yarn test:python`) or the parser is matching prose",
        );
      }
    }
    assert.deepEqual(problems, [], problems.join("\n  "));
    assert.equal(
      registry.length,
      EXPECTED_MODELS.length,
      `the MODELS registry names ${registry.length} row classes, expected ` +
        `${EXPECTED_MODELS.length}. ${TWELFTH_MODEL_REMEDY}`,
    );
  });

  /**
   * The two comparisons below are PURE functions of (schema text, models text)
   * so the falsifiability block at the bottom can drive them with synthetic
   * input. `models.py` declares none of the shapes those cases cover today —
   * every one of them is latent, and a latent defect with no executable case is
   * a comment.
   */
  function typeProblems(schemaSrc: string, modelsSrc: string): string[] {
    const { models } = parsePrismaBlock(schemaSrc);
    const parsed = parseRowFieldTypes(modelsSrc);
    const registry = parseModelsRegistry(modelsSrc);
    const problems: string[] = [];

    for (const { prisma: prismaName, rowClass } of registry) {
      const declared = models.get(prismaName);
      const written = parsed.get(rowClass);
      if (!declared || !written) continue;

      for (const [field, py] of written) {
        const col = declared.types.get(field);
        if (!col) continue; // a name mismatch; reported by the case above

        const allowed = TYPE_COMPAT[col.base];
        if (!allowed) {
          problems.push(
            `${prismaName}.${field}: Prisma declares \`${col.token}\`, a type ` +
              "this test has no mapping for. Add it to TYPE_COMPAT with the " +
              "Python annotations that produce a compatible BSON value — do " +
              "not delete the case.",
          );
          continue;
        }
        if (!allowed.includes(py.base)) {
          problems.push(
            `${prismaName}.${field}: Prisma \`${col.token}\` vs Python ` +
              `\`${py.annotation}\`. pymongo writes what the annotation says ` +
              "and Prisma decodes what the column says; a mismatch is a " +
              "read-time conversion error on rows that were written " +
              "perfectly happily.",
          );
          continue;
        }
        // `Json` is exempt in ONE direction only, and the asymmetry is the
        // point. A scalar `Json` cell genuinely holds either shape, which is
        // the documented exemption above (`UsFundamentals.asReported` is `Json`
        // against `list[dict]`). A `Json[]` COLUMN is not a scalar cell: it is
        // an array, and a writer that puts a scalar in it is a mismatch that
        // the blanket exemption waved straight through — `formerNames: int`
        // against `Json[]` passed every case in this file.
        const listMismatch = col.list
          ? !py.list
          : col.base !== "Json" && py.list;
        if (listMismatch) {
          problems.push(
            `${prismaName}.${field}: Prisma \`${col.token}\` vs Python ` +
              `\`${py.annotation}\` — one is a LIST and the other is not.`,
          );
        }
      }
    }
    return problems;
  }

  it("every field's TYPE is one Prisma can read from what Python writes", () => {
    const problems = typeProblems(
      readOrFail(SCHEMA, ""),
      readOrFail(MODELS_PY, ""),
    );
    assert.deepEqual(
      problems,
      [],
      "schema.prisma and models.py agree on the field NAMES and disagree on " +
        "what is stored in them:\n  " +
        problems.join("\n  "),
    );
  });

  /**
   * The dangerous direction, and it is dangerous because of `to_doc()`: a None
   * field is OMITTED from the document, never written as null. So a
   * Python-optional field against a Prisma-required column produces a document
   * with the key MISSING, which Prisma raises on at READ time — for a row that
   * was written without complaint, by a writer doing exactly what its model
   * allows.
   *
   * The opposite direction (Prisma optional, Python required) is reported too,
   * one severity down: it is not a failure, it is a column declared nullable
   * that no writer can ever leave null, and the honest fix is to tighten the
   * schema. Both are listed so neither is discovered later as "the one this
   * test allowed".
   */
  function nullabilityProblems(schemaSrc: string, modelsSrc: string): string[] {
    const { models } = parsePrismaBlock(schemaSrc);
    const parsed = parseRowFieldTypes(modelsSrc);
    const registry = parseModelsRegistry(modelsSrc);
    const problems: string[] = [];

    for (const { prisma: prismaName, rowClass } of registry) {
      const declared = models.get(prismaName);
      const written = parsed.get(rowClass);
      if (!declared || !written) continue;

      for (const [field, py] of written) {
        const col = declared.types.get(field);
        // A LIST column is no longer skipped. Prisma cannot declare a scalar
        // list optional, so `col.optional` is always false for one — which
        // makes `py.optional && !col.optional` fire on exactly the case that
        // matters (`items: list[str] | None`, whose None `to_doc()` omits,
        // leaving a required array column absent). Skipping the whole column
        // class turned that into a permanent exemption rather than a check.
        if (!col) continue;

        if (py.optional && !col.optional) {
          problems.push(
            `${prismaName}.${field}: REQUIRED in Prisma (\`${col.token}\`) ` +
              `but OPTIONAL in Python (\`${py.annotation}\`). to_doc() OMITS ` +
              "a None field, so this writes a document with the key missing " +
              "and Prisma raises reading it back.",
          );
        } else if (!py.optional && col.optional) {
          problems.push(
            `${prismaName}.${field}: OPTIONAL in Prisma (\`${col.token}\`) ` +
              `but REQUIRED in Python (\`${py.annotation}\`) — a nullable ` +
              "column no writer can leave null. Tighten schema.prisma, or " +
              "loosen the model if a null is genuinely intended.",
          );
        }
      }
    }
    return problems;
  }

  it("a field Prisma declares REQUIRED is never one Python may write as None", () => {
    const problems = nullabilityProblems(
      readOrFail(SCHEMA, ""),
      readOrFail(MODELS_PY, ""),
    );
    assert.deepEqual(
      problems,
      [],
      "nullability disagrees across the seam:\n  " + problems.join("\n  "),
    );
  });

  // ── The collection list ───────────────────────────────────────────────────
  //
  // The model list and the collection list have to describe the same eleven
  // things. `collections.py` is the only place the Python service learns a
  // physical name — Prisma exports `@@map` to nothing a Python process can
  // read — so a divergence here is a writer aimed at a collection that has no
  // schema behind it.

  it("collections.py parses to eleven plain-literal entries", () => {
    const entries = parseCollections(
      readOrFail(
        COLLECTIONS_PY,
        "The Python service declares its physical collection names there, as " +
          "a plain literal dict, precisely so this test can read them " +
          "without running Python. If the file moved, update this path.",
      ),
    );
    assert.equal(
      entries.length,
      EXPECTED_MODELS.length,
      `expected ${EXPECTED_MODELS.length} entries in the COLLECTIONS dict, ` +
        `parsed ${entries.length}. Its docstring requires a plain ` +
        '`"key": "value",` literal with no computation of any kind — a ' +
        "regex parser cannot evaluate Python, and a computed entry makes " +
        "this and prod-only-sync-coverage.test.ts read a partial list and " +
        "pass on it.",
    );
  });

  it("every @@map in the block is a collection collections.py declares", () => {
    const { models } = parsePrismaBlock(readOrFail(SCHEMA, ""));
    const declared = new Set(
      parseCollections(readOrFail(COLLECTIONS_PY, "")).map((e) => e.physical),
    );

    const missing = [...models]
      .filter(([, m]) => m.collection !== null && !declared.has(m.collection))
      .map(([name, m]) => `${name} -> ${m.collection}`)
      .sort();

    assert.deepEqual(
      missing,
      [],
      "schema.prisma declares a collection that " +
        "services/us-fundamentals/app/store/collections.py does not name, so " +
        "no Python writer can reach it: `collection_name()` RAISES on an " +
        "unknown logical key. Add it there.\n  " +
        missing.join("\n  "),
    );
  });

  it("every collection collections.py declares is an @@map in the block", () => {
    const { models } = parsePrismaBlock(readOrFail(SCHEMA, ""));
    const mapped = new Set(
      [...models.values()]
        .map((m) => m.collection)
        .filter((c): c is string => c !== null),
    );

    const undeclared = parseCollections(readOrFail(COLLECTIONS_PY, ""))
      .filter((e) => !mapped.has(e.physical))
      .map((e) => `${e.logical} -> ${e.physical}`)
      .sort();

    assert.deepEqual(
      undeclared,
      [],
      "collections.py names a collection with no @@map in the MONEY-979 " +
        "block. The first write CREATES it: a real Mongo collection with no " +
        "declared shape, no indexes, and no entry in the prod->QA sync, which " +
        "nothing notices until a reader comes up empty.\n  " +
        undeclared.join("\n  "),
    );
  });

  // ── Staleness of the snapshot itself ──────────────────────────────────────
  //
  // Everything above compares the snapshot to Prisma. Nothing above compares
  // the snapshot to the CODE THAT PRODUCED IT. Without these two cases, a
  // field renamed on both sides and a snapshot regenerated on neither reads as
  // a clean pass — the generated-file equivalent of a checkpoint written
  // before the work it records.

  it("the committed snapshot names exactly the models models.py registers", () => {
    const src = readOrFail(
      MODELS_PY,
      "It declares the row models this snapshot is generated from.",
    );
    const registry = parseModelsRegistry(src);
    assert.equal(
      registry.length,
      EXPECTED_MODELS.length,
      `parsed ${registry.length} entries from the MODELS registry in ` +
        `models.py, expected ${EXPECTED_MODELS.length}. This test reads that ` +
        "dict as TEXT; if its shape changed, fix the parser here rather than " +
        "dropping the check.",
    );

    assert.deepEqual(
      [...readSnapshot().keys()].sort(),
      registry.map((e) => e.prisma).sort(),
      `${SNAPSHOT} is STALE: it names a different set of models than ` +
        "models.py's MODELS registry does. The snapshot is an output of that " +
        "registry, so the two can only disagree if the file was not " +
        "regenerated after models.py changed. Run `yarn test:python` and " +
        "commit the result.",
    );
  });

  it("every row model declared in models.py is registered in MODELS", () => {
    const src = readOrFail(MODELS_PY, "");
    assert.deepEqual(
      parseModelsRegistry(src)
        .map((e) => e.rowClass)
        .sort(),
      parseRowClasses(src).sort(),
      "models.py declares a Row subclass that its MODELS registry does not " +
        "list (or lists one it does not declare). `schema_snapshot()` walks " +
        "MODELS, so an unregistered row model is invisible to the snapshot " +
        "and therefore to every case in this file — it would be written to " +
        "MongoDB with nothing comparing its fields to Prisma at all. Add it " +
        "to MODELS and re-run `yarn test:python`.",
    );
  });

  /* ── The parsers must be able to be WRONG ────────────────────────────────
   *
   * Every case above compares two committed files, and everything below is
   * about shapes NEITHER file contains today. That is not a reason to skip
   * them — it is the reason to have them. Each one was measured wrong against
   * the previous parser, and each is triggered by the single most ordinary
   * future edit to `models.py` (adding a `#` comment to a field) or to
   * `schema.prisma` (adding a field-level `@map`). A defect that only a future
   * commit can expose, with no executable case, is a comment.
   *
   * The premise assertions cannot help here either: the field SET is unchanged
   * in every one of them, so only the recorded TYPE is wrong and the guard
   * above it stays green.
   */

  const SYNTH_PRISMA = [
    `// ${BLOCK_MARKER}`,
    "model UsSynth {",
    '  id           String  @id @default(auto()) @map("_id") @db.ObjectId',
    '  fiscalYear   String  @map("fiscal_year")',
    "  plain        String",
    "  maybe        String?",
    "  arr          Json[]",
    "  scalarJson   Json",
    '  @@map("us_synth")',
    "}",
  ].join("\n");

  const synthModels = (fields: readonly string[]): string =>
    [
      "class UsSynthRow(Row):",
      '    """A row model. Prose here must never be parsed as a field."""',
      ...fields.map((f) => `    ${f}`),
      "",
      "",
      "MODELS: dict[str, type[Row]] = {",
      '    "UsSynth": UsSynthRow,',
      "}",
    ].join("\n");

  it("[falsifiability] a trailing comment does not change a Python annotation", () => {
    const withComment = parsePyAnnotation(
      "str | None  # SEC spells share classes with a slash (BRK/B)",
    );
    assert.equal(withComment.base, "str", withComment.annotation);
    assert.equal(
      withComment.optional,
      true,
      "a `#` comment made a NULLABLE python field read as REQUIRED, which " +
        "silently disables the to_doc()-omits-None check for that field",
    );
    const optionalWithComment = parsePyAnnotation("Optional[str]  # a note");
    assert.equal(optionalWithComment.base, "str");
    assert.equal(optionalWithComment.optional, true);
    // The `#` must NOT be honoured inside a string default.
    assert.equal(parsePyAnnotation("str", '"#"').optional, false);
  });

  it("[falsifiability] `Annotated[...]` and a `=` inside it are parsed, not truncated", () => {
    const t = parsePyAnnotation("Annotated[str, Field(max_length=10)]", "None");
    assert.equal(
      t.base,
      "str",
      `Annotated unwrapped to ${t.base}; "Annotated" is not a type this file ` +
        "has a TYPE_COMPAT entry for, so the field would be reported against " +
        "the wrong column type",
    );
    assert.equal(t.optional, true);
    // The whole line, through the real field parser: the annotation must not be
    // cut at the `=` inside `Field(...)`.
    const parsed = parseRowFieldTypes(
      synthModels(["fiscalYear: Annotated[str, Field(max_length=10)] = None"]),
    ).get("UsSynthRow");
    assert.equal(parsed?.get("fiscalYear")?.base, "str");
    assert.equal(parsed?.get("fiscalYear")?.optional, true);
  });

  it("[falsifiability] every spelling of a None default records as OPTIONAL", () => {
    const parsed = parseRowFieldTypes(
      synthModels([
        "a: str | None = None",
        "b: str | (None) = None",
        "c: str = None",
        'd: str = ""',
        "e: list[str] = Field(default_factory=list)",
        // No default at all: the parens must still be seen through, or the
        // union arm reads as the literal string "(None)" and the field records
        // as REQUIRED on the annotation alone.
        "f: str | (None)",
      ]),
    ).get("UsSynthRow");
    const optionality = [...(parsed ?? [])].map(
      ([k, v]) => `${k}=${v.optional}`,
    );
    assert.deepEqual(
      optionality,
      ["a=true", "b=true", "c=true", "d=false", "e=false", "f=true"],
      "`to_doc()` omits a None whatever the annotation says, so any field " +
        "that can hold None is optional for this comparison",
    );
  });

  it("[falsifiability] a field-level @map is compared by the STORED key", () => {
    const { models } = parsePrismaBlock(SYNTH_PRISMA);
    const model = models.get("UsSynth");
    assert.ok(model, "the synthetic block must parse");
    assert.ok(
      model.physicalFields.has("fiscal_year"),
      `physical fields were ${[...model.physicalFields].join(", ")} — a ` +
        "field-level @map was discarded, so this file compares a name that " +
        "is not in the document against a name that is",
    );
    assert.ok(!model.physicalFields.has("fiscalYear"));
    assert.equal(model.types.get("fiscal_year")?.declared, "fiscalYear");
    assert.ok(
      model.physicalFields.has("_id") && model.fields.has("id"),
      '`id @map("_id")` is the split that already exists in the real block',
    );
  });

  it("[falsifiability] a scalar Python value against a Json[] COLUMN is reported", () => {
    // The finding's example: `formerNames: int | None` against `Json[]` passed
    // every case in this file, because `Json` was exempt from the list check in
    // both directions and TYPE_COMPAT.Json admits `int`.
    const problems = typeProblems(
      SYNTH_PRISMA,
      synthModels(["arr: int | None = None"]),
    );
    assert.equal(problems.length, 1, problems.join("\n  "));
    assert.match(problems[0]!, /one is a LIST and the other is not/);

    // The documented exemption survives: a SCALAR `Json` cell holds either
    // shape, which is what `UsFundamentals.asReported` relies on.
    assert.deepEqual(
      typeProblems(
        SYNTH_PRISMA,
        synthModels(["scalarJson: list[dict] = Field(default_factory=list)"]),
      ),
      [],
      "narrowing scalar Json would fail on a difference the header " +
        "deliberately exempts",
    );
  });

  it("[falsifiability] a LIST column is not exempt from the nullability check", () => {
    // `if (!col || col.list) continue` made every Prisma list column a
    // permanent exemption. Prisma cannot declare a scalar list optional, so a
    // Python `list[...] | None` is always the dangerous direction: to_doc()
    // omits the None and the required array column is simply absent.
    const problems = nullabilityProblems(
      SYNTH_PRISMA,
      synthModels(["arr: list[dict] | None = None"]),
    );
    assert.equal(problems.length, 1, problems.join("\n  "));
    assert.match(problems[0]!, /REQUIRED in Prisma .* but OPTIONAL in Python/);
  });

  /* ── `UsFiling.status`'s vocabulary (MONEY-1303) ─────────────────────── */

  it("the status vocabulary schema.prisma documents is the one models.py declares", () => {
    const prisma = prismaStatusVocabulary(readFileSync(SCHEMA, "utf8"));
    const python = pythonStatusVocabulary(readFileSync(MODELS_PY, "utf8"));

    assert.deepEqual(
      [...prisma].sort(),
      [...python].sort(),
      "`UsFiling.status`'s permitted values disagree between " +
        "packages/database/prisma/schema.prisma and " +
        "services/us-fundamentals/app/store/models.py. The Python constants " +
        "are the source of truth — they are what the writers actually emit — " +
        "so update the `///` comment above `status` to match. `status` is a " +
        "plain String, so nothing else in this repo would notice the drift: " +
        "a value the writer emits and the schema does not name is a " +
        "population no reader knows to query.",
    );
  });

  it("the vocabulary parsed from each side is non-trivial and well formed", () => {
    // Without this, a regex that matched NOTHING would satisfy the case above
    // by comparing [] to [] — the shape MONEY-1303's own detect counters were
    // rebuilt to avoid.
    const prisma = prismaStatusVocabulary(readFileSync(SCHEMA, "utf8"));
    const python = pythonStatusVocabulary(readFileSync(MODELS_PY, "utf8"));

    assert.ok(prisma.length >= 7, `prisma vocabulary too small: ${prisma}`);
    assert.ok(python.length >= 7, `python vocabulary too small: ${python}`);
    for (const token of [...prisma, ...python]) {
      assert.match(token, /^[A-Z][A-Z_]*$/, `not a status token: "${token}"`);
    }
    // The two halves of MONEY-1303, named: an in-flight status and the
    // terminal one that stopped borrowing it.
    assert.ok(prisma.includes("DETECTED") && prisma.includes("NO_PARSER"));
  });

  it("the column default is a member of the vocabulary it defaults into", () => {
    const schema = readFileSync(SCHEMA, "utf8");
    const model = /^model UsFiling \{$([\s\S]*?)^\}$/m.exec(schema)?.[1] ?? "";
    const fallback = /^\s*status\s+String\s+@default\("([A-Z_]+)"\)/m.exec(
      model,
    )?.[1];
    assert.ok(fallback, "`UsFiling.status` no longer declares a @default");
    assert.ok(
      prismaStatusVocabulary(schema).includes(fallback),
      `@default("${fallback}") is not in the documented vocabulary`,
    );
  });

  it("[falsifiability] the synthetic fixtures agree with the real parsers", () => {
    // A fixture that no longer resembles the files it stands in for proves
    // nothing. Both real files must parse under the same functions, and the
    // synthetic pair must be CLEAN when it is meant to be — otherwise the
    // cases above could be passing on a broken fixture.
    assert.deepEqual(
      typeProblems(
        SYNTH_PRISMA,
        synthModels([
          "fiscal_year: str | None = None",
          "plain: str",
          "maybe: str | None = None",
          "arr: list[dict] = Field(default_factory=list)",
          "scalarJson: dict = Field(default_factory=dict)",
        ]),
      ),
      [],
    );
    assert.deepEqual(
      nullabilityProblems(
        SYNTH_PRISMA,
        synthModels([
          "fiscal_year: str",
          "plain: str",
          "maybe: str | None = None",
          "arr: list[dict] = Field(default_factory=list)",
        ]),
      ),
      [],
    );
  });
});

describe("a status constant REDECLARED in another module must agree", () => {
  /* ────────────────────────────────────────────────────────────────────────
     `pythonStatusVocabulary` reads `models.py` and nothing else, so it grades
     the DECLARATION and not necessarily the WRITER.

     `app/parsers/dispatch.py` declares its own `STATUS_PARSED`, `STATUS_FAILED`
     and `STATUS_UNSUPPORTED` at module scope and imports nothing from
     `app.store.models` — and it is the live writer for those three. Changing
     `dispatch.py`'s literal to `"PARSED_OK"` left the parity suite fully green,
     which is exactly the failure the suite's own docstring says it exists to
     catch: "a value the writer emits and the schema does not name is a
     population no reader knows to query."

     WHY THIS IS AN AGREEMENT CHECK AND NOT A UNION. `app/bulk/common.py` also
     declares `STATUS_…` constants — COMPLETED, NOT_YET_PUBLISHED,
     BUDGET_EXHAUSTED, WRITE_DISARMED — but those are RUN outcomes, a different
     vocabulary that has no business in `UsFiling.status`. Folding every file's
     constants into one set would have made the Prisma comparison fail on tokens
     that were never filing statuses. So the rule is narrower and holds
     regardless of which vocabulary a constant belongs to: wherever two modules
     declare the SAME NAME, they must agree on the VALUE.
     ──────────────────────────────────────────────────────────────────────── */

  const APP = join(SERVICE, "app");

  /** `{ constant -> { value -> [files] } }` for every module-scope declaration. */
  function statusDeclarations(): Map<string, Map<string, string[]>> {
    const found = new Map<string, Map<string, string[]>>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__pycache__") walk(p);
          continue;
        }
        if (!entry.name.endsWith(".py")) continue;
        for (const m of readFileSync(p, "utf8").matchAll(
          /^(STATUS_\w+) = "([A-Z_]+)"$/gm,
        )) {
          const byValue = found.get(m[1]!) ?? new Map<string, string[]>();
          byValue.set(m[2]!, [
            ...(byValue.get(m[2]!) ?? []),
            p.slice(APP.length + 1),
          ]);
          found.set(m[1]!, byValue);
        }
      }
    };
    walk(APP);
    return found;
  }

  it("PREMISE: at least one constant IS declared in more than one module", () => {
    // Without this the loop below iterates nothing and passes having checked
    // nothing — and the redeclaration it guards could simply have been deleted.
    const decls = statusDeclarations();
    const shared = [...decls].filter(
      ([, byValue]) => [...byValue.values()].flat().length > 1,
    );
    assert.ok(
      shared.length > 0,
      "no STATUS_ constant is declared in two modules any more; if the " +
        "redeclarations were removed, this whole case can go",
    );
  });

  it("every redeclared constant has ONE value across the service", () => {
    for (const [name, byValue] of statusDeclarations()) {
      if (byValue.size <= 1) continue;
      const detail = [...byValue]
        .map(([v, files]) => `${v} (${files.join(", ")})`)
        .join(" vs ");
      assert.fail(
        `${name} is declared with conflicting values: ${detail}. The module ` +
          "that WRITES is the one that matters, and `pythonStatusVocabulary` " +
          "reads only app/store/models.py — so a drifted redeclaration is " +
          "invisible to the parity check above.",
      );
    }
  });
});
