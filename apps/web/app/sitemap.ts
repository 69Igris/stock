import { MetadataRoute } from "next";
import { prisma } from "@usemoney/database";

export const dynamic = "force-dynamic";

// Helper function to map content type to URL path
function contentTypeToPath(contentType: string): string | null {
  switch (contentType) {
    case "BLOG":
      return "blog";
    case "GLOSSARY":
      return "glossary";
    case "NEWSLETTER":
      return "newsletter";
    case "DOCS":
      return "docs";
    default:
      return null;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai";

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    // `/home` is deliberately NOT listed (MONEY-1130). `robots.ts` has it in
    // `privatePaths`, so submitting it here asked crawlers to index a URL the
    // same site tells them not to fetch — which Search Console reports as
    // "Submitted URL blocked by robots.txt" and which taught it nothing, since
    // a disallowed page is never fetched and its `canonical` never read.
    // It is now also a full duplicate of `/`, which is the real marketing page
    // and is listed above at the same priority.
    {
      url: `${baseUrl}/pricing`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/privacy`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  // Static content index pages
  const staticContentPages: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${baseUrl}/glossary`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.7,
    },
    {
      url: `${baseUrl}/newsletter`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/docs`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.6,
    },
  ];

  // Fetch published content from database
  let contentUrls: MetadataRoute.Sitemap = [];
  try {
    const posts = await prisma.post.findMany({
      where: {
        status: "PUBLISHED",
        contentPlatform: "STOCKBOOK",
      },
      select: {
        postUrl: true,
        contentType: true,
        updatedAt: true,
      },
    });

    contentUrls = posts
      .filter((post) => contentTypeToPath(post.contentType) !== null)
      .map((post) => ({
        url: `${baseUrl}/${contentTypeToPath(post.contentType)}/${post.postUrl}`,
        lastModified: post.updatedAt,
        changeFrequency: "weekly" as const,
        priority: 0.7,
      }));
  } catch (error) {
    // Log error but don't fail sitemap generation
    console.error("Failed to fetch content posts for sitemap:", error);
    // Return empty array on database errors
    contentUrls = [];
  }

  return [...staticPages, ...staticContentPages, ...contentUrls];
}
