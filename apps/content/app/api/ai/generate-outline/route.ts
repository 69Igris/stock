import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { generateFallbackOutline } from "./generate-outline-logic";

interface OutlineRequest {
  title: string;
  description?: string;
  topics?: string[];
  additionalContext?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let requestData: OutlineRequest = { title: "" };

  try {
    requestData = (await request.json()) as OutlineRequest;
    const { title, description, topics, additionalContext } = requestData;

    if (!title) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GENAI_API_KEY;

    if (!apiKey) {
      const fallbackOutline = generateFallbackOutline(
        title,
        description,
        topics,
      );
      return NextResponse.json({ outline: fallbackOutline });
    }

    const topicsStr =
      topics && topics.length > 0
        ? `Topics/Keywords: ${topics.join(", ")}`
        : "";

    const prompt = `You are an expert content writer and strategist for an Indian stock market and finance platform called UseMoney. Generate a detailed, well-structured blog post outline for the following idea:

Title: ${title}
${description ? `Description: ${description}` : ""}
${topicsStr}
${additionalContext ? `Additional Context: ${additionalContext}` : ""}

Create a comprehensive blog post outline that includes:
1. An engaging introduction that hooks the reader
2. 3-5 main sections with clear headings
3. Key points to cover under each section
4. A compelling conclusion with a call-to-action

Format the outline in markdown with proper heading hierarchy (## for main sections, ### for subsections).

Important:
- Make the outline actionable and specific
- Include suggestions for examples or data points where relevant
- Consider SEO best practices in the structure
- Keep the tone professional but engaging
- Focus on Indian stock market context where applicable

Generate the outline now:`;

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
    const outline = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    if (!outline) {
      throw new Error("No outline generated");
    }

    return NextResponse.json({ outline });
  } catch {
    const fallbackOutline = generateFallbackOutline(
      requestData.title || "Blog Post",
      requestData.description,
      requestData.topics,
    );
    return NextResponse.json({ outline: fallbackOutline });
  }
}
