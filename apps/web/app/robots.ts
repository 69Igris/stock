import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai";

  const publicPaths = [
    "/",
    "/pricing",
    "/privacy",
    "/terms",
    "/blog",
    "/glossary",
    "/newsletter",
    "/docs",
  ];

  const privatePaths = [
    "/api/",
    "/dashboard",
    "/holdings",
    "/positions",
    "/analysis",
    "/tradebook",
    "/paper-trading",
    "/fire",
    "/chat-history",
    "/discover",
    "/brokers",
    "/tutor",
    "/sage-tutor",
    "/settings",
    "/home",
    "/roast",
    "/risk",
    "/tax",
    "/documents",
    "/quizzes",
    "/compare",
    "/mf",
    "/watchlist",
    "/strategies",
    "/stock",
    "/sign-in",
    "/sign-up",
    "/debug-posthog",
  ];

  return {
    rules: [
      {
        userAgent: "*",
        allow: publicPaths,
        disallow: privatePaths,
      },
      // AI crawlers - allow public content for training/indexing
      {
        userAgent: "GPTBot",
        allow: publicPaths,
        disallow: privatePaths,
      },
      {
        userAgent: "ChatGPT-User",
        allow: publicPaths,
        disallow: privatePaths,
      },
      {
        userAgent: "Claude-Web",
        allow: publicPaths,
        disallow: privatePaths,
      },
      {
        userAgent: "Applebot-Extended",
        allow: publicPaths,
        disallow: privatePaths,
      },
      {
        userAgent: "PerplexityBot",
        allow: publicPaths,
        disallow: privatePaths,
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
