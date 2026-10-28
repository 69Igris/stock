/**
 * SEO utilities for content management
 */

import type { Post, ContentType } from "@usemoney/types";

export interface SEOMetadata {
  title: string;
  description: string;
  keywords?: string[];
  image?: string;
  canonical?: string;
  type: "article" | "website";
  publishedTime?: string;
  modifiedTime?: string;
  author?: string;
}

/**
 * Generate SEO metadata from a post
 */
export function generateSEOMetadata(post: Post, baseUrl: string): SEOMetadata {
  const title = post.metadataTitle || post.title;
  const description = post.metadataDescription || post.excerpt || "";
  const keywords = post.metadataKeywords
    ?.split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  return {
    title: `${title} | UseMoney`,
    description: description.slice(0, 160),
    keywords,
    image:
      post.metadataImageUrl || post.featureImage || `${baseUrl}/og-image.png`,
    canonical:
      post.canonicalUrl ||
      `${baseUrl}/${getContentPath(post.contentType)}/${post.postUrl}`,
    type: "article",
    publishedTime: post.publishDate?.toISOString(),
    modifiedTime: post.updatedAt.toISOString(),
    author: post.author.name || post.author.username,
  };
}

/**
 * Get the URL path for a content type
 */
export function getContentPath(contentType: ContentType): string {
  const paths: Record<ContentType, string> = {
    BLOG: "blog",
    GLOSSARY: "glossary",
    NEWSLETTER: "newsletter",
    LEGAL: "legal",
    DOCS: "docs",
  };
  return paths[contentType] || "content";
}

/**
 * Generate JSON-LD structured data for a post
 */
export function generateStructuredData(post: Post, baseUrl: string): object {
  return {
    "@context": "https://schema.org",
    "@type": post.contentType === "GLOSSARY" ? "DefinedTerm" : "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    image: post.featureImage,
    datePublished: post.publishDate?.toISOString(),
    dateModified: post.updatedAt.toISOString(),
    author: {
      "@type": "Person",
      name: post.author.name || post.author.username,
    },
    publisher: {
      "@type": "Organization",
      name: "UseMoney",
      logo: {
        "@type": "ImageObject",
        url: `${baseUrl}/logo.png`,
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${baseUrl}/${getContentPath(post.contentType)}/${post.postUrl}`,
    },
  };
}
