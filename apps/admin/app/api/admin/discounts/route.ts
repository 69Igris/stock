import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getDodoClient, isDodoConfigured } from "@usemoney/core";
import { verifyAdminUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET: list the live Dodo-native discounts (read-only — handy for reconciling
// against the local Coupon table).
export async function GET() {
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
    const discounts = [];
    for await (const d of dodo.discounts.list()) {
      discounts.push(d);
    }

    return NextResponse.json({ data: discounts });
  } catch (error) {
    console.error("GET /api/admin/discounts error:", error);
    return NextResponse.json(
      { error: "Failed to fetch discounts" },
      { status: 500 },
    );
  }
}

// POST: DEPRECATED (MONEY-865). This used to create a Dodo-NATIVE discount with
// NO local Coupon row — an orphan the web checkout could never validate
// (validateCouponState finds no local coupon) and the webhook could never record
// a redemption against. The canonical, dual-write path is the `createCoupon`
// server action, which writes BOTH the local Coupon and the linked Dodo
// discount. This endpoint has no callers and is intentionally retired.
export async function POST() {
  return NextResponse.json(
    {
      error:
        "Deprecated. Create coupons via the admin Coupons page (createCoupon server action), which writes both the local Coupon and the linked Dodo discount.",
    },
    { status: 410 },
  );
}
