"use client";

/**
 * CitationsRail / SourcesRail — MONEY-587 (StockSage design).
 *
 * Right-hand "sources behind the answer" rail. Renders ONLY when an assistant
 * message carries real, derivable provenance — never fabricated. Per the
 * StockSage design it groups sources into collapsible sections (Web / Data
 * tools run / Instruments / Reports & pages), each a SourceRow with a favicon
 * or badge, an optional [n] citation, source·date·sentiment, and a snippet.
 *
 * Real data sources (no fakes):
 *   1. NewsBlock.articles      → Web sources (favicon, sentiment, date, link).
 *   2. ResearchStreamBlock /   → official-channel exchange filings (NSE
 *      ActionBlock.taskProgress    announcements + board/AGM meetings) carried by
 *                                  the fetch_exchange_announcements /
 *                                  fetch_shareholder_meetings tools → Database /
 *                                  Filings primary-source rows.
 *   3. ResearchStreamBlock /   → the named compute tools that actually ran.
 *      ActionBlock.taskProgress
 *   4. turnMeta.symbols        → the instruments analysed.
 *   5. NavigationBlock links   → report / page sources the turn produced.
 *
 * Group order mirrors the StockSage ss-sources design: Web → Database /
 * Filings → Data tools run → Instruments → Reports & pages.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessageWithBlocks,
  ContentBlock,
  NavigationBlock,
  NewsBlock,
  StructuredReportBlock,
  TaskProgressItem,
} from "@usemoney/types";
import {
  Link2,
  Globe,
  Wrench,
  Briefcase,
  FileText,
  Database,
  ChevronDown,
  ExternalLink,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { Favicon, Sentiment } from "@/components/chat/blocks/ChatBlock";
import {
  useCitationState,
  setHotCitation,
} from "@/components/chat/CitationContext";

type Sentiment3 = "positive" | "neutral" | "negative";

interface SrcRow {
  id: string;
  kind: "web" | "filing" | "tool" | "symbol" | "report";
  cite?: number;
  title: string;
  source?: string;
  date?: string;
  sentiment?: Sentiment3;
  snippet?: string;
  domain?: string;
  href?: string;
}

interface SrcGroup {
  key: string;
  icon: LucideIcon;
  title: string;
  rows: SrcRow[];
}

/** Title-case a snake/kebab tool id: `revenue_mix_v2` → `Revenue mix v2`. */
function humanizeToolId(raw: string): string {
  const cleaned = raw.replace(/[_-]+/g, " ").trim();
  if (!cleaned) return raw;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Pretty domain (drop protocol + www) for the source label. */
function prettyDomain(domain?: string, url?: string): string | undefined {
  const raw = domain || url;
  if (!raw) return undefined;
  try {
    const host = raw.includes("://")
      ? new URL(raw).hostname
      : raw.split("/")[0]!;
    return host.replace(/^www\./, "");
  } catch {
    return domain;
  }
}

function collectWeb(
  blocks: ContentBlock[],
  startCite: { n: number }
): SrcRow[] {
  const rows: SrcRow[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "news") continue;
    for (const a of (block as NewsBlock).articles) {
      const key = a.url || a.headline;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: `web-${rows.length}`,
        kind: "web",
        cite: startCite.n++,
        title: a.headline,
        source: a.source || prettyDomain(a.domain, a.url),
        date: a.at,
        sentiment: a.sentiment,
        domain: a.domain || prettyDomain(undefined, a.url),
        href: a.url,
      });
    }
  }
  return rows;
}

/**
 * Official NSE board / shareholder-meetings filing page. Mirrors
 * SHAREHOLDER_MEETINGS_SOURCE in
 * packages/research/src/tools/fetch-shareholder-meetings.ts — inlined here
 * because that module pulls server-only deps (fs/GCS) we must not bundle
 * into this client component. Used as the citable primary source for board /
 * AGM / EGM rows, which carry no per-row attachment URL.
 */
const NSE_BOARD_MEETINGS_SOURCE =
  "https://www.nseindia.com/companies-listing/corporate-filings-board-meetings";

const FILING_TOOLS = new Set([
  "fetch_exchange_announcements",
  "fetch_shareholder_meetings",
]);

/** Coerce an unknown task-result payload into an array of plain rows. */
function asResultRows(summary: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(summary)) {
    return summary.filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null
    );
  }
  // Some summaries wrap the rows in { data: [...] }.
  const data = (summary as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) {
    return data.filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null
    );
  }
  return [];
}

function str(v: unknown): string | undefined {
  return v == null || v === "" ? undefined : String(v);
}

/**
 * Database / Filings — primary-source exchange filings carried by the two
 * official-channel NSE tools (fetch_exchange_announcements +
 * fetch_shareholder_meetings). Each announcement row carries its own
 * attachment URL (a filing PDF on the exchange); board/AGM meeting rows have
 * no per-row URL so they cite the official NSE board-meetings filing page.
 * Renders ONLY rows derived from real tool output — never fabricated.
 */
function collectFilings(
  blocks: ContentBlock[],
  startCite: { n: number }
): SrcRow[] {
  const tasks: TaskProgressItem[] = [];
  for (const block of blocks) {
    if (block.type === "research-stream" || block.type === "action") {
      const tp = (block as { taskProgress?: TaskProgressItem[] }).taskProgress;
      if (Array.isArray(tp)) tasks.push(...tp);
    }
  }

  const rows: SrcRow[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    if (t.status !== "completed") continue;
    if (!t.tool || !FILING_TOOLS.has(t.tool)) continue;
    for (const r of asResultRows(t.resultSummary)) {
      // Announcements carry a per-filing attachment URL; meetings don't.
      const url =
        str(r.url) ||
        (t.tool === "fetch_shareholder_meetings"
          ? NSE_BOARD_MEETINGS_SOURCE
          : undefined);
      const title =
        str(r.subject) ||
        str(r.purpose) ||
        str(r.detail) ||
        str(r.type) ||
        "Exchange filing";
      // Dedupe on the citable target (URL when present, else title+date).
      const date = str(r.date);
      const key = url || `${title}::${date ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: `filing-${rows.length}`,
        kind: "filing",
        cite: startCite.n++,
        title,
        source: "NSE Corporate Filings",
        date,
        snippet: str(r.detail) || str(r.purpose),
        href: url,
      });
    }
  }
  return rows;
}

function collectTools(blocks: ContentBlock[]): SrcRow[] {
  const tasks: TaskProgressItem[] = [];
  for (const block of blocks) {
    if (block.type === "research-stream" || block.type === "action") {
      const tp = (block as { taskProgress?: TaskProgressItem[] }).taskProgress;
      if (Array.isArray(tp)) tasks.push(...tp);
    }
  }
  const seen = new Set<string>();
  const rows: SrcRow[] = [];
  for (const t of tasks) {
    if (t.status !== "completed") continue;
    const raw = t.tool || t.type;
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    rows.push({
      id: `tool-${raw}`,
      kind: "tool",
      title: humanizeToolId(raw),
      source: raw,
    });
  }
  return rows;
}

function collectReports(blocks: ContentBlock[]): SrcRow[] {
  const rows: SrcRow[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "navigation") continue;
    for (const l of (block as NavigationBlock).links) {
      // Skip in-app toggle hrefs (e.g. #load-report:…) that aren't sources.
      if (l.href.startsWith("#")) continue;
      const key = `${l.href}::${l.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        id: `report-${rows.length}`,
        kind: "report",
        title: l.label,
        snippet: l.description,
        href: l.href,
      });
    }
  }
  return rows;
}

/** Build the grouped sources for a single assistant message. */
export function deriveCitations(
  message: ChatMessageWithBlocks | undefined
): SrcGroup[] {
  if (!message || message.role !== "assistant") return [];
  const blocks = message.blocks ?? [];
  const citeCounter = { n: 1 };

  const web = collectWeb(blocks, citeCounter);
  const filings = collectFilings(blocks, citeCounter);
  const tools = collectTools(blocks);
  const symbolSet = new Set<string>(
    (message.turnMeta?.symbols ?? []).filter(Boolean)
  );
  const reports = collectReports(blocks);

  // P6 (MONEY-670): research completion emits ONLY a structured-report block, so
  // the rail's usual source blocks (news / research-stream / navigation) are gone
  // from this message. Pull the run's sources carried on the block instead.
  const srb = blocks.find((b) => b.type === "structured-report") as
    | StructuredReportBlock
    | undefined;
  if (srb) {
    for (const a of srb.news ?? []) {
      if (!a.url) continue;
      web.push({
        id: `web-r-${web.length}`,
        kind: "web",
        cite: citeCounter.n++,
        title: a.headline,
        source: a.source || prettyDomain(a.domain, a.url),
        date: a.at,
        sentiment: a.sentiment,
        domain: a.domain || prettyDomain(undefined, a.url),
        href: a.url,
      });
    }
    for (const d of srb.dataSources ?? []) {
      if (tools.some((t) => t.source === d.tool)) continue;
      tools.push({
        id: `tool-r-${d.tool}`,
        kind: "tool",
        title: d.label,
        source: d.tool,
      });
    }
    for (const s of srb.symbols ?? []) if (s) symbolSet.add(s);
    if (srb.sessionId && reports.length === 0) {
      reports.push({
        id: "report-self",
        kind: "report",
        title: "View Full Analysis",
        snippet: "Open the detailed research report",
        href: `/analysis/${encodeURIComponent(srb.sessionId)}`,
      });
    }
  }

  const symbols = [...symbolSet].map(
    (s, i) => ({ id: `sym-${i}`, kind: "symbol", title: s }) satisfies SrcRow
  );

  const groups: SrcGroup[] = [
    { key: "web", icon: Globe, title: "WEB", rows: web },
    {
      key: "filings",
      icon: Database,
      title: "DATABASE / FILINGS",
      rows: filings,
    },
    { key: "tools", icon: Wrench, title: "DATA TOOLS RUN", rows: tools },
    { key: "symbols", icon: Briefcase, title: "INSTRUMENTS", rows: symbols },
    { key: "reports", icon: FileText, title: "REPORTS & PAGES", rows: reports },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** True when the message has at least one real source to show. */
export function hasCitations(
  message: ChatMessageWithBlocks | undefined
): boolean {
  return deriveCitations(message).length > 0;
}

function RowBadge({ row }: { row: SrcRow }) {
  if (row.kind === "tool") {
    return (
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "var(--purple)",
          color: "#fff",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          border: "1.5px solid var(--ink)",
        }}
      >
        <Wrench size={12} />
      </span>
    );
  }
  if (row.kind === "symbol") {
    return (
      <span
        className="mono"
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "var(--ink)",
          color: "var(--paper)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          fontWeight: 700,
          fontSize: 9,
        }}
      >
        ₹
      </span>
    );
  }
  if (row.kind === "filing") {
    return (
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "var(--emerald-bg)",
          color: "var(--emerald)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          border: "1.5px solid var(--emerald)",
        }}
      >
        <Database size={11} />
      </span>
    );
  }
  if (row.kind === "report") {
    return (
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: "var(--paper-2)",
          color: "var(--ink-2)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
          border: "1.5px solid var(--rule-soft)",
        }}
      >
        <FileText size={11} />
      </span>
    );
  }
  return <Favicon domain={row.domain} />;
}

function SourceRow({
  row,
  hot,
  onHover,
  refCb,
}: {
  row: SrcRow;
  hot?: boolean;
  onHover?: (n: number | null) => void;
  refCb?: (el: HTMLElement | null) => void;
}) {
  const clickable = !!row.href;
  const meta = (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
        {row.cite != null && (
          <span
            className="mono"
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 5,
              fontSize: 10,
              fontWeight: 700,
              background: "var(--emerald-bg)",
              color: "var(--emerald)",
            }}
          >
            {row.cite}
          </span>
        )}
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ink)",
            lineHeight: 1.35,
          }}
        >
          {row.title}
        </span>
      </div>
      {(row.source || row.date || row.sentiment) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            flexWrap: "wrap",
            margin: "4px 0 5px",
          }}
        >
          {row.source && (
            <span
              className="mono"
              style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 600 }}
            >
              {row.source}
            </span>
          )}
          {row.date && (
            <span
              className="mono"
              style={{ fontSize: 10, color: "var(--ink-4)" }}
            >
              · {row.date}
            </span>
          )}
          {row.sentiment && <Sentiment s={row.sentiment} />}
          {clickable && (
            <ExternalLink
              size={11}
              style={{ color: "var(--ink-4)", marginLeft: "auto" }}
            />
          )}
        </div>
      )}
      {row.snippet && (
        <div
          style={{ fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.45 }}
        >
          {row.snippet}
        </div>
      )}
    </div>
  );

  const style = {
    display: "flex",
    gap: 10,
    padding: 11,
    borderRadius: 11,
    border: "1.5px solid " + (hot ? "var(--emerald)" : "var(--rule-soft)"),
    background: hot ? "var(--emerald-bg)" : "var(--paper-3)",
    cursor: clickable ? "pointer" : "default",
    textDecoration: "none",
    transition: "border-color .15s, background .15s",
    scrollMarginTop: 8,
  } as const;

  // Reverse-sync: hovering a rail row highlights its inline [n] mark too.
  const sync =
    row.cite != null
      ? {
          onMouseEnter: () => onHover?.(row.cite!),
          onMouseLeave: () => onHover?.(null),
        }
      : {};

  const inner = (
    <>
      <RowBadge row={row} />
      {meta}
    </>
  );

  if (clickable && !row.href!.startsWith("/")) {
    return (
      <a
        ref={refCb}
        href={row.href}
        target="_blank"
        rel="noopener noreferrer"
        style={style}
        {...sync}
      >
        {inner}
      </a>
    );
  }
  if (clickable) {
    return (
      <Link ref={refCb} href={row.href!} style={style} {...sync}>
        {inner}
      </Link>
    );
  }
  return (
    <div ref={refCb} style={style} {...sync}>
      {inner}
    </div>
  );
}

function SourceGroup({
  group,
  hot,
  onHover,
  registerRef,
}: {
  group: SrcGroup;
  hot: number | null;
  onHover: (n: number | null) => void;
  registerRef: (cite: number, el: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const Icon = group.icon;
  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 2px 8px",
          textAlign: "left",
          background: "transparent",
        }}
      >
        <Icon size={13} style={{ color: "var(--ink-3)" }} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "1.5px",
            color: "var(--ink-3)",
          }}
        >
          {group.title}{" "}
          <span style={{ color: "var(--ink-4)" }}>({group.rows.length})</span>
        </span>
        <span style={{ flex: 1 }} />
        <ChevronDown
          size={14}
          style={{
            color: "var(--ink-4)",
            transform: open ? "none" : "rotate(-90deg)",
            transition: "transform .15s",
          }}
        />
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {group.rows.map((row) => (
            <SourceRow
              key={row.id}
              row={row}
              hot={row.cite != null && hot === row.cite}
              onHover={onHover}
              refCb={
                row.cite != null
                  ? (el) => registerRef(row.cite!, el)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CitationsRail({
  message,
  onClose,
  open = true,
}: {
  message: ChatMessageWithBlocks | undefined;
  onClose?: () => void;
  /**
   * Drawer open state. Below 1280px the rail is an off-canvas drawer that
   * slides in from the right; at >=1280px it is an inline 3rd pane. When
   * `false`, the drawer is parked off-screen (mobile) / hidden (desktop).
   * Defaults to `true` so callers that don't manage the drawer keep the
   * original always-inline behaviour.
   */
  open?: boolean;
}) {
  const groups = useMemo(() => deriveCitations(message), [message]);
  const total = useMemo(
    () => groups.reduce((n, g) => n + g.rows.length, 0),
    [groups]
  );
  const { hot, scrollKey } = useCitationState();
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLElement | null>>(new Map());
  const registerRef = (cite: number, el: HTMLElement | null) => {
    rowRefs.current.set(cite, el);
  };
  // Click a [n] mark → scroll the rail to its source row. scrollKey bumps only
  // on click, so a hover-highlight alone never yanks the scroll position.
  useEffect(() => {
    if (hot == null || !bodyRef.current) return;
    const el = rowRefs.current.get(hot);
    if (el)
      bodyRef.current.scrollTo({ top: el.offsetTop - 12, behavior: "smooth" });
  }, [scrollKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (groups.length === 0) return null;

  return (
    <aside
      className={`pf-app ss-right flex flex-col h-full ${open ? "is-open" : "is-closed"}`}
      aria-label="Sources"
    >
      <div
        className="flex items-center gap-2.5 px-3.5 py-3 shrink-0"
        style={{ borderBottom: "2px solid var(--ink)" }}
      >
        <Link2 size={15} style={{ color: "var(--emerald)" }} />
        <span style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
          Sources{" "}
          <span className="mono" style={{ color: "var(--ink-3)" }}>
            ({total})
          </span>
        </span>
        <span style={{ flex: 1 }} />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sources"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              display: "grid",
              placeItems: "center",
              color: "var(--ink-3)",
              background: "transparent",
            }}
          >
            <X size={15} />
          </button>
        )}
      </div>

      <div
        ref={bodyRef}
        className="flex-1 overflow-y-auto"
        style={{ padding: "14px 14px 24px" }}
      >
        {groups.map((group) => (
          <SourceGroup
            key={group.key}
            group={group}
            hot={hot}
            onHover={setHotCitation}
            registerRef={registerRef}
          />
        ))}
        <div
          className="serif"
          style={{
            fontSize: 13,
            color: "var(--ink-4)",
            textAlign: "center",
            paddingTop: 6,
            borderTop: "1px dashed var(--rule-soft)",
          }}
        >
          De-duplicated by URL · live-fetched
        </div>
      </div>
    </aside>
  );
}
