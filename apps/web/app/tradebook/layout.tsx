import type { Metadata } from "next";

// Covers /tradebook and /tradebook/export. The /tradebook/import/* pages
// export their own metadata, which overrides this inherited title.
export const metadata: Metadata = {
  title: "Trade Book",
};

export default function TradebookLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
