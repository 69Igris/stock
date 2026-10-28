import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFeatureFlags } from "@/lib/actions/feature-flags";

export const metadata: Metadata = {
  title: "AI Tutor",
};

// Server-side gate mirroring /paper-trading: redirect to /dashboard when the
// `/sage-tutor` flag is off (default), before any HTML renders. StockSage
// Tutor is part of the hidden Learning section. NOTE: "Ask Sage" CTAs (e.g.
// the tax page) route here — they were already gated by this flag; flip it
// on (or repoint those CTAs) to keep Ask Sage reachable.
export const dynamic = "force-dynamic";

export default async function SageTutorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { flags } = await getFeatureFlags();
  if (!flags["/sage-tutor"]) {
    redirect("/dashboard");
  }
  return children;
}
