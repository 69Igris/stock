import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { generateFallbackScript } from "./generate-script-logic";

interface ScriptRequest {
  title: string;
  outline?: string;
  description?: string;
  topics?: string[];
  tone?: "professional" | "casual" | "educational" | "storytelling";
  targetLength?: "short" | "medium" | "long";
  includeCodeExamples?: boolean;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let requestData: ScriptRequest = { title: "" };

  try {
    requestData = (await request.json()) as ScriptRequest;
    const {
      title,
      outline,
      description,
      topics,
      tone = "professional",
      targetLength = "medium",
      includeCodeExamples = false,
    } = requestData;

    if (!title) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GENAI_API_KEY;

    if (!apiKey) {
      const fallbackScript = generateFallbackScript(title, description, topics);
      return NextResponse.json({ script: fallbackScript });
    }

    const lengthGuide: Record<string, string> = {
      short: "around 800-1000 words",
      medium: "around 1500-2000 words",
      long: "around 2500-3500 words",
    };

    const toneGuide: Record<string, string> = {
      professional:
        "Use a professional, authoritative tone with industry terminology where appropriate",
      casual:
        "Use a conversational, friendly tone as if talking to a colleague",
      educational:
        "Use a teaching-focused tone, explaining concepts clearly with examples",
      storytelling:
        "Use a narrative approach, weaving in stories and real-world scenarios",
    };

    const topicsStr =
      topics && topics.length > 0
        ? `\nKeywords/Topics to incorporate: ${topics.join(", ")}`
        : "";
    const outlineStr = outline ? `\n\nFollow this outline:\n${outline}` : "";
    const codeStr = includeCodeExamples
      ? "\n\nInclude relevant code examples where appropriate, using markdown code blocks with syntax highlighting."
      : "";

    const prompt = `You are an expert content writer for UseMoney, an Indian stock market and finance platform. Write a complete, polished blog post based on the following:

Title: ${title}
${description ? `Brief: ${description}` : ""}${topicsStr}${outlineStr}

Requirements:
- Target length: ${lengthGuide[targetLength]}
- Tone: ${toneGuide[tone]}${codeStr}

Format guidelines:
- Use proper markdown formatting
- Start with a compelling hook (do NOT include the title as an H1, it will be added separately)
- Use ## for main section headings
- Use ### for subsections
- Include bullet points and numbered lists where appropriate
- Add a conclusion with a clear takeaway or call-to-action
- Make it SEO-friendly with natural keyword usage
- Focus on Indian stock market context where applicable

Quality standards:
- Write original, engaging content
- Include specific examples and actionable advice
- Avoid fluff and filler content
- Ensure logical flow between sections
- End with a thought-provoking conclusion

Write the complete blog post now (respond with ONLY the markdown content, no meta commentary):`;

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
    const script = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    if (!script) {
      throw new Error("No script generated");
    }

    return NextResponse.json({ script });
  } catch {
    const fallbackScript = generateFallbackScript(
      requestData.title || "Blog Post",
      requestData.description,
      requestData.topics,
    );
    return NextResponse.json({ script: fallbackScript });
  }
}
