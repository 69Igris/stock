"use server";

/**
 * AI Filter Builder - Gemini Flash converts a thesis sentence into a
 * screener filter object (MONEY-202).
 *
 * Flow:
 *   1. User types: "high ROE compounders with low debt under PE 25"
 *   2. We pass the thesis + the active mode's filter schema as a JSON
 *      prompt to gemini-2.5-flash with response_mime_type=application/json
 *   3. Parse + Zod-validate. Drop unknown keys quietly so a bad model
 *      run can never inject garbage into the screener state.
 *   4. Charge 1 AI credit (refund on hard failure).
 *   5. Return a partial filter object the client merges into its state.
 *
 * Why graceful drops vs hard error: the screener supports a fixed
 * vocab; an LLM may name a real metric (e.g. "PEG ratio") we don't yet
 * filter on. Better to apply the recognised parts than reject the whole
 * generation.
 */

import { z } from "zod";
import { withVertexAI } from "@usemoney/core";
import {
  consumeCredits as consumeCreditsService,
  refundCredits as refundCreditsService,
} from "@usemoney/services";
import { getAuthenticatedUser } from "@/lib/auth";
import type { ServiceResult } from "@usemoney/services";
import type {
  ScreenFilters,
  MfScreenFilters,
  EtfScreenFilters,
} from "@/lib/screener/match-score";

// ── Input schema ───────────────────────────────────────────────────

const InputSchema = z.object({
  mode: z.enum(["stocks", "mf", "etf"]),
  thesis: z
    .string()
    .trim()
    .min(8, "Thesis is too short - give 1–2 sentences")
    .max(500, "Thesis is too long - keep under 500 chars"),
});

// ── Per-mode partial schemas (server-side allowlists) ──────────────

const StocksAllowed = z
  .object({
    exchange: z.enum(["NSE", "BSE"]).optional(),
    sector: z.string().max(40).optional(),
    marketCapBucket: z.enum(["LARGE", "MID", "SMALL"]).optional(),
    minPe: z.number().finite().optional(),
    maxPe: z.number().finite().optional(),
    minRoe: z.number().finite().optional(),
    maxRoe: z.number().finite().optional(),
    minRevenueGrowth: z.number().finite().optional(),
    maxRevenueGrowth: z.number().finite().optional(),
    minDebtToEquity: z.number().finite().optional(),
    maxDebtToEquity: z.number().finite().optional(),
  })
  .strip();

const MfAllowed = z
  .object({
    category: z.string().max(40).optional(),
    amcName: z.string().max(80).optional(),
    plan: z.enum(["DIRECT", "REGULAR"]).optional(),
    riskLevel: z.enum(["Low", "Moderate", "High", "Very High"]).optional(),
    fundType: z
      .enum(["equity", "debt", "hybrid", "solution", "other"])
      .optional(),
    minAum: z.number().finite().optional(),
    maxAum: z.number().finite().optional(),
    minReturns1Y: z.number().finite().optional(),
    maxReturns1Y: z.number().finite().optional(),
    minReturns3Y: z.number().finite().optional(),
    maxReturns3Y: z.number().finite().optional(),
    minReturns5Y: z.number().finite().optional(),
    maxReturns5Y: z.number().finite().optional(),
    minExpenseRatio: z.number().finite().optional(),
    maxExpenseRatio: z.number().finite().optional(),
  })
  .strip();

const EtfAllowed = z
  .object({
    exchange: z.enum(["NSE", "BSE"]).optional(),
    assetClass: z
      .enum(["equity", "debt", "hybrid", "solution", "other"])
      .optional(),
    theme: z.string().max(60).optional(),
    minAum: z.number().finite().optional(),
    maxAum: z.number().finite().optional(),
    minReturns1Y: z.number().finite().optional(),
    maxReturns1Y: z.number().finite().optional(),
    minExpenseRatio: z.number().finite().optional(),
    maxExpenseRatio: z.number().finite().optional(),
  })
  .strip();

// ── Filter description for the LLM ─────────────────────────────────

const STOCKS_GUIDE = `Available filter keys for STOCKS mode:
- exchange: "NSE" | "BSE"
- sector: string (e.g. "Banking", "IT", "Pharma")
- marketCapBucket: "LARGE" (>= ₹20,000 Cr) | "MID" (5,000-20,000 Cr) | "SMALL" (< 5,000 Cr)
- minPe / maxPe: P/E ratio range
- minRoe / maxRoe: Return on Equity in percent (e.g. 15 = 15%)
- minRevenueGrowth / maxRevenueGrowth: YoY revenue growth in percent
- minDebtToEquity / maxDebtToEquity: Debt/Equity ratio`;

const MF_GUIDE = `Available filter keys for MUTUAL FUNDS mode:
- category: AMFI bucket (e.g. "Large Cap", "Mid Cap", "Flexi Cap", "ELSS", "Hybrid")
- amcName: exact AMC name (e.g. "SBI", "HDFC", "Axis")
- plan: "DIRECT" | "REGULAR"
- riskLevel: "Low" | "Moderate" | "High" | "Very High"
- fundType: "equity" | "debt" | "hybrid" | "solution" | "other"
- minAum / maxAum: AUM in Crores
- minReturns1Y / maxReturns1Y / 3Y / 5Y: returns in percent
- minExpenseRatio / maxExpenseRatio: in percent (e.g. 0.5 = 0.5%)`;

const ETF_GUIDE = `Available filter keys for ETFs mode:
- exchange: "NSE" | "BSE"
- assetClass: "equity" | "debt" | "hybrid" | "solution" | "other"
- theme: substring matched against ETF name (e.g. "Nifty IT", "Gold")
- minAum / maxAum: AUM in Crores
- minReturns1Y / maxReturns1Y: 1Y returns in percent
- minExpenseRatio / maxExpenseRatio: in percent`;

const GUIDES = {
  stocks: STOCKS_GUIDE,
  mf: MF_GUIDE,
  etf: ETF_GUIDE,
};

const SCHEMAS = {
  stocks: StocksAllowed,
  mf: MfAllowed,
  etf: EtfAllowed,
};

// ── Result ─────────────────────────────────────────────────────────

export interface AiFilterBuildResult {
  mode: "stocks" | "mf" | "etf";
  /** Filter keys the LLM proposed AND that passed Zod validation. */
  filters: ScreenFilters | MfScreenFilters | EtfScreenFilters;
  /** Keys the LLM proposed but we dropped (unknown vocab / failed Zod). */
  droppedKeys: string[];
  /** Filter explanation the model gave (1-2 sentences). */
  explanation?: string;
}

const CREDIT_ACTION = "ai_filter_builder";

// ── Action ─────────────────────────────────────────────────────────

export async function generateFiltersFromThesisAction(
  input: z.input<typeof InputSchema>
): Promise<ServiceResult<AiFilterBuildResult>> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { mode, thesis } = parsed.data;

  const authUser = await getAuthenticatedUser();
  if (!authUser) {
    return { success: false, error: "Sign in to use the AI filter builder" };
  }

  // Charge 1 credit upfront - refund on hard failure below.
  const creditRes = await consumeCreditsService(authUser.userId, CREDIT_ACTION);
  if (!creditRes.success) {
    return { success: false, error: creditRes.error ?? "Out of AI credits" };
  }

  const guide = GUIDES[mode];
  const allowed = SCHEMAS[mode];

  const prompt = `You are an Indian markets equity / fund analyst. Translate the user's
investment thesis into a JSON object of screener filters.

${guide}

RULES:
1. Output VALID JSON ONLY - no preamble, no markdown fences.
2. Only include keys you are confident about. Better to leave a key out than guess.
3. Numbers are bare (no "%" or "₹"); units are implied per the guide.
4. If the thesis specifies "Large cap", set marketCapBucket: "LARGE" (do not also set min/max).
5. Include an "explanation" field (string, max 200 chars) summarising the filter.
6. The shape MUST be: { "filters": { ... }, "explanation": "..." }

USER THESIS:
${thesis}

Reply with the JSON object.`;

  const aiResult = await withVertexAI(async (client) => {
    const model = client.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 600,
        responseMimeType: "application/json",
      },
    });
    const res = await model.generateContent(prompt);
    // Vertex AI's response shape: candidates[0].content.parts[0].text.
    // We requested JSON via responseMimeType, so the part is the raw JSON
    // string - no markdown unwrapping needed.
    const part = res.response?.candidates?.[0]?.content?.parts?.[0];
    return (part && "text" in part ? part.text : "") ?? "";
  });

  if (!aiResult.success) {
    // Hard failure - refund the credit.
    await refundCreditsService(authUser.userId, CREDIT_ACTION).catch(() => {});
    return {
      success: false,
      error: "AI filter builder is unavailable. Please try again.",
    };
  }

  let parsedJson: { filters?: Record<string, unknown>; explanation?: string };
  try {
    parsedJson = JSON.parse(aiResult.data ?? "");
  } catch {
    await refundCreditsService(authUser.userId, CREDIT_ACTION).catch(() => {});
    return {
      success: false,
      error: "Could not understand the AI response - try rephrasing.",
    };
  }

  const rawFilters = parsedJson.filters ?? {};
  const proposedKeys = Object.keys(rawFilters);
  const validation = allowed.safeParse(rawFilters);

  // Drop unknown / invalid keys silently. If literally nothing survived,
  // refund + tell the user to try a more specific thesis.
  const cleanFilters = validation.success ? validation.data : {};
  const acceptedKeys = Object.keys(cleanFilters);
  const droppedKeys = proposedKeys.filter((k) => !acceptedKeys.includes(k));

  if (acceptedKeys.length === 0) {
    await refundCreditsService(authUser.userId, CREDIT_ACTION).catch(() => {});
    return {
      success: false,
      error:
        "AI couldn't map your thesis to any known filter. Try mentioning specific metrics like P/E, ROE, or AUM.",
    };
  }

  return {
    success: true,
    data: {
      mode,
      filters: cleanFilters as
        | ScreenFilters
        | MfScreenFilters
        | EtfScreenFilters,
      droppedKeys,
      explanation: parsedJson.explanation,
    },
  };
}
