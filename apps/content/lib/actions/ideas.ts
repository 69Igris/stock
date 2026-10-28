"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma, IdeaStatus, IdeaStage, ContentRole } from "@usemoney/database";
import {
  CreateIdeaSchema,
  UpdateIdeaSchema,
  type CreateIdeaInput,
  type UpdateIdeaValidationInput,
  type ActionResponse,
} from "@usemoney/validation";
import { revalidatePath } from "next/cache";
import {
  titleToSlug,
  generateUsernameBase,
  usernameWithCounter,
  canAccessResource,
  buildIdeaListWhere,
} from "./ideas-logic";

export type IdeaWithAuthor = {
  id: string;
  title: string;
  description: string | null;
  topics: string[];
  status: string;
  currentStage: string;
  generatedOutline: string | null;
  outlineContent: string | null;
  scriptContent: string | null;
  targetDate: Date | null;
  createdPostId: string | null;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    name: string | null;
    username: string;
    email: string;
    imageUrl: string | null;
  };
};

async function getAuthenticatedAuthor() {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

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
      let username = generateUsernameBase(name, email);

      let counter = 1;
      while (
        await prisma.contentAuthor.findUnique({
          where: { username },
          select: { id: true },
        })
      ) {
        username = usernameWithCounter(username, counter);
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

export async function createIdea(
  data: CreateIdeaInput,
): Promise<ActionResponse<IdeaWithAuthor>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const validated = CreateIdeaSchema.parse(data);

    const idea = await prisma.idea.create({
      data: {
        title: validated.title,
        description: validated.description || null,
        topics: validated.topics || [],
        targetDate: validated.targetDate || null,
        authorId: author.id,
        status: "NEW",
        currentStage: "ROUGH_IDEA",
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            imageUrl: true,
          },
        },
      },
    });

    revalidatePath("/ideas");
    return { success: true, data: idea, message: "Idea created successfully!" };
  } catch (error) {
    console.error("Create idea error:", error);
    if (error instanceof Error) return { success: false, error: error.message };
    return { success: false, error: "Failed to create idea" };
  }
}

export async function listIdeas(
  status?: string,
): Promise<ActionResponse<IdeaWithAuthor[]>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const where = buildIdeaListWhere(author.role, author.id, status);

    const ideas = await prisma.idea.findMany({
      where,
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            imageUrl: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return { success: true, data: ideas };
  } catch (error) {
    console.error("List ideas error:", error);
    if (error instanceof Error) return { success: false, error: error.message };
    return { success: false, error: "Failed to list ideas" };
  }
}

export async function getIdeaById(
  id: string,
): Promise<ActionResponse<IdeaWithAuthor>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const idea = await prisma.idea.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            imageUrl: true,
          },
        },
      },
    });

    if (!idea) return { success: false, error: "Idea not found." };
    if (!canAccessResource(author.role, idea.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to view this idea.",
      };
    }

    return { success: true, data: idea };
  } catch (error) {
    console.error("Get idea by ID error:", error);
    if (error instanceof Error) return { success: false, error: error.message };
    return { success: false, error: "Failed to get idea" };
  }
}

export async function updateIdea(
  id: string,
  data: UpdateIdeaValidationInput,
): Promise<ActionResponse<IdeaWithAuthor>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const validated = UpdateIdeaSchema.parse(data);

    const existingIdea = await prisma.idea.findUnique({
      where: { id },
      select: { authorId: true },
    });

    if (!existingIdea) return { success: false, error: "Idea not found." };
    if (!canAccessResource(author.role, existingIdea.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to edit this idea.",
      };
    }

    const idea = await prisma.idea.update({
      where: { id },
      data: {
        ...(validated.title !== undefined && { title: validated.title }),
        ...(validated.description !== undefined && {
          description: validated.description,
        }),
        ...(validated.topics !== undefined && { topics: validated.topics }),
        ...(validated.status !== undefined && {
          status: validated.status as IdeaStatus,
        }),
        ...(validated.currentStage !== undefined && {
          currentStage: validated.currentStage as IdeaStage,
        }),
        ...(validated.generatedOutline !== undefined && {
          generatedOutline: validated.generatedOutline,
        }),
        ...(validated.outlineContent !== undefined && {
          outlineContent: validated.outlineContent,
        }),
        ...(validated.scriptContent !== undefined && {
          scriptContent: validated.scriptContent,
        }),
        ...(validated.targetDate !== undefined && {
          targetDate: validated.targetDate,
        }),
      },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            imageUrl: true,
          },
        },
      },
    });

    revalidatePath("/ideas");
    revalidatePath(`/ideas/${id}`);
    return { success: true, data: idea, message: "Idea updated successfully!" };
  } catch (error) {
    console.error("Update idea error:", error);
    if (error instanceof Error) return { success: false, error: error.message };
    return { success: false, error: "Failed to update idea" };
  }
}

export async function deleteIdea(id: string): Promise<ActionResponse<void>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const existingIdea = await prisma.idea.findUnique({
      where: { id },
      select: { authorId: true },
    });

    if (!existingIdea) return { success: false, error: "Idea not found." };
    if (!canAccessResource(author.role, existingIdea.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to delete this idea.",
      };
    }

    await prisma.idea.delete({ where: { id } });
    revalidatePath("/ideas");
    return { success: true, message: "Idea deleted successfully!" };
  } catch (error) {
    console.error("Delete idea error:", error);
    if (error instanceof Error) return { success: false, error: error.message };
    return { success: false, error: "Failed to delete idea" };
  }
}

export async function convertIdeaToDraft(
  ideaId: string,
  content: string,
): Promise<ActionResponse<{ postId: string }>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const idea = await prisma.idea.findUnique({ where: { id: ideaId } });
    if (!idea) return { success: false, error: "Idea not found." };
    if (!canAccessResource(author.role, idea.authorId, author.id)) {
      return {
        success: false,
        error: "You don't have permission to convert this idea.",
      };
    }

    const postUrl = titleToSlug(idea.title);

    const uniquePostUrl = `${postUrl}-${Date.now()}`;

    const post = await prisma.post.create({
      data: {
        title: idea.title,
        content,
        postUrl: uniquePostUrl,
        authorId: author.id,
        status: "DRAFT",
        excerpt: idea.description || "",
      },
    });

    await prisma.idea.update({
      where: { id: ideaId },
      data: { status: "DRAFT_CREATED", createdPostId: post.id },
    });

    revalidatePath("/ideas");
    revalidatePath("/posts");
    return {
      success: true,
      data: { postId: post.id },
      message: "Idea converted to draft!",
    };
  } catch (error) {
    console.error("Convert idea to draft error:", error);
    if (error instanceof Error) return { success: false, error: error.message };
    return { success: false, error: "Failed to convert idea to draft" };
  }
}

export async function getIdeasCount(
  status?: string,
): Promise<ActionResponse<number>> {
  try {
    const author = await getAuthenticatedAuthor();
    if (!author) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    const where = buildIdeaListWhere(author.role, author.id, status);

    const count = await prisma.idea.count({ where });
    return { success: true, data: count };
  } catch (error) {
    console.error("Get ideas count error:", error);
    if (error instanceof Error) return { success: false, error: error.message };
    return { success: false, error: "Failed to get ideas count" };
  }
}
