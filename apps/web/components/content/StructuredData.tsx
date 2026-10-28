import Script from "next/script";

// ============== TYPES ==============

interface BaseStructuredDataProps {
  /** Schema.org type */
  type: "BlogPosting" | "Article" | "FAQPage";
}

interface BlogPostingData {
  title: string;
  description: string;
  author: string;
  datePublished: string;
  dateModified?: string;
  image?: string;
  url: string;
  keywords?: string[];
}

interface ArticleData {
  title: string;
  description: string;
  author: string;
  datePublished: string;
  dateModified?: string;
  image?: string;
  url: string;
  section?: string;
  keywords?: string[];
}

interface FAQItem {
  question: string;
  answer: string;
}

interface FAQPageData {
  questions: FAQItem[];
}

type StructuredDataProps =
  | (BaseStructuredDataProps & { type: "BlogPosting"; data: BlogPostingData })
  | (BaseStructuredDataProps & { type: "Article"; data: ArticleData })
  | (BaseStructuredDataProps & { type: "FAQPage"; data: FAQPageData });

// ============== SCHEMA GENERATORS ==============

function generateBlogPostingSchema(data: BlogPostingData): object {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai";

  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: data.title,
    description: data.description,
    author: {
      "@type": "Person",
      name: data.author,
    },
    publisher: {
      "@type": "Organization",
      name: "UseMoney",
      logo: {
        "@type": "ImageObject",
        url: `${baseUrl}/logo.png`,
      },
    },
    datePublished: data.datePublished,
    dateModified: data.dateModified || data.datePublished,
    image: data.image || `${baseUrl}/og-image.png`,
    url: data.url,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": data.url,
    },
    ...(data.keywords && {
      keywords: data.keywords.join(", "),
    }),
  };
}

function generateArticleSchema(data: ArticleData): object {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai";

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: data.title,
    description: data.description,
    author: {
      "@type": "Person",
      name: data.author,
    },
    publisher: {
      "@type": "Organization",
      name: "UseMoney",
      logo: {
        "@type": "ImageObject",
        url: `${baseUrl}/logo.png`,
      },
    },
    datePublished: data.datePublished,
    dateModified: data.dateModified || data.datePublished,
    image: data.image || `${baseUrl}/og-image.png`,
    url: data.url,
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": data.url,
    },
    ...(data.section && {
      articleSection: data.section,
    }),
    ...(data.keywords && {
      keywords: data.keywords.join(", "),
    }),
  };
}

function generateFAQPageSchema(data: FAQPageData): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: data.questions.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

// ============== COMPONENT ==============

/**
 * StructuredData - JSON-LD structured data component for SEO
 *
 * Server component that generates schema.org JSON-LD for different content types.
 * Helps search engines understand the content better and can enable rich snippets.
 *
 * Usage:
 * ```tsx
 * <StructuredData
 *   type="BlogPosting"
 *   data={{
 *     title: "Post Title",
 *     description: "Post description",
 *     author: "Author Name",
 *     datePublished: "2024-01-15T00:00:00Z",
 *     url: "https://usemoney.ai/blog/post-slug"
 *   }}
 * />
 * ```
 */
export function StructuredData(props: StructuredDataProps) {
  let schema: object;

  switch (props.type) {
    case "BlogPosting":
      schema = generateBlogPostingSchema(props.data);
      break;
    case "Article":
      schema = generateArticleSchema(props.data);
      break;
    case "FAQPage":
      schema = generateFAQPageSchema(props.data);
      break;
    default:
      // TypeScript should catch this, but just in case
      throw new Error(`Unsupported structured data type`);
  }

  return (
    <Script
      id={`structured-data-${props.type.toLowerCase()}`}
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

export default StructuredData;
