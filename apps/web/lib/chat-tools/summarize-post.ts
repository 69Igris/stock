/**
 * `summarize_post` chat tool (MONEY-887).
 *
 * Summarises a specific UseMoney post (by slug) and relates it to investing /
 * portfolio management ON UseMoney. Powers the "Discuss with UseMoney AI"
 * deep-link in newsletter emails.
 *
 * WHY a dedicated DB-backed tool (not `web_search`): web_search is Gemini
 * Google-Search grounding (grounding.ts) — it searches Google's index and does
 * NOT fetch the URL, so it can't see a fresh / QA-only / unindexed post and
 * would summarise the wrong page (or nothing). This reads the post straight
 * from OUR DB by slug, so it always summarises the actual article.
 *
 * It is dispatched deterministically from the email
 * (`/stocksage?tool=summarize_post&toolParams={"slug":...}` →
 * ChatContext.executeToolDirect), which BYPASSES the chat classifier — the
 * free-text "Summarise … my portfolio" prompt otherwise collapsed to
 * `get_portfolio_summary` and dumped a generic portfolio summary.
 */

import { prisma } from "@usemoney/database";
import { withVertexAI } from "@/lib/gemini/client";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import { geminiLogger as logger } from "@usemoney/logger";

export interface SummarizePostResult {
  tool: "summarize_post";
  success: boolean;
  data?: { answer: string; title: string; postUrl: string };
  error?: string;
  renderType?: "text";
}

/**
 * BlockNote JSON → plain text. Mirrors `@usemoney/core`
 * `extractTextFromBlocks`; inlined to keep this server-only tool off the core
 * root barrel (which drags fs/child_process). Walks `content[].text` + nested
 * `children`, the only text-bearing nodes.
 */
function blockNoteToText(content: string): string {
  try {
    const blocks = JSON.parse(content);
    const walk = (
      items: Array<{ content?: unknown; children?: unknown }>
    ): string => {
      let out = "";
      for (const b of items) {
        if (Array.isArray(b.content)) {
          for (const item of b.content as Array<{
            type?: string;
            text?: string;
          }>) {
            if (item?.type === "text" && item.text) out += item.text + " ";
          }
        }
        if (Array.isArray(b.children))
          out += walk(b.children as Array<{ content?: unknown }>);
      }
      return out;
    };
    return Array.isArray(blocks) ? walk(blocks).trim() : "";
  } catch {
    return "";
  }
}

/**
 * Read a published post by slug and return an educational, SEBI-safe summary
 * that relates it to UseMoney where genuinely relevant. Never throws — returns
 * a typed `{ success:false, error }` the chat surfaces verbatim.
 */
export async function summarizePost(
  slug: string,
  type: "newsletter" | "blog" = "newsletter"
): Promise<SummarizePostResult> {
  const contentType = type === "blog" ? "BLOG" : "NEWSLETTER";

  // Read straight from the DB (no view-count increment, only the fields we
  // need). Same published-only gate as the public detail page.
  const post = await prisma.post.findFirst({
    where: { postUrl: slug, contentType, status: "PUBLISHED" },
    select: { title: true, excerpt: true, content: true },
  });

  if (!post) {
    return {
      tool: "summarize_post",
      success: false,
      error:
        "I couldn't find that article — it may have been unpublished or moved.",
    };
  }

  const body = blockNoteToText(post.content).slice(0, 12000);
  const lead = post.excerpt?.trim() || "";
  if (!body && !lead) {
    return {
      tool: "summarize_post",
      success: false,
      error: "That article doesn't have readable content to summarise yet.",
    };
  }

  const prompt = `You are UseMoney AI, the assistant inside UseMoney — an AI-powered trading & portfolio-management app for Indian investors (track holdings & mutual funds across brokers, portfolio analytics, paper trading, FIRE planning, AI research).

Summarise the article below for a UseMoney user in 4-6 sentences, in plain language. Then add a short "Why it matters on UseMoney" note (1-2 sentences, or up to 3 short bullets) connecting it to how they could use UseMoney — BUT ONLY if the article genuinely relates to investing, markets, money, or personal finance. If it does NOT, say plainly that it isn't directly relevant to investing and skip the connection. Never invent a relevance that isn't there.

Educational and informational only — no buy/sell/hold advice, no price targets, no recommendations. Use short markdown.

Title: ${post.title}
${lead ? `Excerpt: ${lead}\n` : ""}Article:
${body}`;

  const result = await withVertexAI(async (client) => {
    const model = client.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0.4, maxOutputTokens: 900 },
    });
    const response = await model.generateContent(prompt);
    return (
      response.response?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("")
        .trim() || ""
    );
  });

  if (!result.success || !result.data) {
    logger.warn({ slug }, "summarize_post generation failed");
    return {
      tool: "summarize_post",
      success: false,
      error: "I couldn't summarise that article right now. Please try again.",
    };
  }

  const answer = stripRecommendationLanguage(result.data).trim();
  return {
    tool: "summarize_post",
    success: true,
    data: { answer, title: post.title, postUrl: `/newsletter/${slug}` },
    renderType: "text",
  };
}
