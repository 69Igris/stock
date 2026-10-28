import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Calendar, Clock, Eye, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import BlogContent from "@/components/content/BlogContent";
import { AuthorAvatar } from "@/components/content/AuthorAvatar";
import {
  getDocBySlugAction,
  getRelatedPostsAction,
} from "@/lib/actions/content";
import { resolveOgImage } from "@/lib/seo/og-image";
import type { Metadata } from "next";

interface DocPageProps {
  params: Promise<{
    slug: string;
  }>;
}

function calculateReadingTime(content: string): number {
  try {
    const blocks = JSON.parse(content);
    let wordCount = 0;

    const countWords = (
      items: { text?: string; content?: { text?: string }[] }[]
    ) => {
      items.forEach((item) => {
        if (item.text) {
          wordCount += item.text.split(/\s+/).filter(Boolean).length;
        }
        if (item.content && Array.isArray(item.content)) {
          countWords(item.content);
        }
      });
    };

    if (Array.isArray(blocks)) {
      blocks.forEach((block: { content?: { text?: string }[] }) => {
        if (block.content && Array.isArray(block.content)) {
          countWords(block.content);
        }
      });
    }

    return Math.max(1, Math.ceil(wordCount / 200));
  } catch {
    return 5;
  }
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export async function generateMetadata({
  params,
}: DocPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await getDocBySlugAction(slug);

  if (!post) {
    // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
    return { title: "Doc Not Found" };
  }

  const title = post.metadataTitle || post.title;
  const description =
    post.metadataDescription ||
    post.excerpt ||
    `${post.title} - UseMoney Documentation`;
  // metadataImageUrl → featureImage → site default, always absolute.
  const imageUrl = resolveOgImage(post);

  return {
    // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
    // The 'Docs' qualifier moves into the breadcrumb / OG so it's clear
    // this is documentation without doubling the brand suffix.
    title: `${title} · Docs`,
    description,
    keywords: post.metadataKeywords || undefined,
    openGraph: {
      title,
      description,
      type: "article",
      url: `https://usemoney.ai/docs/${post.postUrl}`,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: title }],
      publishedTime: post.publishDate
        ? new Date(post.publishDate).toISOString()
        : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
    alternates: {
      canonical:
        post.canonicalUrl || `https://usemoney.ai/docs/${post.postUrl}`,
    },
  };
}

async function RelatedDocs({
  postId,
  tagIds,
}: {
  postId: string;
  tagIds: string[];
}) {
  const relatedPosts = await getRelatedPostsAction({
    postId,
    contentType: "DOCS",
    tagIds,
    limit: 3,
  });

  if (relatedPosts.length === 0) return null;

  return (
    <section className="mt-16 pt-8 border-t border-border">
      <h2 className="text-xl font-semibold text-foreground mb-6">
        Related Docs
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {relatedPosts.map((post) => (
          <Link key={post.id} href={`/docs/${post.postUrl}`}>
            <Card className="bg-card/50 border-border p-5 h-full hover:border-blue-500/50 transition-colors group">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FileText className="h-4 w-4 text-blue-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="text-foreground font-medium mb-1 group-hover:text-blue-400 transition-colors line-clamp-2">
                    {post.title}
                  </h3>
                  {post.excerpt && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {post.excerpt}
                    </p>
                  )}
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

function RelatedDocsSkeleton() {
  return (
    <section className="mt-16 pt-8 border-t border-border">
      <div className="h-6 bg-muted rounded w-36 mb-6" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="bg-card/50 border-border p-5 animate-pulse">
            <div className="flex items-start gap-3">
              <div className="h-9 w-9 rounded-lg bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-muted rounded w-3/4" />
                <div className="h-3 bg-muted rounded w-full" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

export default async function DocDetailPage({ params }: DocPageProps) {
  const { slug } = await params;
  const post = await getDocBySlugAction(slug);

  if (!post) {
    notFound();
  }

  const readingTime = calculateReadingTime(post.content);
  const tagIds = post.tags.map((t) => t.tagId);

  return (
    <main className="container mx-auto px-4 sm:px-6 py-12">
      <article className="max-w-4xl mx-auto">
        {/* Breadcrumb */}
        <div className="mb-6">
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors text-sm"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Documentation
          </Link>
        </div>

        {/* Tags */}
        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {post.tags.map((tagOnPost) => (
              <Link
                key={tagOnPost.tag.id}
                href={`/docs?tag=${tagOnPost.tag.slug}`}
              >
                <Badge
                  variant="outline"
                  className="border-border text-muted-foreground hover:border-border hover:text-foreground/80 transition-colors cursor-pointer"
                  style={
                    tagOnPost.tag.color
                      ? {
                          borderColor: `${tagOnPost.tag.color}40`,
                          color: tagOnPost.tag.color,
                        }
                      : undefined
                  }
                >
                  {tagOnPost.tag.name}
                </Badge>
              </Link>
            ))}
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl sm:text-4xl font-bold text-foreground mb-6 leading-tight">
          {post.title}
        </h1>

        {/* Meta */}
        <div className="flex flex-wrap items-center gap-6 text-muted-foreground mb-8 pb-8 border-b border-border">
          {/* Author */}
          {post.author && (
            <div className="flex items-center gap-3">
              <AuthorAvatar
                src={post.author.imageUrl}
                name={post.author.name || post.author.username}
                size={32}
              />
              <span className="text-sm text-foreground">
                {post.author.name || post.author.username}
              </span>
            </div>
          )}
          {post.publishDate && (
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              <span className="text-sm">
                Updated {formatDate(post.publishDate)}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            <span className="text-sm">{readingTime} min read</span>
          </div>
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4" />
            <span className="text-sm">
              {post.viewCount.toLocaleString()} views
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="mb-12">
          <BlogContent content={post.content} />
        </div>

        {/* Back link */}
        <div className="text-center mb-8">
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 text-blue-400 hover:text-blue-300 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Documentation
          </Link>
        </div>

        {/* Related docs */}
        <Suspense fallback={<RelatedDocsSkeleton />}>
          <RelatedDocs postId={post.id} tagIds={tagIds} />
        </Suspense>
      </article>
    </main>
  );
}
