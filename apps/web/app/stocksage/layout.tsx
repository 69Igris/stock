import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "StockSage",
};

export default function StockSageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
