import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Brokers",
};

export default function BrokersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
