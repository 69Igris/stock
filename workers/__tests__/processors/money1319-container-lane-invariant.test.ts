/**
 * ONE CONSTANT, FOUR CONSUMERS, ONE OF THEM TAUGHT — MONEY-1319 review (H1).
 *
 * ## The defect this file exists to make impossible
 *
 * MONEY-1319 taught `stock-document-extract` to open a ZIP and, in the same
 * change, added `application/zip` to `EXTRACTABLE_DOC_MIME_TYPES`. The comment
 * it added beside that array said *"This array is the switch, so the two must
 * move together"* — naming TWO things. There were FOUR readers:
 *
 *   workers/src/processors/stock-document-extract-logic.ts   opens archives
 *   workers/src/processors/stock-document-parse-logic.ts     does NOT
 *   workers/src/processors/doc-ingest-selectors-logic.ts x2  does NOT
 *
 * `PARSEABLE_DOC_TYPES` includes `annual_report`, which is exactly the 172-row
 * NSE ZIP class. So the moment a row carried `application/zip`, the parse lane
 * would download it and hand raw archive bytes to the Gemini Files API or a
 * Vertex `gs://` URI, and the convert lane would hand them to pdf-inspector —
 * paying per row for an archive no model can read. That is MONEY-1319's OWN
 * measured defect, recreated against three more lanes by the commit fixing it,
 * live on merge with no flag, over 13 `application/zip` rows prod already
 * holds.
 *
 * ## What is asserted, and why it is not four copies of a list
 *
 * The INVARIANT is *no consumer may select a container it cannot read*. Every
 * lane's selected set is read back from the REAL query builder — never
 * restated — and cross-checked against `CONTAINER_DOC_MIME_TYPES`. The one
 * lane that claims it CAN unwrap has to earn the claim: real container bytes
 * go through `resolveExtractionSource` and must come back unwrapped. A
 * container type with no such proof fails, which is what stops the next
 * `application/x-7z` from being added to the set on optimism.
 *
 * A source scan closes the last hole — a FIFTH selection site written later,
 * which no table of four lanes can see.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTAINER_DOC_MIME_TYPES,
  DIRECT_DOC_MIME_TYPES,
  EXTRACTABLE_DOC_MIME_TYPES,
  ZIP_MIME_TYPE,
  isContainerDocMimeType,
  isDirectDocMimeType,
} from "@usemoney/core/market-data/doc-mime";

import {
  buildExtractQuery,
  resolveExtractionSource,
} from "../../src/processors/stock-document-extract-logic";
import { buildParseQuery } from "../../src/processors/stock-document-parse-logic";
import {
  buildConvertQuery,
  buildSweepQuery,
} from "../../src/processors/doc-ingest-selectors-logic";
import { shouldPublishIngest } from "../../src/lib/doc-ingest-publish";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const WORKERS_SRC = path.join(REPO, "workers", "src");

/* -------------------------------------------------------------------------- */
/* Container fixtures — bytes, not descriptions                                */
/* -------------------------------------------------------------------------- */

function pdfBytes(size: number): Buffer {
  const head = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n");
  return Buffer.concat([
    head,
    Buffer.alloc(Math.max(0, size - head.length), "x"),
    Buffer.from("\n%%EOF\n"),
  ]);
}

function zipOf(name: string, payload: Buffer): Buffer {
  const nameBuf = Buffer.from(name, "utf-8");
  const deflated = deflateRawSync(payload);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(8, 8);
  head.writeUInt32LE(deflated.length, 18);
  head.writeUInt32LE(payload.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);
  const end = Buffer.alloc(4);
  end.writeUInt32LE(0x02014b50, 0);
  return Buffer.concat([head, nameBuf, deflated, end]);
}

/**
 * Real bytes for each CONTAINER media type, keyed by that type.
 *
 * A container in the set with no entry here is a FAILURE, deliberately. It is
 * the only thing standing between "we added a media type to a constant" and
 * "a lane is now paying a metered call for bytes it cannot open" — the exact
 * step this whole ticket is about.
 */
const CONTAINER_FIXTURES: Readonly<Record<string, Buffer>> = {
  [ZIP_MIME_TYPE]: zipOf("AR_ACCELYA_2023.pdf", pdfBytes(4000)),
};

/* -------------------------------------------------------------------------- */
/* 1. The two sets partition the third                                         */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319 H1: direct and container partition the extractable set", () => {
  it("EXTRACTABLE is exactly DIRECT ∪ CONTAINER", () => {
    assert.deepEqual(
      [...EXTRACTABLE_DOC_MIME_TYPES].sort(),
      [...DIRECT_DOC_MIME_TYPES, ...CONTAINER_DOC_MIME_TYPES].sort(),
    );
  });

  it("they are DISJOINT — nothing is both consumable as-is and a container", () => {
    const direct = new Set(DIRECT_DOC_MIME_TYPES);
    for (const c of CONTAINER_DOC_MIME_TYPES) {
      assert.ok(
        !direct.has(c),
        `${c} is in BOTH sets, so "may this lane select it" has no answer`,
      );
    }
  });

  it("CONTAINER is non-empty — otherwise every assertion below is vacuous", () => {
    // The mutation this catches is the tempting "simplify" one: collapse the
    // split back to a single array by emptying this one. Every "no lane
    // selects a container" test would then pass over an empty loop.
    assert.ok(CONTAINER_DOC_MIME_TYPES.length > 0);
    assert.ok(DIRECT_DOC_MIME_TYPES.length > 0);
  });

  it("the predicates agree with the arrays they read", () => {
    for (const t of DIRECT_DOC_MIME_TYPES) {
      assert.equal(isDirectDocMimeType(t), true, t);
      assert.equal(isContainerDocMimeType(t), false, t);
    }
    for (const t of CONTAINER_DOC_MIME_TYPES) {
      assert.equal(isContainerDocMimeType(t), true, t);
      assert.equal(isDirectDocMimeType(t), false, t);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. THE INVARIANT — every lane, against its own real query                   */
/* -------------------------------------------------------------------------- */

interface Lane {
  /** The source file the selection lives in — also what the scan below joins on. */
  file: string;
  /** The exported builder, for the failure message. */
  builder: string;
  /** The media types this lane's query actually selects, from the REAL builder. */
  selects: readonly string[];
  /**
   * Does this lane open a container before handing bytes to a reader?
   *
   * A `true` here is a CLAIM, and section 3 makes it earn its keep.
   */
  opensContainers: boolean;
}

function selectedMimeTypes(where: Record<string, unknown>): readonly string[] {
  const arm = where["mimeType"] as { in?: string[] } | undefined;
  assert.ok(
    arm && Array.isArray(arm.in),
    "CEILING: this query no longer selects on mimeType at all — if that is " +
      "deliberate the lane now sees EVERY media type and this table is wrong",
  );
  return arm.in as string[];
}

const LANES: readonly Lane[] = [
  {
    file: "workers/src/processors/stock-document-extract-logic.ts",
    builder: "buildExtractQuery",
    // MONEY-1329 gave this builder a required `now` (the stale-PROCESSING
    // cutoff). Only the mimeType arm is under test here.
    selects: selectedMimeTypes(buildExtractQuery({ now: new Date() })),
    // `resolveExtractionSource` sniffs the body and, for an archive, opens it
    // and selects the PDF member before any Document AI call is made.
    opensContainers: true,
  },
  {
    file: "workers/src/processors/stock-document-parse-logic.ts",
    builder: "buildParseQuery",
    // Downloads the object and hands those bytes to the Gemini Files API, or
    // the gs:// URI to Vertex. No unwrapping step anywhere on the path.
    selects: selectedMimeTypes(buildParseQuery({})),
    opensContainers: false,
  },
  {
    file: "workers/src/processors/doc-ingest-selectors-logic.ts",
    builder: "buildConvertQuery",
    // Feeds pdf-inspector and writes a `${gcsPath}.md` sidecar keyed on the
    // OBJECT — a member's markdown would sit under a key naming the archive.
    selects: selectedMimeTypes(buildConvertQuery({})),
    opensContainers: false,
  },
  {
    file: "workers/src/processors/doc-ingest-selectors-logic.ts",
    builder: "buildSweepQuery",
    // The ONLINE per-document path: the most expensive lane there is.
    // MONEY-1341 gave this builder a required `now` (the stale in-flight
    // cutoffs). Only the mimeType arm is under test here.
    selects: selectedMimeTypes(buildSweepQuery({ now: new Date() })),
    opensContainers: false,
  },
];

describe("MONEY-1319 H1: no consumer selects a container it cannot read", () => {
  for (const lane of LANES) {
    it(`${lane.builder} (${lane.file})`, () => {
      for (const mime of lane.selects) {
        if (!isContainerDocMimeType(mime)) continue;
        assert.ok(
          lane.opensContainers,
          `${lane.builder} selects ${mime}, which is a CONTAINER, and this ` +
            `lane has no unwrapping step — every such row is a metered call ` +
            `spent on bytes no reader can open`,
        );
      }
    });

    it(`${lane.builder} selects nothing OUTSIDE the extractable set`, () => {
      for (const mime of lane.selects) {
        assert.ok(
          EXTRACTABLE_DOC_MIME_TYPES.includes(mime),
          `${lane.builder} selects ${mime}, which nothing in this repo reads`,
        );
      }
    });
  }

  it("at least one lane is NOT archive-aware — else this proves nothing", () => {
    assert.ok(
      LANES.some((l) => !l.opensContainers),
      "CEILING: with every lane claiming to unwrap, the invariant is vacuous",
    );
    assert.ok(LANES.some((l) => l.opensContainers));
  });

  it("the realtime ingest publish gate refuses containers too", () => {
    // A FIFTH consumer of the same rule, and not a Prisma query — so the scan
    // below cannot see it. `stock-document-ingest` converts with pdf-inspector
    // and falls over to a PAID vision call; neither opens an archive.
    const env = { DOC_INGEST_REALTIME: "true" } as NodeJS.ProcessEnv;
    for (const mime of CONTAINER_DOC_MIME_TYPES) {
      assert.equal(
        shouldPublishIngest({ mimeType: mime, gcsPath: "stocks/A/x.pdf", env }),
        false,
        `${mime} is a container — announcing it spends a model call on it`,
      );
    }
    for (const mime of DIRECT_DOC_MIME_TYPES) {
      assert.equal(
        shouldPublishIngest({ mimeType: mime, gcsPath: "stocks/A/x.pdf", env }),
        true,
        "CONTROL: the gate must still pass what it is FOR",
      );
    }
    assert.equal(
      shouldPublishIngest({
        mimeType: "application/pdf;charset=UTF-8",
        gcsPath: "stocks/A/x.pdf",
        env,
      }),
      true,
      "MONEY-1255: a parameterised spelling must still pass — the exact-match " +
        "version of this rule made 1,211 rows unreachable",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The `opensContainers: true` claim is EARNED, not asserted                */
/* -------------------------------------------------------------------------- */

describe("MONEY-1319 H1: an archive-aware lane really does unwrap", () => {
  for (const mime of CONTAINER_DOC_MIME_TYPES) {
    it(`${mime} — real bytes go in, a readable member comes out`, () => {
      const body = CONTAINER_FIXTURES[mime];
      assert.ok(
        body,
        `no fixture for container type ${mime}. It is in ` +
          `CONTAINER_DOC_MIME_TYPES and buildExtractQuery therefore SELECTS ` +
          `it, so something must prove the lane can open one. Add real bytes ` +
          `to CONTAINER_FIXTURES, or take the type back out of the set.`,
      );

      const src = resolveExtractionSource({ body, storedMimeType: mime });
      assert.ok(src, `${mime} was selected and could not be opened`);
      assert.equal(
        src.objectIsTheDocument,
        false,
        `${mime} must be UNWRAPPED — a lane handing the archive itself to a ` +
          `reader is the defect, whatever the media type says`,
      );
      assert.ok(
        isDirectDocMimeType(src.mimeType),
        `the recovered member is ${src.mimeType}, which is not directly ` +
          `readable either — unwrapping one layer is not enough`,
      );
      assert.ok(src.bytes.length > 0);
      assert.notEqual(src.bytes, body, "the member is not the whole archive");
    });

    it(`${mime} is actually selected by the archive-aware lane`, () => {
      // The other half: a container nothing selects would pass section 2 for a
      // reason that has nothing to do with capability.
      const aware = LANES.filter((l) => l.opensContainers);
      assert.ok(
        aware.some((l) => l.selects.includes(mime)),
        `${mime} is a container no archive-aware lane selects — it is dead ` +
          `weight in the set, and dead weight is what an untaught lane picks up`,
      );
    });
  }

  it("a DIRECT type is NOT unwrapped — the object is the document", () => {
    // CONTROL. Without this, "always unwrap" would pass everything above.
    const src = resolveExtractionSource({
      body: pdfBytes(3000),
      storedMimeType: "application/pdf",
    });
    assert.ok(src);
    assert.equal(src.objectIsTheDocument, true);
    assert.equal(src.memberName, null);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. A FIFTH selection site, written later, cannot escape                     */
/* -------------------------------------------------------------------------- */

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every `mimeType: { in: [...IDENT] }` selection under `workers/src`. */
const SELECTION_RE = /mimeType:\s*\{\s*in:\s*\[\s*\.\.\.\s*([A-Za-z_$][\w$]*)/g;

interface SelectionSite {
  file: string;
  constant: string;
  source: string;
}

function findSelectionSites(): SelectionSite[] {
  const sites: SelectionSite[] = [];
  for (const full of walkTs(WORKERS_SRC)) {
    const source = readFileSync(full, "utf-8");
    const rel = path.relative(REPO, full).split(path.sep).join("/");
    for (const m of source.matchAll(SELECTION_RE)) {
      sites.push({ file: rel, constant: m[1]!, source });
    }
  }
  return sites;
}

describe("MONEY-1319 H1: the source, not just the four lanes we know about", () => {
  const sites = findSelectionSites();

  it("finds every selection the LANES table claims to cover", () => {
    assert.ok(
      sites.length >= LANES.length,
      `CEILING: the scan found ${sites.length} mimeType selections under ` +
        `workers/src but the table describes ${LANES.length}. Either the ` +
        `regex stopped matching or a lane was deleted — both make every ` +
        `assertion here weaker than it reads.`,
    );
    const scanned = new Set(sites.map((s) => s.file));
    for (const lane of LANES) {
      assert.ok(
        scanned.has(lane.file),
        `${lane.file} is in the LANES table and the scan does not see a ` +
          `mimeType selection in it`,
      );
    }
  });

  it("every selection names a SHARED constant, never a literal list", () => {
    // The regex only matches a spread of an identifier, so a literal list
    // would be INVISIBLE to it rather than caught. Check for that shape too.
    for (const full of walkTs(WORKERS_SRC)) {
      const source = readFileSync(full, "utf-8");
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      const literal = source.match(/mimeType:\s*\{\s*in:\s*\[\s*"/);
      assert.equal(
        literal,
        null,
        `${rel} selects mimeType against a LITERAL list. That is the rule ` +
          `restated, and this one already drifted once between a filename ` +
          `and a column (MONEY-1255, 1,211 unreachable rows).`,
      );
    }
    for (const site of sites) {
      assert.ok(
        ["DIRECT_DOC_MIME_TYPES", "EXTRACTABLE_DOC_MIME_TYPES"].includes(
          site.constant,
        ),
        `${site.file} selects mimeType against ${site.constant}. The only two ` +
          `answers are DIRECT (this lane cannot unwrap) and EXTRACTABLE (it ` +
          `can, and section 3 proves it).`,
      );
    }
  });

  it("a file selecting the ARCHIVE-INCLUSIVE set must reach an unwrapper", () => {
    // The property, not the list: whoever names the container-carrying
    // constant has to have the capability in the same file.
    const archiveAware = sites.filter(
      (s) => s.constant === "EXTRACTABLE_DOC_MIME_TYPES",
    );
    assert.ok(
      archiveAware.length > 0,
      "CEILING: nothing selects the archive-inclusive set, so this test " +
        "would pass with the capability removed entirely",
    );
    for (const site of archiveAware) {
      assert.match(
        site.source,
        /openDocumentZip|resolveExtractionSource/,
        `${site.file} selects ${site.constant} — which carries ` +
          `${CONTAINER_DOC_MIME_TYPES.join(", ")} — and never reaches an ` +
          `unwrapper. That is the H1 defect: a lane selecting a container it ` +
          `cannot open, paying a metered call per row.`,
      );
    }
  });
});
