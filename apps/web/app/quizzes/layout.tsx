import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFeatureFlags } from "@/lib/actions/feature-flags";

// Covers /quizzes and /quizzes/[quizId].
export const metadata: Metadata = {
  title: "Quizzes",
};

// Server-side gate mirroring /paper-trading: redirect to /dashboard when the
// `/quizzes` flag is off (default), before any HTML renders. Part of the
// Learning section, which is hidden from all nav/CTAs.
export const dynamic = "force-dynamic";

export default async function QuizzesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { flags } = await getFeatureFlags();
  if (!flags["/quizzes"]) {
    redirect("/dashboard");
  }
  return children;
}
