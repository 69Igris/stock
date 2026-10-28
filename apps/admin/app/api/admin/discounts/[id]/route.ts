import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { verifyAdminUserId } from "@/lib/auth";
import { getDodoClient, isDodoConfigured } from "@usemoney/core";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const params = await props.params;
  try {
    const { userId } = await auth();
    if (!userId)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await verifyAdminUserId(userId))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isDodoConfigured()) {
      return NextResponse.json(
        { error: "Dodo Payments not configured" },
        { status: 503 },
      );
    }

    const dodo = getDodoClient();
    await dodo.discounts.delete(params.id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/admin/discounts/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to delete discount" },
      { status: 500 },
    );
  }
}
