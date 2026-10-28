"use server";

import { getAuthenticatedUser } from "@/lib/auth";
import { requireFeature } from "./premium-gate";
import { getGeminiModel, generateWithTimeout } from "@/lib/gemini/models";

interface GeneratedStrategy {
  name: string;
  description: string;
  type: string;
  risk: string;
  timeframe: string;
  rules: { entry: string; exit: string; stopLoss: string };
  params?: Record<string, unknown>;
  overlays?: string[];
}

export async function generateStrategyAction(
  prompt: string
): Promise<{ success: boolean; data?: GeneratedStrategy; error?: string }> {
  try {
    // MONEY-1142 — `getAuthenticatedUser()` rather than Clerk's `currentUser()`.
    // `user` was only ever used for the null check here, and the tier gate
    // below needs the INTERNAL user id (Clerk's id is a different namespace and
    // would silently match no subscription, denying every user).
    const authUser = await getAuthenticatedUser();
    if (!authUser) {
      return { success: false, error: "Authentication required" };
    }

    // `/strategies` maps to the `aiStrategies` feature. This generates against
    // a paid model, so an ungated action is both a paywall hole and a direct
    // cost leak.
    const denied = await requireFeature(authUser.userId, "aiStrategies");
    if (denied) return denied;

    if (!prompt || prompt.length < 10) {
      return {
        success: false,
        error: "Please provide a more detailed strategy description",
      };
    }

    if (prompt.length > 2000) {
      return {
        success: false,
        error: "Strategy description too long (max 2000 chars)",
      };
    }

    const model = getGeminiModel("fast");

    const systemPrompt = `You are a trading strategy designer for Indian stock markets (NSE/BSE).
Given a user's trading idea description, create a structured trading strategy.

Return ONLY valid JSON with this exact structure (no markdown, no code blocks):
{
  "name": "Strategy Name",
  "description": "Brief 1-2 sentence description",
  "type": "Momentum|MeanReversion|Breakout|Trend|Scalping|Swing",
  "risk": "Low|Medium|High|Very High",
  "timeframe": "Intraday|Short Term (Days)|Medium Term (Weeks)|Long Term (Months)",
  "rules": {
    "entry": "Specific entry condition",
    "exit": "Specific exit condition",
    "stopLoss": "Stop loss rule"
  },
  "overlays": ["Indicator1", "Indicator2"],
  "params": {}
}

Focus on practical, actionable strategies for Indian markets. Be specific with indicators and levels.`;

    const fullPrompt = `${systemPrompt}\n\nUser's strategy idea:\n${prompt}`;

    const response = await generateWithTimeout(model, fullPrompt, 15000);

    // Parse JSON from response - handle possible markdown code blocks
    let jsonStr = response.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const strategy = JSON.parse(jsonStr) as GeneratedStrategy;

    // Validate required fields
    if (!strategy.name || !strategy.rules?.entry || !strategy.rules?.exit) {
      return {
        success: false,
        error: "AI generated an incomplete strategy. Please try again.",
      };
    }

    return { success: true, data: strategy };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        success: false,
        error: "Failed to parse AI response. Please try again.",
      };
    }
    return {
      success: false,
      error: "Failed to generate strategy. Please try again.",
    };
  }
}
