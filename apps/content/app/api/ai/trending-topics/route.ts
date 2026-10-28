import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  generateFallbackTrends,
  type TrendingTopic,
} from "./trending-topics-logic";

interface TrendingTopicsRequest {
  category?: string;
  region?: string;
  timeframe?: "today" | "week" | "month" | "year";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let requestData: TrendingTopicsRequest = {};

  try {
    requestData = (await request.json()) as TrendingTopicsRequest;
    const { category, region = "IN", timeframe = "week" } = requestData;

    const apiKey = process.env.GOOGLE_GENAI_API_KEY;

    if (!apiKey) {
      const fallbackTrends = generateFallbackTrends(category);
      return NextResponse.json({ trends: fallbackTrends });
    }

    const categoryFilter = category
      ? `specifically in the "${category}" niche`
      : "across stock market, finance, investing, and economic topics";
    const timeframeMap: Record<string, string> = {
      today: "today",
      week: "the past week",
      month: "the past month",
      year: "the past year",
    };

    const prompt = `You are a trend analyst with expertise in Indian financial markets. Based on your knowledge of trending topics and search patterns, identify the most relevant trending topics ${categoryFilter} in ${region} over ${timeframeMap[timeframe]}.

Generate 15 trending topics that would be great for a stock market blog. For each topic, provide:
1. topic: The trending topic name
2. trendScore: A score from 1-100 indicating relative trend strength
3. growth: Growth indicator (e.g., "+250%", "Stable", "Rising")
4. category: The category it belongs to
5. searchVolume: Estimated search volume (e.g., "High", "Medium", "Very High")
6. relatedQueries: 3-4 related search queries

Format as JSON array:
[
  {
    "topic": "NIFTY 50 Rally",
    "trendScore": 95,
    "growth": "+320%",
    "category": "Stock Market",
    "searchVolume": "Very High",
    "relatedQueries": ["NIFTY today", "market rally reasons", "NIFTY target"]
  }
]

Focus on:
- Topics relevant to Indian retail investors
- Topics suitable for in-depth blog posts
- Mix of breaking market trends and evergreen investing topics
- Both technical and fundamental analysis topics

Generate 15 trending topics now (respond ONLY with the JSON array):`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      },
    );

    if (!response.ok) {
      throw new Error("AI request failed");
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    const jsonMatch = /\[[\s\S]*\]/.exec(text);
    if (!jsonMatch) {
      throw new Error("Could not parse trends from response");
    }

    const trends = JSON.parse(jsonMatch[0]) as TrendingTopic[];
    return NextResponse.json({ trends });
  } catch {
    const fallbackTrends = generateFallbackTrends(requestData.category);
    return NextResponse.json({ trends: fallbackTrends });
  }
}
