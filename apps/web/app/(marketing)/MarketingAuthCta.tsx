"use client";

import Link from "next/link";
import { useUser } from "@clerk/nextjs";

/**
 * Auth-aware primary CTA button used in the big-cta sections of server-rendered
 * marketing pages (changelog, alternatives).
 *
 * When signed in  → "Go to dashboard →" linking to /dashboard
 * When signed out → the provided signedOutLabel (default "Start free →") linking to /sign-up
 *
 * Defaults to the signed-out state during SSR / before Clerk loads to avoid a flash.
 */
interface MarketingAuthCtaProps {
  signedOutLabel?: string;
  className?: string;
}

export function MarketingAuthCta({
  signedOutLabel = "Start free →",
  className = "btn-solid",
}: MarketingAuthCtaProps) {
  const { isLoaded, isSignedIn } = useUser();
  const authed = isLoaded && isSignedIn;

  return (
    <Link className={className} href={authed ? "/dashboard" : "/sign-up"}>
      {authed ? "Go to dashboard →" : signedOutLabel}
    </Link>
  );
}
