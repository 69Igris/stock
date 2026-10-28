/**
 * The bridge from an AMC portfolio workbook's scheme NAME to an AMFI scheme CODE.
 *
 * MONEY-1105 (Data Engine P8a). Pure: text in, typed values out. No fetch, no
 * Prisma, no clock — the same split as `amfi-amc-registry.ts` (HTML → records)
 * and `mf-portfolio-logic.ts` (workbook bytes → holdings), so every judgement
 * here is testable against real archived bytes.
 *
 * ## The problem this exists to solve
 *
 * **No AMC monthly portfolio disclosure carries an AMFI scheme code.** Verified
 * against the real July-2026 files from SBI, ABSL, Nippon and HDFC: not in the
 * Index sheet, not in a portfolio sheet header, not in a note. So
 * `MfPortfolioHolding.amfiSchemeCode` is `null` today and holdings can only be
 * joined on a free-text scheme name against ~14,000 schemes industry-wide.
 *
 * AMFI's NAVAll feed — which `instruments/amfi-mf-provider.ts` already ingests —
 * is **grouped by AMC** and DOES carry the scheme code and both ISINs. And
 * `AmfiAmcRecord.fundName` is byte-identical to the NAVAll group header. So
 *
 *     mfId → fundName → NAVAll group → that AMC's schemes only
 *
 * narrows the name match from 14,273 industry-wide rows to one AMC's list.
 * Re-measured against the live feed on 2026-08-14: 14,273 schemes, 52 AMC
 * groups, **median 130 schemes per AMC**, and all 52 group headers matched a
 * registry `fundName` byte-exactly with zero orphans on the NAVAll side. The
 * five registry rows with no NAVAll group (ASK, Carnelian, Lakshya, Monarch,
 * Nuvama) are exactly the five whose monthly-disclosure link is empty.
 *
 * ## The real NAVAll grammar, which is NOT what the file looks like at a glance
 *
 * ```
 * Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
 *  ⟵ separator lines are a SPACE, not empty; every line ends CRLF
 * Open Ended Schemes(Debt Scheme - Banking and PSU Fund)   ⟵ SECTION header
 *
 * Aditya Birla Sun Life Mutual Fund                        ⟵ AMC header
 *
 * 135762;INF846K01WO1;-;Axis Children's Fund;Direct Plan;Growth Option;29.9628;11-Sep-2026
 * ```
 *
 * FIVE things a "reasonable" parser gets wrong, all measured on the live file:
 *
 * **0. The COLUMN SET is not fixed.** The header above is today's. Until
 * 2026-08-19 it was six columns — `Plan` and `Option` did not exist and the NAV
 * was the FIFTH field. Two parsers hard-coded that position; see
 * {@link NavAllColumns} for what it cost. The layout is therefore resolved from
 * the header's NAMES on every parse, and a header missing a required column
 * makes the whole file unreadable rather than mis-sliced.
 *
 * **1. There are TWO kinds of header line, not one.** `amfi-mf-provider.ts`
 * treats every semicolon-free line as an AMC name. The file interleaves 90
 * SECTION headers with the AMC headers, and an AMC is repeated once per section
 * it has schemes in — ICICI Prudential appears **47 times**. That parser
 * survives only because the AMC header normally follows the section header and
 * overwrites it. It does not always follow (see 2), and where it does not, 16
 * rows in the live feed are stamped with `amcName = "Open Ended
 * Schemes(Growth)"`. Here the two are told apart by shape: a section header
 * contains the literal token `Scheme(` or `Schemes(`. Measured: that splits the
 * 142 distinct header lines exactly 90/52, and all 90 sections carry one of
 * three prefixes (`Open Ended`, `Close Ended`, `Interval Fund`).
 *
 * **2. Three sections carry NO AMC header of their own** — `Open Ended
 * Schemes(Growth)`, `…(Income/Debt Oriented Schemes - Corporate Bond Fund)` and
 * `…(Life Cycle Funds - … 15 Years)`. Their rows belong to the AMC of the
 * PREVIOUS section (ICICI, Invesco and Zerodha respectively — verified row by
 * row). So the current AMC must survive a section boundary. It must NOT be
 * reset, and it must NOT default to an "Unknown AMC" sentinel: a row whose AMC
 * cannot be established is dropped, because a sentinel group is
 * indistinguishable from a real one downstream.
 *
 * **3. An AMC name is not required to end in "Mutual Fund".**
 * `IL&FS Mutual Fund (IDF)` does not, and it also parenthesises like a section
 * header does. Discriminating on the suffix would drop it; discriminating on
 * `Schemes?\(` keeps it. The fixture pins that row so a regression fails the
 * test instead of silently losing an AMC.
 *
 * **4. The ISIN columns are not always ISINs.** Across 14,273 rows the two ISIN
 * columns carry `-` 10,547 times, the literal string `Redeemed` 9 times, and
 * once the ETF ticker `HDFCNIVODG`. All three are stored as `null`, because an
 * `isin === "Redeemed"` that reaches a join key is worse than an absent one.
 *
 * ## Why `null` and an empty group are different answers
 *
 * {@link parseNavAllGroups} returns `null` — never `[]` — for bytes that are not
 * this feed. A group with zero schemes is a legitimate value that means "this
 * AMC published nothing"; `null` means "we could not read the file at all". The
 * same discipline as `parseAmfiAmcRegistry` and `amc-portfolio-sources`'
 * `provenance`: make "we do not know" a distinct, loud value, because AMFI
 * silently restructuring the feed and AMFI listing no schemes must never be the
 * same value.
 *
 * ## Why a FAMILY key, and why the resolver refuses to guess
 *
 * A Direct and a Regular plan of one scheme hold **identical securities** and
 * differ only in expense ratio; the IDCW and Growth options of one plan likewise.
 * The workbook publishes ONE portfolio for all of them. Keeping them apart would
 * duplicate every holding and double-count "which funds hold RELIANCE", so
 * {@link schemeFamilyKey} collapses a printed name to the scheme FAMILY.
 *
 * And {@link resolveSchemeCode} never picks one of several. **A wrong scheme
 * code silently attributes one fund's holdings to another**, and the real feed
 * is full of names where that is one keystroke away: `Aditya Birla Sun Life
 * Retirement Fund` alone extends to `The 30s Plan`, `The 40s Plan` and `The 50s
 * Plan`, three funds with materially different books. Measured across all 52
 * AMCs, **772** plausible scheme-name prefixes extend two or more distinct
 * families. So an under-specified name returns `"ambiguous"` WITH its candidates
 * and no code at all.
 */

import type { AmfiAmcRegistry } from "./amfi-amc-registry";

/**
 * The published NAVAll URL. Documentation only — nothing here fetches.
 *
 * NOTE it 302s to `portal.amfiindia.com`; `fetch` follows redirects by default,
 * so callers that disabled redirect-following get an empty body, not an error.
 */
/**
 * The CANONICAL host — MONEY-1198.
 *
 * `www.amfiindia.com` now answers 302 -> `portal.amfiindia.com` (verified
 * 2026-08-14; portal returns 200 / 1,649,879 bytes). `fetch` follows redirects
 * by default, so the `www` form still worked — which is what made it worth
 * changing rather than leaving: the whole MF NAV ingest was resting on a
 * redirect, and `redirect: "manual"`, a non-following fetch wrapper, or a
 * host-scoped egress rule would each have broken it with no code change to
 * blame. Kept identical to `AMFI_NAV_URL` in
 * `market-data/instruments/amfi-mf-provider.ts`.
 */
export const AMFI_NAVALL_URL = "https://portal.amfiindia.com/spages/NAVAll.txt";

/* -------------------------------------------------------------------------- */
/* Parsed feed                                                                 */
/* -------------------------------------------------------------------------- */

/** One scheme row. Every field that could not be read is `null`, never a default. */
export interface NavAllScheme {
  /** AMFI's scheme code — the whole point of this module. Never empty. */
  schemeCode: string;
  /** Column 2, `ISIN Div Payout/ ISIN Growth`. `null` for `-`/`Redeemed`/junk. */
  isinGrowth: string | null;
  /** Column 3, `ISIN Div Reinvestment`. Same nulling rule. */
  isinReinvestment: string | null;
  /** Printed name, verbatim and untrimmed of its internal spacing. Never empty. */
  schemeName: string;
  /**
   * NAV, or `null` when the cell is not a positive finite number.
   *
   * A bad NAV nulls the FIELD and never drops the ROW: the scheme code and name
   * are what this module exists for, and discarding a row over its price would
   * lose a join key to save nothing. (`amfi-mf-provider.parseAmfiFeed` DOES
   * drop such rows — correct for a NAV sync, wrong here.)
   */
  nav: number | null;
  /** `YYYY-MM-DD`, timezone-free. `null` when the date will not parse — never coerced. */
  navDate: string | null;
  /** The scheme-type section the row sat under, verbatim. `null` before the first one. */
  section: string | null;
  /**
   * The feed's own `Plan` / `Option` cells — MONEY-1403.
   *
   * `null` on a file in the pre-2026-08 six-column layout, which carried
   * neither column. That is distinct from `""`, which would mean AMFI published
   * the column and left the cell blank.
   */
  plan: string | null;
  option: string | null;
}

/** One AMC's schemes, merged across every section the AMC appears in. */
export interface NavAllGroup {
  /**
   * The group header verbatim — byte-identical to `AmfiAmcRecord.fundName`.
   * Not trimmed, not case-folded: that exactness IS the join.
   */
  amcName: string;
  schemes: readonly NavAllScheme[];
}

export interface NavAllFile {
  /** One entry per AMC, in first-appearance order. May be empty for an AMC; never `[]` overall. */
  groups: readonly NavAllGroup[];
  /** Scheme-type section headers, in order of first appearance. */
  sections: readonly string[];
  schemeCount: number;
  /**
   * THERE IS NO `rejectedRows` HERE — MONEY-1401 review finding 14.
   *
   * There was, and its docstring said it existed "so a caller can alarm on a
   * feed that starts shedding rows". No caller ever did: `grep -rn rejectedRows`
   * returned this module and its own tests, three releases running. A number
   * whose only reader is the test that asserts it is not coverage, it is a
   * claim — and the standing rule is to stop claiming rather than to build
   * machinery that preserves the claim.
   *
   * What actually watches for a shed is `mf-sync`'s completeness gate
   * (`judgeMfSyncCompleteness`), which counts ACTIVE MASTERS the run did not
   * stamp and fails the run past `MF_SYNC_MAX_MISSING_PCT`. A dropped row is a
   * master that goes un-priced, so it lands there whatever made the parser drop
   * it. It is coarser — measured headroom is 0.6pp, so a shed under ~285
   * schemes passes — and that is the honest state of the coverage.
   *
   * Restoring the count is cheap if a real reader ever appears. Reaching one
   * from here is NOT: the only production chain is
   * `parseNavAllGroups` -> `parseAmfiFeed` -> `syncAmfiMutualFunds`
   * (`instruments/amfi-mf-provider.ts`), which returns `AmfiSyncResult` and
   * would need a new field on it.
   */
}

/* -------------------------------------------------------------------------- */
/* Grammar                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A section header, as opposed to an AMC header.
 *
 * The token `Scheme(`/`Schemes(` — with the paren — is the discriminator.
 * Matching bare `Scheme` would also hit nothing useful here, but matching on the
 * paren keeps `IL&FS Mutual Fund (IDF)` on the AMC side, which a suffix test
 * (`/Mutual Fund$/`) would not. Measured on the live feed: 90 sections, 52 AMCs,
 * zero misclassified.
 */
const SECTION_HEADER = /Schemes?\(/;

/** The feed's own column-header line. Its NAMES are the layout — see below. */
const COLUMN_HEADER = /^Scheme\s+Code\s*;/i;

/**
 * Where each field sits on a data row, resolved from the header's NAMES.
 *
 * ## Why this is not a set of constants — MONEY-1403
 *
 * On or about 2026-08-19 AMFI inserted two columns, `Plan` and `Option`,
 * between `Scheme Name` and `Net Asset Value`. The row went from six fields to
 * eight:
 *
 * ```
 * WAS  Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
 * NOW  Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
 *      135762;INF846K01WO1;-;Axis Children's Fund;Direct Plan;Growth Option;29.9628;11-Sep-2026
 * ```
 *
 * Two parsers read `parts[4]` as the NAV. This one rejected every row for the
 * wrong width and correctly reported the file unreadable; `amfi-mf-provider.ts`
 * read `"Direct Plan"`, got `NaN`, skipped the row, and reported
 * `parsed=0, upserted=0` with exit 0 for **26 nights**. 14,225 funds went stale
 * and no monitor could see it, because a positional parser cannot tell a moved
 * column from an empty file.
 *
 * The repo already carries this exact lesson for a different vendor: Tiingo's
 * EOD CSV is documented `date,open,…` and is really `date,close,high,low,open`,
 * so a parser written from the docs swaps open and close on every US security.
 * The rule is the same one — **parse by header NAME, and assert the header** —
 * and it is applied here rather than left as a comment because this is the
 * second time the same defect has reached production.
 *
 * `width` is retained so a row carrying an unescaped `;` is still rejected
 * rather than silently mis-sliced.
 */
interface NavAllColumns {
  schemeCode: number;
  isinGrowth: number;
  isinReinvestment: number;
  schemeName: number;
  nav: number;
  navDate: number;
  /** Present only since the 2026-08 layout. */
  plan: number | null;
  option: number | null;
  width: number;
}

/**
 * The header names this parser requires, each with the aliases AMFI has used.
 *
 * Matching is case-insensitive, whitespace-collapsed, AND slash-normalised.
 * The last of those is load-bearing rather than tidy: the live header carries a
 * stray space inside `ISIN Div Payout/ ISIN Growth`, and a THIRD spacing of
 * that same cell used to make the entire feed unreadable — see
 * `normaliseHeaderCell`.
 */
const NAVALL_COLUMN_ALIASES = {
  schemeCode: ["scheme code"],
  // ONE spelling: `normaliseHeaderCell` collapses the space around the slash,
  // so every observed variant of this cell lands here.
  isinGrowth: ["isin div payout/isin growth"],
  isinReinvestment: ["isin div reinvestment"],
  schemeName: ["scheme name"],
  nav: ["net asset value"],
  navDate: ["date"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Optional columns — absent before the 2026-08 layout, never required. */
const NAVALL_OPTIONAL_ALIASES = {
  plan: ["plan"],
  option: ["option"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Normalise a header cell for comparison: trim, lowercase, collapse spaces. */
function normaliseHeaderCell(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      // COLLAPSE SPACE AROUND A SLASH — MONEY-1405. `ISIN Div Payout/ ISIN
      // Growth` is the live spelling and AMFI is visibly careless with that one
      // cell: the alias list carried two hand-typed variants and a THIRD
      // spacing (`Payout / ISIN`, a space before the slash as well) made
      // `parseNavAllHeader` return null, which makes the WHOLE FEED unreadable
      // — `AmfiNavGrammarError`, `mf-sync` throws, no NAVs for the night.
      // One stray space is not a grammar change and must not be answered like
      // one. Normalising here means ONE alias covers every spacing, so the list
      // cannot drift out of step with the file again.
      .replace(/\s*\/\s*/g, "/")
  );
}

/**
 * Resolve the column layout from the feed's own header line.
 *
 * Returns `null` when a REQUIRED column is absent — which is a loud, named
 * failure rather than a row that reads the wrong field. A caller that gets
 * `null` must treat the bytes as unreadable, never as an empty feed.
 */
export function parseNavAllHeader(headerLine: string): NavAllColumns | null {
  const cells = headerLine.split(";").map(normaliseHeaderCell);
  const find = (aliases: readonly string[]): number | null => {
    const at = cells.findIndex((cell) => aliases.includes(cell));
    return at === -1 ? null : at;
  };

  const required: Partial<Record<keyof typeof NAVALL_COLUMN_ALIASES, number>> =
    {};
  for (const [field, aliases] of Object.entries(NAVALL_COLUMN_ALIASES) as [
    keyof typeof NAVALL_COLUMN_ALIASES,
    readonly string[],
  ][]) {
    const at = find(aliases);
    if (at === null) return null;
    required[field] = at;
  }

  return {
    schemeCode: required.schemeCode!,
    isinGrowth: required.isinGrowth!,
    isinReinvestment: required.isinReinvestment!,
    schemeName: required.schemeName!,
    nav: required.nav!,
    navDate: required.navDate!,
    plan: find(NAVALL_OPTIONAL_ALIASES.plan),
    option: find(NAVALL_OPTIONAL_ALIASES.option),
    width: cells.length,
  };
}

/**
 * ISIN shape. Indian ISINs are `IN` + one letter + 9 alphanumerics.
 *
 * Deliberately a shape test rather than a blocklist of the three junk values
 * observed today (`-`, `Redeemed`, `HDFCNIVODG`): a blocklist admits the fourth
 * one, and this column has already produced a ticker where an ISIN belongs.
 */
const ISIN_SHAPE = /^IN[A-Z][A-Z0-9]{9}$/;

/**
 * A number AMFI actually publishes.
 *
 * Permits the trailing-point form (`"10."`) because 17 live rows use it, and
 * rejects the empty string, which `Number("")` would otherwise turn into a
 * perfectly finite zero.
 */
const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)$/;

const MONTHS: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

/**
 * `13-Aug-2026` → `"2026-08-13"`, or `null`.
 *
 * Strict on purpose. `new Date("13-Aug-2026")` — what
 * `amfi-mf-provider.parseAmfiDate` does — is implementation-defined for
 * non-ISO input, drags in the host timezone, and would happily accept
 * `31-Feb-2026`. Here the day is round-tripped through `Date.UTC` so an
 * impossible date is REJECTED rather than rolled forward into a plausible one:
 * a silently wrong NAV date is worse than an absent one.
 */
export function parseNavAllDate(raw: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw.trim());
  if (m === null) return null;

  const day = Number(m[1]);
  const month = MONTHS[m[2]!.toUpperCase()];
  const year = Number(m[3]);
  if (month === undefined) return null;

  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null; // 31-Feb and friends: rolled over, therefore not a real date
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A positive finite NAV, or `null`. Never 0, never NaN, never Infinity. */
function parseNav(raw: string): number | null {
  const s = raw.trim();
  if (!NUMERIC.test(s)) return null;
  const n = Number(s);
  // A NAV is a price. Non-positive is malformed, not "cheap".
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseIsin(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return ISIN_SHAPE.test(s) ? s : null;
}

/**
 * Parse the NAVAll feed into per-AMC groups.
 *
 * Returns `null` for bytes that are not this feed — see the header for why that
 * must not be `[]`.
 */
export function parseNavAllGroups(text: string): NavAllFile | null {
  if (typeof text !== "string" || text.length === 0) return null;

  // Split on either ending: the live feed is CRLF throughout, but an archived
  // copy that has been through a text-mode round trip is not, and that is not a
  // reason to report the feed as unreadable.
  const lines = text.split(/\r\n|\n|\r/);

  const order: string[] = [];
  const byAmc = new Map<string, NavAllScheme[]>();
  const sections: string[] = [];
  let currentAmc: string | null = null;
  let currentSection: string | null = null;
  let sawColumnHeader = false;
  // Resolved from the header line when there is one; the pre-2026-08 six-column
  // layout only when there is not (MONEY-1403). `badHeader` is a DISTINCT state
  // from "no header": a header we could read but that is missing a required
  // column means the feed was restructured, and that must not fall back to a
  // positional guess.
  let columns: NavAllColumns | null = null;
  let badHeader = false;

  for (const line of lines) {
    // The separator lines are a single SPACE, not empty — trim covers both.
    const trimmed = line.trim();
    if (trimmed === "") continue;

    if (COLUMN_HEADER.test(trimmed)) {
      sawColumnHeader = true;
      const resolved = parseNavAllHeader(trimmed);
      if (resolved === null) badHeader = true;
      else columns = resolved;
      continue;
    }

    if (!trimmed.includes(";")) {
      if (SECTION_HEADER.test(trimmed)) {
        // A section boundary does NOT clear the AMC: three live sections carry
        // no AMC header and their rows belong to the previous one.
        currentSection = trimmed;
        if (!sections.includes(trimmed)) sections.push(trimmed);
      } else {
        currentAmc = trimmed;
        if (!byAmc.has(trimmed)) {
          byAmc.set(trimmed, []);
          order.push(trimmed);
        }
      }
      continue;
    }

    const parts = trimmed.split(";");
    // NO HEADER, NO ROWS — MONEY-1405. This used to fall back to
    // `NAVALL_LEGACY_COLUMNS`, a fixed positional layout, whenever the header
    // was absent OR unrecognised. That is MONEY-1403 rebuilt as a fallback, and
    // it was reachable: the final guard only refused a headerless file when it
    // ALSO carried no section line, and the live feed is full of section lines
    // (`Open Ended Schemes(Equity Scheme - Large Cap Fund)`).
    //
    // Measured on the shape that matters — a SIX-wide body whose header names
    // the columns in a different order, with the header spelled so the detector
    // misses it — the positional layout read field 0 as the scheme code while
    // the header said field 0 was the date, and reported success. Silent,
    // confident, wrong: exactly the 26-night outage this module was rewritten
    // to make impossible.
    //
    // A row cannot be read without a layout the FILE stated. Dropping it here
    // is what makes a headerless file reach the `schemeCount === 0` refusal
    // below rather than parse through a positional guess.
    if (columns === null) {
      continue;
    }
    // Exactly as wide as the layout says — eight columns since 2026-08, six
    // before it. A different width means the row is not this record, or carries
    // an unescaped `;` inside a field, and either way it must not be sliced.
    const layout = columns;
    if (parts.length !== layout.width) {
      continue;
    }

    const schemeCode = parts[layout.schemeCode]!.trim();
    const schemeName = parts[layout.schemeName]!.trim();
    // No code or no name means no join key and no evidence — reject rather than
    // emit a half record that a downstream `if (scheme.schemeCode)` skips anyway.
    if (schemeCode === "" || schemeName === "" || currentAmc === null) {
      continue;
    }

    byAmc.get(currentAmc)!.push({
      schemeCode,
      isinGrowth: parseIsin(parts[layout.isinGrowth]!),
      isinReinvestment: parseIsin(parts[layout.isinReinvestment]!),
      schemeName,
      nav: parseNav(parts[layout.nav]!),
      navDate: parseNavAllDate(parts[layout.navDate]!),
      section: currentSection,
      plan: layout.plan === null ? null : (parts[layout.plan]?.trim() ?? null),
      option:
        layout.option === null ? null : (parts[layout.option]?.trim() ?? null),
    });
  }

  // Recovered nothing: these bytes are an error page, a truncated download or a
  // restructured feed. Not "AMFI published no schemes today", which cannot
  // happen. The column header alone is not enough — a header with no rows is
  // just as unusable.
  // A header we could READ but that no longer names every required column means
  // the feed was restructured again — MONEY-1403. Unreadable, even if some rows
  // happened to survive the width check, because whatever they parsed to came
  // from a layout this module no longer understands.
  if (badHeader) return null;

  const schemeCount = [...byAmc.values()].reduce((n, s) => n + s.length, 0);
  if (order.length === 0 || schemeCount === 0) return null;
  // NO GUARD ON `sawColumnHeader` HERE, DELIBERATELY.
  //
  // There used to be one — `!sawColumnHeader && sections.length === 0` — and it
  // was the escape hatch: the live feed carries dozens of section lines, so
  // that conjunction was false on every real input and a headerless file
  // parsed through a fixed positional layout.
  //
  // The enforcement now lives at the ROW, where `columns === null` rejects
  // every line rather than guessing at it. That makes a header-level guard
  // here DEAD — a headerless file reaches this point with `schemeCount === 0`
  // and is refused on the next line, whatever `sawColumnHeader` says. It was
  // written, mutation-tested, found unkillable, and removed rather than kept
  // as an expression that reads like protection and cannot change an answer
  // (the same call `mfPortfolioRunOk` made about its `perAmc.length > 0`).

  return {
    groups: order.map((amcName) => ({
      amcName,
      schemes: byAmc.get(amcName)!,
    })),
    sections,
    schemeCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Scheme families                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Tokens that describe the PLAN or the OPTION rather than the scheme.
 *
 * These are only ever stripped as a trailing run (see {@link schemeFamilyKey}),
 * which is what makes the list safe to be this broad. `GROWTH` is in it, and
 * `Nippon India Growth Mid Cap Fund` still keeps its `GROWTH`; `INCOME` is in
 * it, and `Aditya Birla Sun Life Income Fund` still keeps its `INCOME` — because
 * in both the noise word is followed by real name tokens. A set-membership
 * filter over the whole name, rather than the suffix, would have destroyed both.
 *
 * `PALN` is AMFI's own typo for `PLAN`. It appears in the live feed (`SBI
 * BANKING & PSU FUND - Regular Paln - Growth`, `SBI Liquid Fund - Direct Paln -
 * …`) and there is no upstream to fix it in.
 *
 * `INCOME DISTRIBUTION CUM CAPITAL WITHDRAWAL` is SEBI's mandated expansion of
 * IDCW and is written out in full on hundreds of rows, so each of its words has
 * to be here for those names to collapse onto the `- Growth` ones.
 */
const PLAN_OPTION_TOKENS: ReadonlySet<string> = new Set([
  // plans
  "DIRECT",
  "REGULAR",
  "PLAN",
  "PLANS",
  "PALN",
  "INSTITUTIONAL",
  "RETAIL",
  "SUPER",
  "DISCRETIONARY",
  "PREMIUM",
  // options
  "GROWTH",
  "IDCW",
  "DIVIDEND",
  "DIVIDENDS",
  "PAYOUT",
  "PAYOUTS",
  "REINVESTMENT",
  "REINVEST",
  "REINVESTED",
  "BONUS",
  "OPTION",
  "OPTIONS",
  "APPRECIATION",
  "CUMULATIVE",
  // SEBI's spelled-out IDCW
  "INCOME",
  "DISTRIBUTION",
  "CUM",
  "CAPITAL",
  "WITHDRAWAL",
  // payout frequency
  "DAILY",
  "WEEKLY",
  "FORTNIGHTLY",
  "MONTHLY",
  "QUARTERLY",
  "HALF",
  "YEARLY",
  "HALFYEARLY",
  "ANNUAL",
  "ANNUALLY",
  "PERIODIC",
]);

/**
 * Words that join two plan/option words and carry no meaning of their own.
 *
 * Needed because the suffix is not a clean run: `… - Direct - Monthly Payout of
 * IDCW` and `… ETF - IDCW Daily Reinvestment with Weekly Payout` both interrupt
 * the noise with a connector. Without this the walk stops at `OF`/`WITH` and the
 * family key keeps half the option description, which is a silent miss.
 *
 * A connector is transparent only INSIDE an established noise run — never on its
 * own — so a scheme genuinely ending in one of these words is untouched.
 */
const CONNECTOR_TOKENS: ReadonlySet<string> = new Set([
  "OF",
  "WITH",
  "AND",
  "THE",
  "CUM",
]);

/**
 * Drop parenthesised text, honouring NESTING.
 *
 * `replace(/\([^)]*\)/g, "")` is the obvious version and it is wrong on this
 * data: Nippon's names embed a parenthetical inside the SEBI category sentence —
 * `"(An open ended debt scheme … (including fixed rate instruments converted to
 * floating rate exposures using swaps/ derivatives). Relatively High interest
 * rate risk …)"` — so the non-greedy form closes on the INNER paren and leaves
 * the tail of the outer one in the name. Measured: that alone cost 6 of Nippon's
 * 107 sheets a match.
 *
 * An unbalanced `)` becomes a space rather than being kept, so a truncated name
 * degrades to a shorter key instead of a corrupted one.
 */
function stripParentheticals(name: string): string {
  let out = "";
  let depth = 0;
  for (const ch of name) {
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth--;
      else out += " ";
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

/**
 * `Fund of Funds` / `FoF` are the same words. AMFI uses both, within one AMC.
 *
 * ABSL is printed `… Silver ETF FOF-Direct Growth` in NAVAll and
 * `… SILVER ETF FUND OF FUND` in its own workbook. Folding both to one token
 * also stops `OF` from being seen as a connector in the middle of a real name.
 */
function canonicaliseTokens(tokens: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "FOF" || t === "FOFS") {
      out.push("FUNDOFFUNDS");
      continue;
    }
    if (
      t === "FUND" &&
      tokens[i + 1] === "OF" &&
      (tokens[i + 2] === "FUND" || tokens[i + 2] === "FUNDS")
    ) {
      out.push("FUNDOFFUNDS");
      i += 2;
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * The tokens of a scheme name, after every normalisation except the suffix strip.
 *
 * `&` becomes ` AND ` rather than being deleted so that `Banking & PSU` and
 * `Banking and PSU` — both of which the same AMC publishes — agree.
 */
function nameTokens(name: string): string[] {
  const raw = stripParentheticals(name)
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (raw === "") return [];
  return canonicaliseTokens(raw.split(" "));
}

/**
 * Nippon prints the scheme name TWICE for a segregated portfolio.
 *
 * `"Nippon India Credit Risk Fund (An open ended debt scheme …) Nippon India
 * Credit Risk Fund-Segregated Portfolio 2"`. After the parentheticals go, the
 * token list opens with its own prefix repeated, and the resulting key matches
 * nothing. Collapsing a leading `A ++ A` costs nothing anywhere else and
 * recovered 5 of Nippon's 107 sheets.
 *
 * The repeat must be at least two tokens long: a one-token repeat (`FUND FUND`)
 * is a plausible thing for a real name to contain and collapsing it would be a
 * guess, not a normalisation.
 */
function collapseRepeatedPrefix(tokens: readonly string[]): readonly string[] {
  for (let n = Math.floor(tokens.length / 2); n >= 2; n--) {
    let same = true;
    for (let i = 0; i < n; i++) {
      if (tokens[i] !== tokens[n + i]) {
        same = false;
        break;
      }
    }
    if (same) return tokens.slice(n);
  }
  return tokens;
}

/**
 * Collapse a printed scheme name to its FAMILY — the unit that has one portfolio.
 *
 * Direct and Regular of one scheme hold identical securities; so do that plan's
 * Growth and IDCW options. The workbook publishes one portfolio for all of them,
 * so they must share one key or every holding is counted several times.
 *
 * The strip is a **maximal trailing run** of plan/option words (connectors
 * transparent inside it), never a filter over the whole name — that is what lets
 * the vocabulary include `GROWTH`, `INCOME` and `CAPITAL` without destroying
 * `Nippon India Growth Mid Cap Fund`, `ABSL Income Fund` or `WhiteOak Capital
 * Flexi Cap Fund`.
 *
 * The tokens are joined WITHOUT a separator, which is deliberate. AMFI and the
 * AMCs disagree about word boundaries constantly — the SBI workbook prints
 * `SBI Nifty Midcap150 ETF` where NAVAll prints `SBI Nifty Midcap 150 ETF`, and
 * `Flexicap`/`Flexi Cap` and `Midcap`/`Mid Cap` both occur. Measured over the
 * 333 real workbook sheet names: separator-free joining resolves **5 more** than
 * a space-joined key. Token-aligned comparisons still exist where they are
 * needed — {@link SchemeFamily.tokens} keeps the split form for exactly that.
 *
 * Returns `""` for a name that is entirely plan/option words. `""` is never
 * indexed and never matches, so an empty key cannot become a wildcard.
 */
export function schemeFamilyKey(name: string): string {
  return schemeFamilyTokens(name).join("");
}

/**
 * The family key's tokens, before they are joined.
 *
 * Exposed because the key is separator-free by design (see
 * {@link schemeFamilyKey}) and therefore cannot be split back apart, while the
 * token-aligned comparisons that decide ambiguity need the split form.
 *
 * NOTE the split is NOT canonical for a family: `SBI Nifty Midcap150 ETF` and
 * `SBI Nifty Midcap 150 ETF` share a key and produce 4 and 5 tokens
 * respectively. Measured across the live feed, **57 of 4,109 families** contain
 * members that disagree about the split — `ADITYA BIRLA SUN LIFE` vs `ADITYA
 * BIRLA SUNLIFE`, `LARGE AND MID CAP` vs `LARGE AND MIDCAP`, `SERIES 15` vs
 * `SERIES15`. Every one of those 57 is a pair the separator-free key correctly
 * MERGED and a space-joined key would have split into two funds, which is the
 * argument for the design rather than against it.
 *
 * The cost is confined to the diagnostic paths: {@link SchemeFamily.tokens}
 * holds whichever split the family's first feed member produced, so an extension
 * check against a differently-split input can miss. It can never produce a WRONG
 * match, only a missing near-miss line in a coverage report, because every match
 * that yields codes goes through the exact key.
 */
export function schemeFamilyTokens(name: string): readonly string[] {
  if (typeof name !== "string") return [];
  const tokens = collapseRepeatedPrefix(nameTokens(name));

  let end = tokens.length;
  let sawNoise = false;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (PLAN_OPTION_TOKENS.has(t)) {
      sawNoise = true;
      end = i;
      continue;
    }
    // A connector is only skippable once a noise run is under way, and it never
    // extends the strip on its own.
    if (sawNoise && CONNECTOR_TOKENS.has(t)) continue;
    break;
  }
  // Never end the key on a connector — `… FUND OF` is not a family name.
  while (end > 0 && CONNECTOR_TOKENS.has(tokens[end - 1]!)) end--;

  return tokens.slice(0, end);
}

/* -------------------------------------------------------------------------- */
/* Index                                                                       */
/* -------------------------------------------------------------------------- */

/** One scheme family within one AMC: the thing a workbook sheet maps to. */
export interface SchemeFamily {
  /** {@link schemeFamilyKey} of every member. */
  key: string;
  /** The same key, token-split — for token-aligned prefix comparisons. */
  tokens: readonly string[];
  /** Every AMFI scheme code in the family, in feed order. THE payload. */
  schemeCodes: readonly string[];
  /** Every ISIN across both columns, deduped — the secondary join key. */
  isins: readonly string[];
  /** One member's printed name, verbatim. Evidence for a human auditing a match. */
  sampleName: string;
}

export interface AmcSchemeIndex {
  /** Byte-exact NAVAll group header / `AmfiAmcRecord.fundName`. */
  amcName: string;
  /** AMFI's `mfId`, when a registry was supplied and matched. */
  mfId: string | null;
  families: readonly SchemeFamily[];
  schemeCount: number;
}

export interface SchemeIndex {
  amcs: readonly AmcSchemeIndex[];
}

/** How the AMC was named. Explicit so `"22"` can never be read as a fund name. */
export type AmcRef = { readonly fundName: string } | { readonly mfId: string };

/**
 * Build the per-AMC family index from a parsed feed.
 *
 * `registry` is optional and adds only `mfId`. Without it, {@link resolveSchemeCode}
 * can still be called by `fundName`; an `mfId` lookup will report the AMC as not
 * found, which is honest — we genuinely cannot map the id without the registry.
 */
export function buildSchemeIndex(
  file: NavAllFile,
  registry?: AmfiAmcRegistry,
): SchemeIndex {
  const mfIdByFundName = new Map<string, string>();
  if (registry) {
    for (const amc of registry.amcs) mfIdByFundName.set(amc.fundName, amc.mfId);
  }

  const amcs = file.groups.map((group): AmcSchemeIndex => {
    const acc = new Map<
      string,
      {
        tokens: readonly string[];
        codes: string[];
        isins: Set<string>;
        sample: string;
      }
    >();

    for (const scheme of group.schemes) {
      const tokens = schemeFamilyTokens(scheme.schemeName);
      const key = tokens.join("");
      // A name that is nothing but plan/option words has no family. Indexing it
      // under "" would make every unresolvable lookup collide with it.
      if (key === "") continue;

      let entry = acc.get(key);
      if (!entry) {
        entry = {
          tokens,
          codes: [],
          isins: new Set(),
          sample: scheme.schemeName,
        };
        acc.set(key, entry);
      }
      entry.codes.push(scheme.schemeCode);
      if (scheme.isinGrowth !== null) entry.isins.add(scheme.isinGrowth);
      if (scheme.isinReinvestment !== null)
        entry.isins.add(scheme.isinReinvestment);
    }

    return {
      amcName: group.amcName,
      mfId: mfIdByFundName.get(group.amcName) ?? null,
      families: [...acc.entries()].map(([key, e]) => ({
        key,
        tokens: e.tokens,
        schemeCodes: e.codes,
        isins: [...e.isins],
        sampleName: e.sample,
      })),
      schemeCount: group.schemes.length,
    };
  });

  return { amcs };
}

function findAmc(index: SchemeIndex, ref: AmcRef): AmcSchemeIndex | undefined {
  if ("fundName" in ref) {
    // EXACT, for the same reason `findAmcByFundName` is exact: the byte-identity
    // of the group header to the registry's `fundName` is the entire join. A
    // fuzzy hit here attributes a whole AMC's scheme codes to the wrong house.
    return index.amcs.find((a) => a.amcName === ref.fundName);
  }
  return index.amcs.find((a) => a.mfId !== null && a.mfId === ref.mfId);
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The answer to "which AMFI scheme codes is this workbook sheet about?".
 *
 * Four outcomes, and only ONE of them yields codes. `ambiguous` and `no-match`
 * both refuse; they are separate because they need different remediation — an
 * ambiguous name means the workbook printed something under-specified (and the
 * candidates say what it could be), while a no-match means we could not identify
 * the scheme at all.
 */
export type SchemeResolution =
  | {
      readonly status: "matched";
      readonly amcName: string;
      readonly familyKey: string;
      readonly family: SchemeFamily;
      readonly schemeCodes: readonly string[];
    }
  | {
      readonly status: "ambiguous";
      readonly amcName: string;
      readonly familyKey: string;
      /** Every family the name could mean. Never collapsed to a "best" one. */
      readonly candidates: readonly SchemeFamily[];
    }
  | {
      readonly status: "no-match";
      readonly amcName: string;
      readonly familyKey: string;
      /**
       * Families sharing the longest token prefix with the input. DIAGNOSTIC
       * ONLY — a near miss is not a match, and nothing here may be used as a
       * scheme code. It exists so an operator reading a coverage report can see
       * that `SBI CRISIL IBX Gilt Index-APR-2029 Fund` failed against
       * `… - April 2029 Fund` and fix the abbreviation, rather than staring at a
       * bare zero.
       */
      readonly nearest: readonly SchemeFamily[];
    }
  | {
      readonly status: "amc-not-found";
      readonly amc: AmcRef;
    };

/** How many leading tokens two families share. */
function sharedPrefixLength(
  a: readonly string[],
  b: readonly string[],
): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** True when `family` is `input` plus at least one more token. */
function isStrictExtension(
  family: readonly string[],
  input: readonly string[],
): boolean {
  return (
    family.length > input.length &&
    sharedPrefixLength(family, input) === input.length
  );
}

const MAX_NEAREST = 3;

/**
 * Resolve a printed scheme name to AMFI scheme codes within one AMC.
 *
 * The rule, in order:
 *
 *  1. **Exact family key** → `matched`. Family keys are unique within an AMC by
 *     construction, so an exact hit is never ambiguous — a scheme literally
 *     named that is not made uncertain by the existence of its own sub-plans.
 *  2. Otherwise, families that are strict TOKEN extensions of the input.
 *     Two or more → `ambiguous`, with all of them.
 *  3. Otherwise → `no-match`.
 *
 * Note what step 2 deliberately does NOT do: a single extension is **not**
 * promoted to a match. `Bandhan Short Duration Fund` extending only to
 * `… Plan B` does not make the workbook's plain-named sheet a Plan B portfolio,
 * and inventing that link is precisely the silent mis-attribution this module
 * exists to prevent. Measured over the 333 real workbook sheet names, the
 * unique-extension case fires **zero** times, so nothing is lost by refusing it.
 */
export function resolveSchemeCode(
  index: SchemeIndex,
  input: { readonly amc: AmcRef; readonly schemeName: string },
): SchemeResolution {
  const amc = findAmc(index, input.amc);
  if (!amc) return { status: "amc-not-found", amc: input.amc };

  const tokens = schemeFamilyTokens(input.schemeName);
  const familyKey = tokens.join("");
  if (familyKey === "") {
    return {
      status: "no-match",
      amcName: amc.amcName,
      familyKey,
      nearest: [],
    };
  }

  const exact = amc.families.find((f) => f.key === familyKey);
  if (exact) {
    return {
      status: "matched",
      amcName: amc.amcName,
      familyKey,
      family: exact,
      schemeCodes: exact.schemeCodes,
    };
  }

  const extensions = amc.families.filter((f) =>
    isStrictExtension(f.tokens, tokens),
  );
  if (extensions.length >= 2) {
    return {
      status: "ambiguous",
      amcName: amc.amcName,
      familyKey,
      candidates: extensions,
    };
  }

  // Diagnostic near misses: the families sharing the longest token prefix.
  let best = 0;
  for (const f of amc.families) {
    const shared = sharedPrefixLength(f.tokens, tokens);
    if (shared > best) best = shared;
  }
  const nearest =
    best >= 2
      ? amc.families
          .filter((f) => sharedPrefixLength(f.tokens, tokens) === best)
          .slice(0, MAX_NEAREST)
      : [];

  return { status: "no-match", amcName: amc.amcName, familyKey, nearest };
}

/* -------------------------------------------------------------------------- */
/* Coverage                                                                    */
/* -------------------------------------------------------------------------- */

/** One workbook sheet name and what became of it. */
export interface SchemeCoverageEntry {
  readonly schemeName: string;
  readonly familyKey: string;
  readonly status: SchemeResolution["status"];
  /** Codes for a `matched` entry; empty for every other status. */
  readonly schemeCodes: readonly string[];
  /**
   * For `ambiguous`, the family keys it could have meant; for `no-match`, the
   * nearest keys. Empty otherwise. Never a code — see {@link SchemeResolution}.
   */
  readonly candidateKeys: readonly string[];
}

/**
 * Whether an AMC's workbook actually joins to AMFI, in numbers.
 *
 * This is the audit surface for the whole bridge. `resolvedRate` is a fraction
 * of names that produced scheme codes, and `unresolved` names them all — a rate
 * with no list is a number nobody can act on, and the failures cluster
 * (abbreviations, renamed schemes, funds absent from NAVAll entirely) in ways
 * only the names reveal.
 *
 * `resolved + ambiguous + noMatch + amcNotFound === total` always holds.
 *
 * ## STATUS — MONEY-1238 decision: KEEP AND WIRE, do not delete
 *
 * "The audit surface for the whole bridge" has zero production callers today.
 * `workers/src/processors/mf-portfolio-sync.ts` calls {@link resolveSchemeCode}
 * per sheet (~:335), keeps the code only on a single-candidate `matched`, and
 * DISCARDS `ambiguous` / `no-match` / `amc-not-found` without counting them.
 * So the failure this report exists for is live and unobserved: an AMC that
 * renames its schemes makes every `amfiSchemeCode` null while the job reports
 * `written: 4,000` — a perfect-looking run whose holdings join to no fund.
 *
 * Kept rather than deleted because it is NOT a duplicate of anything the
 * worker already does: nothing anywhere tallies resolution outcomes. The
 * wiring is one call per AMC over the sheet names, with `resolvedRate` and
 * `unresolved` going into the job outcome the run already writes. That file is
 * outside this batch's edit scope.
 */
export interface SchemeCoverageReport {
  readonly amc: AmcRef;
  /** `null` when the AMC is not in the feed at all. */
  readonly amcName: string | null;
  readonly total: number;
  readonly resolved: number;
  readonly ambiguous: number;
  readonly noMatch: number;
  readonly amcNotFound: number;
  /** `resolved / total`, or 0 for an empty input. Never NaN. */
  readonly resolvedRate: number;
  /** Distinct scheme codes recovered across all resolved names. */
  readonly schemeCodeCount: number;
  readonly entries: readonly SchemeCoverageEntry[];
  /** Just the entries that produced no codes, in input order. */
  readonly unresolved: readonly SchemeCoverageEntry[];
}

export function reportSchemeCoverage(
  index: SchemeIndex,
  amc: AmcRef,
  schemeNames: readonly string[],
): SchemeCoverageReport {
  const entries: SchemeCoverageEntry[] = [];
  const codes = new Set<string>();
  let resolved = 0;
  let ambiguous = 0;
  let noMatch = 0;
  let amcNotFound = 0;
  let amcName: string | null = null;

  for (const schemeName of schemeNames) {
    const r = resolveSchemeCode(index, { amc, schemeName });
    if (r.status !== "amc-not-found") amcName = r.amcName;

    switch (r.status) {
      case "matched":
        resolved++;
        for (const c of r.schemeCodes) codes.add(c);
        entries.push({
          schemeName,
          familyKey: r.familyKey,
          status: r.status,
          schemeCodes: r.schemeCodes,
          candidateKeys: [],
        });
        break;
      case "ambiguous":
        ambiguous++;
        entries.push({
          schemeName,
          familyKey: r.familyKey,
          status: r.status,
          schemeCodes: [],
          candidateKeys: r.candidates.map((c) => c.key),
        });
        break;
      case "no-match":
        noMatch++;
        entries.push({
          schemeName,
          familyKey: r.familyKey,
          status: r.status,
          schemeCodes: [],
          candidateKeys: r.nearest.map((c) => c.key),
        });
        break;
      case "amc-not-found":
        amcNotFound++;
        entries.push({
          schemeName,
          familyKey: schemeFamilyKey(schemeName),
          status: r.status,
          schemeCodes: [],
          candidateKeys: [],
        });
        break;
    }
  }

  const total = schemeNames.length;
  return {
    amc,
    amcName,
    total,
    resolved,
    ambiguous,
    noMatch,
    amcNotFound,
    // Guarded: an empty sheet list is a legitimate input and must not yield NaN.
    resolvedRate: total > 0 ? resolved / total : 0,
    schemeCodeCount: codes.size,
    entries,
    unresolved: entries.filter((e) => e.status !== "matched"),
  };
}
