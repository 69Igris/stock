import type { Metadata } from "next";

// Covers /settings. /settings/usage and /settings/investor-profile set their
// own titles where a more specific label is useful.
export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
