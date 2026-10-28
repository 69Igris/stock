"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma, ContentRole } from "@usemoney/database";
import { buildPostListWhere } from "./posts-logic";
import {
  safeLimit as clampDashboardLimit,
  buildBaseWhere,
  buildPaginationSkip,
} from "./dashboard-logic";

/**
 * Get the current authenticated author
 * Returns null if not authenticated or not an author
 */
async function getAuthenticatedAuthor() {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return null;
  }

  let author = await prisma.contentAuthor.findUnique({
    where: { clerkId },
    select: { id: true, role: true, clerkId: true },
  });

  if (!author) {
    const clerkUser = await currentUser();
    if (!clerkUser) return null;

    const email = clerkUser.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress;
    if (!email) return null;

    const existingByEmail = await prisma.contentAuthor.findUnique({
      where: { email },
    });

    if (existingByEmail) {
      author = await prisma.contentAuthor.update({
        where: { email },
        data: { clerkId },
        select: { id: true, role: true, clerkId: true },
      });
    } else {
      const name =
        [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
        null;
      let username = (name ?? email.split("@")[0] ?? "user")
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .substring(0, 25);

      let counter = 1;
      while (
        await prisma.contentAuthor.findUnique({
          where: { username },
          select: { id: true },
        })
      ) {
        username = `${username.substring(0, 22)}_${counter}`;
        counter++;
      }

      const authorCount = await prisma.contentAuthor.count();
      const role: ContentRole = authorCount === 0 ? "OWNER" : "WRITER";

      author = await prisma.contentAuthor.create({
        data: {
          clerkId,
          email,
          name,
          username,
          imageUrl: clerkUser.imageUrl,
          role,
        },
        select: { id: true, role: true, clerkId: true },
      });
    }
  }

  return author;
}

// Simple dashboard stats type matching ratecreator pattern
export type DashboardStats = {
  totalPosts: number;
  drafts: number;
  published: number;
  scheduled: number;
  totalIdeas: number;
  ideasInProgress: number;
};

export type PostListType = {
  id: string;
  title: string;
  postUrl: string;
  status: string;
  contentType: string;
  viewCount: number;
  publishDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    name: string | null;
    username: string;
    imageUrl: string | null;
  };
};

/**
 * Fetch dashboard stats (simple format for dashboard component)
 */
export async function fetchDashboardStats(): Promise<DashboardStats> {
  const author = await getAuthenticatedAuthor();
  if (!author) {
    return {
      totalPosts: 0,
      drafts: 0,
      published: 0,
      scheduled: 0,
      totalIdeas: 0,
      ideasInProgress: 0,
    };
  }

  const baseWhere = buildBaseWhere(author.role, author.id);

  const [
    totalPosts,
    drafts,
    published,
    scheduled,
    totalIdeas,
    ideasInProgress,
  ] = await Promise.all([
    prisma.post.count({ where: baseWhere }),
    prisma.post.count({ where: { ...baseWhere, status: "DRAFT" } }),
    prisma.post.count({ where: { ...baseWhere, status: "PUBLISHED" } }),
    prisma.post.count({ where: { ...baseWhere, status: "SCHEDULED" } }),
    prisma.idea.count(),
    prisma.idea.count({ where: { status: "IN_PROGRESS" } }),
  ]);

  return {
    totalPosts,
    drafts,
    published,
    scheduled,
    totalIdeas,
    ideasInProgress,
  };
}

/**
 * Fetch recent posts (simple format for dashboard component)
 */
export async function fetchRecentPostsList(
  limit: number = 5,
): Promise<PostListType[]> {
  const author = await getAuthenticatedAuthor();
  if (!author) return [];

  const where = buildBaseWhere(author.role, author.id);

  return prisma.post.findMany({
    where,
    select: {
      id: true,
      title: true,
      postUrl: true,
      status: true,
      contentType: true,
      viewCount: true,
      publishDate: true,
      createdAt: true,
      updatedAt: true,
      author: {
        select: { id: true, name: true, username: true, imageUrl: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: clampDashboardLimit(limit),
  });
}

/**
 * Fetch post title by ID (for breadcrumbs)
 */
export async function fetchPostTitleById(
  postId: string,
): Promise<string | null> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { title: true },
  });
  return post?.title || null;
}

/**
 * Fetch all posts with filters (for posts list component).
 * Uses Atlas Search (prod) with title > excerpt > content priority,
 * falls back to Prisma contains (QA/local).
 */
export async function fetchAllPosts(
  page: number = 0,
  contentType?: string,
  status?: string,
  pageSize: number = 10,
  search?: string,
  authorId?: string,
  sortOrder: "asc" | "desc" = "desc",
): Promise<PostListType[]> {
  const author = await getAuthenticatedAuthor();
  if (!author) return [];

  const select = {
    id: true,
    title: true,
    postUrl: true,
    status: true,
    contentType: true,
    viewCount: true,
    publishDate: true,
    createdAt: true,
    updatedAt: true,
    author: {
      select: { id: true, name: true, username: true, imageUrl: true },
    },
  };

  // Try Atlas Search when search query is present
  if (search && search.trim()) {
    const { searchPostsAtlas } = await import("./search");
    const atlasIds = await searchPostsAtlas(search.trim(), {
      contentType,
      status,
      limit: (page + 1) * pageSize + pageSize, // enough for pagination
    });

    if (atlasIds) {
      // Atlas returned relevance-ordered IDs - fetch full records
      const pagedIds = atlasIds.slice(page * pageSize, (page + 1) * pageSize);
      if (pagedIds.length === 0) return [];

      // MONEY-866: build the where via the SHARED helper so the Atlas (prod) path
      // applies the SAME default ARCHIVED/DELETED exclusion + WRITER scope as the
      // Prisma path — without it, prod search leaked a WRITER's own trash. Search
      // itself is already applied by Atlas (the ids), so it's not re-added here.
      const where = buildPostListWhere(author.role, author.id, {
        status,
        contentType,
        authorId,
      });
      where.id = { in: pagedIds };

      const posts = await prisma.post.findMany({ where, select });

      // Preserve Atlas relevance order
      const postMap = new Map(posts.map((p) => [p.id, p]));
      return pagedIds
        .map((id) => postMap.get(id))
        .filter(Boolean) as PostListType[];
    }
    // Atlas unavailable - fall through to Prisma
  }

  // Prisma fallback
  const where: Record<string, unknown> = {};

  if (status) {
    where.status = status;
  } else {
    where.status = { notIn: ["ARCHIVED", "DELETED"] };
  }

  if (contentType) {
    where.contentType = contentType;
  }

  if (authorId) {
    where.authorId = authorId;
  }

  // Search: title > excerpt > content
  if (search && search.trim()) {
    where.AND = [
      {
        OR: [
          { title: { contains: search.trim(), mode: "insensitive" } },
          { excerpt: { contains: search.trim(), mode: "insensitive" } },
          { content: { contains: search.trim(), mode: "insensitive" } },
        ],
      },
    ];
  }

  if (author.role === "WRITER") {
    const existing = (where.AND as Record<string, unknown>[]) || [];
    where.AND = [
      ...existing,
      { OR: [{ authorId: author.id }, { status: "PUBLISHED" }] },
    ];
  }

  return prisma.post.findMany({
    where,
    select,
    orderBy: { updatedAt: sortOrder },
    skip: buildPaginationSkip(page, pageSize),
    take: pageSize,
  });
}

/**
 * Fetch all posts count with filters.
 * Uses Atlas Search count (prod) or Prisma count (QA/local).
 */
export async function fetchAllPostsCount(
  contentType?: string,
  status?: string,
  search?: string,
  authorId?: string,
): Promise<number> {
  const author = await getAuthenticatedAuthor();
  if (!author) return 0;

  // Try Atlas Search count when search query is present
  if (search && search.trim()) {
    const { searchPostsAtlas } = await import("./search");
    const atlasIds = await searchPostsAtlas(search.trim(), {
      contentType,
      status,
      limit: 500, // upper bound for count
    });
    if (atlasIds) {
      // MONEY-866: do NOT return atlasIds.length — Atlas indexes ALL statuses and
      // applies no WRITER scope, so the raw length leaked the COUNT of other
      // authors' drafts + ARCHIVED/DELETED. Count via Prisma with the same shared
      // scope the list uses.
      if (atlasIds.length === 0) return 0;
      const countWhere = buildPostListWhere(author.role, author.id, {
        status,
        contentType,
        authorId,
      });
      countWhere.id = { in: atlasIds };
      return prisma.post.count({ where: countWhere });
    }
    // Atlas unavailable - fall through to Prisma
  }

  const where: Record<string, unknown> = {};

  if (status) {
    where.status = status;
  } else {
    where.status = { notIn: ["ARCHIVED", "DELETED"] };
  }

  if (contentType) {
    where.contentType = contentType;
  }

  if (authorId) {
    where.authorId = authorId;
  }

  // Prisma fallback: title > excerpt > content
  if (search && search.trim()) {
    where.AND = [
      {
        OR: [
          { title: { contains: search.trim(), mode: "insensitive" } },
          { excerpt: { contains: search.trim(), mode: "insensitive" } },
          { content: { contains: search.trim(), mode: "insensitive" } },
        ],
      },
    ];
  }

  if (author.role === "WRITER") {
    const existing = (where.AND as Record<string, unknown>[]) || [];
    where.AND = [
      ...existing,
      { OR: [{ authorId: author.id }, { status: "PUBLISHED" }] },
    ];
  }

  return prisma.post.count({ where });
}
