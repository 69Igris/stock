/**
 * Institutional client classification — MONEY-268.
 *
 * `InstitutionalDeal.clientName` is the only free Indian source that names WHO
 * traded, and it is free text. NSE publishes no participant category alongside
 * it. This module turns that string into one of three buckets:
 *
 *     FII | DII | INSTITUTIONAL
 *
 * where `INSTITUTIONAL` means **we did not recognise the counterparty**, not
 * "some third kind of investor". Every name that does not hit a marker lands
 * there, and that is the design: the module is an allowlist, so its failure
 * mode is an under-claim ("Institutional") rather than a wrong claim ("FII").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why this exists at all, given the standing rule against it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `sector-deep-dive.ts` used to carry the opposite instruction — "bucketing
 * `clientName` into FII/DII by name matching … is a heuristic sold as an
 * exchange fact". That objection is about the SALE, not the matching, and it is
 * answered structurally rather than by argument:
 *
 *   1. The **ranking** the picks card shows (net ₹ per symbol over the window)
 *      is pure arithmetic over exchange-reported prints. No heuristic touches
 *      the ordering, the values, or which symbols appear.
 *   2. The classification only decorates a row with a chip, and the chip's
 *      third value is the honest "we don't know" — which is what the majority
 *      of real names get.
 *   3. Markers are matched as WHOLE TOKENS, never substrings, and a name
 *      carrying markers of both classes is refused rather than resolved.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Measured against 400 real prod names (2026-08-19)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `institutional_deals` on prod holds 3,386 rows over 1,349 distinct
 * `clientName` values; the 400 most frequent were captured and every rule below
 * is justified by what they contain. Two findings changed the design:
 *
 * **(a) Substring matching is not merely imprecise, it inverts the answer.**
 * `"LP"` as a substring hit 33 of the 400 names and was RIGHT twice — the other
 * 31 are `LLP` (the Indian Limited Liability Partnership form used by every
 * domestic prop shop: GRAVITON RESEARCH CAPITAL LLP, QE SECURITIES LLP, …),
 * plus incidental hits inside `ALPHA`, `PLUTUS` and `BULLPULSE`. `"ODI"` hit 12
 * and was right 6 times — `COMMODITIES` and `FIRODIA` supplied the rest.
 * `"GLOBAL"` swept up `TRANSGLOBAL SECURITIES LTD` and `GLOBALWORTH SECURITIES
 * LIMITED`, both Indian brokers. Token matching removes every one of those.
 *
 * **(b) Some names carry markers of BOTH classes, and the ones that do are
 * exactly the names a coin-flip gets wrong.** `NORGES BANK ON ACCOUNT OF THE
 * GOVERNMENT PENSION FUND GLOBAL` is the largest FII on earth and matches the
 * DII marker `PENSION`; `AMERICAN FUNDS INSURANCE SERIES GLOBAL SMALL
 * CAPITALIZATION FUND` matches `INSURANCE`. Any fixed precedence between the
 * lists labels one of these wrong. Refusing both (→ `INSTITUTIONAL`) is the
 * only answer that is never false.
 *
 * **(c) One marker is DESCRIPTIVE rather than jurisdictional, and needs a
 * veto.** `GLOBAL` is a word Indian brokers put in their own names: it took
 * `RAJASTHAN GLOBAL SECURITIES PVT LTD` and `OSC GLOBAL PROCESSING PRIVATE
 * LIMITED` with it, and the first of those reached a live sector card labelled
 * FII during this ticket's runtime check. Deleting the marker is not the
 * answer — it is right on the other 20 hits (BLACKROCK GLOBAL FUNDS, PINE OAK
 * GLOBAL FUND, MANULIFE GLOBAL FUND INDIA EQUITY FUND, …). So `GLOBAL` is the
 * one WEAK marker, and a weak-ONLY match loses to an Indian corporate form.
 *
 * The scoping is the whole trick, and it is why the naive form of this veto had
 * to be rejected: NSE's own file writes `CITIGROUP GLOBAL MARKETS MAURITIUS PVT
 * LTD`, so `PVT` is not India-exclusive in this feed and a blanket veto would
 * demote a genuine FII. That name survives because `MAURITIUS` is STRONG — the
 * veto never fires when a jurisdiction, legal form or ODI route is present.
 * Measured effect: `GLOBAL` goes 20/22 → 20/20, losing nothing.
 */

/** The three buckets. `INSTITUTIONAL` is "unrecognised", not a third species. */
export type InstitutionalClientClass = "FII" | "DII" | "INSTITUTIONAL";

/**
 * Foreign-investor markers.
 *
 * Each entry is a whole-token SEQUENCE, so `"LP"` matches `… MASTER FUND LP`
 * and not `… CAPITAL LLP`. Ordering carries no meaning — a name either hits the
 * set or it does not.
 *
 * `ODI` is the offshore-derivative-instrument suffix NSE appends to a
 * participatory-note counterparty (`SOCIETE GENERALE - ODI`, `GOLDMAN SACHS
 * BANK EUROPESE-ODI`). It is by definition foreign money, and normalisation
 * splits it off whether the file separates it with a space, a hyphen or
 * neither.
 */
export const STRONG_FII_MARKERS: readonly string[] = [
  "FPI",
  "MAURITIUS",
  "SINGAPORE",
  "OFFSHORE",
  "ODI",
  "LLC",
  "LP",
  "PLC",
];

/**
 * FII markers that are ordinary English words, not regulatory facts.
 *
 * These are real evidence — twenty of `GLOBAL`'s twenty-two hits on the
 * captured names are genuine foreign funds — but they are the only markers a
 * domestic firm can hit by naming itself aspirationally, so they alone are
 * subject to `INDIAN_FORM_TOKENS` below.
 */
export const WEAK_FII_MARKERS: readonly string[] = ["GLOBAL"];

/** Every FII marker, strong and weak. Exported for tests and for auditing. */
export const FII_MARKERS: readonly string[] = [
  ...STRONG_FII_MARKERS,
  ...WEAK_FII_MARKERS,
];

/**
 * Statutory forms that place an entity under the Indian Companies Act / LLP
 * Act. A firm carrying one is incorporated in India and cannot itself be the
 * foreign portfolio investor.
 *
 * This vetoes a WEAK-only FII match and nothing else — see the module note.
 * It does NOT promote the name to DII: an Indian broker or prop desk is neither
 * a foreign investor nor a domestic institution in the DII sense, so the honest
 * answer is `INSTITUTIONAL`.
 */
export const INDIAN_FORM_TOKENS: readonly string[] = [
  "PVT",
  "PRIVATE",
  "LLP",
  "HUF",
];

/**
 * Domestic-institution markers.
 *
 * `LIC` and `AMC` are single tokens on purpose. As substrings they would fire
 * inside `PUBLIC` / `POLICY` and `DYNAMC`-style typos; the brief wrote `"LIC "`
 * with a trailing space for exactly that reason, and tokenising generalises it.
 */
export const DII_MARKERS: readonly string[] = [
  "MUTUAL FUND",
  "LIFE INSURANCE",
  "INSURANCE",
  "LIC",
  "AMC",
  "PENSION",
  "EPFO",
];

/**
 * Markers from the MONEY-268 brief that MEASURED ZERO PRECISION and are
 * therefore not in the active sets. Kept as data, not as a deleted line, so the
 * decision is auditable and reversible in one edit — and so a test can assert
 * they stay out until the evidence changes.
 *
 * A marker that is wrong on every real name it matches is not an allowlist
 * entry; it is a guess with extra steps, and the whole module exists to not do
 * that.
 */
export const RETIRED_MARKERS: Readonly<Record<string, string>> = {
  // 0 of 2 hits in 400 captured names. `ARIHANT CAPITAL MARKETS LIMITED` is an
  // Indore broker and `TOWER RESEARCH CAPITAL MARKETS INDIA PRIVATE LIMITED` is
  // a US firm's INDIAN broking arm — an Indian entity, not the FII. "Capital
  // markets" is a line of business, not a jurisdiction.
  "CAPITAL MARKETS":
    "FII marker: 0/2 correct on prod names — both hits are Indian brokers",
  // 0 of 2 hits. `… PTY LTD AS TRUSTEE FOR …` is how Australian superannuation
  // funds are named (CARE SUPER, UNITED SUPER) — foreign money that this marker
  // would have stamped DII. Indian MF trustee companies use the same phrase, so
  // the token cannot separate them.
  TRUSTEE:
    "DII marker: 0/2 correct on prod names — both hits are Australian super funds",
};

/**
 * Uppercase, collapse every non-alphanumeric run to a single space, and pad
 * with one space at each end.
 *
 * NOT `normalizeClientName` from `ownership-section-logic.ts`, which is the
 * DISPLAY normaliser (trim, collapse whitespace, drop trailing punctuation) and
 * deliberately preserves the `-`, `/` and `(` that a matcher has to erase.
 * Two different jobs; sharing one function would make each worse.
 *
 * The padding is what makes `includes(" LP ")` a token test rather than a
 * substring test, and it is why the separators NSE actually uses — `-`, `/`,
 * `.`, `(`, `)`, `&`, `#`, double spaces — all resolve to the same thing:
 *
 *     "GOLDMAN SACHS BANK EUROPESE-ODI"  → " GOLDMAN SACHS BANK EUROPESE ODI "
 *     "PZENA VALUE FUNDS PLC/PZENA …"    → " PZENA VALUE FUNDS PLC PZENA … "
 *     "… PORTFOLIO (GQG PARTNERS LLC)"   → " … PORTFOLIO GQG PARTNERS LLC "
 *
 * Digits are KEPT (`ABS DIRECT EQUITY FUND LLC - INDIA SERIES 1`); dropping
 * them would fuse tokens that the file separates.
 */
export function tokenizeClientName(clientName: string): string {
  const collapsed = clientName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return collapsed.length === 0 ? "" : ` ${collapsed} `;
}

/** Whether `normalized` (space-padded) contains `marker` as a whole token run. */
function hasMarker(normalized: string, marker: string): boolean {
  return normalized.includes(` ${marker} `);
}

/**
 * Classify a disclosed counterparty.
 *
 * Deterministic and total: same string in, same bucket out, no I/O, no locale
 * dependence beyond ASCII case folding.
 *
 * The three-way outcome is decided by how many CLASSES matched, never by which
 * marker matched first:
 *
 *   - exactly one class  → that class
 *   - both classes       → `INSTITUTIONAL` (see the module note on NORGES BANK)
 *   - neither            → `INSTITUTIONAL`
 *
 * …after the weak-marker veto has run, which can only ever REMOVE the FII
 * reading, never add one.
 *
 * That collapse is why the function cannot be rewritten as an ordered
 * `if (isFii) … else if (isDii) …` chain: an ordered chain silently resolves
 * the ambiguous names, and the ambiguous names are the ones worth refusing.
 */
export function classifyInstitutionalClient(
  clientName: string,
): InstitutionalClientClass {
  const normalized = tokenizeClientName(clientName);
  if (normalized === "") return "INSTITUTIONAL";

  const strongFii = STRONG_FII_MARKERS.some((m) => hasMarker(normalized, m));
  const weakFii = WEAK_FII_MARKERS.some((m) => hasMarker(normalized, m));
  // The veto is evaluated ONLY against a weak-only match. A name with a
  // jurisdiction, legal form or ODI route on it keeps its FII reading no matter
  // what corporate form NSE also wrote down.
  const vetoed =
    !strongFii &&
    weakFii &&
    INDIAN_FORM_TOKENS.some((t) => hasMarker(normalized, t));
  const fii = strongFii || (weakFii && !vetoed);
  const dii = DII_MARKERS.some((m) => hasMarker(normalized, m));

  if (fii && dii) return "INSTITUTIONAL";
  if (fii) return "FII";
  if (dii) return "DII";
  return "INSTITUTIONAL";
}

/** Reader-facing chip text. `INSTITUTIONAL` must not read as an acronym. */
export function institutionalClassLabel(
  cls: InstitutionalClientClass,
): "FII" | "DII" | "Institutional" {
  return cls === "INSTITUTIONAL" ? "Institutional" : cls;
}
