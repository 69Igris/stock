/**
 * Pure, server-only-free helpers for the posts actions (`posts.ts`).
 *
 * Extracted out of the `"use server"` action module so the permission checks,
 * publish/unpublish gating, publish-status decision, newsletter broadcast
 * conditions, list `where` builder, and the partial update builder can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 * `posts.ts` imports and calls these.
 *
 * SECURITY: `canModifyPost`, `writerCanViewPost`, and the WRITER OR-clause
 * inside `buildPostListWhere` enforce post-level authorization — keep them
 * byte-for-byte identical to the action checks.
 *
 * @see apps/content/__tests__/actions/posts.test.ts
 */

/** Local mirror of the Prisma `PostStatus` enum members (keeps this pure). */
export type PostStatus =
  | "DRAFT"
  | "PUBLISHED"
  | "SCHEDULED"
  | "ARCHIVED"
  | "DELETED";
/** Local mirror of the Prisma `ContentRole` enum members (keeps this pure). */
export type ContentRole = "OWNER" | "ADMIN" | "WRITER";

/**
 * Permission gate: whether an author may modify a post. A WRITER may only
 * modify their own; ADMIN/OWNER may modify all.
 */
export function canModifyPost(
  role: ContentRole,
  postAuthorId: string,
  currentAuthorId: string,
): boolean {
  if (role === "WRITER") return postAuthorId === currentAuthorId;
  return true;
}

/** A future publish date schedules the post; otherwise it publishes now. */
export function determinePublishStatus(publishDate?: Date): PostStatus {
  const now = new Date();
  if (publishDate && publishDate > now) return "SCHEDULED";
  return "PUBLISHED";
}

/** A deleted post cannot be published. */
export function canPublish(currentStatus: PostStatus): {
  allowed: boolean;
  error?: string;
} {
  if (currentStatus === "DELETED") {
    return { allowed: false, error: "Cannot publish a deleted post." };
  }
  return { allowed: true };
}

/** A deleted post cannot be unpublished. */
export function canUnpublish(currentStatus: PostStatus): {
  allowed: boolean;
  error?: string;
} {
  if (currentStatus === "DELETED") {
    return { allowed: false, error: "Cannot unpublish a deleted post." };
  }
  return { allowed: true };
}

/** A deleted (trashed) post cannot be archived — restore it first. */
export function canArchive(currentStatus: PostStatus): {
  allowed: boolean;
  error?: string;
} {
  if (currentStatus === "DELETED") {
    return { allowed: false, error: "Cannot archive a deleted post." };
  }
  return { allowed: true };
}

/** A newsletter broadcast goes out only for a published newsletter w/ segments. */
export function shouldSendBroadcast(
  contentType: string,
  status: PostStatus,
  segments?: string[],
): boolean {
  return (
    contentType === "NEWSLETTER" &&
    status === "PUBLISHED" &&
    !!segments &&
    segments.length > 0
  );
}

/** Individual newsletter emails go out only for a published newsletter w/ emails. */
export function shouldSendIndividualEmails(
  contentType: string,
  status: PostStatus,
  individualEmails?: string[],
): boolean {
  return (
    contentType === "NEWSLETTER" &&
    status === "PUBLISHED" &&
    !!individualEmails &&
    individualEmails.length > 0
  );
}

/**
 * Build the post-list `where`: status (default excludes DELETED), content-type,
 * author, featured/premium, tag, title search, and a WRITER OR-scope (own posts
 * or published).
 */
export function buildPostListWhere(
  role: ContentRole,
  authorId: string,
  filter: {
    status?: string;
    contentType?: string;
    authorId?: string;
    isFeatured?: boolean;
    isPremium?: boolean;
    tagSlug?: string;
    search?: string;
  },
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    // MONEY-865: ARCHIVED + DELETED are both "removed from active" — hide both
    // from the default list. The status dropdown's explicit Archived/Deleted
    // filters still surface them on demand.
    status: filter.status || { notIn: ["ARCHIVED", "DELETED"] },
  };

  if (filter.contentType) where.contentType = filter.contentType;
  if (filter.authorId) where.authorId = filter.authorId;
  if (filter.isFeatured !== undefined) where.isFeatured = filter.isFeatured;
  if (filter.isPremium !== undefined) where.isPremium = filter.isPremium;
  if (filter.tagSlug) {
    where.tags = { some: { tag: { slug: filter.tagSlug } } };
  }
  if (filter.search) {
    where.title = { contains: filter.search, mode: "insensitive" };
  }

  // Writers can only see their own posts or published posts
  if (role === "WRITER") {
    where.OR = [{ authorId }, { status: "PUBLISHED" }];
  }

  return where;
}

/**
 * Whether a WRITER may view a single post (own post or published); other roles
 * may view all.
 */
export function writerCanViewPost(
  role: ContentRole,
  postAuthorId: string,
  currentAuthorId: string,
  postStatus: PostStatus,
): boolean {
  if (role === "WRITER") {
    return postAuthorId === currentAuthorId || postStatus === "PUBLISHED";
  }
  return true;
}

/**
 * Validate a newsletter resend: must be a published newsletter with at least
 * one audience segment or individual email.
 */
export function validateResend(
  contentType: string,
  status: PostStatus,
  segments?: string[],
  individualEmails?: string[],
): { valid: boolean; error?: string } {
  if (contentType !== "NEWSLETTER") {
    return { valid: false, error: "Post is not a newsletter." };
  }
  if (status !== "PUBLISHED") {
    return { valid: false, error: "Newsletter must be published first." };
  }
  const hasSegments = !!segments && segments.length > 0;
  const hasIndividuals = !!individualEmails && individualEmails.length > 0;
  if (!hasSegments && !hasIndividuals) {
    return {
      valid: false,
      error: "Select at least one audience or individual email.",
    };
  }
  return { valid: true };
}

/** Success message for a publish (scheduled vs published). */
export function publishMessage(status: PostStatus): string {
  return status === "SCHEDULED"
    ? "Post scheduled successfully!"
    : "Post published successfully!";
}

/**
 * Build the partial post-update payload: only truthy title/content/postUrl/
 * status, and explicitly-provided featureImage/excerpt/isFeatured/isPremium
 * (including null / false).
 */
export function buildPostUpdateData(validated: {
  title?: string;
  content?: string;
  featureImage?: string | null;
  postUrl?: string;
  excerpt?: string | null;
  status?: string;
  isFeatured?: boolean;
  isPremium?: boolean;
  contentType?: string;
}): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (validated.title) data.title = validated.title;
  if (validated.content) data.content = validated.content;
  if (validated.featureImage !== undefined)
    data.featureImage = validated.featureImage;
  if (validated.postUrl) data.postUrl = validated.postUrl;
  if (validated.excerpt !== undefined) data.excerpt = validated.excerpt;
  if (validated.status) data.status = validated.status;
  if (validated.isFeatured !== undefined)
    data.isFeatured = validated.isFeatured;
  if (validated.isPremium !== undefined) data.isPremium = validated.isPremium;
  // MONEY-864: allow converting a post's type (e.g. BLOG → NEWSLETTER). Without
  // this the editor's contentType selector never persisted, so the newsletter
  // send (gated on contentType === "NEWSLETTER") never fired.
  if (validated.contentType) data.contentType = validated.contentType;
  return data;
}
