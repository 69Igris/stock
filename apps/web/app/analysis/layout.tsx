import type { Metadata } from "next";

// Covers /analysis/[sessionId]. /analysis (index) exports its own metadata,
// which overrides this inherited title.
export const metadata: Metadata = {
  title: "Research",
};

export default function AnalysisLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
