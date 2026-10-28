import "./playful.css";

import { PlayfulHeader } from "@/components/marketing/PlayfulHeader";
import { PlayfulFooter } from "@/components/marketing/PlayfulFooter";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="playful-page">
      <PlayfulHeader />
      {children}
      <PlayfulFooter />
    </div>
  );
}
