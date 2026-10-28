/**
 * BSE shareholding-pattern provider (MONEY-1205).
 *
 * The NSE path (`ownership-sync` -> `/api/corporate-shareholding`) serves
 * NSE-listed symbols only, so every BSE-only company has no shareholding data
 * and no way to get any. Measured on prod 2026-08-18: 7,953
 * `shareholding_patterns` rows across 440 distinct symbols, `exchange` "NSE" on
 * 100% of them, and 8,139 active BSE-only equity names with nothing at all.
 *
 * ## How the endpoints were found
 *
 * NOT guessed. A guessed URL 404s (or, far worse here, 200s with zeros —
 * see the skeleton trap below) exactly like "this company never filed", so the
 * endpoints were recovered by reading BSE's own Angular bundle,
 * `https://www.bseindia.com/assets/includenew/js/main-*.js`, the same method
 * that recovered the price-history endpoint. The relevant constants are in the
 * bundle's `B.url` map:
 *
 *   sHPQNewFormat             : "/SHPQNewFormat/w"
 *   corporatesSHPSecuritybeta : "/CorporatesSHPSecuritybeta/w"
 *   corp_shpSec_SHPPubShold_ng: "/Corp_shpSec_SHPPubShold_ng/w"
 *
 * and the call sites (`GetquoteShareholdingPatternComponent.getShpData`,
 * `GetquoteShareholdingPatternArchiveComponent.getShpData`) supply the
 * parameter names. Every URL below was then verified live against real scrip
 * codes and captured into `__tests__/fixtures/bse-shp/`.
 *
 * ## Traps, all of them measured
 *
 * 1. THE ZERO SKELETON. This is the `Seg=`-empty trap in a nastier form. A
 *    scrip code that never filed for a quarter, a BOGUS scrip code (999999),
 *    and a BOGUS qtrid (9999) all return **HTTP 200** carrying a complete
 *    SEBI category skeleton in `Table1` with every numeric field set to
 *    `0.00`. There is no error, no empty array, no 404. A parser that reads
 *    `Table1` and stops would write a fully-formed "promoter 0%, public 0%,
 *    pledge 0%" pattern for a company that filed nothing — fabricated
 *    all-clear data, indistinguishable from a real filing downstream.
 *
 *    The liveness gate is the METADATA tables, not the data table: a real
 *    filing has `Table.length === 1` (the transaction/declaration row) AND
 *    `Table3.length === 1` (scrip + quarter dates). The skeleton has BOTH
 *    empty while `Table1` still holds 6 zero rows. {@link parseBseShareholding}
 *    returns `null` on that, so a caller refuses the write and stays
 *    un-checkpointed.
 *
 * 2. `qtrid` vs `qtrcode`. The parameter name is NOT the same across the two
 *    data endpoints, and the wrong one also fails softly:
 *      /CorporatesSHPSecuritybeta/w   takes `qtrid`
 *      /Corp_shpSec_SHPPubShold_ng/w  takes `qtrcode`
 *    Calling `Corp_shpSec_SHPPubShold_ng` with `qtrid=` returns 200 with
 *    `"Table": []` — i.e. it silently drops the metadata table that gate 1
 *    depends on — while `Table1` still populates. Measured, both ways.
 *
 * 3. `Corp_shpSec_SHPSUMMARY_ng` is NOT interchangeable with
 *    `CorporatesSHPSecuritybeta` even though both return the same summary
 *    table. SHPSUMMARY coerces unreported columns to `0`
 *    (`Fld_NoOfPartlyPaidShares: 0`) where Securitybeta preserves `null`.
 *    Securitybeta is used here because absence must stay absence, and it is
 *    also what BSE's own live SHP page calls.
 *
 * 4. HEADER ROWS FABRICATE ZEROS. In the public-shareholder payload each
 *    institution block is preceded by a header row with the same
 *    `Fld_SubCategory` as its total, `Fld_Level: null`, and every figure `0`.
 *    Keying on `Fld_SubCategory` alone picks the header (first match) and
 *    writes DII/FII as 0. The rollup is the row whose `Fld_Level` starts with
 *    `"Sub Total"`. See {@link readPublicDetail}.
 *
 * 5. PLEDGE IS NOT ENCUMBRANCE. `Fld_PledgeEncumberedPercentage` covers pledge
 *    only; BSE reports NDU (non-disposal undertaking) and "other encumbrances"
 *    separately and totals them in `Fld_TotalencumberedPercentage`. Vedanta
 *    (500295, Jun-2026) reports `Fld_IsPledge: false`, `pledgePct: null` and
 *    `totalEncumberedPct: 99.99`. Mapping only pledge and dropping the total
 *    would report a 99.99%-encumbered promoter as unencumbered, so
 *    {@link BseShareholdingParse} surfaces both and counts
 *    `encumbranceExceedsPledge` when they diverge.
 *
 * ## Quarter identity
 *
 * `normalizeQuarter` is INJECTED ({@link BseShareholdingDeps}), not
 * reimplemented and not imported. It lives in
 * `packages/research/src/data-sources/ownership-logic.ts`, and
 * `packages/research` depends on `@usemoney/core` — not the reverse — so core
 * importing it would invert the dependency graph. The same constraint is
 * already documented in `bse-master-logic.ts`, which duplicates BSE envelope
 * knowledge for exactly this reason. Injection keeps ONE spelling of the rule:
 * the worker passes the real function, so `ShareholdingPattern.quarter` and
 * `ShareholdingBreakdown.quarter` written from BSE key identically to the NSE
 * rows and the two join. The permanent fix is to hoist `normalizeQuarter` into
 * core and have research re-export it; that is a cross-package move and is out
 * of scope for a new-files-only change.
 *
 * The value fed to it is `Table3[0].fld_enddate` — the quarter END date, e.g.
 * `"30 Jun 2026"` -> `"2026-06"`. It is used in preference to
 * `fld_quartername` because that field is NULL on real filings (ATV Projects
 * 500028 Jun-2026 has `fld_quartername: null`, `fld_enddate: "30 Jun 2026"`).
 *
 * ## I/O seam
 *
 * Fetch and parse are separate exported functions and every fetch goes through
 * `getFeedAsset`, so archive/replay applies without touching this module. Note
 * for whoever wires the schedule: these endpoints are PER SCRIP, so archiving
 * them at full universe scale writes ~10k objects per quarter per feed. That is
 * a real ops decision, not a detail — see the note on
 * {@link BSE_SHP_SUMMARY_FEED}.
 */

import { BSE_REFERER } from "../exchange-feed";
import { getFeedAsset } from "../feed-archive";

// ── Endpoint construction ────────────────────────────────────────────────────

/** BSE's public JSON API. Same host/base as the scrip master we already use. */
export const BSE_SHP_API_BASE = "https://api.bseindia.com/BseIndiaAPI/api";

/** Feed slugs for the archive key. Kept distinct so replay can be reasoned about per leg. */
export const BSE_SHP_QUARTER_INDEX_FEED = "shp-quarter-index";
/**
 * Summary leg. One archived object per (scrip, quarter) — ~10k per quarter at
 * universe scale. Left DATED-less on purpose: the descriptor takes no `date`,
 * so the key lands under `current/` and a re-run overwrites in place rather
 * than accumulating a new object per run.
 */
export const BSE_SHP_SUMMARY_FEED = "shp-summary";
/** Public-shareholder breakdown leg. Same volume characteristics. */
export const BSE_SHP_PUBLIC_FEED = "shp-public";

/**
 * All quarters BSE holds for a scrip, newest first. NO date parameter — one
 * call returns the entire history (105 quarters for scrip 500014, back to
 * ~2001), which is what makes a backfill cheap.
 */
export function bseShpQuarterIndexUrl(scripCode: string): string {
  return `${BSE_SHP_API_BASE}/SHPQNewFormat/w?scripcode=${encodeURIComponent(scripCode)}`;
}

/**
 * Summary (A / B / C rollup) for one quarter.
 *
 * Parameter is `qtrid`. See trap 2 in the module header — the sibling endpoint
 * spells the same concept `qtrcode`, and neither errors on the other's name.
 */
export function bseShpSummaryUrl(scripCode: string, qtrId: string): string {
  return (
    `${BSE_SHP_API_BASE}/CorporatesSHPSecuritybeta/w` +
    `?scripcode=${encodeURIComponent(scripCode)}&qtrid=${encodeURIComponent(qtrId)}`
  );
}

/**
 * Public-shareholder breakdown (the FII / DII / mutual-fund / retail legs).
 *
 * Parameter is `qtrcode`, NOT `qtrid`. Passing `qtrid` here returns 200 with
 * `"Table": []`, which silently disarms the liveness gate.
 */
export function bseShpPublicUrl(scripCode: string, qtrId: string): string {
  return (
    `${BSE_SHP_API_BASE}/Corp_shpSec_SHPPubShold_ng/w` +
    `?scripcode=${encodeURIComponent(scripCode)}&qtrcode=${encodeURIComponent(qtrId)}`
  );
}

// ── Types ────────────────────────────────────────────────────────────────────

/** One entry of the per-scrip quarter index. */
export interface BseShpQuarter {
  /**
   * BSE's quarter handle, passed back verbatim as `qtrid`/`qtrcode`.
   *
   * A STRING, deliberately. It is fractional for revisions — a re-filed
   * June-2026 is `130.01` while the original is `130` — and round-tripping it
   * through a JS number then back to a string yields "130.01" only by luck of
   * formatting. Keeping the source text means the value we send is byte-for-byte
   * the value BSE published.
   */
  qtrId: string;
  /** BSE's own label, e.g. "June 2026". Not the canonical key. */
  label: string;
  /** "New" | "Revised" (verbatim). */
  status: string;
  /** Filing timestamp, verbatim. */
  filedAt: string | null;
  /** Relative path of the XBRL rendering, when present. */
  xbrlUrl: string | null;
}

/** Percentages + counts for one category line. */
export interface BseShpLeg {
  pct: number | null;
  shares: number | null;
}

/**
 * The parse result for ONE (scrip, quarter).
 *
 * Split to match the two sinks it feeds: `summary` -> `ShareholdingPattern`,
 * `breakdown` -> `ShareholdingBreakdown`. No new sink is invented.
 */
export interface BseShareholdingParse {
  /** BSE scrip code, echoed from the payload metadata (not from the request). */
  scripCode: string;
  companyName: string | null;
  /** Canonical `YYYY-MM`, from the injected `normalizeQuarter`. */
  quarter: string;
  /** `fld_enddate` verbatim, e.g. "30 Jun 2026". */
  quarterRaw: string;
  /** BSE's quarter handle this parse came from. */
  qtrId: string;

  /** Maps 1:1 onto `ShareholdingPattern`'s nullable percentage columns. */
  summary: {
    promoterPct: number | null;
    pledgedPct: number | null;
    fiiPct: number | null;
    diiPct: number | null;
    publicPct: number | null;
    employeeTrustsPct: number | null;
    underlyingDrsPct: number | null;
  };

  /** Maps 1:1 onto `ShareholdingBreakdown`'s columns. */
  breakdown: {
    promoterPct: number | null;
    promoterPledgedPct: number | null;
    fiiPct: number | null;
    diiPct: number | null;
    mutualFundPct: number | null;
    insurancePct: number | null;
    banksFiPct: number | null;
    alternateInvPct: number | null;
    govtPct: number | null;
    publicPct: number | null;
    retailPct: number | null;
    employeeTrustPct: number | null;
    custodianDrPct: number | null;
    nonPromoterNonPublicPct: number | null;
    promoterShares: number | null;
    fiiShares: number | null;
    diiShares: number | null;
    publicShares: number | null;
    totalShares: number | null;
  };

  /**
   * Promoter encumbrance BEYOND pledge (NDU + other). Not a schema column;
   * surfaced so a caller can see the Vedanta case rather than inferring
   * "unencumbered" from a null pledge. Also lands in {@link raw}.
   */
  totalEncumberedPct: number | null;

  /** Whether the filing DECLARED pledge data at all (`Fld_IsPledge`). */
  pledgeDeclared: boolean;

  /** Per-skip tally, same posture as the NSE path's `ParseOutcome.reasons`. */
  reasons: Record<string, number>;

  /** The source payload, JSON-stringified, for `ShareholdingPattern.raw`. */
  raw: string;
}

/**
 * Injected pure helpers.
 *
 * `normalizeQuarter` MUST be the one from
 * `packages/research/src/data-sources/ownership-logic.ts`. See the module
 * header for why it is a parameter and not an import.
 */
export interface BseShareholdingDeps {
  normalizeQuarter(value: unknown): string | null;
}

/** The two payloads that make one quarter's parse. */
export interface BseShareholdingPayload {
  /** `/CorporatesSHPSecuritybeta/w` response. Required. */
  summary: unknown;
  /**
   * `/Corp_shpSec_SHPPubShold_ng/w` response. Optional: without it the
   * institution legs stay NULL (not zero) and `reasons.noPublicDetail` fires.
   */
  publicDetail?: unknown;
}

// ── Small local helpers ──────────────────────────────────────────────────────
//
// `readPct`/`parseQty` are re-stated here rather than imported for the same
// dependency-direction reason as `normalizeQuarter`. They are deliberately NOT
// injected: unlike the quarter rule they do not participate in a KEY, so a
// divergence cannot split one quarter into two rows. Semantics are kept
// identical to `ownership-logic.ts` on purpose.

const BLANK_SENTINELS = new Set(["", "-", "--", "N/A", "NA", "NIL", "NULL"]);

function bump(tally: Record<string, number>, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rows of `payload[key]`, or `[]`. Never throws on a shape surprise. */
function tableOf(payload: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const v = payload[key];
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

/**
 * Number from BSE's JSON. Blank / sentinel / absent -> null, NEVER 0.
 *
 * BSE sends real numbers rather than strings on these endpoints, but the string
 * branch is kept because the same host serves string-typed numerics elsewhere
 * (the scrip master's `FACE_VALUE`, `Mktcap`).
 */
function readNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (BLANK_SENTINELS.has(trimmed.toUpperCase())) return null;
  const cleaned = trimmed.replace(/[%₹,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * A percentage, range-checked to [0, 100].
 *
 * The range check is a SHAPE ASSERTION: if a field we read turns out to hold a
 * share COUNT, every row lands out of range and the tally lights up on the
 * first run instead of 10-digit "percentages" reaching the model.
 */
function readPct(
  value: unknown,
  reasons: Record<string, number>,
): number | null {
  const n = readNumber(value);
  if (n === null) return null;
  if (n < 0 || n > 100) {
    bump(reasons, "pctOutOfRange");
    return null;
  }
  return n;
}

/** A share count. Beyond 2^53 it is a mis-mapped column, not a holding. */
function readShares(value: unknown): number | null {
  const n = readNumber(value);
  if (n === null) return null;
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  return Math.round(n);
}

/** Squeeze whitespace + upper-case, so `"Insurance  Companies"` matches. */
function label(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ").toUpperCase()
    : "";
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// ── Quarter index ────────────────────────────────────────────────────────────

/**
 * Parse `/SHPQNewFormat/w`. `null` on an unrecognised shape so the caller can
 * tell "endpoint moved" from "this scrip has never filed" (`[]`).
 *
 * DEDUPES BY QUARTER LABEL, keeping the first occurrence. BSE lists a revision
 * and its original as two rows for one quarter, newest first — ATV Projects
 * 500028 shows `130.01/June 2026/Revised` immediately above
 * `130/June 2026/New`. Both normalise to the same `YYYY-MM`, so ingesting both
 * would have the superseded filing overwrite the revision or vice versa
 * depending on iteration order.
 */
export function parseBseShpQuarters(payload: unknown): BseShpQuarter[] | null {
  if (!isRecord(payload)) return null;
  if (!Array.isArray(payload.Table)) return null;

  const rows = tableOf(payload, "Table");
  const out: BseShpQuarter[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    // `qtrid` arrives as a JSON number (130, 130.01). Stringify from the raw
    // value rather than reformatting, and refuse a row without one.
    const qtrIdRaw = row.qtrid;
    const qtrId =
      typeof qtrIdRaw === "number" && Number.isFinite(qtrIdRaw)
        ? String(qtrIdRaw)
        : text(qtrIdRaw);
    if (!qtrId) continue;

    const labelText = text(row.qtr) ?? "";
    const key = label(labelText);
    if (key !== "" && seen.has(key)) continue;
    if (key !== "") seen.add(key);

    out.push({
      qtrId,
      label: labelText,
      status: text(row.status) ?? "",
      filedAt: text(row.filing_date_time),
      xbrlUrl: text(row.xbrlurl),
    });
  }
  return out;
}

// ── Summary leg ──────────────────────────────────────────────────────────────

/**
 * `Fld_Code` -> the line it represents, in the A/B/C rollup.
 *
 * Verified across 7 live companies (RIL, TCS, HDFC Bank, SBI, Adani Ports,
 * ATV Projects, Utique). `STC1` and `C1a` are the SAME line: real payloads use
 * `C1a`, the zero skeleton uses `STC1`.
 */
const SUMMARY_CODES = {
  promoter: "STA1A2",
  public: "STB1B2B3",
  drs: ["C1A", "STC1"],
  employeeTrust: "STC2",
  nonPromoterNonPublic: "STC1C2",
  grandTotal: "STABC",
} as const;

interface SummaryRead {
  promoter: BseShpLeg;
  public: BseShpLeg;
  drs: BseShpLeg;
  employeeTrust: BseShpLeg;
  nonPromoterNonPublic: BseShpLeg;
  grandTotal: BseShpLeg;
  pledgedPct: number | null;
  totalEncumberedPct: number | null;
}

const EMPTY_LEG: BseShpLeg = { pct: null, shares: null };

function readSummary(
  rows: Record<string, unknown>[],
  reasons: Record<string, number>,
): SummaryRead {
  const read: SummaryRead = {
    promoter: { ...EMPTY_LEG },
    public: { ...EMPTY_LEG },
    drs: { ...EMPTY_LEG },
    employeeTrust: { ...EMPTY_LEG },
    nonPromoterNonPublic: { ...EMPTY_LEG },
    grandTotal: { ...EMPTY_LEG },
    pledgedPct: null,
    totalEncumberedPct: null,
  };

  for (const row of rows) {
    const code = label(row.Fld_Code);
    if (code === "") continue;

    const leg: BseShpLeg = {
      pct: readPct(row.Fld_TotalPercentageOf_A_B_C2, reasons),
      shares: readShares(row.Fld_TotalNoOfShares),
    };

    if (code === SUMMARY_CODES.promoter) {
      read.promoter = leg;
      // Pledge and total encumbrance are promoter-line columns.
      read.pledgedPct = readPct(row.Fld_PledgeEncumberedPercentage, reasons);
      read.totalEncumberedPct = readPct(
        row.Fld_TotalencumberedPercentage,
        reasons,
      );
    } else if (code === SUMMARY_CODES.public) {
      read.public = leg;
    } else if ((SUMMARY_CODES.drs as readonly string[]).includes(code)) {
      read.drs = leg;
    } else if (code === SUMMARY_CODES.employeeTrust) {
      read.employeeTrust = leg;
    } else if (code === SUMMARY_CODES.nonPromoterNonPublic) {
      read.nonPromoterNonPublic = leg;
    } else if (code === SUMMARY_CODES.grandTotal) {
      read.grandTotal = leg;
    } else {
      bump(reasons, `unknownSummaryCode:${code}`);
    }
  }
  return read;
}

// ── Public-shareholder breakdown ─────────────────────────────────────────────

/**
 * `Fld_Level` (squeezed, upper-cased) -> breakdown column, for LEAF categories.
 *
 * The double space in BSE's `"Insurance  Companies"` is why {@link label}
 * squeezes whitespace instead of comparing raw strings.
 */
const PUBLIC_LEAF_LEVELS: Record<string, keyof PublicRead> = {
  "MUTUAL FUNDS/": "mutualFundPct",
  "INSURANCE COMPANIES": "insurancePct",
  BANKS: "banksFiPct",
  "ALTERNATE INVESTMENT FUNDS": "alternateInvPct",
  "RESIDENT INDIVIDUALS HOLDING NOMINAL SHARE CAPITAL UP TO RS. 2 LAKHS":
    "retailPct",
};

interface PublicRead {
  diiPct: number | null;
  diiShares: number | null;
  fiiPct: number | null;
  fiiShares: number | null;
  govtPct: number | null;
  mutualFundPct: number | null;
  insurancePct: number | null;
  banksFiPct: number | null;
  alternateInvPct: number | null;
  retailPct: number | null;
  publicTotalPct: number | null;
  publicTotalShares: number | null;
}

/**
 * Read the institution legs out of `/Corp_shpSec_SHPPubShold_ng/w`.
 *
 * Two filters carry the correctness here and BOTH are load-bearing:
 *
 *   - `Fld_ShareHolderName === null` keeps CATEGORY rows and drops NAMED
 *     holders. BSE lists "Mutual Funds/" with the category total (RIL: 10.11%,
 *     78 holders) followed by the individually-disclosed funds above 1%
 *     (ICICI Prudential 1.76%, SBI 2.62%). Summing without this filter double
 *     counts.
 *   - a rollup is a row whose `Fld_Level` starts with `"SUB TOTAL"`. The
 *     header row that precedes each block carries the SAME `Fld_SubCategory`
 *     with `Fld_Level: null` and all-zero figures, so matching on
 *     `Fld_SubCategory` alone returns the header first and reports DII/FII as
 *     a fabricated 0.
 *
 * The rollup is then classified by `Fld_SubCategory`, NOT by the "B1/B2/B3/B4"
 * suffix in the level text. Those suffixes are BSE's own numbering and do not
 * agree with the SEBI `Fld_Code` numbering in the same payload — `Fld_Code`
 * "B2" is Government while `Fld_Level` "Sub Total B2" is Institutions
 * (Foreign). Classifying by suffix would silently swap two columns.
 */
function readPublicDetail(
  rows: Record<string, unknown>[],
  reasons: Record<string, number>,
): PublicRead {
  const read: PublicRead = {
    diiPct: null,
    diiShares: null,
    fiiPct: null,
    fiiShares: null,
    govtPct: null,
    mutualFundPct: null,
    insurancePct: null,
    banksFiPct: null,
    alternateInvPct: null,
    retailPct: null,
    publicTotalPct: null,
    publicTotalShares: null,
  };

  for (const row of rows) {
    // Named holders are components of a category, never the category.
    if (text(row.Fld_ShareHolderName) !== null) continue;

    const lvl = label(row.Fld_Level);
    if (lvl === "") continue;

    const pct = readPct(row.Fld_TotalPercentageOf_A_B_C2, reasons);
    const shares = readShares(row.Fld_TotalNoOfShares);

    if (lvl.startsWith("SUB TOTAL")) {
      const sub = label(row.Fld_SubCategory);
      if (sub === "INSTITUTIONS (DOMESTIC)") {
        read.diiPct = pct;
        read.diiShares = shares;
      } else if (sub === "INSTITUTIONS (FOREIGN)") {
        read.fiiPct = pct;
        read.fiiShares = shares;
      } else if (sub.includes("GOVERNMENT")) {
        read.govtPct = pct;
      } else if (sub === "NON-INSTITUTIONS") {
        // Modelled by its leaf legs (retail etc.); the rollup itself has no
        // column. Counted so a taxonomy change is visible rather than silent.
        bump(reasons, "subTotalNonInstitutions");
      } else {
        bump(reasons, `unknownSubTotal:${sub}`);
      }
      continue;
    }

    // The grand public total, e.g. "B=B1+B2+B3+B4".
    if (lvl.startsWith("B=")) {
      read.publicTotalPct = pct;
      read.publicTotalShares = shares;
      continue;
    }

    // Every field of PublicRead is `number | null`, so the indexed write is
    // type-safe without a cast.
    const leaf = PUBLIC_LEAF_LEVELS[lvl];
    if (leaf) read[leaf] = pct;
  }
  return read;
}

// ── The parse ────────────────────────────────────────────────────────────────

/**
 * One (scrip, quarter) -> the two sink shapes, or `null`.
 *
 * `null` — never `{}` and never zeros — on: a non-object payload, a missing
 * summary envelope, the zero skeleton (see trap 1), or a quarter that
 * `normalizeQuarter` cannot key. A caller that gets `null` must refuse the
 * write and leave the (scrip, quarter) un-checkpointed so a later run retries.
 */
export function parseBseShareholding(
  payload: unknown,
  deps: BseShareholdingDeps,
): BseShareholdingParse | null {
  const reasons: Record<string, number> = {};

  if (!isRecord(payload)) return null;
  const summaryPayload = payload.summary;
  if (!isRecord(summaryPayload)) return null;

  // ── The liveness gate. This is the whole defence against trap 1. ──────────
  // `Table1` is NOT consulted: the skeleton has 6 fully-populated zero rows in
  // it. Only the metadata tables distinguish a filing from a fabrication.
  // ONE gate, deliberately. An earlier version checked `.length === 0` here and
  // `!metaRow || !scripRow` immediately after; the second check subsumed the
  // first, so deleting the first changed nothing and a mutation test could not
  // tell the gate was even there. Two spellings of one guard is one guard plus
  // a decoy.
  const metaRow = tableOf(summaryPayload, "Table")[0];
  const scripRow = tableOf(summaryPayload, "Table3")[0];
  if (!metaRow || !scripRow) {
    bump(reasons, "noFiling");
    return null;
  }

  const quarterRaw = text(scripRow.fld_enddate);
  if (!quarterRaw) {
    // A filing with no end date cannot be keyed. Refuse rather than invent one
    // from the request parameters — that would key a row to a quarter the
    // payload never claimed.
    bump(reasons, "noQuarterDate");
    return null;
  }

  const quarter = deps.normalizeQuarter(quarterRaw);
  if (!quarter) {
    bump(reasons, "noQuarter");
    return null;
  }

  const summaryRows = tableOf(summaryPayload, "Table1");
  if (summaryRows.length === 0) {
    bump(reasons, "noSummaryRows");
    return null;
  }
  const s = readSummary(summaryRows, reasons);

  const hasPublicDetail = isRecord(payload.publicDetail);
  const p = hasPublicDetail
    ? readPublicDetail(tableOf(payload.publicDetail, "Table1"), reasons)
    : null;
  if (!hasPublicDetail) bump(reasons, "noPublicDetail");

  // The C1/C2 lines carry share counts but BSE reports no percentage for them
  // (they sit outside the A+B+C2 denominator), so these are usually null. That
  // is absence, not zero, and is left as null.
  const underlyingDrsPct = s.drs.pct;
  const employeeTrustsPct = s.employeeTrust.pct;

  // Pledge vs total encumbrance — trap 5.
  const pledgeDeclared = metaRow.Fld_IsPledge === true;
  if (
    s.totalEncumberedPct !== null &&
    s.totalEncumberedPct > (s.pledgedPct ?? 0)
  ) {
    bump(reasons, "encumbranceExceedsPledge");
  }

  // Cross-check the two endpoints against each other. They are separate calls,
  // so a mismatch means the quarter moved under us mid-fetch (or the qtrid/
  // qtrcode confusion of trap 2). Reported, not corrected: the summary is the
  // authority for `publicPct` because it is the leg the pattern row keys on.
  if (
    p?.publicTotalPct !== null &&
    p?.publicTotalPct !== undefined &&
    s.public.pct !== null &&
    Math.abs(p.publicTotalPct - s.public.pct) > 0.01
  ) {
    bump(reasons, "publicTotalMismatch");
  }

  const raw = JSON.stringify(payload);

  return {
    scripCode: text(scripRow.nscripcode) ?? "",
    companyName: text(scripRow.slongname),
    quarter,
    quarterRaw,
    qtrId: text(scripRow.fld_quarterid) ?? "",

    summary: {
      promoterPct: s.promoter.pct,
      pledgedPct: s.pledgedPct,
      fiiPct: p?.fiiPct ?? null,
      diiPct: p?.diiPct ?? null,
      publicPct: s.public.pct,
      employeeTrustsPct,
      underlyingDrsPct,
    },

    breakdown: {
      promoterPct: s.promoter.pct,
      promoterPledgedPct: s.pledgedPct,
      fiiPct: p?.fiiPct ?? null,
      diiPct: p?.diiPct ?? null,
      mutualFundPct: p?.mutualFundPct ?? null,
      insurancePct: p?.insurancePct ?? null,
      banksFiPct: p?.banksFiPct ?? null,
      alternateInvPct: p?.alternateInvPct ?? null,
      govtPct: p?.govtPct ?? null,
      publicPct: s.public.pct,
      retailPct: p?.retailPct ?? null,
      employeeTrustPct: employeeTrustsPct,
      custodianDrPct: underlyingDrsPct,
      nonPromoterNonPublicPct: s.nonPromoterNonPublic.pct,
      promoterShares: s.promoter.shares,
      fiiShares: p?.fiiShares ?? null,
      diiShares: p?.diiShares ?? null,
      publicShares: s.public.shares,
      totalShares: s.grandTotal.shares,
    },

    totalEncumberedPct: s.totalEncumberedPct,
    pledgeDeclared,
    reasons,
    raw,
  };
}

// ── Fetch seam ───────────────────────────────────────────────────────────────
//
// Thin on purpose and separate from every function above, so the parse is
// testable against captured bytes and the transport can be re-pointed at the
// archive without touching parsing.

/** Read a BSE JSON asset through the feed archive. `null` when unavailable. */
async function getJson(
  url: string,
  feed: string,
  basename: string,
): Promise<unknown | null> {
  const res = await getFeedAsset(url, BSE_REFERER, {
    exchange: "BSE",
    // No `date`: these are addressed by BSE's own quarter handle, so the key
    // lands under `current/` and a re-run overwrites in place.
    feed,
    // These URLs are REST routes, not files — without an explicit basename the
    // derived name is the single letter `w`, which also picks the content type.
    basename,
  });
  if (!res) return null;
  try {
    return (await res.json()) as unknown;
  } catch {
    // A body that is not JSON is a shape failure, not a transport failure. Let
    // the caller see "nothing" and refuse, rather than throwing mid-universe.
    return null;
  }
}

/** Every quarter BSE holds for a scrip, newest first. `null` on failure. */
export async function fetchBseShpQuarters(
  scripCode: string,
): Promise<BseShpQuarter[] | null> {
  const payload = await getJson(
    bseShpQuarterIndexUrl(scripCode),
    BSE_SHP_QUARTER_INDEX_FEED,
    `bse-shp-quarters-${scripCode}.json`,
  );
  return payload === null ? null : parseBseShpQuarters(payload);
}

/**
 * Both legs for one (scrip, quarter), ready for {@link parseBseShareholding}.
 *
 * The public leg is best-effort: when it is unavailable the summary still
 * parses and the institution columns stay NULL. Losing FII/DII detail must not
 * cost the promoter/public figures too.
 */
export async function fetchBseShareholding(
  scripCode: string,
  qtrId: string,
): Promise<BseShareholdingPayload | null> {
  const summary = await getJson(
    bseShpSummaryUrl(scripCode, qtrId),
    BSE_SHP_SUMMARY_FEED,
    `bse-shp-summary-${scripCode}-${qtrId}.json`,
  );
  if (summary === null) return null;

  const publicDetail = await getJson(
    bseShpPublicUrl(scripCode, qtrId),
    BSE_SHP_PUBLIC_FEED,
    `bse-shp-public-${scripCode}-${qtrId}.json`,
  );

  return publicDetail === null ? { summary } : { summary, publicDetail };
}
