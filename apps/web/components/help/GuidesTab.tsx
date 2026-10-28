"use client";

import Link from "next/link";
import {
  ArrowRight,
  Activity,
  Briefcase,
  Target,
  BookOpen,
  Landmark,
  FileSpreadsheet,
  Flame,
  Brain,
  Search,
  Link2,
  Settings,
  Sparkles,
  Filter,
  type LucideIcon,
} from "lucide-react";
import { featureGuides } from "@/app/help/lib/feature-guides-data";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";

const iconMap: Record<string, LucideIcon> = {
  Activity,
  Briefcase,
  Target,
  BookOpen,
  Landmark,
  FileSpreadsheet,
  Flame,
  Brain,
  Search,
  Link2,
  Settings,
  Sparkles,
  Filter,
};

/** Accent colour per guide index (cycling) */
const GUIDE_ACCENTS = [
  "var(--emerald)",
  "var(--pop-2)",
  "var(--pop-3)",
  "var(--pop-1)",
  "var(--pop-5)",
  "var(--pop-4)",
] as const;

export default function GuidesTab() {
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const guides = paperTradingEnabled
    ? featureGuides
    : featureGuides.filter((g) => g.title !== "Paper Trading");

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
        gap: 12,
      }}
    >
      {guides.map((guide, idx) => {
        const Icon = iconMap[guide.icon] ?? Activity;
        const accent = GUIDE_ACCENTS[idx % GUIDE_ACCENTS.length];
        return (
          <Link
            key={guide.title}
            href={guide.href}
            style={{ textDecoration: "none" }}
          >
            <div
              className="pf-card"
              style={{
                padding: 16,
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 12,
                height: "100%",
                transition: "transform .12s, box-shadow .12s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.transform =
                  "translate(-1px,-1px)";
                (e.currentTarget as HTMLDivElement).style.boxShadow =
                  "4px 4px 0 var(--ink)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.transform =
                  "translate(0,0)";
                (e.currentTarget as HTMLDivElement).style.boxShadow =
                  "var(--shadow-soft)";
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 9,
                    background: accent,
                    color: accent === "var(--pop-2)" ? "#1d1d1b" : "#fff",
                    border: "1.5px solid var(--ink)",
                    transform: "rotate(-3deg)",
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon style={{ width: 15, height: 15 }} />
                </span>
              </div>
              <div
                style={{
                  fontSize: 15,
                  fontWeight: 800,
                  letterSpacing: -0.3,
                  lineHeight: 1.2,
                  color: "var(--ink)",
                }}
              >
                {guide.title}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                  fontFamily: "Instrument Serif, serif",
                  fontStyle: "italic",
                }}
              >
                {guide.description}
              </div>
              <div style={{ marginTop: "auto" }}>
                <span
                  className="pf-bf sm"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  Read guide <ArrowRight style={{ width: 11, height: 11 }} />
                </span>
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
