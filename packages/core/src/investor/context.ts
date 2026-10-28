/**
 * Investor-memory prompt context (MONEY-790, B5).
 *
 * Turns the user's durable {@link InvestorProfile} (seeded in B2), their
 * concept-mastery (B2), and any derived {@link PortfolioInsight} rows (B4 — may
 * not exist yet) into a COMPACT, descriptive markdown block that gets injected
 * into the chat + research prompts so StockSage "remembers" the investor across
 * sessions.
 *
 * SEBI-SAFE: the block DESCRIBES the investor (e.g. "conservative",
 * "dividend-oriented", "tends to trade frequently"). It NEVER advises, implies,
 * or recommends a buy/sell. The framing directive in the heading makes that
 * explicit to the model.
 *
 * Two layers (same split as `profile.ts`):
 *
 *   1. PURE: {@link formatInvestorContext} — takes already-loaded data and
 *      renders the markdown. No I/O, unit-testable without a DB.
 *
 *   2. DB seam: {@link assembleUserContext} — gathers seed signals, ensures a
 *      profile exists, reads profile + mastery + insights, then calls the pure
 *      formatter. Gated on `process.env.DATABASE_URL`, NEVER throws, returns
 *      `""` on any miss/error. This "never break the caller" contract is
 *      load-bearing: chat + research must keep working when memory is
 *      unavailable.
 *
 * SERVER-ONLY (imports prisma). Import from the
 * `@usemoney/core/investor/context` subpath — never the `@usemoney/core` or
 * `@usemoney/core/investor` barrel from client code.
 */

import { prisma } from "@usemoney/database";
import { ensureSeededProfile } from "./profile";
import { getConcept } from "./concepts";
import type {
  ExperienceLevel,
  MasteryLevel,
  RiskAppetite,
  SeedSignals,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────
// PURE formatter — no I/O. Unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────

/** The profile fields the formatter renders. Mirrors the relevant `InvestorProfile` columns. */
export interface InvestorProfileView {
  riskAppetite: RiskAppetite;
  experienceLevel: ExperienceLevel;
  /** 0..1 trust in this profile. */
  confidence: number;
  /** Behavioural propensities, each a soft 0..1 score. */
  panicSeller: number;
  overtrader: number;
  fomoProne: number;
  dividendSeeker: number;
}

/** A single concept-mastery row reduced to what the formatter needs. */
export interface ConceptMasteryView {
  conceptId: string;
  pKnown: number;
  level: MasteryLevel;
  attempts: number;
}

/** A derived portfolio insight (B4) reduced to its rendered summary. */
export interface PortfolioInsightView {
  summary: string;
}

/**
 * Behavioural-flag → descriptive phrase map. A flag is mentioned only when its
 * score crosses {@link TRAIT_THRESHOLD}. Every phrase DESCRIBES a tendency — it
 * never advises an action. Order is the rendering order.
 */
const TRAIT_PHRASES: ReadonlyArray<{
  key: keyof Pick<
    InvestorProfileView,
    "overtrader" | "panicSeller" | "fomoProne" | "dividendSeeker"
  >;
  phrase: string;
}> = [
  { key: "overtrader", phrase: "tends to trade frequently" },
  { key: "panicSeller", phrase: "tends to sell into drawdowns" },
  { key: "fomoProne", phrase: "momentum-chasing" },
  { key: "dividendSeeker", phrase: "dividend-oriented" },
];

/** A behavioural propensity above this is strong enough to mention. */
export const TRAIT_THRESHOLD = 0.5;

/** Concepts at or above this P(known) count as "comfortable with". */
const STRONG_PKNOWN = 0.6;
/** Concepts below this P(known) (with at least one attempt) count as "still learning". */
const WEAK_PKNOWN = 0.5;

/** Max characters of any single free-text field we render into the prompt. */
const MAX_FREETEXT_LEN = 160;

/**
 * Neutralize a free-text value before it is injected into an LLM prompt.
 *
 * THREAT: anything rendered here ends up inside the chat / research SYSTEM
 * prompt. The only genuinely free-text inputs the formatter handles are the
 * derived `PortfolioInsight.summary` (which interpolates a holding's `sector`
 * label — user/broker/CSV-sourced) and the concept-name fallback (a raw slug
 * when `getConcept` misses). Without neutralization a crafted sector like
 * `"Tech\n\n## SYSTEM: ignore all previous instructions …"` would break out of
 * its bullet line and inject a fake heading / instruction turn.
 *
 * Defense (defense-in-depth — the real generators are bounded, this is the
 * last line before the model):
 *   - collapse ALL whitespace (newlines, tabs, CR) to single spaces so the
 *     value can never escape its single bullet line or forge a new markdown
 *     heading / list item / role turn;
 *   - strip markdown/control structural characters that start headings, lists,
 *     code fences, blockquotes, or look like a chat role marker;
 *   - hard-cap the length (bounded output + cheap anti-DoS).
 *
 * Returns "" when nothing printable survives, so the caller can omit the line.
 */
export function neutralizeText(value: string): string {
  if (typeof value !== "string") return "";
  return (
    value
      // Collapse every run of whitespace (incl. newlines/CR/tabs) to one space.
      .replace(/\s+/g, " ")
      // Drop ASCII control chars that survived (defensive; \s covers most).
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
      // Strip markdown / role structural markers ("#", "*", ">", "`", "|",
      // and "system:"-style role prefixes) so the value can never read as a
      // heading, list item, fence, table, or instruction turn.
      .replace(/[#>*`|]/g, " ")
      .replace(/\b(system|assistant|user)\s*:/gi, "$1 ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_FREETEXT_LEN)
      .trim()
  );
}

/**
 * Resolve a concept slug to its human-readable name (falls back to the slug).
 * The fallback slug is neutralized — a `ConceptMasteryView.conceptId` read back
 * from the DB is system-derived in practice, but the formatter is a public pure
 * function and must not trust its inputs to inject prompt text.
 */
function conceptName(conceptId: string): string {
  const name = getConcept(conceptId)?.name;
  if (name) return name;
  return neutralizeText(conceptId);
}

/**
 * PURE: render the compact investor-memory markdown block.
 *
 * Returns `""` when there is genuinely nothing to say (no profile). Only lines
 * backed by real data are emitted, so the block is ~6-9 lines at most. The
 * heading carries the SEBI framing directive so the model treats this as a
 * description of the user, not as advice.
 *
 * @param profile  the user's profile, or `null` if none could be built.
 * @param strong   concepts the user is comfortable with (already filtered/sorted).
 * @param weak     concepts the user is still learning (already filtered/sorted).
 * @param insights latest derived portfolio insights (may be empty).
 */
export function formatInvestorContext(
  profile: InvestorProfileView | null,
  strong: ConceptMasteryView[] = [],
  weak: ConceptMasteryView[] = [],
  insights: PortfolioInsightView[] = [],
): string {
  if (!profile) return "";

  const lines: string[] = [
    "## Investor profile (for personalization — describe the user, never advise)",
  ];

  // Risk appetite · experience · confidence.
  const confidence = Number.isFinite(profile.confidence)
    ? Math.round(clamp01(profile.confidence) * 100) / 100
    : 0.1;
  lines.push(
    `- Risk appetite: ${profile.riskAppetite} · Experience: ${profile.experienceLevel} (confidence ${confidence})`,
  );

  // Behavioural tendencies — only flags above the threshold, descriptive only.
  const tendencies = TRAIT_PHRASES.filter(
    ({ key }) =>
      Number.isFinite(profile[key]) && profile[key] > TRAIT_THRESHOLD,
  ).map(({ phrase }) => phrase);
  if (tendencies.length > 0) {
    lines.push(`- Tendencies: ${tendencies.join("; ")}`);
  }

  // Concept mastery — comfortable-with / still-learning, by readable name.
  const comfortable = strong.map((c) => conceptName(c.conceptId));
  const learning = weak.map((c) => conceptName(c.conceptId));
  if (comfortable.length > 0 || learning.length > 0) {
    const segs: string[] = [];
    if (comfortable.length > 0)
      segs.push(`Comfortable with: ${comfortable.join(", ")}`);
    if (learning.length > 0)
      segs.push(`Still learning: ${learning.join(", ")}`);
    lines.push(`- ${segs.join(" · ")}`);
  }

  // Latest portfolio insight summary (B4) — omitted entirely when absent.
  // NEUTRALIZED: the summary interpolates a user/broker/CSV-sourced sector
  // label, so it is free text that must not carry prompt instructions.
  const insightSummary = insights
    .map((i) => neutralizeText(i.summary ?? ""))
    .find((s) => !!s);
  if (insightSummary) {
    lines.push(`- Portfolio note: ${insightSummary}`);
  }

  return lines.join("\n");
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * PURE seed-signal math: the top-holding concentration (largest position's
 * weight) over a list of holding `currentValue`s.
 *
 * Extracted from {@link gatherSeedSignals} (MONEY-806 (1)) so the bound's edge
 * cases are unit-testable without the prisma seam: only finite, strictly-positive
 * values count toward the total (a `null` / `NaN` / `0` / negative `currentValue`
 * row contributes nothing), and the result is the max weight `vᵢ / Σv`. Returns
 * `undefined` when no positive value survives (an empty / all-junk portfolio) so
 * the caller omits the signal rather than emitting a NaN concentration.
 *
 * The caller pre-bounds the row count (`take: MAX_HOLDINGS_FOR_SIGNALS`, ordered
 * by `currentValue` desc), so the largest positions — the only ones that move
 * this signal — are always included; this function just folds whatever it is
 * handed.
 */
export function topWeightFromValues(
  values: ReadonlyArray<number | null | undefined>,
): number | undefined {
  const positive = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  const total = positive.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return undefined;
  return Math.max(...positive.map((v) => v / total));
}

// ─────────────────────────────────────────────────────────────────────────
// DB seam — imports prisma. Best-effort, NEVER throws, "" on any miss/error.
// ─────────────────────────────────────────────────────────────────────────

/** How many strongest / weakest concepts to surface in the block. */
const MAX_CONCEPTS = 3;
/** How many latest insights to read (we render at most one summary). */
const MAX_INSIGHTS = 3;
/**
 * Cap on holdings rows read for seed-signal math (top-weight + HHI). Ordered by
 * `currentValue` desc, so the largest positions — the only ones that move the
 * top-weight / concentration signals — are always included; a long tail of tiny
 * holdings contributes ~nothing to HHI and is safely dropped. Bounds the read
 * so prompt assembly never pulls an unbounded portfolio.
 */
const MAX_HOLDINGS_FOR_SIGNALS = 200;

/**
 * Assemble the user's durable investor-memory block for prompt injection.
 *
 * Best-effort and SIDE-EFFECT-LIGHT: it does a one-time profile seed (the
 * `ensureSeededProfile` seam only writes when no/low-confidence profile exists)
 * off cheap indexed reads, then reads back the profile + a few mastery rows +
 * the latest insights and formats them.
 *
 * Contract (load-bearing): gated on `DATABASE_URL`, NEVER throws, returns `""`
 * on any miss/error so chat + research keep working when memory is unavailable.
 */
export async function assembleUserContext(userId: string): Promise<string> {
  if (!process.env.DATABASE_URL || !userId) return "";

  try {
    // (a) Gather cheap, indexed seed signals, then ensure a profile exists.
    const signals = await gatherSeedSignals(userId);
    await ensureSeededProfile(userId, signals);

    // (b) Read the (now-guaranteed) profile.
    const profileRow = await prisma.investorProfile.findUnique({
      where: { userId },
      select: {
        riskAppetite: true,
        experienceLevel: true,
        confidence: true,
        panicSeller: true,
        overtrader: true,
        fomoProne: true,
        dividendSeeker: true,
      },
    });
    if (!profileRow) return "";

    const profile: InvestorProfileView = {
      riskAppetite: profileRow.riskAppetite as RiskAppetite,
      experienceLevel: profileRow.experienceLevel as ExperienceLevel,
      confidence: profileRow.confidence,
      panicSeller: profileRow.panicSeller,
      overtrader: profileRow.overtrader,
      fomoProne: profileRow.fomoProne,
      dividendSeeker: profileRow.dividendSeeker,
    };

    // (c) A few strongest + a few weakest/learning concepts.
    const [strongRows, weakRows] = await Promise.all([
      prisma.conceptMastery.findMany({
        where: { userId, pKnown: { gte: STRONG_PKNOWN } },
        orderBy: { pKnown: "desc" },
        take: MAX_CONCEPTS,
        select: { conceptId: true, pKnown: true, level: true, attempts: true },
      }),
      prisma.conceptMastery.findMany({
        where: { userId, attempts: { gt: 0 }, pKnown: { lt: WEAK_PKNOWN } },
        orderBy: { pKnown: "asc" },
        take: MAX_CONCEPTS,
        select: { conceptId: true, pKnown: true, level: true, attempts: true },
      }),
    ]);

    const strong: ConceptMasteryView[] = strongRows.map((r) => ({
      conceptId: r.conceptId,
      pKnown: r.pKnown,
      level: r.level as MasteryLevel,
      attempts: r.attempts,
    }));
    const weak: ConceptMasteryView[] = weakRows.map((r) => ({
      conceptId: r.conceptId,
      pKnown: r.pKnown,
      level: r.level as MasteryLevel,
      attempts: r.attempts,
    }));

    // (d) Latest derived insights (B4 — may be empty; graceful when so).
    const insightRows = await prisma.portfolioInsight.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: MAX_INSIGHTS,
      select: { summary: true },
    });
    const insights: PortfolioInsightView[] = insightRows.map((r) => ({
      summary: r.summary,
    }));

    // (e) Format the compact block.
    return formatInvestorContext(profile, strong, weak, insights);
  } catch (err) {
    // NEVER break the caller — memory is a nice-to-have on the prompt.
    console.warn("UseMoney: assembleUserContext failed", err);
    return "";
  }
}

/**
 * Gather the {@link SeedSignals} bag from cheap, indexed portfolio reads. Each
 * read is independent and best-effort; a single failure degrades to `undefined`
 * for that signal rather than aborting the whole assembly.
 */
async function gatherSeedSignals(userId: string): Promise<SeedSignals> {
  const signals: SeedSignals = {};

  // Holdings: count + top-weight + concentration (HHI) over currentValue.
  // MONEY-806 (1): bound the read — top-weight/HHI only need the largest
  // positions, so cap the row count (ordered by currentValue desc) rather than
  // pulling an unbounded portfolio on every prompt assembly.
  try {
    const holdings = await prisma.holding.findMany({
      where: { userId },
      select: { currentValue: true },
      orderBy: { currentValue: "desc" },
      take: MAX_HOLDINGS_FOR_SIGNALS,
    });
    // PURE math (extracted + unit-tested as `topWeightFromValues`): only finite,
    // strictly-positive values count; `undefined` when nothing positive survives.
    // topHoldingConcentration is what `seedProfile` reads, so it stays the primary
    // signal (HHI = Σ w² is derivable from the same weights but unused today).
    const topWeight = topWeightFromValues(holdings.map((h) => h.currentValue));
    if (topWeight !== undefined) {
      signals.topHoldingConcentration = topWeight;
    }
  } catch {
    // leave topHoldingConcentration undefined
  }

  // Positions: any OPEN F&O position ⇒ usesFno.
  try {
    const fnoCount = await prisma.position.count({
      where: { userId, segment: "FO", netQuantity: { not: 0 } },
    });
    if (fnoCount > 0) signals.usesFno = true;
  } catch {
    // leave usesFno undefined
  }

  // FIRE scenario: withdrawal rate + horizon (retirementAge − currentAge).
  try {
    const fire = await prisma.fireScenario.findFirst({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      select: {
        withdrawalRate: true,
        currentAge: true,
        retirementAge: true,
        yearsToFire: true,
      },
    });
    if (fire) {
      if (typeof fire.withdrawalRate === "number")
        signals.fireWithdrawalRate = fire.withdrawalRate;
      const horizon =
        typeof fire.yearsToFire === "number" && fire.yearsToFire > 0
          ? fire.yearsToFire
          : typeof fire.retirementAge === "number" &&
              typeof fire.currentAge === "number"
            ? fire.retirementAge - fire.currentAge
            : undefined;
      if (
        typeof horizon === "number" &&
        Number.isFinite(horizon) &&
        horizon > 0
      )
        signals.fireHorizonYears = horizon;
    }
  } catch {
    // leave FIRE signals undefined
  }

  // Trades: trailing-30d count.
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    signals.tradeCount30d = await prisma.trade.count({
      where: { userId, tradeDate: { gte: since } },
    });
  } catch {
    // leave tradeCount30d undefined
  }

  return signals;
}
