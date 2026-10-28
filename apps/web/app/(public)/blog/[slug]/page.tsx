import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { prisma } from "@usemoney/database";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { AuthorAvatar } from "@/components/content/AuthorAvatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import BlogContent from "@/components/content/BlogContent";
import BlogCard from "@/components/content/BlogCard";
import { ShareButtons } from "../../newsletter/[slug]/ShareButtons";
import {
  getBlogPostBySlugAction,
  getRelatedPostsAction,
} from "@/lib/actions/content";
import { resolveOgImage } from "@/lib/seo/og-image";
import type { Metadata } from "next";

interface BlogPostPageProps {
  params: Promise<{
    slug: string;
  }>;
}

// Calculate reading time based on content
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

// Get adjacent blog posts by publish date
async function getAdjacentPosts(publishDate: Date | null, currentId: string) {
  if (!publishDate) return { prev: null, next: null };
  const date = new Date(publishDate);

  const [prev, next] = await Promise.all([
    prisma.post.findFirst({
      where: {
        id: { not: currentId },
        contentType: "BLOG",
        contentPlatform: "STOCKBOOK",
        status: "PUBLISHED",
        publishDate: { lt: date },
      },
      select: { title: true, postUrl: true },
      orderBy: { publishDate: "desc" },
    }),
    prisma.post.findFirst({
      where: {
        id: { not: currentId },
        contentType: "BLOG",
        contentPlatform: "STOCKBOOK",
        status: "PUBLISHED",
        publishDate: { gt: date },
      },
      select: { title: true, postUrl: true },
      orderBy: { publishDate: "asc" },
    }),
  ]);

  return { prev, next };
}

// Generate metadata for SEO
export async function generateMetadata({
  params,
}: BlogPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await getBlogPostBySlugAction(slug);

  if (!post) {
    return {
      title: "Post Not Found",
      description: "The blog post you're looking for could not be found.",
    };
  }

  const title = post.metadataTitle || post.title;
  const description =
    post.metadataDescription ||
    post.excerpt ||
    `Read ${post.title} on UseMoney Blog`;
  // metadataImageUrl → featureImage → site default, always absolute.
  const imageUrl = resolveOgImage(post);

  return {
    title,
    description,
    keywords: post.metadataKeywords || undefined,
    openGraph: {
      title,
      description,
      type: "article",
      url: `https://usemoney.ai/blog/${post.postUrl}`,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
      publishedTime: post.publishDate
        ? new Date(post.publishDate).toISOString()
        : undefined,
      authors: [post.author.name || post.author.username],
      tags: post.tags.map((t) => t.tag.name),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
    alternates: {
      canonical:
        post.canonicalUrl || `https://usemoney.ai/blog/${post.postUrl}`,
    },
  };
}

// Related posts section
async function RelatedPosts({
  postId,
  tagIds,
}: {
  postId: string;
  tagIds: string[];
}) {
  const relatedPosts = await getRelatedPostsAction({
    postId,
    contentType: "BLOG",
    tagIds,
    limit: 3,
  });

  if (relatedPosts.length === 0) return null;

  return (
    <section className="mt-16 pt-8 border-t border-border">
      <h2 className="text-2xl font-semibold text-foreground mb-6">
        Related Posts
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {relatedPosts.map((post) => (
          <BlogCard key={post.id} post={post} />
        ))}
      </div>
    </section>
  );
}

function RelatedPostsSkeleton() {
  return (
    <section className="mt-16 pt-8 border-t border-border">
      <div className="h-8 bg-muted rounded w-48 mb-6" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card
            key={i}
            className="bg-card/50 border-border overflow-hidden animate-pulse"
          >
            <div className="h-48 bg-muted" />
            <div className="p-5 space-y-3">
              <div className="h-4 bg-muted rounded w-1/4" />
              <div className="h-6 bg-muted rounded w-3/4" />
              <div className="h-4 bg-muted rounded w-full" />
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

export default async function BlogPostPage({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = await getBlogPostBySlugAction(slug);

  if (!post) {
    notFound();
  }

  const readingTime = calculateReadingTime(post.content);
  const tagIds = post.tags.map((t) => t.tagId);
  const adjacent = await getAdjacentPosts(post.publishDate ?? null, post.id);

  return (
    <div className="container mx-auto px-4 sm:px-6 py-12">
      <article className="max-w-4xl mx-auto">
        {/* Back link */}
        <Link
          href="/blog"
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to blogs
        </Link>

        {/* Feature image */}
        {post.featureImage && (
          <div className="relative aspect-video w-full overflow-hidden rounded-xl mb-8">
            <Image
              src={post.featureImage}
              alt={post.title}
              fill
              priority
              className="object-cover"
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 896px"
            />
          </div>
        )}

        {/* Tags */}
        {post.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {post.tags.map((tagOnPost) => (
              <Link
                key={tagOnPost.tag.id}
                href={`/blog?tag=${tagOnPost.tag.slug}`}
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
            {post.isPremium && (
              <Badge className="bg-amber-500/90 hover:bg-amber-500 text-black font-semibold">
                Premium
              </Badge>
            )}
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mb-6 leading-tight">
          {post.title}
        </h1>

        {/* Meta info */}
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-border">
          <div className="flex items-center gap-3">
            <AuthorAvatar
              src={post.author.imageUrl}
              name={post.author.name || post.author.username}
              size={36}
            />
            <span className="text-base text-foreground/80 font-medium">
              {post.author.name || post.author.username}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-sm text-muted-foreground">
              {formatDate(post.publishDate)}
            </span>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{readingTime} min read</span>
              <span>{post.viewCount.toLocaleString()} views</span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="mb-12">
          <BlogContent content={post.content} />
        </div>

        {/* Share Buttons */}
        <div className="mt-12 pt-8 border-t border-border mb-12">
          <h3 className="text-foreground font-semibold mb-4">
            Share this post
          </h3>
          <ShareButtons
            title={post.title}
            url={`https://usemoney.ai/blog/${post.postUrl}`}
          />
        </div>

        {/* Prev / Next Navigation */}
        {(adjacent.prev || adjacent.next) && (
          <div className="flex justify-between items-center gap-4 py-6 border-t border-b border-border">
            {adjacent.prev ? (
              <Link
                href={`/blog/${adjacent.prev.postUrl}`}
                className="group flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors max-w-[45%]"
              >
                <ChevronLeft className="h-4 w-4 flex-shrink-0 group-hover:-translate-x-0.5 transition-transform" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Previous</p>
                  <p className="text-sm truncate">{adjacent.prev.title}</p>
                </div>
              </Link>
            ) : (
              <div />
            )}
            {adjacent.next ? (
              <Link
                href={`/blog/${adjacent.next.postUrl}`}
                className="group flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors max-w-[45%] text-right ml-auto"
              >
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Next</p>
                  <p className="text-sm truncate">{adjacent.next.title}</p>
                </div>
                <ChevronRight className="h-4 w-4 flex-shrink-0 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            ) : (
              <div />
            )}
          </div>
        )}

        {/* Related posts */}
        <Suspense fallback={<RelatedPostsSkeleton />}>
          <RelatedPosts postId={post.id} tagIds={tagIds} />
        </Suspense>
      </article>
    </div>
  );
}
