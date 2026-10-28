/**
 * SEBI shareholding-pattern (SHP) XBRL → per-category breakdown — MONEY-1205.
 *
 * Pure. No I/O, no Prisma, no clock. Give it the bytes of one filing, get back
 * one quarter's category breakdown or a reason it is not that.
 *
 * ## Why this module exists
 *
 * NSE's SUMMARY endpoint (`/api/corporate-shareholding`) carries promoter +
 * public + employee trusts + DRs and NOTHING ELSE. It has no FII/DII split at
 * all, so `ShareholdingPattern.fiiPct` / `.diiPct` were null on 100% of 7,953
 * prod rows — which renders to a user as "this company has no institutional
 * holders" rather than "we never fetched it". The split lives in the XBRL that
 * the same payload links from its `xbrl` key, which had never been fetched.
 *
 * ## The document
 *
 * `https://nsearchives.nseindia.com/corporate/xbrl/SHP_{id}_{ts}_WEB.xml`, an
 * XBRL instance against BSE's SHP taxonomy — which NSE also serves:
 *
 *     xmlns:in-bse-shp="http://www.bseindia.com/xbrl/shp/2025-10-31/in-bse-shp"
 *
 * Dispatch is on that DECLARED NAMESPACE, never on a tag guess — the same rule
 * `xbrl-financials-logic.ts` had to learn the expensive way. The version
 * segment is read, not required to be a particular value, so a 2026 revision of
 * the taxonomy is a data observation rather than a silent total failure.
 *
 * ## Facts are dimensioned; the CATEGORY is in the context, not the tag
 *
 * Every number in these filings is the SAME handful of elements repeated once
 * per shareholder category:
 *
 *     <in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares
 *        contextRef="InstitutionsForeignPortfolioInvestorCategoryOne_ContextI"
 *        decimals="INF" unitRef="pure">0.0954</…>
 *
 * and the context says which category:
 *
 *     <xbrli:context id="InstitutionsForeignPortfolioInvestorCategoryOne_ContextI">
 *       …<xbrldi:explicitMember dimension="in-bse-shp:CategoryOfShareholdersAxis"
 *          >in-bse-shp:InstitutionsForeignPortfolioInvestorCategoryOneMember</…>
 *
 * So the unit of work here is (member → facts), and a fact whose context is not
 * declared, or is declared without a `CategoryOfShareholdersAxis` member, is
 * unattributable and is COUNTED rather than guessed at.
 *
 * ## Three traps that are each worth the whole module
 *
 * ### 1. The percentages are FRACTIONS, not percents
 *
 * `unitRef="pure"` — XBRL's dimensionless ratio. Bank of Baroda's promoter
 * holding files as `0.6397`, and the summary row for the same quarter says
 * `"63.97"`. Writing the filing's number straight into a `…Pct` column turns a
 * 64%-promoter PSU into a 0.64%-promoter shell, with nothing anywhere to
 * contradict it.
 *
 * The scale is therefore DERIVED and never assumed — see {@link detectScale}.
 * The anchor is the grand total (`ShareholdingPatternMember`), which must be
 * 100% of itself: `1` ⇒ fractions, `100` ⇒ percents. A document whose scale
 * cannot be established is refused, not guessed.
 *
 * ### 2. The pledge percentage is NOT "of total number of shares"
 *
 * The element is literally named
 * `EncumberedShareUnderPledgedAsPercentageOfTotalNumberOfShares`, and under the
 * PROMOTER context it is the percentage of the PROMOTER'S OWN HOLDING.
 * BEDMUTHA Q1-FY27, measured:
 *
 *     promoter context   0.9499  → 94.99% of the promoter's 18,418,479 shares
 *     grand-total context 0.5423 → 54.23% of the company's 32,263,884 shares
 *
 * 17,496,105 pledged shares reconcile both ways, so neither number is wrong —
 * they answer different questions, and the element name answers the wrong one.
 * `promoterPledgedPct` takes the PROMOTER-context value, because "94% of the
 * promoter's stake is pledged" is what every consumer of that number means by
 * promoter pledge. See {@link PLEDGE_PCT}.
 *
 * ### 3. Absence is not zero, and this taxonomy is full of absence
 *
 * Measured on the four committed fixtures:
 *
 *   - CUB has NO promoter table at all (it has no promoter). `promoterPct` is
 *     null here while the summary row says `0`. Those are different facts and
 *     {@link reconcileWithSummary} treats the pair as INCOMPARABLE rather than
 *     as agreement or as a delta.
 *   - BHARTIARTL's Table IV total carries a share count (2,422,406) and NO
 *     percentage element. `nonPromoterNonPublicPct` is null while
 *     `employeeTrustPct` — its only leg — is 0.04.
 *   - BEDMUTHA files no `InstitutionsDomesticMember` and no
 *     `InstitutionsForeignMember`: a smallcap with no institutional holders at
 *     all. `fiiPct` and `diiPct` are null. This is where the temptation to
 *     write 0 is strongest and where it would be most wrong — "no institution
 *     filed" and "we could not read the institutions" must not collapse into
 *     the same number that "an institution reported zero" produces.
 *   - Bank of Baroda's `GovernmentsMember` IS a filed zero: 37,946 shares of
 *     5.17bn, which rounds to `0`. `govtPct` is 0, not null.
 *
 * `Number("")` is `0`, so every numeric read here goes through
 * {@link readRatio} / {@link readShares}, which return null for blank, `-` and
 * every other absence sentinel before any coercion can happen.
 *
 * ## Refusal, not a shrug
 *
 * {@link parseShareholdingXbrl} returns `null` — never `{}`, never zeros — when
 * the document is not a readable SHP filing, so the caller can refuse the write
 * and stay un-checkpointed. That is this repo's rule (`writeBseLegacyCash`
 * documents it; MONEY-1205 converted six more writers to it). Callers that need
 * to know WHY use {@link inspectShareholdingXbrl}, which returns the same parse
 * wrapped in a discriminated outcome — because "understood nothing" and "there
 * was nothing" rendering as the same number is the exact defect that emptied
 * `xbrl_filings` while every log line read as success.
 */

// ─── Namespace / taxonomy ────────────────────────────────────────────────────

/**
 * The SHP taxonomy namespace, `$`-anchored on the entry point.
 *
 * Anchoring is load-bearing: these documents also declare
 * `…/2025-10-31/in-bse-shp-types`, and an unanchored match binds the prefix of
 * whichever sibling schema happens to be declared first — which then finds zero
 * facts and reports a perfectly healthy filing as unreadable.
 */
const SHP_NAMESPACE_RE =
  /^https?:\/\/www\.bseindia\.com\/xbrl\/shp\/(\d{4}-\d{2}-\d{2})\/in-bse-shp$/;

const XBRL_INSTANCE_NS = "http://www.xbrl.org/2003/instance";
const XBRL_DIMENSIONS_NS = "http://xbrl.org/2006/xbrldi";

/** How many namespace URIs an `unknown-taxonomy` outcome reports back. */
const MAX_REPORTED_NS = 24;

/** The axis whose member names the shareholder category. */
const CATEGORY_AXIS_LOCAL = "CategoryOfShareholdersAxis";

// ─── Element names ───────────────────────────────────────────────────────────

const PCT_OF_TOTAL = "ShareholdingAsAPercentageOfTotalNumberOfShares";
const NUMBER_OF_SHARES = "NumberOfShares";
const NUMBER_OF_SHAREHOLDERS = "NumberOfShareholders";

/**
 * Promoter encumbrance. Read ONLY from the promoter context, where it means
 * "percentage of the promoter's own holding" despite its name — see the module
 * header, trap 2.
 */
const PLEDGE_PCT =
  "EncumberedShareUnderPledgedAsPercentageOfTotalNumberOfShares";

const TAG_SYMBOL = "Symbol";
const TAG_ISIN = "ISIN";
const TAG_SCRIP_CODE = "ScripCode";
const TAG_COMPANY = "NameOfTheCompany";
const TAG_DATE_OF_REPORT = "DateOfReport";

// ─── Category members ────────────────────────────────────────────────────────

/**
 * SEBI SHP members, by the role this module gives them.
 *
 * Values are ordered candidate lists so an alias observed later is a data
 * change. Every match is recorded in {@link ShareholdingBreakdownParse.memberHits}
 * — the falsification mechanism this repo uses everywhere a key set is partly
 * guessed: a candidate that never appears in `memberHits` across a prod run is
 * a candidate that does not exist.
 */
export const SHP_MEMBERS = {
  /** Table I grand total. Also the SCALE ANCHOR — it must be 100% of itself. */
  grandTotal: ["ShareholdingPatternMember"],
  /** Table II total. */
  promoter: ["ShareholdingOfPromoterAndPromoterGroupMember"],
  /** Table III total. */
  public: ["PublicShareholdingMember"],

  /** Table III (1) — the filing's OWN domestic-institutions total. */
  domesticInstitutions: ["InstitutionsDomesticMember"],
  /** Table III (2) — foreign-institutions total. A SUPERSET of FPI; see fii. */
  foreignInstitutions: ["InstitutionsForeignMember"],
  fpiCategoryOne: ["InstitutionsForeignPortfolioInvestorCategoryOneMember"],
  fpiCategoryTwo: ["InstitutionsForeignPortfolioInvestorCategoryTwoMember"],

  mutualFunds: ["MutualFundsOrUTIMember"],
  insurance: ["InsuranceCompaniesMember"],
  banks: ["BanksMember"],
  otherFinancialInstitutions: ["OtherFinancialInstitutionsMember"],
  alternativeInvestmentFunds: ["AlternativeInvestmentFundsMember"],
  providentPensionFunds: ["ProvidentFundsOrPensionFundsMember"],
  sovereignWealthFundsDomestic: ["SovereignWealthFundsDomesticMember"],
  nbfcs: ["NBFCsRegisteredWithRBIMember"],

  /**
   * Table III (3) — government holdings in the PUBLIC table.
   *
   * NOT `CentralGovernmentOrStateGovernmentSMember`, which is the Table II
   * PROMOTER member every PSU files. Confusing the two would report Bank of
   * Baroda's 63.97% government promoter as a public-side government holding
   * and double it against `promoterPct`.
   */
  governments: ["GovernmentsMember"],

  /** Retail = resident individuals holding up to ₹2 lakh nominal capital. */
  retail: [
    "ResidentIndividualShareholdersHoldingNominalShareCapitalUpToRsTwoLakhMember",
  ],

  /** Table IV total. */
  nonPromoterNonPublic: ["SharesHeldByNonPromoterNonPublicShareholdersMember"],
  /** Table IV (2). */
  employeeTrust: ["EmployeeBenefitsTrustsMember"],
  /**
   * Table IV (1), Custodian/DR Holder — UNCONFIRMED.
   *
   * Twelve live filings were inspected (four committed here, eight more
   * including WIPRO, which has ADRs) and NONE carries a Table IV custodian
   * member; the only DR-shaped member seen anywhere is
   * `OverseasDepositoriesMember`, which sits under Table III's FOREIGN
   * INSTITUTIONS as the DR balancing figure and is a different line. Prod's
   * 7,953 summary rows likewise carry `underlyingDrs` non-null ZERO times.
   *
   * These names are therefore GUESSES and are declared as such. A guessed
   * member matches nothing in exactly the way a real member matches nothing
   * when a company has no DRs, so the only thing that can tell them apart is
   * `memberHits` over a prod run. Until one of them appears there,
   * `custodianDrPct` staying null is the expected outcome and NOT evidence the
   * mapping works.
   */
  custodianDr: [
    "CustodianOrDRHolderMember",
    "SharesUnderlyingDRsMember",
    "CustodianMember",
  ],
} as const;

export type ShpMemberRole = keyof typeof SHP_MEMBERS;

// ─── Public types ────────────────────────────────────────────────────────────

/** Whether the filing states its percentages as 0–1 ratios or as 0–100. */
export type ShareholdingScale = "fraction" | "percent";

/** How {@link ShareholdingBreakdownParse.scale} was established. */
export type ScaleSource = "grand-total" | "share-ratio";

/**
 * Where `diiPct` came from.
 *
 * `filed` — the filing's own `InstitutionsDomesticMember` total.
 * `summed-legs` — no such total; the modelled legs were summed instead.
 *
 * The distinction is recorded per row because a summed total can only
 * UNDERSTATE. Bank of Baroda Q1-FY27, measured: the filed DII total is 18.42%,
 * while the legs this schema models (MF 9.78 + insurance 5.93 + banks/FI 0.06 +
 * AIF 0.24) come to 16.01% — 2.41 points of provident/pension, domestic
 * sovereign-wealth and NBFC holdings that have no column here and would simply
 * vanish. So the filed total wins whenever it exists, and when it does not the
 * row says so rather than presenting a floor as a fact.
 */
export type DiiTotalMode = "filed" | "summed-legs";

/**
 * Where `fiiPct` came from.
 *
 * `fpi-categories` — FPI Category I + Category II summed. This is the default
 * and the intended meaning: SEBI folded the old FII/QFI/sub-account regime into
 * FPI Cat I/II in 2014, so those two lines ARE the FII universe, and summing
 * two legs of one concept is not the same act as fabricating a total the filing
 * already states.
 *
 * `foreign-institutions-total` — fallback used only when NEITHER FPI line is
 * present. `InstitutionsForeignMember` is a SUPERSET: it also carries foreign
 * direct investment, foreign venture capital, foreign sovereign wealth funds
 * and the Overseas Depositories balancing figure (an ADR/GDR custodian pool,
 * not an investor). Folding a strategic FDI stake into "FII %" overstates
 * portfolio-flow exposure, which is what a reader takes that number to mean —
 * hence fallback, and hence recorded.
 *
 * On the committed fixtures the two agree to within a rounding hair
 * (BANKBARODA 10.14 vs 10.14, CUB 18.65 vs 18.65, BHARTIARTL 26.51 vs 26.52),
 * so the choice costs nothing today and is correct on the day a filer has real
 * FDI.
 */
export type FiiMode = "fpi-categories" | "foreign-institutions-total";

/** One shareholder category exactly as filed — the audit artifact for `raw`. */
export interface ShareholdingCategory {
  /** Percentage of total shares, 0–100, scale-normalised. Null if not filed. */
  pct: number | null;
  /** Verbatim share count as filed, or null. String so `raw` stays JSON-safe. */
  shares: string | null;
  /** Verbatim shareholder count as filed, or null. */
  shareholders: string | null;
}

/** One SHP filing, read. Every percentage is 0–100; every count is a BigInt. */
export interface ShareholdingBreakdownParse {
  // ── Identity ──────────────────────────────────────────────────────────────
  symbol: string | null;
  isin: string | null;
  scripCode: string | null;
  companyName: string | null;
  /** `DateOfReport` as `YYYY-MM-DD`, or null. */
  reportDate: string | null;
  /**
   * `YYYY-MM` of the report date — the join key against
   * `ShareholdingPattern.quarter`.
   *
   * Derived the same way `normalizeQuarter` derives it for a date-ish input
   * (year-month of the parsed date), which is what makes the two tables join
   * without a second spelling of the rule. Not IMPORTED from it: that function
   * lives in `@usemoney/research`, and `@usemoney/core` does not depend on it.
   */
  quarter: string | null;

  // ── Promoter ──────────────────────────────────────────────────────────────
  promoterPct: number | null;
  /** Percentage of the PROMOTER'S OWN HOLDING that is pledged — see trap 2. */
  promoterPledgedPct: number | null;

  // ── Institutional ─────────────────────────────────────────────────────────
  fiiPct: number | null;
  diiPct: number | null;
  mutualFundPct: number | null;
  insurancePct: number | null;
  /** Banks + Other Financial Institutions — both legs of one retail concept. */
  banksFiPct: number | null;
  alternateInvPct: number | null;
  govtPct: number | null;

  // ── Public and the rest ───────────────────────────────────────────────────
  publicPct: number | null;
  retailPct: number | null;
  employeeTrustPct: number | null;
  custodianDrPct: number | null;
  nonPromoterNonPublicPct: number | null;

  // ── Counts ────────────────────────────────────────────────────────────────
  promoterShares: bigint | null;
  fiiShares: bigint | null;
  diiShares: bigint | null;
  publicShares: bigint | null;
  totalShares: bigint | null;

  // ── Provenance ────────────────────────────────────────────────────────────
  /** Taxonomy version segment, e.g. `2025-10-31`. */
  taxonomyVersion: string;
  scale: ShareholdingScale;
  scaleSource: ScaleSource;
  diiMode: DiiTotalMode | null;
  fiiMode: FiiMode | null;
  /** Every recognised member, verbatim. Stringify into `ShareholdingBreakdown.raw`. */
  categories: Record<string, ShareholdingCategory>;
  /** Which candidate member actually matched, per role — the falsifier. */
  memberHits: Record<string, string>;
  /** Per-fact rejections, tallied. Same shape as the ownership parsers'. */
  reasons: Record<string, number>;
}

/**
 * Why a document produced no parse, or the parse itself.
 *
 * Exists so a caller can COUNT refusals by kind. A run that downloads 1,500
 * filings and writes 0 rows must be able to say whether that was 1,500 unknown
 * taxonomies or 1,500 successful reads of empty documents; collapsing both into
 * `null` is how `xbrl_filings` came to be empty behind green logs.
 */
export type ShareholdingXbrlOutcome =
  | { kind: "ok"; parse: ShareholdingBreakdownParse }
  | { kind: "empty-input" }
  | { kind: "not-xml" }
  | { kind: "unknown-taxonomy"; namespaces: string[] }
  | { kind: "no-categories"; reasons: Record<string, number> }
  | {
      kind: "scale-undeterminable";
      reasons: Record<string, number>;
      grandTotalText: string | null;
    }
  | { kind: "no-anchor"; reasons: Record<string, number> };

// ─── Scanning primitives ─────────────────────────────────────────────────────
//
// Deliberately the same linear regex scan `xbrl-financials-logic.ts` uses: one
// regex finds an opening tag, `indexOf` finds its close. No nested quantifier
// and no backreference, so no catastrophic backtracking on adversarial input,
// and no XML-parser dependency in a package apps/web imports.
//
// Those helpers are private to that module and this one does not reach into it:
// a cross-module private import is a coupling that breaks silently, and the
// scan is ~40 lines.

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `<pfx:Local attr="…">`, tolerating `>` inside quoted attributes. */
function openTagRe(prefix: string): RegExp {
  return new RegExp(
    `<${escapeRe(prefix)}:([A-Za-z0-9_.-]+)((?:[^>"']|"[^"]*"|'[^']*')*)(/?)>`,
    "g",
  );
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`${escapeRe(name)}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m?.[1] ?? null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

interface RawFact {
  local: string;
  contextRef: string;
  text: string;
}

function scanFacts(xml: string, prefix: string): RawFact[] {
  const out: RawFact[] = [];
  const open = openTagRe(prefix);
  const close = `</${prefix}:`;
  let m: RegExpExecArray | null;

  while ((m = open.exec(xml)) !== null) {
    const whole = m[0];
    const local = m[1] ?? "";
    const attrs = m[2] ?? "";
    // Self-closing = nil. No value, so not a fact — and crucially not a zero.
    if (m[3] === "/") continue;

    const start = m.index + whole.length;
    const end = xml.indexOf(`${close}${local}>`, start);
    if (end === -1) continue; // truncated mid-fact: drop it, keep the rest.

    const text = xml.slice(start, end);
    // Only leaf facts carry values; a nested element means this is a container.
    if (text.includes("<")) continue;

    out.push({
      local,
      contextRef: attr(attrs, "contextRef") ?? "",
      text: decodeXmlText(text).trim(),
    });
    open.lastIndex = end;
  }
  return out;
}

interface ContextIndex {
  /** contextId → `CategoryOfShareholdersAxis` member local name. */
  byCategory: Map<string, string>;
  /** EVERY declared context id, category-bearing or not. */
  declared: Set<string>;
}

/**
 * Index the contexts.
 *
 * Two maps rather than one because the two ways a fact can fail to be
 * attributed are diagnostically different, and collapsing them hides the only
 * one that is a problem:
 *
 *   - DECLARED but carrying no `CategoryOfShareholdersAxis` — `MainD`/`MainI`
 *     (identity facts) and the per-shareholder detail rows
 *     (`D_MutualFundsOrUTI_Context15`, `IndividualsOrHUF_Context17`, …) that
 *     name individual holders above 1% and split promoter lock-in and pledge
 *     holder by holder. These are EXPECTED, they number in the dozens on every
 *     healthy filing (22–46 across the four fixtures), and they are not
 *     category totals.
 *   - NOT DECLARED at all — a `contextRef` pointing at nothing. That is invalid
 *     XBRL and it does happen: `xbrl-financials-logic.ts` documents a BHARTIARTL
 *     filing that references two contexts it never declares. Here it would mean
 *     a category total we can see but cannot attribute, which is real data loss
 *     and is worth alerting on.
 *
 * A single counter mixing the two would sit at 22–46 forever and no rise would
 * ever be visible above it.
 */
function scanCategoryContexts(
  xml: string,
  instancePrefix: string,
  dimPrefix: string | null,
): ContextIndex {
  const out: ContextIndex = { byCategory: new Map(), declared: new Set() };

  const open = openTagRe(instancePrefix);
  const closeTag = `</${instancePrefix}:context>`;
  const memberRe =
    dimPrefix === null
      ? null
      : new RegExp(
          `<${escapeRe(dimPrefix)}:explicitMember\\s+dimension="([^"]*)"\\s*>([^<]*)<`,
          "g",
        );
  let m: RegExpExecArray | null;

  while ((m = open.exec(xml)) !== null) {
    const whole = m[0];
    const attrs = m[2] ?? "";
    if (m[1] !== "context" || m[3] === "/") continue;

    const start = m.index + whole.length;
    const end = xml.indexOf(closeTag, start);
    if (end === -1) break; // truncated: nothing after this can be a context.
    const body = xml.slice(start, end);
    open.lastIndex = end;

    const id = attr(attrs, "id");
    if (id === null) continue;
    out.declared.add(id);
    if (memberRe === null) continue;

    memberRe.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = memberRe.exec(body)) !== null) {
      if (localName(mm[1] ?? "") !== CATEGORY_AXIS_LOCAL) continue;
      const member = localName(decodeXmlText(mm[2] ?? "").trim());
      if (member !== "") out.byCategory.set(id, member);
    }
  }
  return out;
}

/** `in-bse-shp:FooMember` → `FooMember`. */
function localName(qname: string): string {
  const i = qname.lastIndexOf(":");
  return i === -1 ? qname : qname.slice(i + 1);
}

/**
 * The ROOT ELEMENT's attribute text.
 *
 * Scoped to the root rather than the whole document deliberately: these filings
 * carry free-text explanatory blocks containing arbitrary escaped content, and
 * a filer is free to paste a namespace URI into one. Every real declaration
 * sits on the root, so the narrower scan loses nothing and cannot be steered by
 * a filer's prose.
 */
function rootAttributes(xml: string): string | null {
  const m = /<([A-Za-z0-9_.-]+:)?xbrl(\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/.exec(
    xml,
  );
  return m === null ? null : (m[2] ?? "");
}

function namespaceDeclarations(rootAttrs: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /xmlns:([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rootAttrs)) !== null) out.push([m[1] ?? "", m[2] ?? ""]);
  return out;
}

// ─── Value readers — the "never 0" boundary ──────────────────────────────────

/**
 * Values that mean NOT REPORTED. Compared upper-cased and trimmed.
 *
 * `Number("")`, `Number(" ")` and `Number("\n")` are all `0`, and `-` is `NaN`
 * only by luck of JS parsing rather than by design. Everything that is not a
 * number we can defend is refused here, before any coercion exists to be got
 * wrong downstream.
 */
const BLANK_SENTINELS = new Set([
  "",
  "-",
  "--",
  "N.A.",
  "NA",
  "N/A",
  "NIL",
  "NONE",
  "NOT APPLICABLE",
  "NOT AVAILABLE",
]);

function isBlank(text: string): boolean {
  return BLANK_SENTINELS.has(text.trim().toUpperCase());
}

/** Strict decimal: optional sign, digits, optional fraction, optional exponent. */
const DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A filed ratio, in the filing's own scale. Null for absence or nonsense.
 *
 * Returns the RAW number: scaling to 0–100 happens once, in
 * {@link toPercent}, so a sum of legs is summed in the filing's own units and
 * rounded exactly once instead of accumulating rounding per leg.
 */
function readRatio(text: string | undefined): number | null {
  if (text === undefined || isBlank(text)) return null;
  const t = text.trim();
  if (!DECIMAL_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Filed ratio → percentage 0–100, rounded to 4dp.
 *
 * Rounding is not cosmetic: `0.6397 * 100` is `63.96999999999999` in IEEE-754,
 * and a `Float?` column storing that renders as `63.96999999999999%` and fails
 * every equality assertion a test could write. 4dp is the filings' own
 * precision (`decimals="INF"`, values to 4 decimal places as ratios).
 *
 * Out-of-range values are REFUSED rather than clamped — a percentage above 100
 * or below 0 means the scale detection or the document is wrong, and clamping
 * would hide exactly that. The 0.5 slack absorbs a filer whose legs round up
 * past their own total.
 */
function toPercent(raw: number, scale: ShareholdingScale): number | null {
  const pct = scale === "fraction" ? raw * 100 : raw;
  if (!Number.isFinite(pct) || pct < -0.5 || pct > 100.5) return null;
  return Math.round(pct * 1e4) / 1e4;
}

/**
 * A filed share count. BigInt because an Indian large cap's count exceeds what
 * a Number can hold exactly once multiplied by anything.
 *
 * Non-integer and negative counts are refused: there is no such thing as a
 * negative shareholding, and a fractional one means we are reading the wrong
 * element.
 */
function readShares(text: string | undefined): bigint | null {
  if (text === undefined || isBlank(text)) return null;
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  try {
    return BigInt(t);
  } catch {
    return null;
  }
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

// ─── Scale detection ─────────────────────────────────────────────────────────

interface ScaleVerdict {
  scale: ShareholdingScale;
  source: ScaleSource;
}

/**
 * Establish whether percentages are 0–1 ratios or already 0–100.
 *
 * PRIMARY — the grand total (`ShareholdingPatternMember`) is 100% of itself by
 * construction, so it is a self-validating anchor: `1` ⇒ fractions, `100` ⇒
 * percents. Anything else means we are not reading what we think we are, and
 * the document is refused rather than scaled by a guess.
 *
 * FALLBACK — no grand total, but a category with BOTH a percentage and a share
 * count plus a known total: `shares / totalShares` gives the true ratio, and
 * whichever interpretation of the stated percentage lands closer to it wins.
 * Deterministic, not a threshold heuristic on the value's magnitude — "is this
 * number bigger than 1.5" is undecidable for a company with a 1.2% promoter.
 *
 * A residual bound still applies to the fallback: if NEITHER reading is close,
 * the two numbers are not describing each other and we have learnt nothing.
 */
function detectScale(
  categories: Map<string, Map<string, string>>,
  reasons: Record<string, number>,
): ScaleVerdict | null {
  const total = categories.get(SHP_MEMBERS.grandTotal[0]);
  const totalPct = readRatio(total?.get(PCT_OF_TOTAL));

  if (totalPct !== null) {
    if (Math.abs(totalPct - 1) <= 0.02) {
      return { scale: "fraction", source: "grand-total" };
    }
    if (Math.abs(totalPct - 100) <= 2) {
      return { scale: "percent", source: "grand-total" };
    }
    bump(reasons, "grandTotalNotWhole");
  }

  const totalShares = readShares(total?.get(NUMBER_OF_SHARES));
  if (totalShares === null || totalShares === ZERO_SHARES) return null;

  for (const [member, facts] of categories) {
    if (member === SHP_MEMBERS.grandTotal[0]) continue;
    const pct = readRatio(facts.get(PCT_OF_TOTAL));
    const shares = readShares(facts.get(NUMBER_OF_SHARES));
    if (pct === null || shares === null || shares === ZERO_SHARES) continue;

    // Ratio in [0,1]. Number() on the quotient of two BigInts is exact enough:
    // both are ≤ ~1e13 and we only need 4 significant decimals.
    const trueRatio = Number(shares) / Number(totalShares);
    if (!Number.isFinite(trueRatio)) continue;

    const asFraction = Math.abs(pct - trueRatio);
    const asPercent = Math.abs(pct / 100 - trueRatio);
    const best = Math.min(asFraction, asPercent);
    // 0.0005 in ratio terms = 0.05 percentage points: tighter than any real
    // rounding difference, looser than the gap between the two readings for
    // anything above 0.05% — and a category below that is skipped by the
    // `shares === ZERO_SHARES` guard or fails this bound and we try the next one.
    if (best > 0.0005) continue;

    return {
      scale: asFraction <= asPercent ? "fraction" : "percent",
      source: "share-ratio",
    };
  }

  return null;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Read one SHP XBRL filing.
 *
 * Returns `null` — never `{}`, never a row of zeros — for anything that is not
 * a readable SHP filing, so the caller can refuse the write and stay
 * un-checkpointed. Use {@link inspectShareholdingXbrl} when the refusal reason
 * needs counting.
 *
 * Accepts bytes or text; bytes are decoded as UTF-8, which is what every
 * observed filing declares.
 */
export function parseShareholdingXbrl(
  input: string | Uint8Array | ArrayBuffer,
): ShareholdingBreakdownParse | null {
  const outcome = inspectShareholdingXbrl(input);
  return outcome.kind === "ok" ? outcome.parse : null;
}

/** {@link parseShareholdingXbrl}, with the refusal reason preserved. */
export function inspectShareholdingXbrl(
  input: string | Uint8Array | ArrayBuffer,
): ShareholdingXbrlOutcome {
  const xml = toText(input);
  if (xml.trim() === "") return { kind: "empty-input" };

  const rootAttrs = rootAttributes(xml);
  if (rootAttrs === null) return { kind: "not-xml" };

  const declarations = namespaceDeclarations(rootAttrs);
  let shpPrefix: string | null = null;
  let taxonomyVersion = "";
  for (const [prefix, uri] of declarations) {
    const m = SHP_NAMESPACE_RE.exec(uri);
    if (m !== null) {
      shpPrefix = prefix;
      taxonomyVersion = m[1] ?? "";
      break;
    }
  }
  if (shpPrefix === null) {
    return {
      kind: "unknown-taxonomy",
      namespaces: declarations.map(([, uri]) => uri).slice(0, MAX_REPORTED_NS),
    };
  }

  const instancePrefix = prefixForNamespace(rootAttrs, XBRL_INSTANCE_NS);
  const dimPrefix = prefixForNamespace(rootAttrs, XBRL_DIMENSIONS_NS);

  const reasons: Record<string, number> = {};
  const facts = scanFacts(xml, shpPrefix);
  const contexts: ContextIndex =
    instancePrefix === null
      ? { byCategory: new Map(), declared: new Set() }
      : scanCategoryContexts(xml, instancePrefix, dimPrefix);

  // member → element → text. Last write wins within a member, which matches the
  // ownership parsers' restatement rule: a repeated fact is a correction.
  const categories = new Map<string, Map<string, string>>();
  const identity = new Map<string, string>();

  for (const fact of facts) {
    const member = contexts.byCategory.get(fact.contextRef);
    if (member === undefined) {
      // Identity facts live in the undimensioned `MainD`/`MainI` contexts.
      if (IDENTITY_TAGS.has(fact.local)) {
        identity.set(fact.local, fact.text);
      } else if (NUMERIC_TAGS.has(fact.local)) {
        // A number we cannot attribute to a category is a number we must not
        // use. Split so the benign case cannot mask the harmful one — see
        // {@link scanCategoryContexts}.
        bump(
          reasons,
          contexts.declared.has(fact.contextRef)
            ? "nonCategoryContext"
            : "undeclaredContext",
        );
      }
      continue;
    }
    let bucket = categories.get(member);
    if (bucket === undefined) {
      bucket = new Map<string, string>();
      categories.set(member, bucket);
    }
    bucket.set(fact.local, fact.text);
  }

  if (categories.size === 0) return { kind: "no-categories", reasons };

  const verdict = detectScale(categories, reasons);
  if (verdict === null) {
    return {
      kind: "scale-undeterminable",
      reasons,
      grandTotalText:
        categories.get(SHP_MEMBERS.grandTotal[0])?.get(PCT_OF_TOTAL) ?? null,
    };
  }
  const { scale, source: scaleSource } = verdict;

  const memberHits: Record<string, string> = {};

  /** First candidate member for `role` that this filing actually carries. */
  const findRole = (role: ShpMemberRole): Map<string, string> | null => {
    for (const candidate of SHP_MEMBERS[role]) {
      const facts_ = categories.get(candidate);
      if (facts_ !== undefined) {
        memberHits[role] = candidate;
        return facts_;
      }
    }
    return null;
  };

  /** Filed percentage for `role`, scale-normalised. */
  const pctOf = (role: ShpMemberRole): number | null => {
    const raw = readRatio(findRole(role)?.get(PCT_OF_TOTAL));
    if (raw === null) return null;
    const pct = toPercent(raw, scale);
    if (pct === null) bump(reasons, "pctOutOfRange");
    return pct;
  };

  const sharesOf = (role: ShpMemberRole): bigint | null =>
    readShares(findRole(role)?.get(NUMBER_OF_SHARES));

  /** Sum of legs in the FILING's units, or null when no leg is present. */
  const sumRatios = (roles: readonly ShpMemberRole[]): number | null => {
    let acc = 0;
    let seen = false;
    for (const role of roles) {
      const raw = readRatio(findRole(role)?.get(PCT_OF_TOTAL));
      if (raw === null) continue;
      acc += raw;
      seen = true;
    }
    return seen ? acc : null;
  };

  const sumShares = (roles: readonly ShpMemberRole[]): bigint | null => {
    let acc = ZERO_SHARES;
    let seen = false;
    for (const role of roles) {
      const s = readShares(findRole(role)?.get(NUMBER_OF_SHARES));
      if (s === null) continue;
      acc += s;
      seen = true;
    }
    return seen ? acc : null;
  };

  // ── FII: FPI Cat I + Cat II, falling back to the foreign total ────────────
  const FPI_ROLES = ["fpiCategoryOne", "fpiCategoryTwo"] as const;
  const fpiRatio = sumRatios(FPI_ROLES);
  let fiiMode: FiiMode | null = null;
  let fiiPct: number | null = null;
  let fiiShares: bigint | null = null;
  if (fpiRatio !== null) {
    fiiMode = "fpi-categories";
    fiiPct = toPercent(fpiRatio, scale);
    if (fiiPct === null) bump(reasons, "pctOutOfRange");
    fiiShares = sumShares(FPI_ROLES);
  } else {
    const foreignPct = pctOf("foreignInstitutions");
    const foreignShares = sharesOf("foreignInstitutions");
    if (foreignPct !== null || foreignShares !== null) {
      fiiMode = "foreign-institutions-total";
      fiiPct = foreignPct;
      fiiShares = foreignShares;
    }
  }

  // ── DII: the filing's OWN total; legs only when it states none ────────────
  const DII_LEG_ROLES = [
    "mutualFunds",
    "insurance",
    "banks",
    "otherFinancialInstitutions",
    "alternativeInvestmentFunds",
    "providentPensionFunds",
    "sovereignWealthFundsDomestic",
    "nbfcs",
  ] as const;
  const filedDiiPct = pctOf("domesticInstitutions");
  const filedDiiShares = sharesOf("domesticInstitutions");
  let diiMode: DiiTotalMode | null = null;
  let diiPct: number | null = null;
  let diiShares: bigint | null = null;
  if (filedDiiPct !== null || filedDiiShares !== null) {
    diiMode = "filed";
    diiPct = filedDiiPct;
    diiShares = filedDiiShares;
  } else {
    const legRatio = sumRatios(DII_LEG_ROLES);
    const legShares = sumShares(DII_LEG_ROLES);
    if (legRatio !== null || legShares !== null) {
      diiMode = "summed-legs";
      diiPct = legRatio === null ? null : toPercent(legRatio, scale);
      if (legRatio !== null && diiPct === null) bump(reasons, "pctOutOfRange");
      diiShares = legShares;
    }
  }

  // ── Banks/FIs: two legs of one retail concept, never a filed total ────────
  const banksRatio = sumRatios(["banks", "otherFinancialInstitutions"]);
  const banksFiPct = banksRatio === null ? null : toPercent(banksRatio, scale);
  if (banksRatio !== null && banksFiPct === null)
    bump(reasons, "pctOutOfRange");

  // ── Promoter pledge — the promoter context, NOT the grand total ───────────
  const promoterFacts = findRole("promoter");
  const pledgeRaw = readRatio(promoterFacts?.get(PLEDGE_PCT));
  const promoterPledgedPct =
    pledgeRaw === null ? null : toPercent(pledgeRaw, scale);
  if (pledgeRaw !== null && promoterPledgedPct === null) {
    bump(reasons, "pledgePctOutOfRange");
  }

  const promoterPct = pctOf("promoter");
  const publicPct = pctOf("public");
  const totalShares = sharesOf("grandTotal");

  // An anchor is what makes the row about a COMPANY rather than about a
  // fragment. Without any of promoter / public / a total share count, whatever
  // we read is unmoored and must not be written.
  if (promoterPct === null && publicPct === null && totalShares === null) {
    return { kind: "no-anchor", reasons };
  }

  const reportDate = toIsoDate(identity.get(TAG_DATE_OF_REPORT));

  return {
    kind: "ok",
    parse: {
      symbol: cleanText(identity.get(TAG_SYMBOL)),
      isin: cleanText(identity.get(TAG_ISIN)),
      scripCode: cleanText(identity.get(TAG_SCRIP_CODE)),
      companyName: cleanText(identity.get(TAG_COMPANY)),
      reportDate,
      quarter: reportDate === null ? null : reportDate.slice(0, 7),

      promoterPct,
      promoterPledgedPct,

      fiiPct,
      diiPct,
      mutualFundPct: pctOf("mutualFunds"),
      insurancePct: pctOf("insurance"),
      banksFiPct,
      alternateInvPct: pctOf("alternativeInvestmentFunds"),
      govtPct: pctOf("governments"),

      publicPct,
      retailPct: pctOf("retail"),
      employeeTrustPct: pctOf("employeeTrust"),
      custodianDrPct: pctOf("custodianDr"),
      nonPromoterNonPublicPct: pctOf("nonPromoterNonPublic"),

      promoterShares: sharesOf("promoter"),
      fiiShares,
      diiShares,
      publicShares: sharesOf("public"),
      totalShares,

      taxonomyVersion,
      scale,
      scaleSource,
      diiMode,
      fiiMode,
      categories: buildCategoryRecord(categories, scale),
      memberHits,
      reasons,
    },
  };
}

/** Identity facts, which live in the UNDIMENSIONED contexts. */
const IDENTITY_TAGS = new Set([
  TAG_SYMBOL,
  TAG_ISIN,
  TAG_SCRIP_CODE,
  TAG_COMPANY,
  TAG_DATE_OF_REPORT,
]);

/** Numeric facts worth counting when they cannot be attributed to a category. */
const NUMERIC_TAGS = new Set([PCT_OF_TOTAL, NUMBER_OF_SHARES, PLEDGE_PCT]);

/**
 * Every recognised member, verbatim, for `ShareholdingBreakdown.raw`.
 *
 * Includes members this schema has no column for — provident funds, domestic
 * sovereign wealth, NBFCs, foreign nationals, the promoter sub-categories. That
 * is the point: `raw` exists to be RE-PARSED from when the taxonomy shifts or a
 * column is added, and a `raw` filtered down to today's columns cannot serve
 * that. Share counts stay STRINGS so the record is `JSON.stringify`-able —
 * BigInt throws there, and a `raw` that cannot be serialised is not an audit
 * artifact.
 */
function buildCategoryRecord(
  categories: Map<string, Map<string, string>>,
  scale: ShareholdingScale,
): Record<string, ShareholdingCategory> {
  const out: Record<string, ShareholdingCategory> = {};
  for (const [member, facts] of categories) {
    const raw = readRatio(facts.get(PCT_OF_TOTAL));
    out[member] = {
      pct: raw === null ? null : toPercent(raw, scale),
      shares: nonBlank(facts.get(NUMBER_OF_SHARES)),
      shareholders: nonBlank(facts.get(NUMBER_OF_SHAREHOLDERS)),
    };
  }
  return out;
}

function nonBlank(text: string | undefined): string | null {
  if (text === undefined || isBlank(text)) return null;
  return text.trim();
}

function cleanText(text: string | undefined): string | null {
  if (text === undefined) return null;
  const t = text.trim();
  return t === "" ? null : t;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `DateOfReport` → `YYYY-MM-DD`, or null.
 *
 * Validated rather than trusted: a malformed date would produce a malformed
 * `quarter`, and `quarter` is half of this table's unique key.
 */
function toIsoDate(text: string | undefined): string | null {
  if (text === undefined) return null;
  const t = text.trim();
  const m = ISO_DATE_RE.exec(t);
  if (m === null) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return t;
}

function prefixForNamespace(rootAttrs: string, uri: string): string | null {
  const re = new RegExp(`xmlns:([A-Za-z0-9_.-]+)\\s*=\\s*"${escapeRe(uri)}"`);
  return re.exec(rootAttrs)?.[1] ?? null;
}

function toText(input: string | Uint8Array | ArrayBuffer): string {
  if (typeof input === "string") return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return new TextDecoder("utf-8").decode(bytes);
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

/**
 * The already-stored SUMMARY row this breakdown claims to describe.
 *
 * Deliberately a plain shape rather than the Prisma model: this module is pure
 * and must stay testable without a database.
 */
export interface ShareholdingSummarySnapshot {
  symbol: string;
  /** `YYYY-MM`, as `normalizeQuarter` produces it. */
  quarter: string;
  promoterPct: number | null;
  publicPct: number | null;
  isin?: string | null;
}

/** Which identity or value check failed. */
export type ReconcileMismatch =
  | "symbol"
  | "quarter"
  | "promoterPct"
  | "publicPct";

/**
 * The verdict a caller acts on.
 *
 * `agree` — at least one field was comparable and every comparable field
 * matched within tolerance. Safe to write.
 * `disagree` — a comparable field did not match, or the document names a
 * different company or quarter. REFUSE the write; do not overwrite.
 * `incomparable` — identity matched (or could not be checked) and no value
 * field had a non-null on both sides. Not evidence of agreement, so the caller
 * decides; but it is not evidence of a conflict either.
 */
export type ReconcileVerdict =
  | {
      status: "agree";
      checked: ReconcileMismatch[];
      maxDeltaPct: number;
      isinMismatch: boolean;
    }
  | {
      status: "disagree";
      field: ReconcileMismatch;
      breakdownValue: string | number | null;
      summaryValue: string | number | null;
      deltaPct: number | null;
    }
  | { status: "incomparable"; reason: string; isinMismatch: boolean };

/**
 * Default tolerance in PERCENTAGE POINTS.
 *
 * The summary endpoint publishes 2dp (`"63.97"`); the XBRL publishes 4dp
 * ratios. 0.5pp is far wider than that rounding and far tighter than any real
 * difference between two companies or two quarters — the smallest promoter gap
 * between distinct fixtures here is 6.6pp (BEDMUTHA 57.09 vs BANKBARODA 63.97),
 * and a wrong-company match would have to be a coincidence to land inside it.
 */
/**
 * `BigInt(0)`, not the `0n` literal.
 *
 * `packages/core` targets ES2022 so `0n` compiles here — but `apps/web` targets
 * es2017, and this module reaches it through the market-data barrel. A BigInt
 * LITERAL is a syntax-level feature (TS2737) while the `BigInt()` call is not,
 * so the literal builds green in its own package and breaks the consumer. Share
 * counts must stay BigInt: an Indian large cap's count exceeds 2^53.
 */
const ZERO_SHARES = BigInt(0);

export const RECONCILE_TOLERANCE_PCT = 0.5;

/**
 * Does this breakdown describe the same (company, quarter) as the summary row
 * we already store?
 *
 * ## Why this is not optional
 *
 * The XBRL URL comes out of the summary payload, so a mis-keyed row, a reused
 * `recordId` or a restated filing pointing at the wrong document all land here
 * as a perfectly valid filing for the WRONG company. `ShareholdingBreakdown` is
 * upserted on `(symbol, exchange, quarter)` with last-filing-wins, so an
 * unchecked write silently replaces a correct row with another company's
 * numbers, and nothing downstream can tell.
 *
 * ## Why ISIN is reported but never fails the check
 *
 * Measured on prod: NSE's own summary payload and NSE's own XBRL disagree on
 * ISIN for 2 of 5 sampled symbols — BANKBARODA is `IN9028A01011` in the summary
 * and `INE028A01039` in the filing; CUB is `IN9491A01011` against
 * `INE491A01021`. Both filings are unambiguously the right company by symbol,
 * quarter and every percentage. Treating ISIN as authoritative would therefore
 * reject 40% of a healthy sample, so it is surfaced as `isinMismatch` for
 * whoever wants to investigate and is not allowed to block a write.
 *
 * ## Why a null and a zero are INCOMPARABLE, not a 100% delta
 *
 * CUB files no promoter table at all — it has no promoter — so the breakdown's
 * `promoterPct` is null while the summary says `0`. Scoring that as a
 * disagreement would reject every promoter-less company; scoring it as
 * agreement would assert we verified something we did not. It is neither, and
 * the verdict says so.
 */
export function reconcileWithSummary(
  breakdown: Pick<
    ShareholdingBreakdownParse,
    "symbol" | "quarter" | "promoterPct" | "publicPct" | "isin"
  >,
  summary: ShareholdingSummarySnapshot,
  tolerancePct: number = RECONCILE_TOLERANCE_PCT,
): ReconcileVerdict {
  const isinMismatch =
    breakdown.isin !== null &&
    typeof summary.isin === "string" &&
    summary.isin.trim() !== "" &&
    breakdown.isin.trim().toUpperCase() !== summary.isin.trim().toUpperCase();

  const bSymbol = normalizeSymbol(breakdown.symbol);
  const sSymbol = normalizeSymbol(summary.symbol);
  if (bSymbol !== null && sSymbol !== null && bSymbol !== sSymbol) {
    return {
      status: "disagree",
      field: "symbol",
      breakdownValue: bSymbol,
      summaryValue: sSymbol,
      deltaPct: null,
    };
  }

  const bQuarter = cleanText(breakdown.quarter ?? undefined);
  const sQuarter = cleanText(summary.quarter);
  if (bQuarter !== null && sQuarter !== null && bQuarter !== sQuarter) {
    return {
      status: "disagree",
      field: "quarter",
      breakdownValue: bQuarter,
      summaryValue: sQuarter,
      deltaPct: null,
    };
  }

  const checked: ReconcileMismatch[] = [];
  let maxDeltaPct = 0;

  const pairs: Array<[ReconcileMismatch, number | null, number | null]> = [
    ["promoterPct", breakdown.promoterPct, summary.promoterPct],
    ["publicPct", breakdown.publicPct, summary.publicPct],
  ];

  for (const [field, a, b] of pairs) {
    // One side null = we never compared them. Never a delta, never agreement.
    if (a === null || b === null) continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const delta = Math.abs(a - b);
    if (delta > tolerancePct) {
      return {
        status: "disagree",
        field,
        breakdownValue: a,
        summaryValue: b,
        deltaPct: Math.round(delta * 1e4) / 1e4,
      };
    }
    checked.push(field);
    if (delta > maxDeltaPct) maxDeltaPct = delta;
  }

  if (checked.length === 0) {
    return {
      status: "incomparable",
      reason:
        bSymbol === null || sSymbol === null
          ? "noSymbolOnOneSide"
          : "noComparableValue",
      isinMismatch,
    };
  }

  return {
    status: "agree",
    checked,
    maxDeltaPct: Math.round(maxDeltaPct * 1e4) / 1e4,
    isinMismatch,
  };
}

/** Upper-cased, `.NS`/`.BO` stripped — the same shape the ownership feeds use. */
function normalizeSymbol(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const t = value
    .trim()
    .toUpperCase()
    .replace(/\.(NS|BO)$/, "");
  return t === "" ? null : t;
}
