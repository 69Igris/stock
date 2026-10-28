import type { Metadata } from "next";

// Covers /strategies and /strategies/[id]/* (backtest, forward). The
// /strategies/build and /strategies/create segments set their own titles.
export const metadata: Metadata = {
  title: "Strategies",
};

export default function StrategiesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
