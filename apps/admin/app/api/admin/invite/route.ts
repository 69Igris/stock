import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { verifyAdminUserId } from "@/lib/auth";
import {
  validateInviteEmail,
  buildInviteResponse,
} from "@/lib/actions/invite-logic";

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify the requesting user is an admin (role OR ADMIN_EMAILS allowlist).
    if (!(await verifyAdminUserId(userId))) {
      return NextResponse.json(
        { error: "Forbidden - admin role required" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { email } = body;

    const emailError = validateInviteEmail({ email });
    if (emailError) {
      return NextResponse.json({ error: emailError }, { status: 400 });
    }

    const client = await clerkClient();

    // Check if user already exists in Clerk
    const existingUsers = await client.users.getUserList({
      emailAddress: [email],
    });

    if (existingUsers.data.length > 0) {
      // User exists, update their publicMetadata to add admin role
      const existingUser = existingUsers.data[0];
      await client.users.updateUser(existingUser.id, {
        publicMetadata: {
          ...existingUser.publicMetadata,
          role: "admin",
        },
      });

      return NextResponse.json(
        buildInviteResponse(email, existingUsers.data.length),
      );
    }

    // User doesn't exist - create an invitation
    // Note: This requires Clerk Pro plan for invitations
    // For now, we'll just return a message about manual setup
    return NextResponse.json(buildInviteResponse(email, 0));
  } catch (error) {
    console.error("Invite admin error:", error);
    return NextResponse.json(
      { error: "Failed to invite admin" },
      { status: 500 },
    );
  }
}
