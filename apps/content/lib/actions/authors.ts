"use server";

import { auth, currentUser, clerkClient } from "@clerk/nextjs/server";
import { prisma, ContentRole, InviteStatus } from "@usemoney/database";
import { ContentRoleEnum, type ActionResponse } from "@usemoney/validation";
import { revalidatePath } from "next/cache";
import { sendEmail } from "@usemoney/email";
import { AuthorRoleChangedEmail } from "@usemoney/email/templates";
import React from "react";
import {
  generateUsernameBase,
  usernameWithCounter,
  determineNewAuthorRole,
  canChangeRoles,
  canSelfDemote,
  buildClerkName,
  checkInviteEligibility,
  canRevokeInvite,
  buildProfileUpdateData,
} from "./authors-logic";

// Types for author responses
type Author = {
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

type AuthorWithPostCount = Author & {
  _count: {
    posts: number;
  };
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
 * Generate a unique username from email or name
 */
async function generateUniqueUsername(
  email: string,
  name?: string | null,
): Promise<string> {
  // Start with email prefix or name
  const baseUsername = generateUsernameBase(email, name);

  // Check if username exists
  let username = baseUsername;
  let counter = 1;

  while (true) {
    const existing = await prisma.contentAuthor.findUnique({
      where: { username },
      select: { id: true },
    });

    if (!existing) {
      break;
    }

    username = usernameWithCounter(baseUsername, counter);
    counter++;
  }

  return username;
}

/**
 * Get or create an author from Clerk user ID
 * This is called during authentication to ensure the author record exists
 */
export async function getOrCreateAuthor(
  clerkId: string,
): Promise<ActionResponse<Author>> {
  try {
    // Check if author already exists
    let author = await prisma.contentAuthor.findUnique({
      where: { clerkId },
    });

    if (author) {
      return { success: true, data: author };
    }

    // Author doesn't exist, get Clerk user data to create one
    const clerkUser = await currentUser();

    if (!clerkUser || clerkUser.id !== clerkId) {
      return { success: false, error: "Unable to verify user identity." };
    }

    // Get email from Clerk user
    const email = clerkUser.emailAddresses.find(
      (e) => e.id === clerkUser.primaryEmailAddressId,
    )?.emailAddress;

    if (!email) {
      return { success: false, error: "No email address found for user." };
    }

    // Check if there's already an author with this email (edge case)
    const existingByEmail = await prisma.contentAuthor.findUnique({
      where: { email },
    });

    if (existingByEmail) {
      // Update the existing author with the new clerkId
      author = await prisma.contentAuthor.update({
        where: { email },
        data: { clerkId },
      });
      return { success: true, data: author };
    }

    // Generate a unique username
    const name = buildClerkName(clerkUser.firstName, clerkUser.lastName);
    const username = await generateUniqueUsername(email, name);

    // Determine role: check for pending invite, first author = OWNER, else WRITER
    const authorCount = await prisma.contentAuthor.count();

    // Check if there's a pending invite for this email
    const pendingInvite = await prisma.contentInvite.findFirst({
      where: { email, status: "PENDING" },
    });
    const role: ContentRole = determineNewAuthorRole(
      authorCount,
      pendingInvite?.role,
    );
    if (pendingInvite) {
      await prisma.contentInvite.update({
        where: { id: pendingInvite.id },
        data: { status: "ACCEPTED" },
      });
    }

    author = await prisma.contentAuthor.create({
      data: {
        clerkId,
        email,
        name,
        username,
        imageUrl: clerkUser.imageUrl,
        role,
      },
    });

    return {
      success: true,
      data: author,
      message: "Author profile created successfully!",
    };
  } catch (error) {
    console.error("Get or create author error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to get or create author" };
  }
}

/**
 * Update an author's role
 * Only OWNER can change roles
 */
export async function updateAuthorRole(
  id: string,
  role: "ADMIN" | "OWNER" | "WRITER",
): Promise<ActionResponse<Author>> {
  try {
    // Validate role
    const validatedRole = ContentRoleEnum.parse(role);

    // Get authenticated author
    const currentAuthor = await getAuthenticatedAuthor();
    if (!currentAuthor) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    // Only OWNER can change roles
    if (!canChangeRoles(currentAuthor.role)) {
      return {
        success: false,
        error: "Unauthorized. Only the owner can change author roles.",
      };
    }

    // Check if target author exists
    const targetAuthor = await prisma.contentAuthor.findUnique({
      where: { id },
    });

    if (!targetAuthor) {
      return { success: false, error: "Author not found." };
    }

    // Prevent owner from demoting themselves if they're the only owner
    if (targetAuthor.id === currentAuthor.id && validatedRole !== "OWNER") {
      const ownerCount = await prisma.contentAuthor.count({
        where: { role: "OWNER" },
      });

      const demote = canSelfDemote(
        targetAuthor.id,
        currentAuthor.id,
        validatedRole,
        ownerCount,
      );
      if (!demote.allowed) {
        return { success: false, error: demote.error! };
      }
    }

    // Update the role
    const author = await prisma.contentAuthor.update({
      where: { id },
      data: { role: validatedRole as ContentRole },
    });

    revalidatePath("/members");

    // Send role change notification email (fire-and-forget)
    sendEmail({
      to: author.email,
      subject: "Your UseMoney CMS role has been updated",
      react: React.createElement(AuthorRoleChangedEmail, {
        name: author.name || author.username,
        newRole: validatedRole,
      }),
      template: "author-role-changed",
    });

    return {
      success: true,
      data: author,
      message: "Author role updated successfully!",
    };
  } catch (error) {
    console.error("Update author role error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to update author role" };
  }
}

/**
 * Get an author by Clerk ID
 */
export async function getAuthorByClerkId(
  clerkId: string,
): Promise<ActionResponse<Author>> {
  try {
    const author = await prisma.contentAuthor.findUnique({
      where: { clerkId },
    });

    if (!author) {
      return { success: false, error: "Author not found." };
    }

    return { success: true, data: author };
  } catch (error) {
    console.error("Get author by Clerk ID error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to get author" };
  }
}

/**
 * Get the current authenticated author's profile
 */
export async function getCurrentAuthor(): Promise<
  ActionResponse<AuthorWithPostCount>
> {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const author = await prisma.contentAuthor.findUnique({
      where: { clerkId },
      include: {
        _count: {
          select: { posts: true },
        },
      },
    });

    if (!author) {
      return {
        success: false,
        error: "Author profile not found. Please contact support.",
      };
    }

    return { success: true, data: author };
  } catch (error) {
    console.error("Get current author error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to get author profile" };
  }
}

/**
 * List all authors (for admin use)
 */
export async function listAuthors(): Promise<
  ActionResponse<AuthorWithPostCount[]>
> {
  try {
    // Get authenticated author
    const currentAuthor = await getAuthenticatedAuthor();
    if (!currentAuthor) {
      return {
        success: false,
        error: "Unauthorized. You must be a content author.",
      };
    }

    // Only ADMIN and OWNER can list all authors
    if (currentAuthor.role === "WRITER") {
      return {
        success: false,
        error: "Unauthorized. Only admins can view all authors.",
      };
    }

    const authors = await prisma.contentAuthor.findMany({
      include: {
        _count: {
          select: { posts: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return { success: true, data: authors };
  } catch (error) {
    console.error("List authors error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to list authors" };
  }
}

/**
 * Update the current author's profile
 */
export async function updateAuthorProfile(data: {
  name?: string;
  imageUrl?: string;
}): Promise<ActionResponse<Author>> {
  try {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
      return { success: false, error: "Unauthorized. Please sign in." };
    }

    const author = await prisma.contentAuthor.findUnique({
      where: { clerkId },
    });

    if (!author) {
      return { success: false, error: "Author profile not found." };
    }

    const updatedAuthor = await prisma.contentAuthor.update({
      where: { clerkId },
      data: buildProfileUpdateData(data),
    });

    revalidatePath("/profile");

    return {
      success: true,
      data: updatedAuthor,
      message: "Profile updated successfully!",
    };
  } catch (error) {
    console.error("Update author profile error:", error);
    if (error instanceof Error) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to update profile" };
  }
}

// ---------------------------------------------------------------------------
// Invite management
// ---------------------------------------------------------------------------

type ContentInviteData = {
  id: string;
  email: string;
  role: string;
  invitedBy: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
};

/**
 * Invite a new author by email. Creates a ContentInvite and sets Clerk
 * publicMetadata so the middleware allows access on first login.
 * Only OWNER or ADMIN can invite.
 */
export async function inviteAuthor(
  email: string,
  role: "ADMIN" | "WRITER",
): Promise<ActionResponse<ContentInviteData>> {
  try {
    const currentAuthor = await getAuthenticatedAuthor();
    if (!currentAuthor) {
      return { success: false, error: "Unauthorized" };
    }

    const eligibility = checkInviteEligibility(currentAuthor.role);
    if (!eligibility.allowed) {
      return { success: false, error: eligibility.error! };
    }

    // Validate role
    const validatedRole = ContentRoleEnum.parse(role);

    // Check if email is already an author
    const existingAuthor = await prisma.contentAuthor.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingAuthor) {
      return { success: false, error: "This email is already a member" };
    }

    // Check for existing pending invite
    const existingInvite = await prisma.contentInvite.findFirst({
      where: {
        email: email.toLowerCase(),
        status: "PENDING",
      },
    });

    if (existingInvite) {
      return {
        success: false,
        error: "An invite is already pending for this email",
      };
    }

    // Create invite (expires in 7 days)
    const invite = await prisma.contentInvite.create({
      data: {
        email: email.toLowerCase(),
        role: validatedRole as ContentRole,
        invitedBy: currentAuthor.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    // Try to find the user in Clerk and set publicMetadata
    try {
      const client = await clerkClient();
      const users = await client.users.getUserList({
        emailAddress: [email.toLowerCase()],
      });

      const user = users.data[0];
      if (user) {
        await client.users.updateUserMetadata(user.id, {
          publicMetadata: {
            ...(user.publicMetadata || {}),
            content_role: validatedRole,
          },
        });
      }
    } catch (err) {
      // Clerk API call is best-effort
      console.error("Failed to set Clerk metadata for invite:", err);
    }

    revalidatePath("/members");

    return {
      success: true,
      data: invite,
      message: `Invite sent to ${email}`,
    };
  } catch (error) {
    console.error("Invite author error:", error);
    return { success: false, error: "Failed to send invite" };
  }
}

/**
 * List all pending invites.
 */
export async function listInvites(): Promise<
  ActionResponse<ContentInviteData[]>
> {
  try {
    const currentAuthor = await getAuthenticatedAuthor();
    if (!currentAuthor) {
      return { success: false, error: "Unauthorized" };
    }

    if (currentAuthor.role !== "OWNER" && currentAuthor.role !== "ADMIN") {
      return {
        success: false,
        error: "Only owners and admins can view invites",
      };
    }

    // Auto-expire old invites
    await prisma.contentInvite.updateMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: new Date() },
      },
      data: { status: "EXPIRED" },
    });

    const invites = await prisma.contentInvite.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "desc" },
    });

    return { success: true, data: invites };
  } catch (error) {
    console.error("List invites error:", error);
    return { success: false, error: "Failed to list invites" };
  }
}

/**
 * Revoke a pending invite.
 */
export async function revokeInvite(
  inviteId: string,
): Promise<ActionResponse<void>> {
  try {
    const currentAuthor = await getAuthenticatedAuthor();
    if (!currentAuthor) {
      return { success: false, error: "Unauthorized" };
    }

    if (currentAuthor.role !== "OWNER" && currentAuthor.role !== "ADMIN") {
      return {
        success: false,
        error: "Only owners and admins can revoke invites",
      };
    }

    const invite = await prisma.contentInvite.findUnique({
      where: { id: inviteId },
    });

    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    const revoke = canRevokeInvite(invite.status);
    if (!revoke.allowed) {
      return { success: false, error: revoke.error! };
    }

    await prisma.contentInvite.update({
      where: { id: inviteId },
      data: { status: "REVOKED" },
    });

    // Remove Clerk publicMetadata if user exists
    try {
      const client = await clerkClient();
      const users = await client.users.getUserList({
        emailAddress: [invite.email],
      });

      const user = users.data[0];
      if (user) {
        const metadata = { ...(user.publicMetadata || {}) } as Record<
          string,
          unknown
        >;
        delete metadata.content_role;
        await client.users.updateUserMetadata(user.id, {
          publicMetadata: metadata,
        });
      }
    } catch (err) {
      console.error("Failed to remove Clerk metadata for revoked invite:", err);
    }

    revalidatePath("/members");

    return { success: true, message: "Invite revoked" };
  } catch (error) {
    console.error("Revoke invite error:", error);
    return { success: false, error: "Failed to revoke invite" };
  }
}
