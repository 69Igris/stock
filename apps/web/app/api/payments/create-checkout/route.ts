import { NextResponse } from "next/server";

// MONEY-872: DEPRECATED & REMOVED. This was the pre-MONEY-865 checkout path — it
// charged the STALE plan-config price (₹999 for PRO/PREMIUM) via `tradebook_<plan>`
// product ids, with no coupon, billing-period, core PLAN_CONFIG, or product
// auto-sync. It has ZERO source callers (the live flow is `createCheckoutAction`).
// Left as a hard 410 so any forgotten/cached client gets a clear error instead of a
// wrong ₹999 charge.
export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error:
        "This checkout endpoint has been removed. Please use the in-app plan checkout.",
    },
    { status: 410 }
  );
}
