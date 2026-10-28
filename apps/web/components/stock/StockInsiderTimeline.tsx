"use client";

/**
 * Insider & promoter activity — MONEY-1204 (P14 / 14c.5).
 *
 * A month-grouped timeline of SEBI PIT / SAST Reg-29 / promoter-pledge filings,
 * headed by a netted 90-day summary.
 *
 * ## Three things this component must not do
 *
 * **1. Drop a row it does not recognise.** `InsiderEvent.action` is BUY, SELL
 * or one of three PLEDGE_* values — *or the verbatim upper-cased source text*,
 * because upstream deliberately has no OTHER bucket (the day SEBI adds a
 * transaction type, an OTHER bucket makes every row of it indistinguishable
 * from every other unknown). So an action string this UI has never seen is
 * NORMAL input: it renders in a neutral chip with its own words, and it is
 * excluded from the net rather than guessed at.
 *
 * **2. Print 0 for "not disclosed".** Quantities and rupee values are nullable
 * throughout. A dash is the truth; a zero is a claim the filer never made. The
 * summary carries `undisclosedQtyCount` so the net can say what it excludes.
 *
 * **3. Assert a document link.** The related-filing link is a date-proximity
 * heuristic against `StockDocument.fetchedAt` — our INGEST time, since that
 * table has no filing-date column at all. It is labelled "likely" on screen for
 * that reason, and the label is not decoration.
 *
 * Theme-aware tokens for neutrals; accents use the literal Tailwind palette,
 * which is the established split in `components/stock/*`.
 */

import { useEffect, useState } from "react";
import { ExternalLink, UserCheck } from "lucide-react";
import {
  getStockInsiderActivityAction,
  type StockInsiderSectionData,
} from "@/lib/actions/stock-sections-ownership";
import { SectionShell } from "./SectionShell";

type MonthGroup = StockInsiderSectionData["months"][number];
type EventRow = MonthGroup["events"][number];
type Summary = StockInsiderSectionData["summary"];

interface StockInsiderTimelineProps {
  symbol: string;
  exchange?: string;
}

/** Quantities: grouped Indian digits, or a dash when nothing was disclosed. */
function fmtQty(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-IN");
}

/** Rupees. Null is "not disclosed", never ₹0. */
function fmtInr(n: number | null | undefined): string {
  return n === null || n === undefined
    ? "—"
    : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

/** Signed quantity, so a net sale reads as one at a glance. */
function fmtNet(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toLocaleString("en-IN")}`;
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

const DIRECTION_STYLE: Record<EventRow["direction"], string> = {
  BUY: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400",
  SELL: "border-red-400/30 bg-red-400/10 text-red-400",
  PLEDGE: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  // Deliberately neutral. An unrecognised action has no known direction, and
  // colouring it green or red would state one.
  UNKNOWN:
    "border-[var(--border-default)] bg-[var(--paper)] text-[var(--text-muted)]",
};

export function StockInsiderTimeline({
  symbol,
  exchange = "NSE",
}: StockInsiderTimelineProps) {
  const [data, setData] = useState<StockInsiderSectionData | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockInsiderActivityAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) {
          setData(r.data.data);
          setSource(r.data.source);
          setAsOf(r.data.asOf);
          setNote(r.data.note);
          setEmpty(r.data.empty);
        } else {
          setError(r.error ?? "Failed to load insider activity");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  // "entries", not "filings" — MONEY-1205. A pledge row is a daily snapshot of
  // a standing position, not something anybody filed that day, and on a pledged
  // stock those rows are most of the list.
  const entries = data?.eventCount ?? 0;

  return (
    <SectionShell
      title="Insider & promoter activity"
      Icon={UserCheck}
      eyebrow={
        entries > 0
          ? `${entries} entr${entries === 1 ? "y" : "ies"}`
          : undefined
      }
      loading={loading}
      error={error}
      empty={empty}
      // MONEY-1255 — demoted, not deleted. This one is the "the exchange
      // genuinely published nothing" half of the distinction: the filings are
      // event-driven, so an absence is a real fact about the company rather
      // than a gap in our sync (contrast `StockShareholdingSection`).
      emptyNote={
        `We track SEBI PIT, SAST Reg-29 and promoter-pledge filings for ${symbol}. ` +
        "The exchange has published none for this stock."
      }
      source={source}
      asOf={asOf}
      note={note}
      skeleton={<InsiderSkeleton />}
    >
      {data && (
        <div className="space-y-4">
          <NetSummary summary={data.summary} />
          {data.months.map((m) => (
            <div key={m.monthKey}>
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
                  {m.label}
                </span>
                <span className="h-px flex-1 bg-[var(--rule-soft)]" />
                <span className="font-mono text-[10.5px] text-[var(--text-dim)]">
                  {m.events.length}
                </span>
              </div>
              <div className="space-y-2">
                {m.events.map((e, i) => (
                  <EventCard key={e.id ?? `${m.monthKey}-${i}`} event={e} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

/**
 * The netted 90-day headline.
 *
 * `undisclosedQtyCount` is shown rather than hidden: a net computed from four
 * filings when six were made is a different number from a complete one, and the
 * user is the only one who can decide whether that matters.
 */
function NetSummary({ summary }: { summary: Summary }) {
  // Real pledge FILINGS (SAST/PIT `PLEDGE …` actions) versus NSE's daily
  // snapshot rows. `pledgeCount` is the total; the snapshots are its subset.
  const pledgeFilings = Math.max(
    0,
    summary.pledgeCount - summary.pledgeSnapshotCount
  );
  const netTone =
    summary.netQty === null
      ? "text-[var(--text-muted)]"
      : summary.netQty > 0
        ? "text-emerald-400"
        : summary.netQty < 0
          ? "text-red-400"
          : "text-[var(--text-primary)]";

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <div className="mb-3 font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
        Last {summary.windowDays} days
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Net qty" value={fmtNet(summary.netQty)} tone={netTone} />
        <Stat
          label={`Bought (${summary.buyCount})`}
          value={fmtQty(summary.buyQty)}
        />
        <Stat
          label={`Sold (${summary.sellCount})`}
          value={fmtQty(summary.sellQty)}
        />
        <Stat
          label="Net value"
          value={fmtInr(summary.netValue)}
          tone={netTone}
        />
      </div>
      {(summary.pledgeCount > 0 ||
        summary.unknownCount > 0 ||
        summary.undisclosedQtyCount > 0) && (
        <p className="mt-3 text-[11.5px] italic leading-relaxed text-[var(--text-dim)]">
          {/* Each clause names something the NET does not include. Saying so is
              the difference between an incomplete number and a wrong one. */}
          {pledgeFilings > 0 && (
            <>
              Excludes {pledgeFilings} pledge filing
              {pledgeFilings === 1 ? "" : "s"} (no change of ownership).{" "}
            </>
          )}
          {/* MONEY-1205 — NSE's pledge feed is a DAILY COMPANY SNAPSHOT of a
              running `numSharesPledged` total, not a stream of filings. Calling
              a re-statement of the same standing position an "event" invents an
              event; counting sixty of them invents sixty. */}
          {summary.pledgeSnapshotCount > 0 && (
            <>
              Excludes {summary.pledgeSnapshotCount} daily pledge snapshot
              {summary.pledgeSnapshotCount === 1 ? "" : "s"} — a running total
              of pledged shares, restated each session, not a trade.{" "}
            </>
          )}
          {/* The banner is SUPPRESSED for pledges, not merely reworded: with
              `category` outranking `action` upstream, a pledge row is no longer
              "unrecognised" at all, so `unknownCount` counts only actions we
              genuinely cannot classify. Every pledge row on prod carries an
              empty action (5,734 of 5,734), which is what used to make this
              sentence appear on every pledged stock in the market. */}
          {summary.unknownCount > 0 && (
            <>
              {summary.unknownCount} filing
              {summary.unknownCount === 1 ? "" : "s"} with an unrecognised
              transaction type shown below but not netted.{" "}
            </>
          )}
          {summary.undisclosedQtyCount > 0 && (
            <>
              {summary.undisclosedQtyCount} filing
              {summary.undisclosedQtyCount === 1 ? "" : "s"} disclosed no
              quantity.
            </>
          )}
        </p>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "text-[var(--text-primary)]",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
        {label}
      </div>
      <div className={`mt-0.5 font-display text-[15px] font-bold ${tone}`}>
        {value}
      </div>
    </div>
  );
}

function EventCard({ event }: { event: EventRow }) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
          {fmtDay(event.dateIso)}
        </span>
        <span
          className={`rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.5px] ${DIRECTION_STYLE[event.direction]}`}
        >
          {/* Verbatim for an unrecognised action — the feed's own words are more
              informative than a bucket name, and rewriting them hides the case
              the no-OTHER-bucket design exists to expose. */}
          {event.actionLabel}
        </span>
        <span className="rounded border border-[var(--border-default)] px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.5px] text-[var(--text-dim)]">
          {event.category}
        </span>
        {event.document && (
          <a
            href={event.document.sourceUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={
              "Matched to a filing published within " +
              `${Math.abs(event.document.dayGap)} day(s) of this transaction. ` +
              "This is a date-proximity match, not a stated relationship."
            }
            className="ml-auto flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.5px] text-[var(--text-muted)] hover:text-emerald-400"
          >
            likely filing
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="text-[13.5px] font-semibold leading-snug text-[var(--text-primary)]">
        {/* MONEY-1205 — `personLabel`, not `person ?? "Person not disclosed"`.
            NSE's `/api/corporate-pledgedata` has NO pledgor column, so "not
            disclosed" accused a filer of withholding a field that does not
            exist. The label is computed in core beside the direction rule. */}
        {event.personLabel}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-[var(--text-dim)]">
        <span>Qty {fmtQty(event.qty)}</span>
        <span>Value {fmtInr(event.value)}</span>
      </div>
    </div>
  );
}

/** Shimmer mirroring the real layout: a summary card, then two filing rows. */
function InsiderSkeleton() {
  return (
    <div className="space-y-3">
      <div className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
        <div className="mb-3 h-3 w-24 rounded bg-emerald-400/[0.10]" />
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <div className="mb-1 h-2.5 w-12 rounded bg-white/[0.04]" />
              <div className="h-4 w-16 rounded bg-white/[0.06]" />
            </div>
          ))}
        </div>
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4"
        >
          <div className="mb-2 h-3 w-32 rounded bg-white/[0.04]" />
          <div className="mb-2 h-4 w-2/3 rounded bg-white/[0.06]" />
          <div className="h-3 w-1/3 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

export default StockInsiderTimeline;
