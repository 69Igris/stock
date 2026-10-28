import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Chat History",
};

export default function ChatHistoryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
