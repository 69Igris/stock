"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { after } from "next/server";
import {
  prisma,
  PostStatus,
  ContentType,
  ContentRole,
} from "@usemoney/database";
import {
  CreatePostSchema,
  UpdatePostSchema,
  type CreatePostInput,
  type UpdatePostInput,
  type ActionResponse,
} from "@usemoney/validation";
import { revalidatePath } from "next/cache";
import {
  sendNewsletterToIndividuals as sendNewsletterToIndividualsShared,
  routeNewsletterSend as routeNewsletterSendShared,
} from "@usemoney/email";
import { invalidateWebContentCache } from "@/lib/cache/invalidate-web-cache";
import {
  canArchive,
  canModifyPost,
  canPublish,
  canUnpublish,
  determinePublishStatus,
  publishMessage,
  validateResend,
  writerCanViewPost,
  shouldSendBroadcast,
  shouldSendIndividualEmails,
  buildPostUpdateData,
} from "./posts-logic";

// Types for post responses
type PostWithRelations = {
  id: string;
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
  viewCount: number;
  metadataTitle: string | null;
  metadataDescription: string | null;
  metadataImageUrl: string | null;
  metadataKeywords: string | null;
  canonicalUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    name: string | null;
    username: string;
    imageUrl: string | null;
  };
  tags: {
    tag: {
      id: string;
      slug: string;
      name: string;
      color: string | null;
    };
  }[];
};

/**
 * Get the current authenticated author
 * Auto-creates the author record if it doesn't exist yet
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
    // Auto-create author from Clerk user data
    const clerkUser = await currentUser();
    if (!clerkUser) return null;

    const email = clerkUser.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress;
    if (!email) return null;

    // Check if author exists by email
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

      // Ensure unique username
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

/**
 * Create a new post
 */
export async function createPost(
  data: CreatePostInput,
): Promise<ActionResponse<PostWithRelations>> {
  try {
    // Get authenticated author
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    // Validate input
    const validated = CreatePostSchema.parse(data);

    // Check if URL is already taken
    const existingPost = await prisma.post.findUnique({
      where: { postUrl: validated.postUrl },
    });

    if (existingPost) {
      return { success: false, error: "A post with this URL already exists." };
    }

    // Create the post
    const post = await prisma.post.create({
      data: {
        contentType: validated.contentType as ContentType,
        title: validated.title,
        content: validated.content,
        featureImage: validated.featureImage,
        postUrl: validated.postUrl,
        excerpt: validated.excerpt,
        publishDate: validated.publishDate,
        status: validated.status as PostStatus,
        isFeatured: validated.isFeatured,
        isPremium: validated.isPremium,
        authorId: author.id,
        metadataTitle: validated.metadataTitle,
        metadataDescription: validated.metadataDescription,
        metadataImageUrl: validated.metadataImageUrl,
        metadataKeywords: validated.metadataKeywords,
        canonicalUrl: validated.canonicalUrl,
        tags: validated.tagIds
          ? {
              create: validated.tagIds.map((tagId) => ({
                tagId,
              })),
            }
          : undefined,
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            imageUrl: true,
          },
        },
        tags: {
          include: {
            tag: {
              select: {
                id: true,
                slug: true,
                name: true,
                color: true,
              },
            },
          },
        },
      },
    });

    revalidatePath("/posts");
    invalidateWebContentCache({
      action: "create",
      contentType: post.contentType,
      slug: post.postUrl,
    }).catch(() => {});

    return {
      success: true,
      data: post,
      message: "Post created successfully!",
    };
  } catch (error) {
    console.error("Create post error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to create post" };
  }
}

/**
 * Update an existing post
 */
export async function updatePost(
  id: string,
  data: UpdatePostInput,
): Promise<ActionResponse<PostWithRelations>> {
  try {
    // Get authenticated author
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    // Validate input
    const validated = UpdatePostSchema.parse(data);

    // Check if post exists and author has permission
    const existingPost = await prisma.post.findUnique({
      where: { id },
      select: { authorId: true, status: true },
    });

    if (!existingPost) {
      return { success: false, error: "Post not found." };
    }

    // Only allow author or ADMIN/OWNER to edit
    if (!canModifyPost(author.role, existingPost.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to edit this post.",
      };
    }

    // Check if new URL conflicts with another post
    if (validated.postUrl) {
      const urlConflict = await prisma.post.findFirst({
        where: {
          postUrl: validated.postUrl,
          id: { not: id },
        },
      });

      if (urlConflict) {
        return {
          success: false,
          error: "A post with this URL already exists.",
        };
      }
    }

    // Handle tag updates
    if (validated.tagIds !== undefined) {
      // Delete existing tags
      await prisma.tagOnPost.deleteMany({
        where: { postId: id },
      });
    }

    // Update the post
    const post = await prisma.post.update({
      where: { id },
      data: {
        ...buildPostUpdateData(validated),
        ...(validated.publishDate !== undefined && {
          publishDate: validated.publishDate,
        }),
        ...(validated.metadataTitle !== undefined && {
          metadataTitle: validated.metadataTitle,
        }),
        ...(validated.metadataDescription !== undefined && {
          metadataDescription: validated.metadataDescription,
        }),
        ...(validated.metadataImageUrl !== undefined && {
          metadataImageUrl: validated.metadataImageUrl,
        }),
        ...(validated.metadataKeywords !== undefined && {
          metadataKeywords: validated.metadataKeywords,
        }),
        ...(validated.canonicalUrl !== undefined && {
          canonicalUrl: validated.canonicalUrl,
        }),
        ...(validated.tagIds !== undefined && {
          tags: {
            create: validated.tagIds.map((tagId) => ({
              tagId,
            })),
          },
        }),
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            imageUrl: true,
          },
        },
        tags: {
          include: {
            tag: {
              select: {
                id: true,
                slug: true,
                name: true,
                color: true,
              },
            },
          },
        },
      },
    });

    revalidatePath("/posts");
    revalidatePath(`/posts/${post.postUrl}`);
    invalidateWebContentCache({
      action: "update",
      contentType: post.contentType,
      slug: post.postUrl,
    }).catch(() => {});

    return {
      success: true,
      data: post,
      message: "Post updated successfully!",
    };
  } catch (error) {
    console.error("Update post error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to update post" };
  }
}

/**
 * Soft delete a post (sets status to DELETED)
 */
export async function deletePost(id: string): Promise<ActionResponse<void>> {
  try {
    // Get authenticated author
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    // Check if post exists and author has permission
    const existingPost = await prisma.post.findUnique({
      where: { id },
      select: { authorId: true, contentType: true, postUrl: true },
    });

    if (!existingPost) {
      return { success: false, error: "Post not found." };
    }

    // Only allow author or ADMIN/OWNER to delete
    if (!canModifyPost(author.role, existingPost.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to delete this post.",
      };
    }

    // Soft delete by setting status to DELETED
    await prisma.post.update({
      where: { id },
      data: { status: "DELETED" },
    });

    revalidatePath("/posts");
    invalidateWebContentCache({
      action: "delete",
      contentType: existingPost.contentType,
      slug: existingPost.postUrl,
    }).catch(() => {});

    return { success: true, message: "Post deleted successfully!" };
  } catch (error) {
    console.error("Delete post error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to delete post" };
  }
}

/**
 * Archive a post (sets status to ARCHIVED). Recoverable; hidden from active
 * lists but distinct from the soft-DELETE trash state.
 */
export async function archivePost(id: string): Promise<ActionResponse<void>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }
    const existingPost = await prisma.post.findUnique({
      where: { id },
      select: {
        authorId: true,
        contentType: true,
        postUrl: true,
        status: true,
      },
    });
    if (!existingPost) {
      return { success: false, error: "Post not found." };
    }
    if (!canModifyPost(author.role, existingPost.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to archive this post.",
      };
    }
    const archiveGate = canArchive(existingPost.status as PostStatus);
    if (!archiveGate.allowed) {
      return { success: false, error: archiveGate.error };
    }
    await prisma.post.update({
      where: { id },
      data: { status: "ARCHIVED" },
    });
    revalidatePath("/posts");
    invalidateWebContentCache({
      action: "delete",
      contentType: existingPost.contentType,
      slug: existingPost.postUrl,
    }).catch(() => {});
    return { success: true, message: "Post archived successfully!" };
  } catch (error) {
    console.error("Archive post error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to archive post" };
  }
}

/**
 * Publish a post or schedule it for later
 */
export async function publishPost(
  id: string,
  publishDate?: Date,
  segments?: string[],
  individualEmails?: string[],
): Promise<ActionResponse<PostWithRelations>> {
  try {
    // Get authenticated author
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    // Check if post exists and author has permission
    const existingPost = await prisma.post.findUnique({
      where: { id },
      select: { authorId: true, status: true },
    });

    if (!existingPost) {
      return { success: false, error: "Post not found." };
    }

    // Only allow author or ADMIN/OWNER to publish
    if (!canModifyPost(author.role, existingPost.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to publish this post.",
      };
    }

    // Cannot publish a deleted post
    const publishGate = canPublish(existingPost.status as PostStatus);
    if (!publishGate.allowed) {
      return { success: false, error: publishGate.error! };
    }

    // Determine status and publish date
    const now = new Date();
    const finalPublishDate = publishDate || now;
    const status: PostStatus = determinePublishStatus(publishDate);

    // Update the post - persist target audiences for scheduled newsletters
    const post = await prisma.post.update({
      where: { id },
      data: {
        status,
        publishDate: finalPublishDate,
        targetSegments: segments || [],
        targetEmails: individualEmails || [],
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            imageUrl: true,
          },
        },
        tags: {
          include: {
            tag: {
              select: {
                id: true,
                slug: true,
                name: true,
                color: true,
              },
            },
          },
        },
      },
    });

    revalidatePath("/posts");
    revalidatePath(`/posts/${post.postUrl}`);
    invalidateWebContentCache({
      action: "publish",
      contentType: post.contentType,
      slug: post.postUrl,
    }).catch(() => {});

    // If this is a NEWSLETTER being published now, send to selected audiences (fire-and-forget)
    if (post.contentType === "NEWSLETTER" && status === "PUBLISHED") {
      const broadcastParams = {
        title: post.title,
        excerpt: post.excerpt,
        content: post.content,
        postUrl: post.postUrl,
        featureImage: post.featureImage,
        authorName: post.author?.name || undefined,
        authorImageUrl: post.author?.imageUrl || undefined,
        publishDate: post.publishDate?.toISOString(),
      };

      // MONEY-864: defer delivery with after() so Vercel keeps the function alive
      // until the send finishes. Bare fire-and-forget was killed when the action
      // returned — the slower, rate-limited INDIVIDUAL path (500ms between Resend
      // batches) never completed (no logs, no send) while the fast broadcast
      // usually survived. after() runs post-response without that freeze.
      after(async () => {
        // Send to audience segments
        if (shouldSendBroadcast(post.contentType, status, segments)) {
          // MONEY-866: route via the shared entry so the opt-in "newsletter"
          // audience is actually reached — sendNewsletterBroadcast alone silently
          // no-ops on that token, so immediate publishes reached nobody.
          await routeNewsletterSendShared(
            broadcastParams,
            segments!,
            post.id,
          ).catch((err) => console.error("Newsletter delivery error:", err));
        }

        // Send to individual emails
        if (
          shouldSendIndividualEmails(post.contentType, status, individualEmails)
        ) {
          await sendNewsletterToIndividualsShared(
            broadcastParams,
            individualEmails!,
          ).catch((err) =>
            console.error("Individual newsletter delivery error:", err),
          );
        }
      });
    }

    const message = publishMessage(status);

    return { success: true, data: post, message };
  } catch (error) {
    console.error("Publish post error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to publish post" };
  }
}

// Newsletter sending functions are now in @usemoney/email/src/newsletter.ts

/**
 * Resend a published newsletter to selected audience segments.
 * Does NOT change the post status - just re-triggers the email delivery.
 */
export async function resendNewsletter(
  id: string,
  segments: string[],
  individualEmails?: string[],
): Promise<ActionResponse<null>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return { success: false, error: "Unauthorized." };
    }

    const post = await prisma.post.findUnique({
      where: { id },
      include: {
        author: { select: { name: true, imageUrl: true } },
      },
    });
    if (!post) {
      return { success: false, error: "Post not found." };
    }
    const resendCheck = validateResend(
      post.contentType,
      post.status as PostStatus,
      segments,
      individualEmails,
    );
    if (!resendCheck.valid) {
      return { success: false, error: resendCheck.error! };
    }
    const hasSegments = segments && segments.length > 0;
    const hasIndividuals = individualEmails && individualEmails.length > 0;

    const broadcastParams = {
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      postUrl: post.postUrl,
      featureImage: post.featureImage,
      authorName: post.author?.name || undefined,
      authorImageUrl: post.author?.imageUrl || undefined,
      publishDate: post.publishDate?.toISOString(),
    };

    const promises: Promise<unknown>[] = [];

    if (hasSegments) {
      // MONEY-866: route via the shared entry so the "newsletter" audience is
      // reached on resend too (not just the legacy per-tier segments).
      promises.push(
        routeNewsletterSendShared(broadcastParams, segments, post.id),
      );
    }
    if (hasIndividuals) {
      promises.push(
        sendNewsletterToIndividualsShared(broadcastParams, individualEmails),
      );
    }

    await Promise.all(promises);

    return {
      success: true,
      data: null,
      message: "Newsletter resent successfully!",
    };
  } catch (error) {
    console.error("Resend newsletter error:", error);
    return { success: false, error: "Failed to resend newsletter." };
  }
}

/**
 * Unpublish a post (sets back to DRAFT)
 */
export async function unpublishPost(
  id: string,
): Promise<ActionResponse<PostWithRelations>> {
  try {
    // Get authenticated author
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    // Check if post exists and author has permission
    const existingPost = await prisma.post.findUnique({
      where: { id },
      select: { authorId: true, status: true },
    });

    if (!existingPost) {
      return { success: false, error: "Post not found." };
    }

    // Only allow author or ADMIN/OWNER to unpublish
    if (!canModifyPost(author.role, existingPost.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to unpublish this post.",
      };
    }

    // Cannot unpublish a deleted post
    const unpublishGate = canUnpublish(existingPost.status as PostStatus);
    if (!unpublishGate.allowed) {
      return { success: false, error: unpublishGate.error! };
    }

    // Update the post
    const post = await prisma.post.update({
      where: { id },
      data: {
        status: "DRAFT",
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            imageUrl: true,
          },
        },
        tags: {
          include: {
            tag: {
              select: {
                id: true,
                slug: true,
                name: true,
                color: true,
              },
            },
          },
        },
      },
    });

    revalidatePath("/posts");
    revalidatePath(`/posts/${post.postUrl}`);
    invalidateWebContentCache({
      action: "unpublish",
      contentType: post.contentType,
      slug: post.postUrl,
    }).catch(() => {});

    return {
      success: true,
      data: post,
      message: "Post unpublished successfully!",
    };
  } catch (error) {
    console.error("Unpublish post error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to unpublish post" };
  }
}

/**
 * Get a single post by ID
 */
export async function getPostById(
  id: string,
): Promise<ActionResponse<PostWithRelations>> {
  try {
    // Get authenticated author
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const post = await prisma.post.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            imageUrl: true,
          },
        },
        tags: {
          include: {
            tag: {
              select: {
                id: true,
                slug: true,
                name: true,
                color: true,
              },
            },
          },
        },
      },
    });

    if (!post) {
      return { success: false, error: "Post not found." };
    }

    // Writers can only see their own posts or published posts
    if (
      !writerCanViewPost(
        author.role,
        post.authorId,
        author.id,
        post.status as PostStatus,
      )
    ) {
      return {
        success: false,
        error: "You don't have permission to view this post.",
      };
    }

    return { success: true, data: post };
  } catch (error) {
    console.error("Get post by ID error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to get post" };
  }
}
