"use client";

import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { PfPageHead } from "@/components/playful/PfPageHead";
import {
  Compass,
  Terminal,
  BookOpen,
  FileText,
  MessageSquareText,
  HelpCircle,
} from "lucide-react";
import PromptLibraryTab from "@/components/help/PromptLibraryTab";
import SlashCommandsTab from "@/components/help/SlashCommandsTab";
import GuidesTab from "@/components/help/GuidesTab";
import DocsTab from "@/components/help/DocsTab";
import FAQTab from "@/components/help/FAQTab";
import GlossaryTab from "@/components/help/GlossaryTab";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";

const TABS = [
  { value: "prompts", label: "Prompts", icon: Compass },
  { value: "slash-commands", label: "Commands", icon: Terminal },
  { value: "guides", label: "Guides", icon: BookOpen },
  { value: "docs", label: "Docs", icon: FileText },
  { value: "faq", label: "FAQ", icon: MessageSquareText },
  { value: "glossary", label: "Glossary", icon: HelpCircle },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default function HelpPage() {
  const searchParams = useSearchParams();
  const ownedRoute = useOwnedRoute("/help");
  const currentTab = (searchParams?.get("tab") as TabValue) || "prompts";

  // MONEY-1082: guarded so a tab write can't re-assert /help after the user
  // has navigated away. Stays a real navigation because `currentTab` is read
  // back out of useSearchParams.
  const handleTabChange = (value: string) => {
    ownedRoute.replaceRoute(`/help?tab=${value}`, { scroll: false });
  };

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1600px] mx-auto">
          {/* Playful page header */}
          <PfPageHead
            eyebrow="PROMPTS · COMMANDS · GUIDES · FAQ"
            title={
              <>
                Help <span className="ser">center.</span>
              </>
            }
            sub="Prompts, guides, and answers to get the most out of UseMoney"
          />

          {/* Tab strip — wraps on mobile (no horizontal overflow) */}
          <div
            className="pf-tabs"
            style={{ marginBottom: 22, flexWrap: "wrap" }}
            role="tablist"
          >
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = currentTab === tab.value;
              return (
                <button
                  key={tab.value}
                  role="tab"
                  aria-selected={isActive}
                  className={`pf-tab${isActive ? " is-active" : ""}`}
                  onClick={() => handleTabChange(tab.value)}
                >
                  <Icon style={{ width: 13, height: 13 }} />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Tab panels */}
          <div role="tabpanel">
            {currentTab === "prompts" && <PromptLibraryTab />}
            {currentTab === "slash-commands" && <SlashCommandsTab />}
            {currentTab === "guides" && <GuidesTab />}
            {currentTab === "docs" && <DocsTab />}
            {currentTab === "faq" && <FAQTab />}
            {/* GlossaryTab fetches its own terms. It only mounts when this tab
                is open, so the query no longer blocks visitors who never open
                it — which is five out of six, since Prompts is the default. */}
            {currentTab === "glossary" && <GlossaryTab />}
          </div>
        </div>
      </main>
    </div>
  );
}
