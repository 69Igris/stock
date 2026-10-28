"use client";

/**
 * Filings & documents timeline — MONEY-1204 (P14 / 14c.7).
 *
 * Everything we have indexed for this company, newest-PERIOD first, with the
 * next scheduled event pinned above it.
 *
 * Three things this component is careful about, all of which are easy to "fix"
 * into a bug:
 *
 * 1. **The date is labelled "indexed", never "filed".** `StockDocument` has no
 *    filing-date column — `period` is free-form (`nse-{seq_id}` for
 *    announcements) and `fetchedAt` is set to `new Date()` by every writer at
 *    ingest. A column headed "Filed" over ingest timestamps would be a
 *    fabricated fact, and a backfill would make it obviously wrong.
 *
 * 2. **A document whose extraction is PENDING or FAILED still renders.** That
 *    status describes OUR pipeline, not the filing. Hiding those rows would put
 *    an internal job's state in front of real published documents — and make a
 *    stalled extractor look like a quiet company. Only the "search inside"
 *    affordance is gated on READY; the link to the exchange's own attachment is
 *    offered regardless.
 *
 * 3. **Our pipeline's state is not the reader's business** (MONEY-1255). The
 *    row used to carry a "QUEUED FOR EXTRACTION" pill and a per-row "INDEXED
 *    19 APR 2026 · SCREENER" line. Both were TRUE and both were noise: 36,027
 *    of 43,031 documents are PENDING, so the pill printed on nearly every row
 *    and distinguished nothing, and the ingest line repeats identically down a
 *    whole page because a backfill writes a company's history in one pass. The
 *    ingest provenance now lives in the row's `title` tooltip (inspectable, not
 *    shouted) and the section's own chip carries it once, where it is a real
 *    signal — a section that stopped updating three weeks ago should say so.
 *    `statusLabel` / `readable` still arrive from the server; this component
 *    just stops painting them.
 */

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, CalendarClock } from "lucide-react";
import {
  getStockFilingsTimelineAction,
  type StockFilingsTimelineData,
} from "@/lib/actions/stock-sections-docs";
import {
  SectionShell,
  SectionEmptyInline,
  formatAsOf,
  type SectionProvenance,
} from "./SectionShell";

type DocCategory = StockFilingsTimelineData["items"][number]["category"];

const CATEGORY_ORDER: DocCategory[] = [
  "result",
  "annual_report",
  "transcript",
  "announcement",
  "other",
];

const CATEGORY_LABEL: Record<DocCategory, string> = {
  result: "Results",
  annual_report: "Annual reports",
  transcript: "Transcripts",
  announcement: "Announcements",
  other: "Other",
};

interface StockFilingsTimelineProps {
  symbol: string;
  exchange?: string;
  className?: string;
}

export function StockFilingsTimeline({
  symbol,
  exchange = "NSE",
  className = "",
}: StockFilingsTimelineProps) {
  const [data, setData] = useState<StockFilingsTimelineData | null>(null);
  const [prov, setProv] = useState<SectionProvenance>({});
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<DocCategory | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setActive(null);
    getStockFilingsTimelineAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) {
          setData(r.data.data);
          setProv({
            source: r.data.source,
            asOf: r.data.asOf,
            fallback: r.data.fallback,
            note: r.data.note,
          });
          setEmpty(r.data.empty);
        } else {
          setError(r.error ?? "Failed to load filings");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  const items = useMemo(() => {
    if (!data) return [];
    return active === null
      ? data.items
      : data.items.filter((d) => d.category === active);
  }, [data, active]);

  const chips = CATEGORY_ORDER.filter((c) => (data?.counts?.[c] ?? 0) > 0);

  return (
    <SectionShell
      title="Filings & documents"
      Icon={FileText}
      eyebrow={
        data && data.items.length > 0
          ? `${data.items.length} doc${data.items.length === 1 ? "" : "s"}`
          : undefined
      }
      loading={loading}
      error={error}
      empty={empty}
      // MONEY-1255 — `emptyNote`, not `emptyMessage`. The visible body is the
      // generic sentence for every section; this one carries the DISTINCTION
      // that matters here — "published" (the exchange filed nothing) versus
      // "picked up" (our ingest has not reached this company) — into the
      // box's tooltip, where it stays available without being the headline.
      emptyNote={
        `We index NSE and BSE filings, annual reports and earnings-call ` +
        `transcripts for ${symbol}. Nothing has been published — or picked ` +
        `up — for this company yet.`
      }
      className={className}
      {...prov}
    >
      {data && (
        <div className="space-y-3">
          {data.pinned && <PinnedEventCard event={data.pinned} />}

          {chips.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip
                label="All"
                count={data.items.length}
                active={active === null}
                onClick={() => setActive(null)}
              />
              {chips.map((c) => (
                <FilterChip
                  key={c}
                  label={CATEGORY_LABEL[c]}
                  count={data.counts[c]}
                  active={active === c}
                  onClick={() => setActive(active === c ? null : c)}
                />
              ))}
            </div>
          )}

          {/* No "N documents awaiting text extraction" banner — see header
              note 3. `notReadyCount` still ships in the payload and still
              reaches the provenance tooltip via the service's note. */}

          {items.length === 0 ? (
            // MONEY-1255 — was a re-typed copy of `SectionShell`'s dashed
            // box. Near-unreachable in practice: the category chips carry
            // their own counts, so a chip the reader can click always has at
            // least one row, and a genuinely empty section is caught by the
            // shell's own `empty` branch above. Kept, migrated, and given the
            // filter name as its tooltip rather than deleted, because "kept
            // but unreachable" is cheaper to be wrong about than "deleted and
            // it turned out to be reachable".
            <SectionEmptyInline
              className="px-6 py-8 text-center"
              note={
                active
                  ? `No ${CATEGORY_LABEL[active].toLowerCase()} match this filter.`
                  : null
              }
            />
          ) : (
            <ol className="space-y-2">
              {items.map((d) => (
                <li key={d.id}>
                  <DocumentRow doc={d} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-full border px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[1px] transition-colors " +
        (active
          ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-400"
          : "border-[var(--border-default)] text-[var(--text-muted)] hover:text-[var(--text-primary)]")
      }
    >
      {label}
      <span className="ml-1.5 opacity-70">{count}</span>
    </button>
  );
}

function PinnedEventCard({
  event,
}: {
  event: NonNullable<StockFilingsTimelineData["pinned"]>;
}) {
  const when = formatAsOf(event.date);
  const away =
    event.daysAway === null
      ? null
      : event.daysAway === 0
        ? "today"
        : event.daysAway === 1
          ? "tomorrow"
          : `in ${event.daysAway} days`;
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4">
      <div className="mb-1 flex items-center gap-2">
        <CalendarClock className="h-3.5 w-3.5 text-amber-400" />
        <span className="font-mono text-[10px] uppercase tracking-[1px] text-amber-400">
          Upcoming · {event.category}
        </span>
        {event.source && (
          <span className="ml-auto font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
            {event.source}
          </span>
        )}
      </div>
      <p className="text-[13.5px] font-semibold text-[var(--text-primary)]">
        {event.title}
      </p>
      <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
        {when}
        {away ? ` · ${away}` : ""}
      </p>
    </div>
  );
}

function DocumentRow({
  doc,
}: {
  doc: StockFilingsTimelineData["items"][number];
}) {
  const indexed = formatAsOf(doc.indexedAt);
  // Ingest provenance, kept INSPECTABLE rather than printed on every row: it is
  // when WE scraped the document, not when the company filed it, and a backfill
  // stamps a whole history with one timestamp. See header note 3.
  const ingestTooltip =
    [indexed ? `Indexed ${indexed}` : "Index date unknown", doc.sourceType]
      .filter(Boolean)
      .join(" · ") + " — when we indexed it, not when it was filed";
  return (
    <div
      title={ingestTooltip}
      className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4"
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[1px] text-emerald-400">
          {doc.categoryLabel}
        </span>
        {doc.period && (
          <span className="font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
            {doc.period}
          </span>
        )}
        {doc.sourceUrl && (
          <a
            href={doc.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)] hover:text-emerald-400"
          >
            Original <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <p className="text-[13.5px] font-medium leading-snug text-[var(--text-primary)]">
        {doc.title}
      </p>
      {doc.description && (
        <p className="mt-1 line-clamp-2 text-[12px] text-[var(--text-muted)]">
          {doc.description}
        </p>
      )}
    </div>
  );
}

export default StockFilingsTimeline;
