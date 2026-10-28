import type { Metadata } from "next";

// Title-only segment layout: gives /dashboard a distinct browser-tab /
// share title instead of inheriting the generic site default. The root
// layout's `template: "%s | UseMoney"` renders this as "Dashboard | UseMoney".
export const metadata: Metadata = {
  title: "Dashboard",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
