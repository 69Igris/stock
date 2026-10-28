import type { Metadata } from "next";

// Covers /discover. Child routes (/discover/lists, /markets, /news,
// /screener, /sectors/[sector]) export their own metadata and override this.
export const metadata: Metadata = {
  title: "Discover",
};

export default function DiscoverLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
