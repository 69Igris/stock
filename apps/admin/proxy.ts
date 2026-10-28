import {
  clerkMiddleware,
  createRouteMatcher,
  clerkClient,
} from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isUserAdmin, parseAdminEmails } from "@/lib/admin-auth-logic";

// Admin emails from environment variable (comma-separated, lowercase for comparison)
const ADMIN_EMAILS = parseAdminEmails(process.env.ADMIN_EMAILS);

const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  // Allow public routes (sign-in, sign-up)
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.redirect(new URL("/sign-in", req.url));
    }

    // Fetch user details from Clerk to get email
    const client = await clerkClient();
    const user = await client.users.getUser(userId);

    // Check if user is admin by email or by role in public metadata
    if (!isUserAdmin(user, ADMIN_EMAILS)) {
      // Redirect to unauthorized page instead of JSON response for better UX
      return NextResponse.redirect(new URL("/unauthorized", req.url));
    }

    return NextResponse.next();
  } catch (error) {
    console.error("Admin middleware error:", error);
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
