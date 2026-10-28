import type { Metadata } from "next";

// /discover/sectors index. /discover/sectors/[sector] exports its own
// per-sector metadata, which overrides this inherited title.
export const metadata: Metadata = {
  title: "Sectors",
};

export default function SectorsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
