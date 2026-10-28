"use server";

import prisma from "@/lib/prisma";
import type { PostListItem, Post, ContentType } from "@usemoney/types";
import { getCached, setCached } from "@/lib/cache/wrapper";
import { searchContentAtlas } from "@/lib/market/content-search";
import type { AtlasContentResult } from "@/lib/market/content-search";
import {
  getBlogPosts,
  getBlogPostBySlug,
  getFeaturedBlogPosts,
  getLatestBlogPosts,
  getGlossaryPosts,
  getGlossaryPostBySlug,
  getGlossaryTermsForHelp,
  getNewsletters,
  getNewsletterBySlug,
  getDocs,
  getDocBySlug,
  getTags,
  getTagBySlug,
  getRelatedPosts,
} from "@usemoney/services";

// ============== ATLAS SEARCH HELPER ==============

/**
 * Transform Prisma Post record to PostListItem type
 */
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

/**
 * Convert Atlas Search results to PostListItem format.
 * Atlas returns minimal fields, so we fetch full records by IDs.
 *
 * `contentType` + `status: "PUBLISHED"` are re-asserted here rather than
 * inherited from the Atlas filter, and that is the point: this re-fetch is
 * the ONLY thing standing between a `$search` hit and an anonymous visitor.
 * Before MONEY-1128 the compound filter used the `text` operator against
 * three `token`-mapped fields, which matched nothing — so this path returned
 * zero rows and was, in effect, dead. Fixing the operator brought it to life,
 * and with it the fact that the `where` clause here trusted the index for
 * authorization: an unpublished (DRAFT / ARCHIVED / DELETED) post whose index
 * entry was stale or drifted would have its title, excerpt and slug returned
 * to the public blog/glossary/docs search — and `setCached(..., "public", …)`
 * would pin the leak for the cache TTL.
 *
 * These predicates match `content.service.ts`'s non-search path exactly, so
 * both routes to the same list agree, and the index stays a performance layer
 * instead of becoming an access-control one.
 */
async function atlasResultsToPostListItems(
  results: AtlasContentResult[],
  contentType: "BLOG" | "GLOSSARY" | "DOCS"
): Promise<PostListItem[]> {
  if (results.length === 0) return [];

  const ids = results.map((r) => r._id.$oid);
  const posts = await prisma.post.findMany({
    where: { id: { in: ids }, contentType, status: "PUBLISHED" },
    include: {
      author: {
        select: { id: true, name: true, username: true, imageUrl: true },
      },
      tags: {
        include: {
          tag: {
            select: { id: true, name: true, slug: true, color: true },
          },
        },
      },
    },
  });

  // Preserve Atlas relevance ordering
  const postMap = new Map(posts.map((p) => [p.id, p]));
  return ids
    .map((id) => postMap.get(id))
    .filter(Boolean)
    .map((post) => transformToPostListItem(post!));
}

// ============== BLOG ACTIONS ==============

/**
 * Get published blog posts with pagination
 * Filters by search (title, excerpt) and tag if provided
 * Sort by publishDate desc
 * Uses Atlas Search as fast-path for text queries, falls back to service
 */
export async function getBlogPostsAction(params: {
  page?: number;
  limit?: number;
  search?: string;
  featured?: boolean;
  tagSlug?: string;
}): Promise<{ posts: PostListItem[]; total: number; pages: number }> {
  try {
    // Use shorter TTL for search queries, longer for browse
    const cacheModule = params.search ? "content-search" : "content";
    const cached = await getCached<{
      posts: PostListItem[];
      total: number;
      pages: number;
    }>(cacheModule, "public", `blog-posts`, params);
    if (cached) return cached;

    const page = params.page ?? 1;
    const limit = params.limit ?? 10;

    // Try Atlas Search for text queries (no tag filter -- Atlas can't filter by tag slug)
    if (params.search && !params.tagSlug && !params.featured) {
      const atlasResults = await searchContentAtlas(params.search, {
        contentType: "BLOG",
        limit: limit * page, // fetch enough for pagination
      });
      if (atlasResults) {
        const allPosts = await atlasResultsToPostListItems(
          atlasResults,
          "BLOG"
        );
        const total = allPosts.length;
        const paginatedPosts = allPosts.slice((page - 1) * limit, page * limit);
        const result = {
          posts: paginatedPosts,
          total,
          pages: Math.ceil(total / limit),
        };
        await setCached(cacheModule, "public", `blog-posts`, result, params);
        return result;
      }
      // Atlas unavailable -- fall through to service
    }

    // Use service for Prisma-based queries
    const serviceResult = await getBlogPosts(params);
    if (serviceResult.success) {
      return serviceResult.data;
    }

    return { posts: [], total: 0, pages: 0 };
  } catch (error) {
    console.error("Error fetching blog posts:", error);
    return { posts: [], total: 0, pages: 0 };
  }
}

/**
 * Get single published blog post by postUrl (slug)
 * Increments view count
 * Returns null if not found or not published
 */
export async function getBlogPostBySlugAction(
  slug: string
): Promise<Post | null> {
  try {
    const result = await getBlogPostBySlug(slug);
    if (result?.success) {
      return result?.data;
    }
    return null;
  } catch (error) {
    console.error("Error fetching blog post by slug:", error);
    return null;
  }
}

/**
 * Get featured published blog posts
 * Sort by publishDate desc, limit to specified count
 */
export async function getFeaturedBlogPostsAction(
  limit: number = 3
): Promise<PostListItem[]> {
  try {
    const result = await getFeaturedBlogPosts(limit);
    if (result?.success) {
      return result?.data;
    }
    return [];
  } catch (error) {
    console.error("Error fetching featured blog posts:", error);
    return [];
  }
}

// ============== GLOSSARY ACTIONS ==============

/**
 * Get all published glossary terms
 * Filter by search if provided
 * Sort alphabetically by title
 * Uses Atlas Search as fast-path for text queries, falls back to service
 */
export async function getGlossaryTermsAction(
  search?: string
): Promise<PostListItem[]> {
  try {
    const cacheModule = search ? "content-search" : "content";
    const cacheId = search ? `glossary-search` : `glossary-all`;
    const cached = await getCached<PostListItem[]>(
      cacheModule,
      "public",
      cacheId,
      search ? { search } : undefined
    );
    if (cached) return cached;

    // Try Atlas Search for text queries
    if (search) {
      const atlasResults = await searchContentAtlas(search, {
        contentType: "GLOSSARY",
        limit: 200, // glossary can have many terms
      });
      if (atlasResults) {
        const result = await atlasResultsToPostListItems(
          atlasResults,
          "GLOSSARY"
        );
        await setCached(cacheModule, "public", cacheId, result, { search });
        return result;
      }
      // Atlas unavailable -- fall through to service
    }

    // Use service for Prisma-based queries
    const serviceResult = await getGlossaryPosts(search);
    if (serviceResult.success) {
      return serviceResult.data;
    }

    return [];
  } catch (error) {
    console.error("Error fetching glossary terms:", error);
    return [];
  }
}

/**
 * Get single published glossary term by postUrl (slug)
 * Increments view count
 * Returns null if not found or not published
 */
export async function getGlossaryTermBySlugAction(
  slug: string
): Promise<Post | null> {
  try {
    const result = await getGlossaryPostBySlug(slug);
    if (result?.success) {
      return result?.data;
    }
    return null;
  } catch (error) {
    console.error("Error fetching glossary term by slug:", error);
    return null;
  }
}

// ============== NEWSLETTER ACTIONS ==============

/**
 * Get published newsletters with pagination
 * Sort by publishDate desc
 */
export async function getNewslettersAction(params: {
  page?: number;
  limit?: number;
  tagSlug?: string;
}): Promise<{ posts: PostListItem[]; total: number; pages: number }> {
  try {
    const result = await getNewsletters(params);
    if (result?.success) {
      return result?.data;
    }
    return { posts: [], total: 0, pages: 0 };
  } catch (error) {
    console.error("Error fetching newsletters:", error);
    return { posts: [], total: 0, pages: 0 };
  }
}

/**
 * Get single published newsletter by postUrl (slug)
 * Increments view count
 * Returns null if not found or not published
 */
export async function getNewsletterBySlugAction(
  slug: string
): Promise<Post | null> {
  try {
    const result = await getNewsletterBySlug(slug);
    if (result?.success) {
      return result?.data;
    }
    return null;
  } catch (error) {
    console.error("Error fetching newsletter by slug:", error);
    return null;
  }
}

// ============== RELATED CONTENT ACTIONS ==============

/**
 * Get related posts based on shared tags
 * Excludes current post
 * Same content type
 * Sort by relevance (tag overlap count) and then by publishDate
 */
export async function getRelatedPostsAction(params: {
  postId: string;
  contentType: ContentType;
  tagIds: string[];
  limit?: number;
}): Promise<PostListItem[]> {
  try {
    const result = await getRelatedPosts(params);
    if (result?.success) {
      return result?.data;
    }
    return [];
  } catch (error) {
    console.error("Error fetching related posts:", error);
    return [];
  }
}

// ============== DOCS ACTIONS ==============

/**
 * Get published docs with pagination
 * Filter by search (title, excerpt) and tag if provided
 * Sort by title asc
 * Uses Atlas Search as fast-path for text queries, falls back to service
 */
export async function getDocsAction(params: {
  page?: number;
  limit?: number;
  search?: string;
  tagSlug?: string;
}): Promise<{ posts: PostListItem[]; total: number; pages: number }> {
  try {
    const cacheModule = params.search ? "content-search" : "content";
    const cached = await getCached<{
      posts: PostListItem[];
      total: number;
      pages: number;
    }>(cacheModule, "public", `docs`, params);
    if (cached) return cached;

    const page = params.page ?? 1;
    const limit = params.limit ?? 12;

    // Try Atlas Search for text queries (no tag filter)
    if (params.search && !params.tagSlug) {
      const atlasResults = await searchContentAtlas(params.search, {
        contentType: "DOCS",
        limit: limit * page,
      });
      if (atlasResults) {
        const allPosts = await atlasResultsToPostListItems(
          atlasResults,
          "DOCS"
        );
        const total = allPosts.length;
        const paginatedPosts = allPosts.slice((page - 1) * limit, page * limit);
        const result = {
          posts: paginatedPosts,
          total,
          pages: Math.ceil(total / limit),
        };
        await setCached(cacheModule, "public", `docs`, result, params);
        return result;
      }
      // Atlas unavailable -- fall through to service
    }

    // Use service for Prisma-based queries
    const serviceResult = await getDocs(params);
    if (serviceResult.success) {
      return serviceResult.data;
    }

    return { posts: [], total: 0, pages: 0 };
  } catch (error) {
    console.error("Error fetching docs:", error);
    return { posts: [], total: 0, pages: 0 };
  }
}

/**
 * Get single published doc by postUrl (slug)
 * Increments view count
 * Returns null if not found or not published
 */
export async function getDocBySlugAction(slug: string): Promise<Post | null> {
  try {
    const result = await getDocBySlug(slug);
    if (result?.success) {
      return result?.data;
    }
    return null;
  } catch (error) {
    console.error("Error fetching doc by slug:", error);
    return null;
  }
}

/**
 * Get latest published blog posts (for landing page)
 * Returns the most recent published blog posts regardless of featured status
 */
export async function getLatestBlogPostsAction(
  limit: number = 3
): Promise<PostListItem[]> {
  try {
    const result = await getLatestBlogPosts(limit);
    if (result?.success) {
      return result?.data;
    }
    return [];
  } catch (error) {
    console.error("Error fetching latest blog posts:", error);
    return [];
  }
}

// ============== TAG ACTIONS ==============

/**
 * Get all tags
 */
export async function getTagsAction(): Promise<
  Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    color: string | null;
    imageUrl: string | null;
    postCount: number;
  }>
> {
  try {
    const result = await getTags();
    if (result?.success) {
      return result?.data;
    }
    return [];
  } catch (error) {
    console.error("Error fetching tags:", error);
    return [];
  }
}

/**
 * Get tag by slug with post count
 */
export async function getTagBySlugAction(slug: string): Promise<{
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  imageUrl: string | null;
  postCount: number;
} | null> {
  try {
    const result = await getTagBySlug(slug);
    if (result?.success) {
      return result?.data;
    }
    return null;
  } catch (error) {
    console.error("Error fetching tag by slug:", error);
    return null;
  }
}

// ─── Help Center Glossary ─────────────────────────────────────────────────

export interface HelpGlossaryTerm {
  term: string;
  definition: string;
}

/**
 * Fetch published glossary terms in a lightweight format for the Help Center.
 * Returns { term, definition } sorted alphabetically.
 * Falls back to empty array on error.
 */
export async function getGlossaryTermsForHelpAction(): Promise<
  HelpGlossaryTerm[]
> {
  try {
    const result = await getGlossaryTermsForHelp();
    if (result?.success) {
      return result?.data;
    }
    return [];
  } catch (error) {
    console.error("Error fetching glossary terms for help:", error);
    return [];
  }
}
