import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Tutor",
};

export default function TutorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
