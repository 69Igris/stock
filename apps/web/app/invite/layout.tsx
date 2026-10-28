import type { Metadata } from "next";

// Covers /invite/[token].
export const metadata: Metadata = {
  title: "Invitation",
};

export default function InviteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
