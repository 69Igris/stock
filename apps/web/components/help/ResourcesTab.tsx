"use client";

import { useState, useEffect } from "react";
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
  FileText,
  type LucideIcon,
} from "lucide-react";
import { featureGuides } from "@/app/help/lib/feature-guides-data";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";

const guideIconMap: Record<string, LucideIcon> = {
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

const GUIDE_ACCENTS = [
  "var(--emerald)",
  "var(--pop-2)",
  "var(--pop-3)",
  "var(--pop-1)",
  "var(--pop-5)",
  "var(--pop-4)",
] as const;

interface DocItem {
  id: string;
  title: string;
  excerpt: string | null;
  postUrl: string;
}

export default function ResourcesTab() {
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const guides = paperTradingEnabled
    ? featureGuides
    : featureGuides.filter((g) => g.title !== "Paper Trading");
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);

  useEffect(() => {
    async function fetchDocs() {
      try {
        const res = await fetch("/api/content/docs");
        if (res.ok) {
          const data = await res.json();
          setDocs(data.posts || []);
        }
      } catch {
        // Silently fail
      } finally {
        setDocsLoading(false);
      }
    }
    fetchDocs();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 24,
        maxWidth: 860,
      }}
    >
      {/* Feature Guides */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        {guides.map((guide, idx) => {
          const Icon = guideIconMap[guide.icon] ?? Activity;
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
                  padding: 14,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  transition: "transform .12s, box-shadow .12s",
                  height: "100%",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform =
                    "translate(-1px,-1px)";
                  (e.currentTarget as HTMLDivElement).style.boxShadow =
                    "3px 3px 0 var(--ink)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.transform =
                    "translate(0,0)";
                  (e.currentTarget as HTMLDivElement).style.boxShadow =
                    "var(--shadow-soft)";
                }}
              >
                <span
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    background: accent,
                    color: accent === "var(--pop-2)" ? "#1d1d1b" : "#fff",
                    border: "1.5px solid var(--ink)",
                    display: "grid",
                    placeItems: "center",
                    transform: "rotate(-3deg)",
                    flexShrink: 0,
                  }}
                >
                  <Icon style={{ width: 13, height: 13 }} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: "var(--ink)",
                      lineHeight: 1.3,
                    }}
                  >
                    {guide.title}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {guide.description}
                  </div>
                </div>
                <ArrowRight
                  style={{
                    width: 12,
                    height: 12,
                    color: "var(--ink-3)",
                    flexShrink: 0,
                  }}
                />
              </div>
            </Link>
          );
        })}
      </div>

      {/* Published docs from CMS */}
      {!docsLoading && docs.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Link href="/docs" style={{ textDecoration: "none" }}>
            <div
              className="pf-card"
              style={{
                padding: "12px 16px",
                background: "var(--emerald-bg)",
                borderColor: "var(--emerald)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                cursor: "pointer",
              }}
            >
              <div>
                <div
                  style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}
                >
                  View all documentation
                </div>
                <div
                  style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}
                >
                  Browse complete docs with search and filtering
                </div>
              </div>
              <ArrowRight
                style={{
                  width: 14,
                  height: 14,
                  color: "var(--emerald-text)",
                  flexShrink: 0,
                }}
              />
            </div>
          </Link>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: 10,
            }}
          >
            {docs.map((doc) => (
              <Link
                key={doc.id}
                href={`/docs/${doc.postUrl}`}
                style={{ textDecoration: "none" }}
              >
                <div
                  className="pf-card"
                  style={{
                    padding: 12,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    boxShadow: "none",
                    transition: "border-color .12s",
                  }}
                >
                  <FileText
                    style={{
                      width: 13,
                      height: 13,
                      color: "var(--emerald-text)",
                      marginTop: 2,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: "var(--ink)",
                        lineHeight: 1.3,
                      }}
                    >
                      {doc.title}
                    </div>
                    {doc.excerpt && (
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          marginTop: 3,
                          lineHeight: 1.4,
                          display: "-webkit-box",
                          WebkitLineClamp: 1,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {doc.excerpt}
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
