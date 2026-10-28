import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { verifyAdminUserId } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { nanoid } from "nanoid";
import type { PlanType } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await verifyAdminUserId(userId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const tokens = await prisma.inviteToken.findMany({
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ data: tokens });
  } catch (error) {
    console.error("GET /api/admin/invites error:", error);
    return NextResponse.json(
      { error: "Failed to fetch invite tokens" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await verifyAdminUserId(userId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { planId, maxUses, assignedTo, expiresAt, discountId, discountCode } =
      body;

    if (!planId || !maxUses) {
      return NextResponse.json(
        { error: "planId and maxUses are required" },
        { status: 400 },
      );
    }

    const token = await prisma.inviteToken.create({
      data: {
        token: nanoid(12),
        planId: planId as PlanType,
        maxUses,
        assignedTo: assignedTo || null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        discountId: discountId || null,
        discountCode: discountCode || null,
        createdBy: userId,
      },
    });

    return NextResponse.json({ data: token }, { status: 201 });
  } catch (error) {
    console.error("POST /api/admin/invites error:", error);
    return NextResponse.json(
      { error: "Failed to create invite token" },
      { status: 500 },
    );
  }
}
