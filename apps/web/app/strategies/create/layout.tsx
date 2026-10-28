import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create Strategy",
};

export default function StrategyCreateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
