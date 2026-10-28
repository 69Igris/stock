import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  _request: NextRequest,
  props: { params: Promise<{ token: string }> }
) {
  const params = await props.params;
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const invite = await prisma.inviteToken.findUnique({
      where: { token: params.token },
    });

    if (!invite) {
      return NextResponse.json(
        { error: "Invalid invite token" },
        { status: 404 }
      );
    }

    // Validate
    if (!invite.isActive) {
      return NextResponse.json(
        { error: "This invite is no longer active" },
        { status: 410 }
      );
    }

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "This invite has expired" },
        { status: 410 }
      );
    }

    if (invite.maxUses !== -1 && invite.usedCount >= invite.maxUses) {
      return NextResponse.json(
        { error: "This invite has reached its usage limit" },
        { status: 410 }
      );
    }

    // Check assignedTo restriction
    if (invite.assignedTo) {
      const clerkUser = await currentUser();
      const email = clerkUser?.emailAddresses?.[0]?.emailAddress?.toLowerCase();
      if (email !== invite.assignedTo.toLowerCase()) {
        return NextResponse.json(
          { error: "This invite is assigned to a different user" },
          { status: 403 }
        );
      }
    }

    // Check if user already redeemed
    const user = await prisma.user.findFirst({
      where: {
        email: {
          in:
            (await currentUser())?.emailAddresses.map((e) => e.emailAddress) ||
            [],
        },
      },
    });

    if (user && invite.usedBy.includes(user.id)) {
      return NextResponse.json(
        { error: "You have already used this invite" },
        { status: 409 }
      );
    }

    // Redeem: increment usedCount, add to usedBy
    await prisma.inviteToken.update({
      where: { id: invite.id },
      data: {
        usedCount: { increment: 1 },
        usedBy: { push: user?.id || clerkUserId },
      },
    });

    return NextResponse.json({
      planId: invite.planId,
      discountCode: invite.discountCode,
    });
  } catch (error) {
    console.error("Invite redeem error:", error);
    return NextResponse.json(
      { error: "Failed to redeem invite" },
      { status: 500 }
    );
  }
}
