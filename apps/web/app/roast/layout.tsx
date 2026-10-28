import type { Metadata } from "next";

// Covers /roast and /roast/[id].
export const metadata: Metadata = {
  title: "Portfolio Roast",
};

export default function RoastLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
