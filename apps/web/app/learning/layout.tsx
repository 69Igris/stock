import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFeatureFlags } from "@/lib/actions/feature-flags";

export const metadata: Metadata = {
  title: "Learning",
  description:
    "Structured investing courses and lessons for Indian markets — from market basics to portfolio strategy, taught the UseMoney way.",
};

// Server-side gate for /learning (+ /learning/* course & lesson pages),
// mirroring the /paper-trading layout: evaluate the `/learning` flag on the
// server BEFORE any HTML is sent. When the flag is off the route 307s to
// /dashboard without ever rendering the Learning shell (the section is also
// hidden from all nav/CTAs). getFeatureFlags() reads auth headers, so opt
// out of static optimisation.
export const dynamic = "force-dynamic";

export default async function LearningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { flags } = await getFeatureFlags();
  if (!flags["/learning"]) {
    redirect("/dashboard");
  }
  return children;
}
