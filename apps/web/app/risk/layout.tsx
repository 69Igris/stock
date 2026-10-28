import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Risk Analysis",
};

export default function RiskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
