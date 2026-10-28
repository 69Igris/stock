import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  generateFallbackTopics,
  type TopicSuggestion,
} from "./suggest-topics-logic";

interface TopicSuggestionRequest {
  category?: string;
  existingTopics?: string[];
  count?: number;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let requestData: TopicSuggestionRequest = {};

  try {
    requestData = (await request.json()) as TopicSuggestionRequest;
    const { category, existingTopics = [], count = 10 } = requestData;

    const apiKey = process.env.GOOGLE_GENAI_API_KEY;

    if (!apiKey) {
      const fallbackTopics = generateFallbackTopics(category, count);
      return NextResponse.json({ topics: fallbackTopics });
    }

    const existingTopicsStr =
      existingTopics.length > 0
        ? `\n\nExclude these topics as they already exist: ${existingTopics.join(", ")}`
        : "";

    const categoryStr = category
      ? `in the "${category}" category`
      : "across various finance, stock market, and investing categories";

    const prompt = `You are an expert content strategist for UseMoney, an Indian stock market and investing platform. Suggest ${String(count)} trending and engaging blog topics ${categoryStr} that would be valuable for Indian retail investors.
${existingTopicsStr}

For each topic suggestion, provide:
1. topic: A concise topic name (2-5 words)
2. description: Brief explanation of why this topic is relevant (1 sentence)
3. relevanceScore: A score from 1-10 indicating how trending/relevant this topic is
4. relatedKeywords: 3-5 related keywords for SEO

Format your response as a JSON array:
[
  {
    "topic": "NIFTY 50 Analysis",
    "description": "Deep dive into current NIFTY 50 trends and what they mean for investors",
    "relevanceScore": 9,
    "relatedKeywords": ["NIFTY", "index funds", "market analysis", "BSE"]
  }
]

Focus on:
- Current trends in Indian stock markets
- Topics with good search volume
- Evergreen investing topics with lasting value
- Mix of technical and beginner-friendly topics

Generate ${String(count)} topic suggestions now (respond ONLY with the JSON array, no additional text):`;

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
      throw new Error("Could not parse topics from response");
    }

    const topics = JSON.parse(jsonMatch[0]) as TopicSuggestion[];
    return NextResponse.json({ topics });
  } catch {
    const fallbackTopics = generateFallbackTopics(
      requestData.category,
      requestData.count || 10,
    );
    return NextResponse.json({ topics: fallbackTopics });
  }
}
