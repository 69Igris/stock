"use server";

import { auth } from "@clerk/nextjs/server";
import { prisma } from "@usemoney/database";
import {
  CreateTagSchema,
  UpdateTagSchema,
  type CreateTagInput,
  type UpdateTagInput,
  type ActionResponse,
} from "@usemoney/validation";
import { revalidatePath } from "next/cache";

// Types for tag responses
type TagWithPostCount = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count: {
    posts: number;
  };
};

type Tag = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Get the current authenticated author
 * Returns null if not authenticated or not an author
 */
async function getAuthenticatedAuthor() {
  const { userId: clerkId } = await auth();

  if (!clerkId) {
    return null;
  }

  const author = await prisma.contentAuthor.findUnique({
    where: { clerkId },
    select: { id: true, role: true, clerkId: true },
  });

  return author;
}

/**
 * Check if user has permission to manage tags
 * Only ADMIN and OWNER can manage tags
 */
async function canManageTags(): Promise<boolean> {
  const author = await getAuthenticatedAuthor();
  if (!author) return false;
  return author.role === "ADMIN" || author.role === "OWNER";
}

/**
 * Create a new tag
 */
export async function createTag(
  data: CreateTagInput,
): Promise<ActionResponse<Tag>> {
  try {
    // Check permissions
    const hasPermission = await canManageTags();
    if (!hasPermission) {
      return {
        success: false,
        error: "Unauthorized. Only admins can manage tags.",
      };
    }

    // Validate input
    const validated = CreateTagSchema.parse(data);

    // Check if slug is already taken
    const existingTag = await prisma.tag.findUnique({
      where: { slug: validated.slug },
    });

    if (existingTag) {
      return { success: false, error: "A tag with this slug already exists." };
    }

    // Create the tag
    const tag = await prisma.tag.create({
      data: {
        slug: validated.slug,
        name: validated.name,
        description: validated.description,
        color: validated.color,
        imageUrl: validated.imageUrl,
      },
    });

    revalidatePath("/tags");

    return {
      success: true,
      data: tag,
      message: "Tag created successfully!",
    };
  } catch (error) {
    console.error("Create tag error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to create tag" };
  }
}

/**
 * Update an existing tag
 */
export async function updateTag(
  id: string,
  data: UpdateTagInput,
): Promise<ActionResponse<Tag>> {
  try {
    // Check permissions
    const hasPermission = await canManageTags();
    if (!hasPermission) {
      return {
        success: false,
        error: "Unauthorized. Only admins can manage tags.",
      };
    }

    // Validate input
    const validated = UpdateTagSchema.parse(data);

    // Check if tag exists
    const existingTag = await prisma.tag.findUnique({
      where: { id },
    });

    if (!existingTag) {
      return { success: false, error: "Tag not found." };
    }

    // Check if new slug conflicts with another tag
    if (validated.slug && validated.slug !== existingTag.slug) {
      const slugConflict = await prisma.tag.findFirst({
        where: {
          slug: validated.slug,
          id: { not: id },
        },
      });

      if (slugConflict) {
        return {
          success: false,
          error: "A tag with this slug already exists.",
        };
      }
    }

    // Update the tag
    const tag = await prisma.tag.update({
      where: { id },
      data: {
        ...(validated.slug && { slug: validated.slug }),
        ...(validated.name && { name: validated.name }),
        ...(validated.description !== undefined && {
          description: validated.description,
        }),
        ...(validated.color !== undefined && { color: validated.color }),
        ...(validated.imageUrl !== undefined && {
          imageUrl: validated.imageUrl,
        }),
      },
    });

    revalidatePath("/tags");

    return {
      success: true,
      data: tag,
      message: "Tag updated successfully!",
    };
  } catch (error) {
    console.error("Update tag error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to update tag" };
  }
}

/**
 * Delete a tag
 * Only allowed if no posts are using this tag
 */
export async function deleteTag(id: string): Promise<ActionResponse<void>> {
  try {
    // Check permissions
    const hasPermission = await canManageTags();
    if (!hasPermission) {
      return {
        success: false,
        error: "Unauthorized. Only admins can manage tags.",
      };
    }

    // Check if tag exists
    const existingTag = await prisma.tag.findUnique({
      where: { id },
      include: {
        _count: {
          select: { posts: true },
        },
      },
    });

    if (!existingTag) {
      return { success: false, error: "Tag not found." };
    }

    // Check if tag is in use
    if (existingTag._count.posts > 0) {
      return {
        success: false,
        error: `Cannot delete tag. It is used by ${existingTag._count.posts} post(s). Remove the tag from all posts first.`,
      };
    }

    // Delete the tag
    await prisma.tag.delete({
      where: { id },
    });

    revalidatePath("/tags");

    return { success: true, message: "Tag deleted successfully!" };
  } catch (error) {
    console.error("Delete tag error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to delete tag" };
  }
}

/**
 * Get a tag by slug
 */
export async function getTagBySlug(
  slug: string,
): Promise<ActionResponse<TagWithPostCount>> {
  try {
    // No auth required for reading tags
    const tag = await prisma.tag.findUnique({
      where: { slug },
      include: {
        _count: {
          select: { posts: true },
        },
      },
    });

    if (!tag) {
      return { success: false, error: "Tag not found." };
    }

    return { success: true, data: tag };
  } catch (error) {
    console.error("Get tag by slug error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to get tag" };
  }
}

/**
 * List all tags with post counts
 */
export async function listTags(): Promise<ActionResponse<TagWithPostCount[]>> {
  try {
    // No auth required for reading tags
    const tags = await prisma.tag.findMany({
      include: {
        _count: {
          select: { posts: true },
        },
      },
      orderBy: { name: "asc" },
    });

    return { success: true, data: tags };
  } catch (error) {
    console.error("List tags error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to list tags" };
  }
}
