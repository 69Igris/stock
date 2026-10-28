import React from "react";
// Pull the playful chrome + tokens for every public route — blog, glossary,
// docs, newsletter, privacy, terms, legal, data-usage, subprocessors. The
// per-route content keeps its own internal styling, but header/footer and
// background now match the rest of the marketing site.
import "../(marketing)/playful.css";
import { PlayfulHeader } from "@/components/marketing/PlayfulHeader";
import { PlayfulFooter } from "@/components/marketing/PlayfulFooter";

interface PublicLayoutProps {
  children: React.ReactNode;
}

export default function PublicLayout({ children }: PublicLayoutProps) {
  return (
    <div className="playful-page">
      <PlayfulHeader />
      <main>{children}</main>
      <PlayfulFooter />
    </div>
  );
}
