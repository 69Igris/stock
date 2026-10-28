import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FIRE Planner",
};

export default function FireLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
