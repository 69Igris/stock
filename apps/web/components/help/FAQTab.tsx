"use client";

import { useState, useCallback } from "react";
import {
  CreditCard,
  Link2,
  Sparkles,
  PieChart,
  FileSpreadsheet,
  Flame,
  IndianRupee,
  Shield,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { faqSections } from "@/app/help/lib/faq-data";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";

const iconMap: Record<string, LucideIcon> = {
  CreditCard,
  Link2,
  Sparkles,
  PieChart,
  FileSpreadsheet,
  Flame,
  IndianRupee,
  Shield,
};

/** Accent colour per section icon (consistent with palette) */
const SECTION_ACCENTS: Record<string, string> = {
  CreditCard: "var(--pop-2)",
  Link2: "var(--pop-3)",
  Sparkles: "var(--emerald)",
  PieChart: "var(--pop-5)",
  FileSpreadsheet: "var(--pop-4)",
  Flame: "var(--pop-1)",
  IndianRupee: "var(--pop-2)",
  Shield: "var(--emerald)",
};

export default function FAQTab() {
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const sections = paperTradingEnabled
    ? faqSections
    : faqSections.filter((s) => s.title !== "Paper Trading");
  const [activeSection, setActiveSection] = useState(sections[0].id);
  // Single open FAQ item across ALL sections
  const [openItem, setOpenItem] = useState<string>("");

  const scrollToSection = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    const el = document.getElementById(`faq-section-${sectionId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const toggleItem = (key: string) => {
    setOpenItem((prev) => (prev === key ? "" : key));
  };

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
      {/* Main FAQ content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {sections.map((section) => {
          const Icon = iconMap[section.icon] ?? CreditCard;
          const accent = SECTION_ACCENTS[section.icon] ?? "var(--emerald)";
          return (
            <div
              key={section.id}
              id={`faq-section-${section.id}`}
              style={{ scrollMarginTop: 16, marginBottom: 28 }}
            >
              {/* Section header */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: accent,
                    color: accent === "var(--pop-2)" ? "#1d1d1b" : "#fff",
                    border: "1.5px solid var(--ink)",
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                    transform: "rotate(-2deg)",
                  }}
                >
                  <Icon style={{ width: 14, height: 14 }} />
                </span>
                <h3
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: "var(--ink)",
                    letterSpacing: -0.2,
                    margin: 0,
                  }}
                >
                  {section.title}
                </h3>
                <span
                  className="mono"
                  style={{ fontSize: 10, color: "var(--ink-4)", marginLeft: 2 }}
                >
                  {section.items.length}
                </span>
              </div>

              {/* Accordion items */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {section.items.map((item, idx) => {
                  const key = `${section.id}-${idx}`;
                  const isOpen = openItem === key;
                  return (
                    <div
                      key={key}
                      className="pf-card"
                      style={{
                        padding: 0,
                        overflow: "hidden",
                        boxShadow: "none",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => toggleItem(key)}
                        style={{
                          width: "100%",
                          padding: "14px 18px",
                          background: "transparent",
                          border: 0,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          textAlign: "left",
                          fontFamily: "Inter, sans-serif",
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 6,
                            background: isOpen
                              ? "var(--emerald)"
                              : "var(--pop-2)",
                            color: isOpen ? "var(--paper)" : "#1d1d1b",
                            border: "1.5px solid var(--ink)",
                            display: "grid",
                            placeItems: "center",
                            fontSize: 11,
                            fontWeight: 800,
                            transform: "rotate(-3deg)",
                            flexShrink: 0,
                            transition: "background .15s",
                          }}
                        >
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        <div
                          style={{
                            flex: 1,
                            fontSize: 14,
                            fontWeight: 700,
                            color: "var(--ink)",
                            lineHeight: 1.35,
                          }}
                        >
                          {item.question}
                        </div>
                        <ChevronDown
                          style={{
                            width: 14,
                            height: 14,
                            color: "var(--ink-3)",
                            flexShrink: 0,
                            transform: isOpen
                              ? "rotate(180deg)"
                              : "rotate(0deg)",
                            transition: "transform .15s",
                          }}
                        />
                      </button>
                      {isOpen && (
                        <div
                          style={{
                            padding: "0 18px 18px 54px",
                            fontFamily: "Instrument Serif, serif",
                            fontStyle: "italic",
                            fontSize: 16,
                            lineHeight: 1.5,
                            color: "var(--ink-2)",
                          }}
                        >
                          {item.answer}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Right-side category index — hidden on mobile */}
      <nav
        style={{
          display: "none",
          flexDirection: "column",
          gap: 4,
          position: "sticky",
          top: 16,
          alignSelf: "flex-start",
          flexShrink: 0,
          width: 160,
        }}
        className="faq-nav-desktop"
      >
        <div className="ttl" style={{ marginBottom: 8, padding: "0 6px" }}>
          CATEGORIES
        </div>
        {sections.map((section) => {
          const Icon = iconMap[section.icon] ?? CreditCard;
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => scrollToSection(section.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 7,
                border: 0,
                background: isActive ? "var(--emerald-bg)" : "transparent",
                color: isActive ? "var(--emerald-text)" : "var(--ink-3)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                textAlign: "left",
                borderLeft: isActive
                  ? "2px solid var(--emerald)"
                  : "2px solid transparent",
                transition: "all .12s",
              }}
            >
              <Icon style={{ width: 12, height: 12, flexShrink: 0 }} />
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {section.title}
              </span>
            </button>
          );
        })}
      </nav>

      <style>{`
        @media (min-width: 768px) {
          .faq-nav-desktop { display: flex !important; }
        }
      `}</style>
    </div>
  );
}
