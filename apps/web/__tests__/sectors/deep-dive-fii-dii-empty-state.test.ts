/**
 * MONEY-268 — the sector deep-dive's institutional picks cards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What this file used to assert, and why it is inverted
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Under MONEY-1215 these two cards rendered "FII flow data not yet wired." to
 * users, and three defects sat behind that one string:
 *
 *   1. THE COPY was engineering vocabulary on a product surface.
 *   2. THE QUERY could never have run — the action probed `prisma.fiiDiiFlow`
 *      through a `prisma as unknown as` cast, and no `FiiDiiFlow` model has
 *      ever existed. The cast is what made dead code look like a feature
 *      degrading gracefully.
 *   3. THE DATA does not exist at that grain at all. `InstitutionalFlow` is
 *      keyed `@@unique([date, category, segment])` — MARKET-WIDE, no `symbol`
 *      column — so no query over it can rank stocks within a sector.
 *
 * The cards were then HIDDEN, and this suite asserted their absence. MONEY-268
 * (founder call, Option A) replaces them rather than restoring them: the cards
 * now rank the largest disclosed BULK/BLOCK prints among a sector's
 * constituents, which is arithmetic over exchange-reported rows, and they no
 * longer say FII or DII in their titles.
 *
 * So the mount assertions flip to "renders" — but every SCHEMA CANARY below is
 * kept exactly as it was, because those never asserted the cards' absence. They
 * assert WHY the original ticket was unbuildable, and they are the notification
 * channel for the day that stops being true: if `InstitutionalFlow` ever gains
 * a per-symbol dimension, this suite goes red and tells the next reader that
 * real per-stock FII/DII flow is now available and these cards can be upgraded
 * from "disclosed prints" to the thing the ticket originally asked for.
 *
 * Source-level assertions, matching the convention in
 * ../markets/sector-caption-count.test.ts and ./deep-dive-query-shape.test.ts
 * ("no DOM runtime in this suite").
 *
 * Sources: apps/web/app/discover/sectors/SectorDeepDive.tsx
 *          apps/web/lib/actions/sector-deep-dive.ts
 *          packages/database/prisma/schema.prisma
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const REPO = join(ROOT, "..", "..");

const panel = readFileSync(
  join(ROOT, "app/discover/sectors/SectorDeepDive.tsx"),
  "utf8"
);
const action = readFileSync(
  join(ROOT, "lib/actions/sector-deep-dive.ts"),
  "utf8"
);
const schema = readFileSync(
  join(REPO, "packages/database/prisma/schema.prisma"),
  "utf8"
);

/**
 * Source with comments removed.
 *
 * Every scan below that is about CODE or about USER-VISIBLE COPY must run on
 * this, not on the raw file. The first draft of this suite did not, and it
 * failed on its own documentation: the block comments that explain the defect
 * necessarily quote `fiiDiiFlow` and the phrase "not yet wired", so the raw
 * file matches every pattern the fix removed. Scanning prose would also make
 * the guards actively harmful — the only way to keep them green would be to
 * delete the explanation of why they exist.
 *
 * `//` preceded by `:` is left alone so a URL is not truncated mid-literal.
 */
function stripComments(src: string): string {
  // LINE first, then BLOCK — MONEY-1143, and the order is load-bearing.
  //
  // A `//` comment containing `/*` opens a phantom block that runs to the next
  // `*/`, which can be hundreds of lines away. Measured on this tree,
  // block-first stripping ate 11,192 characters of `Sidebar.tsx` — including
  // real call sites. Every scan below asserts an ABSENCE, so eaten text makes
  // the assertion pass BECAUSE the code is gone rather than because the wiring
  // is right: the one failure mode where a broken test and a healthy test are
  // indistinguishable. `comment-strip-ordering.test.ts` enforces this
  // repo-wide.
  return src
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const panelCode = stripComments(panel);
const actionCode = stripComments(action);

/** Field NAMES declared in a model body — not `@@…` attributes or `///` docs. */
function modelFields(model: string): string[] {
  return model
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("//") &&
        !l.startsWith("@@") &&
        !l.startsWith("model ")
    )
    .map((l) => l.split(/\s+/)[0]!);
}

/** The body of the `model X { … }` block named `name`, or null. */
function prismaModel(name: string): string | null {
  const start = schema.indexOf(`model ${name} {`);
  if (start === -1) return null;
  const end = schema.indexOf("\n}", start);
  assert.notEqual(end, -1, `model ${name} is not closed — schema unparseable`);
  return schema.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness — a static scan that reads the wrong file passes everything.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — liveness", () => {
  it("all three sources are readable and non-trivial", () => {
    assert.ok(panel.length > 2000, "panel source unexpectedly small");
    assert.ok(action.length > 2000, "action source unexpectedly small");
    assert.ok(schema.length > 2000, "schema unexpectedly small");
    assert.match(panel, /PicksPanel/);
    assert.match(action, /getSectorDeepDiveAction/);
  });

  it("stripComments removes prose without eating the code", () => {
    // Every `doesNotMatch` below runs on the stripped text, so an over-eager
    // stripper returning "" would make this whole suite pass vacuously — the
    // exact failure mode the strip was introduced to avoid on the other side.
    for (const [name, raw, code] of [
      ["panel", panel, panelCode],
      ["action", action, actionCode],
    ] as const) {
      assert.ok(
        code.length < raw.length,
        `${name}: stripComments removed nothing — is the comment syntax what we think?`
      );
      assert.ok(
        code.length > raw.length * 0.4,
        `${name}: stripComments removed ${raw.length - code.length} of ${raw.length} ` +
          "chars — it is eating code, and the scans below are near-vacuous"
      );
    }
    // The specific anchors the scans rely on must survive stripping.
    assert.match(panelCode, /function PicksPanel/);
    assert.match(actionCode, /getSectorDeepDiveAction/);
    assert.match(actionCode, /institutionalPicks/);

    // And the strip must genuinely remove PROSE that quotes the very terms the
    // scans ban — the case that broke the first draft of this file. The source
    // comment explaining MONEY-268 names `fiiDiiFlow`; if the stripper left it
    // in, the `doesNotMatch` scans below would fail on their own documentation,
    // and the only way to keep them green would be to delete the explanation.
    assert.match(
      action,
      /fiiPicks/,
      "the explaining comment should still name what this replaced"
    );
    assert.ok(
      (actionCode.match(/fiiPicks/g) ?? []).length === 0,
      "stripComments left the comment's `fiiPicks` mention in the code scan"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The cards render again — and say something true.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — both picks cards are MOUNTED", () => {
  it("two PicksPanels are rendered", () => {
    const mounts = panelCode.match(/<PicksPanel\b/g) ?? [];
    assert.equal(
      mounts.length,
      2,
      "expected exactly the buys and sells cards — MONEY-268 replaced the two " +
        "hidden FII/DII cards one for one"
    );
  });

  it("the titles are the new, honest copy", () => {
    for (const title of ["TOP INSTITUTIONAL BUYS", "TOP INSTITUTIONAL SELLS"]) {
      assert.ok(panelCode.includes(title), `${title} is not rendered`);
    }
  });

  it("[regression] the titles do NOT claim FII or DII", () => {
    // The rows carry a per-counterparty chip whose most common value is the
    // honest "Institutional". A card HEADED "Top FII buys" would make in its
    // header the exact claim its rows decline to make.
    for (const banned of [
      "TOP FII PICK",
      "TOP DII PICK",
      "TOP FII",
      "TOP DII",
    ]) {
      assert.ok(
        !panelCode.includes(banned),
        `${banned} is back — per-symbol FII/DII attribution still does not exist`
      );
    }
  });

  it("[regression] 'not yet wired' has not come back", () => {
    // The string that started this: engineering vocabulary on a product
    // surface. Scanned across the whole file, comments included, because it
    // must not reappear even as a suggestion.
    assert.doesNotMatch(
      panel,
      /not yet wired/i,
      "'not yet wired' reads as a missing deploy to anyone but the author"
    );
  });

  it("the cards are fed from the payload, not from a placeholder", () => {
    // The failure this replaced was a card wired to a constant `[]`. Both
    // mounts must read the real field.
    assert.match(panelCode, /picks=\{data\.institutionalPicks\?\.buys/);
    assert.match(panelCode, /picks=\{data\.institutionalPicks\?\.sells/);
  });

  it("each row is chipped with its counterparty class", () => {
    assert.match(panelCode, /<ClientChip\b/);
    assert.match(
      panelCode,
      /cls === "INSTITUTIONAL" \? "Institutional"/,
      "the unknown bucket must render as a word, not as the enum"
    );
  });
});

describe("MONEY-268 — the action returns real picks", () => {
  it("the payload field exists and is nullable", () => {
    assert.match(
      actionCode,
      /institutionalPicks: SectorInstitutionalPicksData \| null;/,
      "null must stay distinct from an empty window — see the empty-state cases"
    );
    assert.match(actionCode, /^\s*institutionalPicks,\s*$/m);
  });

  it("[regression] the always-empty arrays are GONE, not left as furniture", () => {
    // They existed only to keep the payload shape stable while the cards were
    // hidden. Keeping two permanently-empty arrays after the cards came back is
    // exactly the dead surface this ticket removed.
    for (const dead of ["fiiPicks", "diiPicks"]) {
      assert.ok(
        !actionCode.includes(dead),
        `${dead} is still on the payload — nothing reads it any more`
      );
    }
  });

  it("the picks come from the shared service, not a second inline query", () => {
    // Standing rule: apps/web and apps/api must run the SAME code. A query
    // written inline here is how the two drift.
    assert.match(actionCode, /getSectorInstitutionalPicks\(\{ sector \}\)/);
    assert.match(actionCode, /from "@usemoney\/services"/);
  });

  it("the picks leg is BOUNDED and soft-fails", () => {
    // Every other leg in this action runs under `withTimeout`; an unbounded one
    // is how the spinner used to hang forever. And a deals-table outage must
    // not take down a panel whose other eight cards are real data.
    assert.match(
      actionCode,
      /withTimeout\(\s*getSectorInstitutionalPicks/,
      "the picks query must run under the file's per-query ceiling"
    );
    assert.match(
      actionCode,
      /getSectorInstitutionalPicks[\s\S]{0,400}?\.catch\(/,
      "a throw here must degrade to `null`, not reject the whole payload"
    );
  });
});

describe("MONEY-268 — no phantom Prisma model probes", () => {
  it("[regression] the action does not reference `fiiDiiFlow`", () => {
    assert.doesNotMatch(
      actionCode,
      /fiiDiiFlow/,
      "`prisma.fiiDiiFlow` is not a model — the probe was unreachable code " +
        "wearing a graceful-degradation costume"
    );
  });

  it("`FiiDiiFlow` is not a model, which is why the probe never ran", () => {
    assert.equal(
      prismaModel("FiiDiiFlow"),
      null,
      "if this model now exists, the probe was merely early rather than " +
        "fictional — revisit the whole card"
    );
  });

  it("the action does not cast prisma to invent optional models", () => {
    // The defect CLASS, not just its one instance: `prisma as unknown as
    // { someModel?: … }` compiles against any name at all, so a typo or a
    // model that was only ever planned degrades silently to `undefined`.
    assert.doesNotMatch(
      actionCode,
      /prisma as unknown as/,
      "casting the Prisma client to an optional-model shape defeats the " +
        "generated types — the compiler is what should have caught this"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The schema canaries — KEPT VERBATIM through the inversion.
//
//    These never asserted the cards' absence. They assert why the ORIGINAL
//    ticket (per-symbol FII/DII flow) was unbuildable, and they are how the
//    next reader learns that it has become buildable.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — per-symbol FII/DII flow still does not exist in the schema", () => {
  it("InstitutionalFlow is the FII/DII feed and is market-wide", () => {
    const model = prismaModel("InstitutionalFlow");
    assert.ok(model, "InstitutionalFlow model not found — did it move?");
    assert.match(
      model!,
      /@@unique\(\[date, category, segment\]\)/,
      "the market-wide grain is what makes per-stock FII/DII picks impossible; " +
        "if this key changed, re-derive the conclusion in the action's comment"
    );
  });

  it("[canary] InstitutionalFlow has no per-symbol dimension", () => {
    // POSITIVE CONTROL first. A field extractor that silently returns nothing
    // would make the canary below permanently, invisibly green — so prove it
    // finds `symbol` on a model that HAS one before trusting its absence on a
    // model that should not. (schema.prisma is not mutated to test this; the
    // control is a second, real model.)
    const deal = prismaModel("InstitutionalDeal");
    assert.ok(deal, "InstitutionalDeal not found — control is unusable");
    assert.ok(
      modelFields(deal!).includes("symbol"),
      "the field extractor cannot see `symbol` on InstitutionalDeal, which " +
        "definitely has one — the canary below proves nothing"
    );

    const fields = modelFields(prismaModel("InstitutionalFlow")!);
    assert.ok(fields.length >= 8, `only ${fields.length} fields parsed`);
    for (const forbidden of ["symbol", "instrumentId", "isin"]) {
      assert.ok(
        !fields.includes(forbidden),
        `InstitutionalFlow now has a \`${forbidden}\` field — REAL per-symbol ` +
          "FII/DII flow exists. MONEY-268's original model (sector flow × index " +
          "weight) is finally buildable, and these cards can be upgraded from " +
          "disclosed bulk/block prints to actual institutional flow."
      );
    }
  });

  it("[canary] StockShareholding's fii/dii remain a percent stake, not a flow", () => {
    // The other table that tempts a wiring attempt. It is quarterly ownership
    // PERCENT, so it can never fill a card captioned in ₹ — and on prod it held
    // 12 rows for one symbol (BEML), every value 0.
    const model = prismaModel("StockShareholding");
    assert.ok(model, "StockShareholding model not found — did it move?");
    assert.match(model!, /\bfii\s+Float\?/, "fii is a nullable percent");
    assert.match(model!, /\bdii\s+Float\?/, "dii is a nullable percent");
    assert.match(
      model!,
      /@@unique\(\[symbol, exchange, quarter\]\)/,
      "the QUARTERLY grain is the point — it is a stake, not a session flow"
    );
  });

  it("[canary] InstitutionalDeal still has no participant category of its own", () => {
    // This canary is UNCHANGED but its consequence is inverted. It used to say
    // "so the card cannot be built". It now says "so the FII/DII chip is
    // derived from `clientName` by an allowlist, and the moment NSE ships a
    // real category column we should read THAT instead of classifying text".
    const model = prismaModel("InstitutionalDeal");
    assert.ok(model, "InstitutionalDeal model not found — did it move?");
    assert.match(model!, /clientName\s+String/);
    const fields = modelFields(model!);
    assert.ok(
      !fields.includes("category") && !fields.includes("participant"),
      "InstitutionalDeal now carries a participant category — retire " +
        "classifyInstitutionalClient's name matching and read the column"
    );
  });

  it("[canary] the deal quantity is still BigInt", () => {
    // The service converts it deliberately (`dealQtyToNumber`) because
    // `Number()` past 2^53 loses precision silently. If this column is ever
    // narrowed to Int, that seam becomes dead weight; if a sibling column is
    // widened, it needs the same treatment.
    const model = prismaModel("InstitutionalDeal");
    assert.match(model!, /\bqty\s+BigInt\b/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Empty must stay distinguishable from an error — now in BOTH directions.
// ─────────────────────────────────────────────────────────────────────────────

describe("MONEY-268 — empty is not an error", () => {
  it("the picks are part of a SUCCESSFUL payload", () => {
    // The action must never signal this absence by failing. The rest of the
    // sector page is real data and has to render.
    assert.match(actionCode, /^\s*institutionalPicks,\s*$/m);
    assert.doesNotMatch(
      actionCode,
      /getSectorInstitutionalPicks[\s\S]{0,400}?\bthrow\b/,
      "a missing picks section must not throw out of the resolver"
    );
  });

  it("the empty state is an HONEST ZERO about the sector", () => {
    assert.ok(
      panel.includes("No bulk or block deals in this sector this week"),
      "the empty copy must state a fact about the sector, not about our deploy"
    );
  });

  it("[regression] a FAILED read says something different from an empty week", () => {
    // Collapsing them is what made the previous card unreadable: a permanent
    // structural absence and a transient outage looked identical.
    assert.match(panelCode, /failed\s*\?/);
    assert.ok(
      panel.includes("Couldn't load bulk & block deals just now."),
      "a failed read needs its own copy"
    );
  });

  it("the card renders copy rather than an error affordance when empty", () => {
    // PicksPanel branches on picks.length === 0 into the empty copy. If that
    // ever becomes a retry surface, a sector that simply had no prints this
    // week would start looking like a transient failure users should retry.
    assert.match(panelCode, /picks\.length === 0 \? \(/);
    assert.doesNotMatch(
      panelCode,
      /picks\.length === 0 \? \([\s\S]{0,600}?\b(retry|Retry|Try again)\b/,
      "a sector with no prints must not offer a retry"
    );
  });

  it("[regression] the caption only appears when numbers are on screen", () => {
    // Rendered unconditionally it contradicted the empty state directly above
    // it — the card said there was nothing and then captioned itself with a
    // metric, which reads as a broken feed rather than a quiet one.
    assert.match(
      panelCode,
      /picks\.length > 0 \? \([\s\S]{0,900}?From bulk &amp; block deals/,
      "the provenance caption must be inside the non-empty branch"
    );
  });

  it("the caption names the source and the window", () => {
    assert.ok(
      panel.includes("From bulk &amp; block deals reported to the exchange"),
      "the reader has to be able to tell what these rows are"
    );
    assert.match(panelCode, /sessions \?\? 7\}\s*sessions\./);
  });
});
