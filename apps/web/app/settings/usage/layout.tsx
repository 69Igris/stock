import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Usage & Billing",
};

export default function SettingsUsageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
