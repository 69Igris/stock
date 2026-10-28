import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { verifyDemoCookieEdge } from "@/lib/demo/session";
// Route pattern lists live in the dependency-free `proxy-routes` module so the
// route-classification tests assert the SAME source-of-truth arrays this
// middleware compiles into Clerk matchers (no shadow / no drift).
import {
  PUBLIC_ROUTE_PATTERNS,
  API_ROUTE_PATTERNS,
  APP_ROUTE_PATTERNS,
} from "@/proxy-routes";

// Define public routes that don't require authentication
const isPublicRoute = createRouteMatcher(PUBLIC_ROUTE_PATTERNS);

// Define API routes that need special handling
const isApiRoute = createRouteMatcher(API_ROUTE_PATTERNS);

// Define app routes (dashboard, tradebook, etc.)
const isAppRoute = createRouteMatcher(APP_ROUTE_PATTERNS);

export default clerkMiddleware(async (auth, req) => {
  const pathname = req.nextUrl.pathname;

  // Allow public routes immediately - no auth() call needed
  // (but check root "/" for logged-in redirect)
  //
  // MONEY-1130 — this block is the ONLY place the "/" audience is decided.
  // It used to be half here and half in a client component: the middleware
  // sent signed-IN users to /dashboard, and `app/client.tsx` (a "use client"
  // stub rendered by `app/page.tsx`) waited for clerk.js to hydrate before
  // `router.replace("/home")`-ing everyone else. That second half cost
  // anonymous visitors two full page loads and made the LCP element on "/" a
  // "Loading…" paragraph (Datadog RUM). Both halves now resolve server-side:
  //
  //   signed IN  → 307 to /dashboard (below), before any page renders
  //   signed OUT → NextResponse.next(), which serves the PRERENDERED marketing
  //                landing at `app/(marketing)/page.tsx`. No redirect, no
  //                client-side navigation, no dependency on clerk.js for first
  //                paint.
  //
  // Do NOT reintroduce a signed-out redirect to /home here: `app/robots.ts`
  // disallows /home and allows "/", so bouncing crawlers off "/" would drop the
  // homepage out of the index. "/" is the canonical marketing URL.
  if (pathname === "/") {
    // Only call auth() once for root redirect check
    const { userId } = await auth();
    if (userId) {
      return NextResponse.redirect(new URL("/dashboard", req.url));
    }
    return NextResponse.next();
  }

  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  // For all protected routes: call auth() ONCE and reuse the result
  const { userId } = await auth();

  // API routes: check auth OR valid demo cookie
  if (isApiRoute(req)) {
    if (userId) {
      return NextResponse.next();
    }

    // Allow demo sessions to access API routes
    const apiDemoCookie = req.cookies.get("sb_demo")?.value;
    if (apiDemoCookie && (await verifyDemoCookieEdge(apiDemoCookie))) {
      return NextResponse.next();
    }

    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // App routes: require auth OR valid demo cookie
  if (isAppRoute(req)) {
    if (userId) {
      return NextResponse.next();
    }

    // Verify demo cookie (HMAC-signed, Edge-compatible)
    const demoCookie = req.cookies.get("sb_demo")?.value;
    if (demoCookie && (await verifyDemoCookieEdge(demoCookie))) {
      return NextResponse.next();
    }

    // Redirect unauthenticated non-demo users to sign-in
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("redirect_url", req.url);
    return NextResponse.redirect(signInUrl);
  }

  // All other routes: require auth
  if (!userId) {
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("redirect_url", req.url);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
});

export const config = {
  // Next.js statically analyzes this matcher at build time, so it MUST be an
  // inline literal — an imported identifier fails the build ("Unknown
  // identifier ... at config.matcher"). `xml` and `txt` are in the static-file
  // skip-list so /sitemap.xml, /robots.txt and /llms.txt reach the crawler
  // instead of being 307'd to /sign-in; `/(api|trpc)(.*)` still forces every
  // /api path through the middleware regardless of extension (no auth hole).
  // A drift guard in __tests__/middleware/route-access.test.ts reads this
  // literal from source and asserts .xml/.txt stay excluded.
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|json|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|xml|txt)).*)",
    "/(api|trpc)(.*)",
  ],
};
