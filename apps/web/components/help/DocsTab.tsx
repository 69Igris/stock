"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { FileText, ArrowRight } from "lucide-react";

interface DocItem {
  id: string;
  title: string;
  excerpt: string | null;
  postUrl: string;
  tags: { id: string; name: string }[];
}

/* Playful doc category definitions (static UI — real docs load dynamically) */
const DOC_CATEGORIES = [
  {
    title: "Getting started",
    count: 12,
    icon: "sparkles",
    color: "var(--pop-2)",
    items: ["What is UseMoney?", "Sign up + verify", "Read-only OAuth"],
  },
  {
    title: "Brokers & sync",
    count: 14,
    icon: "link",
    color: "var(--pop-4)",
    items: ["Connect Zerodha", "Connect Groww", "CSV import"],
  },
  {
    title: "StockSage AI",
    count: 18,
    icon: "brain",
    color: "var(--pop-3)",
    items: ["How research works", "Credits explained", "Citations & sources"],
  },
  {
    title: "Trading & alerts",
    count: 9,
    icon: "trend",
    color: "var(--pop-1)",
    items: ["Price alerts", "Strategy builder", "Trade journal"],
  },
  {
    title: "Reports & tax",
    count: 11,
    icon: "receipt",
    color: "var(--pop-5)",
    items: ["Risk report", "Tax suite", "ITR-2 export"],
  },
  {
    title: "Security",
    count: 8,
    icon: "shield",
    color: "var(--emerald)",
    items: ["256-bit AES-GCM", "Read-only scope", "SEBI alignment"],
  },
] as const;

export default function DocsTab() {
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDocs() {
      try {
        const res = await fetch("/api/content/docs");
        if (res.ok) {
          const data = await res.json();
          setDocs(data.posts || []);
        }
      } catch {
        // Silently fail - docs tab will show static categories
      } finally {
        setLoading(false);
      }
    }
    fetchDocs();
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Link to full docs */}
      <Link href="/docs" style={{ textDecoration: "none" }}>
        <div
          className="pf-card"
          style={{
            padding: "14px 18px",
            background: "var(--emerald-bg)",
            borderColor: "var(--emerald)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            cursor: "pointer",
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
          <div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: "var(--ink)",
                marginBottom: 2,
              }}
            >
              View all documentation
            </div>
            <div
              style={{
                fontFamily: "Instrument Serif, serif",
                fontStyle: "italic",
                fontSize: 13,
                color: "var(--ink-3)",
              }}
            >
              Browse our complete docs with search and filtering
            </div>
          </div>
          <ArrowRight
            style={{
              width: 16,
              height: 16,
              color: "var(--emerald-text)",
              flexShrink: 0,
            }}
          />
        </div>
      </Link>

      {/* Static doc category grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        {DOC_CATEGORIES.map((cat) => (
          <div
            key={cat.title}
            className="pf-card"
            style={{ padding: 18, display: "flex", flexDirection: "column" }}
          >
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
                  width: 36,
                  height: 36,
                  borderRadius: 9,
                  background: cat.color,
                  color: cat.color === "var(--pop-2)" ? "#1d1d1b" : "#fff",
                  border: "1.5px solid var(--ink)",
                  transform: "rotate(-3deg)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
              >
                <FileText style={{ width: 17, height: 17 }} />
              </span>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 800,
                  letterSpacing: -0.3,
                  color: "var(--ink)",
                }}
              >
                {cat.title}
              </div>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, flex: 1 }}>
              {cat.items.map((it) => (
                <li
                  key={it}
                  style={{
                    padding: "5px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    color: "var(--ink-2)",
                    cursor: "pointer",
                    borderBottom: "1px dashed var(--rule-soft)",
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      color: "var(--emerald-text)",
                      fontWeight: 700,
                      fontSize: 11,
                    }}
                  >
                    →
                  </span>{" "}
                  {it}
                </li>
              ))}
            </ul>
            <div
              className="mono"
              style={{
                marginTop: 14,
                fontSize: 11,
                fontWeight: 700,
                color: "var(--ink-3)",
                letterSpacing: 1.2,
                textTransform: "uppercase",
              }}
            >
              {cat.count} articles →
            </div>
          </div>
        ))}
      </div>

      {/* Dynamic docs (loaded from API) */}
      {!loading && docs.length > 0 && (
        <>
          <div className="ttl" style={{ marginTop: 4 }}>
            PUBLISHED DOCS
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: 12,
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
                    padding: 16,
                    cursor: "pointer",
                    transition: "transform .12s, box-shadow .12s",
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
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 10,
                    }}
                  >
                    <FileText
                      style={{
                        width: 14,
                        height: 14,
                        color: "var(--emerald-text)",
                        marginTop: 2,
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
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
                            fontSize: 12,
                            color: "var(--ink-3)",
                            marginTop: 4,
                            lineHeight: 1.4,
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {doc.excerpt}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      {!loading && docs.length === 0 && (
        <div className="pf-card" style={{ padding: 32, textAlign: "center" }}>
          <FileText
            style={{
              width: 40,
              height: 40,
              color: "var(--ink-4)",
              margin: "0 auto 12px",
            }}
          />
          <div
            style={{
              fontWeight: 700,
              fontSize: 15,
              color: "var(--ink)",
              marginBottom: 4,
            }}
          >
            No additional docs published yet.
          </div>
          <div
            style={{
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontSize: 14,
              color: "var(--ink-3)",
            }}
          >
            Docs will appear here once published.
          </div>
        </div>
      )}
    </div>
  );
}
