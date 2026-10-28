/**
 * Content Service
 *
 * Blog posts, glossary, newsletters, docs, and tags.
 * All public content - no auth required.
 * Atlas Search stays in apps/web; this service uses Prisma queries.
 * Source: apps/web/lib/actions/content.ts
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import { dbLogger as logger } from "@usemoney/logger";
import type { PostListItem, Post, ContentType } from "@usemoney/types";
import type { ServiceResult } from "./types";
import {
  clampPagePagination,
  computePages,
  redactPremiumPost,
  type ContentViewer,
} from "./content-logic";

// ── Helpers ────────────────────────────────────────────────────────

function transformToPostListItem(post: {
  id: string;
  postUrl: string;
  contentType: string;
  title: string;
  excerpt: string | null;
  featureImage: string | null;
  publishDate: Date | null;
  status: string;
  isFeatured: boolean;
  isPremium: boolean;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    name: string | null;
    username: string;
    imageUrl: string | null;
  };
  tags: Array<{
    tag: {
      id: string;
      name: string;
      slug: string;
      color: string | null;
    };
  }>;
}): PostListItem {
  return {
    id: post.id,
    postUrl: post.postUrl,
    contentType: post.contentType as ContentType,
    title: post.title,
    excerpt: post.excerpt,
    featureImage: post.featureImage,
    publishDate: post.publishDate,
    status: post.status as "DRAFT" | "PUBLISHED" | "SCHEDULED" | "DELETED",
    isFeatured: post.isFeatured,
    isPremium: post.isPremium,
    viewCount: post.viewCount,
    author: {
      id: post.author.id,
      name: post.author.name,
      username: post.author.username,
      imageUrl: post.author.imageUrl,
    },
    tags: post.tags.map((t) => ({
      id: t.tag.id,
      name: t.tag.name,
      slug: t.tag.slug,
      color: t.tag.color,
    })),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

function transformToPost(post: {
  id: string;
  contentPlatform: string;
  contentType: string;
  title: string;
  content: string;
  featureImage: string | null;
  postUrl: string;
  excerpt: string | null;
  publishDate: Date | null;
  status: string;
  isFeatured: boolean;
  isPremium: boolean;
  authorId: string;
  metadataTitle: string | null;
  metadataDescription: string | null;
  metadataImageUrl: string | null;
  metadataKeywords: string | null;
  canonicalUrl: string | null;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    clerkId: string;
    name: string | null;
    username: string;
    email: string;
    imageUrl: string | null;
    role: string;
    createdAt: Date;
    updatedAt: Date;
  };
  tags: Array<{
    id: string;
    postId: string;
    tagId: string;
    createdAt: Date;
    tag: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      color: string | null;
      imageUrl: string | null;
      createdAt: Date;
      updatedAt: Date;
    };
  }>;
}): Post {
  return {
    id: post.id,
    contentPlatform: post.contentPlatform as "STOCKBOOK",
    contentType: post.contentType as ContentType,
    title: post.title,
    content: post.content,
    featureImage: post.featureImage,
    postUrl: post.postUrl,
    excerpt: post.excerpt,
    publishDate: post.publishDate,
    status: post.status as "DRAFT" | "PUBLISHED" | "SCHEDULED" | "DELETED",
    isFeatured: post.isFeatured,
    isPremium: post.isPremium,
    authorId: post.authorId,
    author: {
      id: post.author.id,
      clerkId: post.author.clerkId,
      name: post.author.name,
      username: post.author.username,
      email: post.author.email,
      imageUrl: post.author.imageUrl,
      role: post.author.role as "ADMIN" | "OWNER" | "WRITER",
      createdAt: post.author.createdAt,
      updatedAt: post.author.updatedAt,
    },
    tags: post.tags.map((t) => ({
      id: t.id,
      postId: t.postId,
      tagId: t.tagId,
      createdAt: t.createdAt,
      tag: {
        id: t.tag.id,
        slug: t.tag.slug,
        name: t.tag.name,
        description: t.tag.description,
        color: t.tag.color,
        imageUrl: t.tag.imageUrl,
        createdAt: t.tag.createdAt,
        updatedAt: t.tag.updatedAt,
      },
    })),
    metadataTitle: post.metadataTitle,
    metadataDescription: post.metadataDescription,
    metadataImageUrl: post.metadataImageUrl,
    metadataKeywords: post.metadataKeywords,
    canonicalUrl: post.canonicalUrl,
    viewCount: post.viewCount,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}

const POST_LIST_INCLUDE = {
  author: {
    select: { id: true, name: true, username: true, imageUrl: true },
  },
  tags: {
    include: {
      tag: { select: { id: true, name: true, slug: true, color: true } },
    },
  },
} as const;

// ── Blog ───────────────────────────────────────────────────────────

export async function getBlogPosts(params: {
  page?: number;
  limit?: number;
  search?: string;
  featured?: boolean;
  tagSlug?: string;
}): Promise<
  ServiceResult<{ posts: PostListItem[]; total: number; pages: number }>
> {
  try {
    const cacheModule = params.search ? "content-search" : "content";
    const cached = await getCached<{
      posts: PostListItem[];
      total: number;
      pages: number;
    }>(cacheModule, "public", "blog-posts", params);
    if (cached) return { success: true, data: cached };

    // Clamp possibly-untrusted (page, limit) from the query string into safe
    // Prisma bounds — a NaN/negative page yields a negative/NaN skip that Prisma
    // throws on. See content-logic.ts#clampPagePagination.
    const { limit, skip } = clampPagePagination(params.page, params.limit, 10);

    const where: Record<string, unknown> = {
      contentType: "BLOG",
      status: "PUBLISHED",
    };
    if (params.featured !== undefined) where.isFeatured = params.featured;
    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: "insensitive" } },
        { excerpt: { contains: params.search, mode: "insensitive" } },
        { content: { contains: params.search, mode: "insensitive" } },
      ];
    }
    if (params.tagSlug) {
      where.tags = { some: { tag: { slug: params.tagSlug } } };
    }

    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
        include: POST_LIST_INCLUDE,
        orderBy: { publishDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    const result = {
      posts: posts.map(transformToPostListItem),
      total,
      pages: computePages(total, limit),
    };

    await setCached(cacheModule, "public", "blog-posts", result, params);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get blog posts service error");
    return { success: false, error: "Failed to fetch blog posts" };
  }
}

export async function getBlogPostBySlug(
  slug: string,
): Promise<ServiceResult<Post | null>> {
  try {
    const cached = await getCached<Post>(
      "content",
      "public",
      `blog-post-${slug}`,
    );
    if (cached) return { success: true, data: cached };

    const post = await prisma.post.findFirst({
      where: { postUrl: slug, contentType: "BLOG", status: "PUBLISHED" },
      include: { author: true, tags: { include: { tag: true } } },
    });

    if (!post) return { success: true, data: null };

    // Increment view count and use updated value
    try {
      const updated = await prisma.post.update({
        where: { id: post.id },
        data: { viewCount: { increment: 1 } },
        select: { viewCount: true },
      });
      post.viewCount = updated.viewCount;
    } catch {
      // Don't fail the whole request if increment fails
    }

    const result = transformToPost(post);
    await setCached(
      "content",
      "public",
      `blog-post-${slug}`,
      result,
      undefined,
      {
        ttl: 30 * 60,
        enableMemory: true,
        enableRedis: true,
      },
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, slug }, "Get blog post by slug service error");
    return { success: false, error: "Failed to fetch blog post" };
  }
}

export async function getFeaturedBlogPosts(
  limit: number = 3,
): Promise<ServiceResult<PostListItem[]>> {
  try {
    const cached = await getCached<PostListItem[]>(
      "content",
      "public",
      `featured-blog-${limit}`,
    );
    if (cached) return { success: true, data: cached };

    const posts = await prisma.post.findMany({
      where: { contentType: "BLOG", status: "PUBLISHED", isFeatured: true },
      include: POST_LIST_INCLUDE,
      orderBy: { publishDate: "desc" },
      take: limit,
    });

    const result = posts.map(transformToPostListItem);
    await setCached("content", "public", `featured-blog-${limit}`, result);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get featured blog posts service error");
    return { success: false, error: "Failed to fetch featured posts" };
  }
}

export async function getLatestBlogPosts(
  limit: number = 3,
): Promise<ServiceResult<PostListItem[]>> {
  try {
    const cached = await getCached<PostListItem[]>(
      "content",
      "public",
      `latest-blog-${limit}`,
    );
    if (cached) return { success: true, data: cached };

    const posts = await prisma.post.findMany({
      where: { contentType: "BLOG", status: "PUBLISHED" },
      include: POST_LIST_INCLUDE,
      orderBy: { publishDate: "desc" },
      take: limit,
    });

    const result = posts.map(transformToPostListItem);
    await setCached("content", "public", `latest-blog-${limit}`, result);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get latest blog posts service error");
    return { success: false, error: "Failed to fetch latest posts" };
  }
}

// ── Glossary ───────────────────────────────────────────────────────

export async function getGlossaryPosts(
  search?: string,
): Promise<ServiceResult<PostListItem[]>> {
  try {
    const cacheModule = search ? "content-search" : "content";
    const cacheId = search ? "glossary-search" : "glossary-all";
    const cached = await getCached<PostListItem[]>(
      cacheModule,
      "public",
      cacheId,
      search ? { search } : undefined,
    );
    if (cached) return { success: true, data: cached };

    const where: Record<string, unknown> = {
      contentType: "GLOSSARY",
      status: "PUBLISHED",
    };
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { excerpt: { contains: search, mode: "insensitive" } },
        { content: { contains: search, mode: "insensitive" } },
      ];
    }

    const posts = await prisma.post.findMany({
      where,
      include: POST_LIST_INCLUDE,
      orderBy: { title: "asc" },
    });

    const result = posts.map(transformToPostListItem);
    await setCached(
      cacheModule,
      "public",
      cacheId,
      result,
      search ? { search } : undefined,
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get glossary posts service error");
    return { success: false, error: "Failed to fetch glossary" };
  }
}

export async function getGlossaryPostBySlug(
  slug: string,
): Promise<ServiceResult<Post | null>> {
  try {
    const cached = await getCached<Post>(
      "content",
      "public",
      `glossary-term-${slug}`,
    );
    if (cached) return { success: true, data: cached };

    const post = await prisma.post.findFirst({
      where: { postUrl: slug, contentType: "GLOSSARY", status: "PUBLISHED" },
      include: { author: true, tags: { include: { tag: true } } },
    });

    if (!post) return { success: true, data: null };

    try {
      const updated = await prisma.post.update({
        where: { id: post.id },
        data: { viewCount: { increment: 1 } },
        select: { viewCount: true },
      });
      post.viewCount = updated.viewCount;
    } catch {
      // Don't fail the whole request if increment fails
    }

    const result = transformToPost(post);
    await setCached(
      "content",
      "public",
      `glossary-term-${slug}`,
      result,
      undefined,
      {
        ttl: 30 * 60,
        enableMemory: true,
        enableRedis: true,
      },
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, slug }, "Get glossary post by slug service error");
    return { success: false, error: "Failed to fetch glossary term" };
  }
}

export interface HelpGlossaryTerm {
  term: string;
  definition: string;
}

/**
 * Cache policy for the Help Center glossary — cached until INVALIDATED, not
 * until a clock runs out.
 *
 * /help is `force-dynamic`, so every visit blocks its server render on this
 * query: ~190ms for 132 rows / 25KB, measured against prod data. The `content`
 * module default is a 10-minute TTL whose own comment says the data "changes
 * only on publish" — so for 10 minutes it serves a value nothing has changed,
 * and then makes a visitor pay 190ms to re-fetch a value that is still
 * identical. Time was never the right trigger; a publish is.
 *
 * The two tiers get DIFFERENT lifetimes, and that asymmetry is the whole
 * design (see CacheConfig.memoryTtl, MONEY-1127):
 *
 *   ttl (Redis, shared)  30 days. Effectively permanent. Invalidation is what
 *                        ends it, via `invalidateHelpGlossaryCache` below.
 *   memoryTtl (L1)       60s. Deliberately SHORT. `deleteCached` issues a
 *                        global Redis DEL but only clears the L1 of the
 *                        process that ran it — and the process that publishes
 *                        a glossary term is apps/content, a DIFFERENT app from
 *                        the apps/web instances serving /help. Nothing can
 *                        reach their memory. A 30-day L1 would therefore
 *                        strand every warm web instance on a stale glossary
 *                        until redeploy. 60s bounds that to a minute, at the
 *                        cost of one Redis GET + a 25KB parse per instance per
 *                        minute, which is nothing next to the 190ms query.
 *
 * This is the "set it shorter than ttl" case the memoryTtl docs describe — a
 * small entry that MUTATIONS invalidate — not the "leave it unset" case for
 * multi-MB blobs nothing ever invalidates.
 *
 * ## What actually invalidates it
 *
 * apps/content's `invalidateWebContentCache`, which every post mutation
 * already calls — create, update, delete, archive, publish and unpublish, each
 * passing the post's `contentType`. For GLOSSARY it purges
 * `content:public:help-glossary:*` straight out of the shared Redis.
 *
 * That pattern's trailing `:*` is load-bearing and easy to misread as a typo:
 * `generateCacheKey` appends a version segment, which is the literal
 * `"default"` when no filters are passed, so the real key is
 * `content:public:help-glossary:default`. A pattern without the `:*` would
 * match nothing and this entry would never be cleared. Nothing would break
 * loudly — /help would simply serve a month-old glossary. If that key ever
 * gains filters, the pattern still holds; if it loses its version segment, it
 * will not.
 */
const HELP_GLOSSARY_CACHE = {
  ttl: 30 * 24 * 60 * 60,
  memoryTtl: 60,
  enableMemory: true,
  enableRedis: true,
} as const;

export async function getGlossaryTermsForHelp(): Promise<
  ServiceResult<HelpGlossaryTerm[]>
> {
  try {
    const cached = await getCached<HelpGlossaryTerm[]>(
      "content",
      "public",
      "help-glossary",
      undefined,
      HELP_GLOSSARY_CACHE,
    );
    if (cached) return { success: true, data: cached };

    const posts = await prisma.post.findMany({
      where: {
        contentType: "GLOSSARY",
        contentPlatform: "STOCKBOOK",
        status: "PUBLISHED",
      },
      select: { title: true, excerpt: true },
      orderBy: { title: "asc" },
    });

    const result = posts.map((p) => ({
      term: p.title,
      definition: p.excerpt || "",
    }));

    await setCached(
      "content",
      "public",
      "help-glossary",
      result,
      undefined,
      HELP_GLOSSARY_CACHE,
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get help glossary terms service error");
    return { success: false, error: "Failed to fetch glossary terms" };
  }
}

// ── Newsletters ────────────────────────────────────────────────────

export async function getNewsletters(params: {
  page?: number;
  limit?: number;
  tagSlug?: string;
}): Promise<
  ServiceResult<{ posts: PostListItem[]; total: number; pages: number }>
> {
  try {
    const cached = await getCached<{
      posts: PostListItem[];
      total: number;
      pages: number;
    }>("content", "public", "newsletters", params);
    if (cached) return { success: true, data: cached };

    const { limit, skip } = clampPagePagination(params.page, params.limit, 10);
    const where: Record<string, unknown> = {
      contentType: "NEWSLETTER" as const,
      status: "PUBLISHED" as const,
    };
    if (params.tagSlug) {
      where.tags = { some: { tag: { slug: params.tagSlug } } };
    }

    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
        include: POST_LIST_INCLUDE,
        orderBy: { publishDate: "desc" },
        skip,
        take: limit,
      }),
    ]);

    const result = {
      posts: posts.map(transformToPostListItem),
      total,
      pages: computePages(total, limit),
    };

    await setCached("content", "public", "newsletters", result, params);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get newsletters service error");
    return { success: false, error: "Failed to fetch newsletters" };
  }
}

export async function getNewsletterBySlug(
  slug: string,
): Promise<ServiceResult<Post | null>> {
  try {
    const cached = await getCached<Post>(
      "content",
      "public",
      `newsletter-${slug}`,
    );
    if (cached) return { success: true, data: cached };

    const post = await prisma.post.findFirst({
      where: { postUrl: slug, contentType: "NEWSLETTER", status: "PUBLISHED" },
      include: { author: true, tags: { include: { tag: true } } },
    });

    if (!post) return { success: true, data: null };

    try {
      const updated = await prisma.post.update({
        where: { id: post.id },
        data: { viewCount: { increment: 1 } },
        select: { viewCount: true },
      });
      post.viewCount = updated.viewCount;
    } catch {
      // Don't fail the whole request if increment fails
    }

    const result = transformToPost(post);
    await setCached(
      "content",
      "public",
      `newsletter-${slug}`,
      result,
      undefined,
      {
        ttl: 30 * 60,
        enableMemory: true,
        enableRedis: true,
      },
    );
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, slug }, "Get newsletter by slug service error");
    return { success: false, error: "Failed to fetch newsletter" };
  }
}

// ── Docs ───────────────────────────────────────────────────────────

export async function getDocs(params: {
  page?: number;
  limit?: number;
  search?: string;
  tagSlug?: string;
}): Promise<
  ServiceResult<{ posts: PostListItem[]; total: number; pages: number }>
> {
  try {
    const cacheModule = params.search ? "content-search" : "content";
    const cached = await getCached<{
      posts: PostListItem[];
      total: number;
      pages: number;
    }>(cacheModule, "public", "docs", params);
    if (cached) return { success: true, data: cached };

    const { limit, skip } = clampPagePagination(params.page, params.limit, 12);

    const where: Record<string, unknown> = {
      contentType: "DOCS",
      status: "PUBLISHED",
    };
    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: "insensitive" } },
        { excerpt: { contains: params.search, mode: "insensitive" } },
        { content: { contains: params.search, mode: "insensitive" } },
      ];
    }
    if (params.tagSlug) {
      where.tags = { some: { tag: { slug: params.tagSlug } } };
    }

    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
        include: POST_LIST_INCLUDE,
        orderBy: { title: "asc" },
        skip,
        take: limit,
      }),
    ]);

    const result = {
      posts: posts.map(transformToPostListItem),
      total,
      pages: computePages(total, limit),
    };

    await setCached(cacheModule, "public", "docs", result, params);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get docs service error");
    return { success: false, error: "Failed to fetch docs" };
  }
}

export async function getDocBySlug(
  slug: string,
): Promise<ServiceResult<Post | null>> {
  try {
    const cached = await getCached<Post>("content", "public", `doc-${slug}`);
    if (cached) return { success: true, data: cached };

    const post = await prisma.post.findFirst({
      where: { postUrl: slug, contentType: "DOCS", status: "PUBLISHED" },
      include: { author: true, tags: { include: { tag: true } } },
    });

    if (!post) return { success: true, data: null };

    try {
      const updated = await prisma.post.update({
        where: { id: post.id },
        data: { viewCount: { increment: 1 } },
        select: { viewCount: true },
      });
      post.viewCount = updated.viewCount;
    } catch {
      // Don't fail the whole request if increment fails
    }

    const result = transformToPost(post);
    await setCached("content", "public", `doc-${slug}`, result, undefined, {
      ttl: 30 * 60,
      enableMemory: true,
      enableRedis: true,
    });
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, slug }, "Get doc by slug service error");
    return { success: false, error: "Failed to fetch doc" };
  }
}

// ── Tags ───────────────────────────────────────────────────────────

export interface TagData {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  imageUrl: string | null;
  postCount: number;
}

export async function getTags(): Promise<ServiceResult<TagData[]>> {
  try {
    const cached = await getCached<TagData[]>("content", "public", "tags");
    if (cached) return { success: true, data: cached };

    const tags = await prisma.tag.findMany({
      include: {
        _count: {
          select: { posts: { where: { post: { status: "PUBLISHED" } } } },
        },
      },
      orderBy: { name: "asc" },
    });

    const result = tags.map((tag) => ({
      id: tag.id,
      slug: tag.slug,
      name: tag.name,
      description: tag.description,
      color: tag.color,
      imageUrl: tag.imageUrl,
      postCount: tag._count.posts,
    }));

    await setCached("content", "public", "tags", result);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error }, "Get tags service error");
    return { success: false, error: "Failed to fetch tags" };
  }
}

export async function getTagBySlug(
  slug: string,
): Promise<ServiceResult<TagData | null>> {
  try {
    const cached = await getCached<TagData>("content", "public", `tag-${slug}`);
    if (cached) return { success: true, data: cached };

    const tag = await prisma.tag.findUnique({
      where: { slug },
      include: {
        _count: {
          select: { posts: { where: { post: { status: "PUBLISHED" } } } },
        },
      },
    });

    if (!tag) return { success: true, data: null };

    const result = {
      id: tag.id,
      slug: tag.slug,
      name: tag.name,
      description: tag.description,
      color: tag.color,
      imageUrl: tag.imageUrl,
      postCount: tag._count.posts,
    };

    await setCached("content", "public", `tag-${slug}`, result);
    return { success: true, data: result };
  } catch (error) {
    logger.error({ error, slug }, "Get tag by slug service error");
    return { success: false, error: "Failed to fetch tag" };
  }
}

// ── Related Content ────────────────────────────────────────────────

export async function getRelatedPosts(params: {
  postId: string;
  contentType: ContentType;
  tagIds: string[];
  limit?: number;
}): Promise<ServiceResult<PostListItem[]>> {
  try {
    const limit = params.limit ?? 3;

    if (params.tagIds.length === 0) {
      const posts = await prisma.post.findMany({
        where: {
          id: { not: params.postId },
          contentType: params.contentType,
          status: "PUBLISHED",
        },
        include: POST_LIST_INCLUDE,
        orderBy: { publishDate: "desc" },
        take: limit,
      });
      return { success: true, data: posts.map(transformToPostListItem) };
    }

    const posts = await prisma.post.findMany({
      where: {
        id: { not: params.postId },
        contentType: params.contentType,
        status: "PUBLISHED",
        tags: { some: { tagId: { in: params.tagIds } } },
      },
      include: POST_LIST_INCLUDE,
      orderBy: { publishDate: "desc" },
    });

    // Sort by tag overlap count (relevance)
    const sorted = posts
      .map((post) => ({
        post,
        matchingTags: post.tags.filter((t) => params.tagIds.includes(t.tagId))
          .length,
      }))
      .sort((a, b) => {
        if (b.matchingTags !== a.matchingTags)
          return b.matchingTags - a.matchingTags;
        const dateA = a.post.publishDate?.getTime() ?? 0;
        const dateB = b.post.publishDate?.getTime() ?? 0;
        return dateB - dateA;
      })
      .slice(0, limit)
      .map((p) => p.post);

    return { success: true, data: sorted.map(transformToPostListItem) };
  } catch (error) {
    logger.error({ error }, "Get related posts service error");
    return { success: false, error: "Failed to fetch related posts" };
  }
}

// ── Entitlement-gated reads (premium content, fail-closed) ──────────
//
// The plain `get*BySlug` readers are viewer-agnostic and cache the FULL post
// (so the cache key never needs a viewer). These wrappers apply the premium
// entitlement gate PER REQUEST, after cache retrieval, redacting the body for a
// FREE / unentitled / expired viewer. They are the entry points a premium
// content surface (web action / future apps/api `/v1/content`) should call so a
// premium body is never served to someone who hasn't paid — see
// content-logic.ts#redactPremiumPost.

/**
 * Blog post by slug, gated by the viewer's entitlement. Identical to
 * `getBlogPostBySlug` for non-premium posts and for entitled viewers; for a
 * premium post + unentitled viewer the `content` body is stripped (the paywall
 * preview keeps title / excerpt / metadata). Fail-closed.
 */
export async function getGatedBlogPostBySlug(
  slug: string,
  viewer?: ContentViewer | null,
): Promise<ServiceResult<Post | null>> {
  const res = await getBlogPostBySlug(slug);
  if (!res.success || !res.data) return res;
  return { success: true, data: redactPremiumPost(res.data, viewer) };
}

/** Glossary term by slug, entitlement-gated (fail-closed). */
export async function getGatedGlossaryPostBySlug(
  slug: string,
  viewer?: ContentViewer | null,
): Promise<ServiceResult<Post | null>> {
  const res = await getGlossaryPostBySlug(slug);
  if (!res.success || !res.data) return res;
  return { success: true, data: redactPremiumPost(res.data, viewer) };
}

/** Newsletter by slug, entitlement-gated (fail-closed). */
export async function getGatedNewsletterBySlug(
  slug: string,
  viewer?: ContentViewer | null,
): Promise<ServiceResult<Post | null>> {
  const res = await getNewsletterBySlug(slug);
  if (!res.success || !res.data) return res;
  return { success: true, data: redactPremiumPost(res.data, viewer) };
}

/** Doc by slug, entitlement-gated (fail-closed). */
export async function getGatedDocBySlug(
  slug: string,
  viewer?: ContentViewer | null,
): Promise<ServiceResult<Post | null>> {
  const res = await getDocBySlug(slug);
  if (!res.success || !res.data) return res;
  return { success: true, data: redactPremiumPost(res.data, viewer) };
}
