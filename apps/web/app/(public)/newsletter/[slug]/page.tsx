import { Suspense } from "react";
import { Metadata } from "next";
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
import { ShareButtons } from "./ShareButtons";
import {
  getNewsletterBySlugAction,
  getRelatedPostsAction,
} from "@/lib/actions/content";
import { resolveOgImage } from "@/lib/seo/og-image";

interface NewsletterDetailPageProps {
  params: Promise<{ slug: string }>;
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

// Get adjacent newsletters by publish date
async function getAdjacentNewsletters(
  publishDate: Date | null,
  currentId: string
) {
  if (!publishDate) return { prev: null, next: null };
  const date = new Date(publishDate);

  const [prev, next] = await Promise.all([
    prisma.post.findFirst({
      where: {
        id: { not: currentId },
        contentType: "NEWSLETTER",
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
        contentType: "NEWSLETTER",
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

export async function generateMetadata({
  params,
}: NewsletterDetailPageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const newsletter = await getNewsletterBySlugAction(resolvedParams.slug);

  if (!newsletter) {
    return {
      title: "Newsletter Not Found",
      description: "The requested newsletter could not be found.",
    };
  }

  const title = newsletter.metadataTitle || newsletter.title;
  const description =
    newsletter.metadataDescription ||
    newsletter.excerpt ||
    `Read ${newsletter.title} on UseMoney`;
  // metadataImageUrl → featureImage → site default, always absolute.
  const imageUrl = resolveOgImage(newsletter);
  const canonicalUrl =
    newsletter.canonicalUrl ||
    `https://usemoney.ai/newsletter/${newsletter.postUrl}`;

  return {
    title,
    description,
    keywords: newsletter.metadataKeywords || undefined,
    openGraph: {
      title,
      description,
      type: "article",
      url: canonicalUrl,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: title }],
      publishedTime: newsletter.publishDate
        ? new Date(newsletter.publishDate).toISOString()
        : undefined,
      authors: [newsletter.author.name || newsletter.author.username],
      tags: newsletter.tags.map((t) => t.tag.name),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
    alternates: {
      canonical: canonicalUrl,
    },
  };
}

// Related newsletters component
async function RelatedNewsletters({
  postId,
  tagIds,
}: {
  postId: string;
  tagIds: string[];
}) {
  const relatedPosts = await getRelatedPostsAction({
    postId,
    contentType: "NEWSLETTER",
    tagIds,
    limit: 3,
  });

  if (relatedPosts.length === 0) return null;

  return (
    <section className="mt-16 pt-8 border-t border-border">
      <h2 className="text-2xl font-semibold text-foreground mb-6">
        Related Newsletters
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {relatedPosts.map((post) => (
          <BlogCard key={post.id} post={post} />
        ))}
      </div>
    </section>
  );
}

function RelatedNewslettersSkeleton() {
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

export default async function NewsletterDetailPage({
  params,
}: NewsletterDetailPageProps) {
  const resolvedParams = await params;
  const newsletter = await getNewsletterBySlugAction(resolvedParams.slug);

  if (!newsletter) {
    notFound();
  }

  const readingTime = calculateReadingTime(newsletter.content);
  const tagIds = newsletter.tags.map((t) => t.tagId);
  const adjacent = await getAdjacentNewsletters(
    newsletter.publishDate ?? null,
    newsletter.id
  );

  return (
    <div className="container mx-auto px-4 sm:px-6 py-12">
      <article className="max-w-4xl mx-auto">
        {/* Back link */}
        <Link
          href="/newsletter"
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to newsletters
        </Link>

        {/* Feature Image */}
        {newsletter.featureImage && (
          <div className="relative aspect-video w-full overflow-hidden rounded-xl mb-8">
            <Image
              src={newsletter.featureImage}
              alt={newsletter.title}
              fill
              priority
              className="object-cover"
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 896px"
            />
          </div>
        )}

        {/* Tags */}
        {newsletter.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {newsletter.tags.map((tagOnPost) => (
              <Link
                key={tagOnPost.tag.id}
                href={`/newsletter?tag=${tagOnPost.tag.slug}`}
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
            {newsletter.isPremium && (
              <Badge className="bg-amber-500/90 hover:bg-amber-500 text-black font-semibold">
                Premium
              </Badge>
            )}
          </div>
        )}

        {/* Title */}
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground mb-6 leading-tight">
          {newsletter.title}
        </h1>

        {/* Meta info */}
        <div className="flex items-center justify-between mb-8 pb-6 border-b border-border">
          <div className="flex items-center gap-3">
            <AuthorAvatar
              src={newsletter.author.imageUrl}
              name={newsletter.author.name || newsletter.author.username}
              size={36}
            />
            <span className="text-base text-foreground/80 font-medium">
              {newsletter.author.name || newsletter.author.username}
            </span>
          </div>
          <div className="flex flex-col items-end gap-0.5">
            <span className="text-sm text-muted-foreground">
              {formatDate(newsletter.publishDate)}
            </span>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{readingTime} min read</span>
              <span>{newsletter.viewCount.toLocaleString()} views</span>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="mb-12">
          <BlogContent content={newsletter.content} />
        </div>

        {/* Share Buttons */}
        <div className="mt-12 pt-8 border-t border-border mb-12">
          <h3 className="text-foreground font-semibold mb-4">
            Share this newsletter
          </h3>
          <ShareButtons
            title={newsletter.title}
            url={`https://usemoney.ai/newsletter/${newsletter.postUrl}`}
          />
        </div>

        {/* Prev / Next Navigation */}
        {(adjacent.prev || adjacent.next) && (
          <div className="flex justify-between items-center gap-4 py-6 border-t border-b border-border">
            {adjacent.prev ? (
              <Link
                href={`/newsletter/${adjacent.prev.postUrl}`}
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
                href={`/newsletter/${adjacent.next.postUrl}`}
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

        {/* Related Newsletters */}
        <Suspense fallback={<RelatedNewslettersSkeleton />}>
          <RelatedNewsletters postId={newsletter.id} tagIds={tagIds} />
        </Suspense>
      </article>
    </div>
  );
}
