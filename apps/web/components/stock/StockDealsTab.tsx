"use client";

/**
 * Bulk & block deals — MONEY-1204 (P14 / 14c.6).
 *
 * NSE's bulk and block files are the only free Indian feed that names WHO
 * traded. `clientName` is therefore the point of the section, not a detail:
 * everything else here (repeat-counterparty detection, the buy/sell split) is
 * only possible because the print is attributed.
 *
 * ## Rendering rules that are load-bearing
 *
 * - **`remarks` is null on `-` AND when `block.csv` omits the column.** Both
 *   render as nothing at all. Printing the word "null", or a bare dash where a
 *   sentence belongs, is the failure this note exists to prevent.
 * - **Value is qty × price only when BOTH are known.** A missing price makes the
 *   value unknown, not ₹0 — a zero there reads as a free trade.
 * - **A repeat counterparty is a flag, not a verdict.** Two prints in 90 days is
 *   what the badge means and what its tooltip says; it is not "accumulation",
 *   which would be an inference we cannot support from a disclosure file.
 *
 * Theme-aware tokens for neutrals; accents use the literal Tailwind palette.
 */

import { useEffect, useState } from "react";
import { Handshake, Repeat2 } from "lucide-react";
import {
  getStockDealsSectionAction,
  type StockDealsSectionData,
} from "@/lib/actions/stock-sections-ownership";
import { SectionShell } from "./SectionShell";

type DealRow = StockDealsSectionData["deals"][number];
type Coverage = StockDealsSectionData["coverage"];
type RepeatRow = StockDealsSectionData["repeatClients"][number];

interface StockDealsTabProps {
  symbol: string;
  exchange?: string;
}

function fmtQty(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-IN");
}

function fmtInr(n: number | null | undefined, dp = 2): string {
  return n === null || n === undefined
    ? "—"
    : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: dp })}`;
}

function fmtNet(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${n > 0 ? "+" : ""}${n.toLocaleString("en-IN")}`;
}

/** `2026-08-04` → `04 Aug 2026`. Day-only strings, so no timezone shifting. */
function fmtIsoDay(isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!m) return isoDay;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const mon = months[Number(m[2]) - 1];
  return mon === undefined ? isoDay : `${m[3]} ${mon} ${m[1]}`;
}

function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

export function StockDealsTab({
  symbol,
  exchange = "NSE",
}: StockDealsTabProps) {
  const [data, setData] = useState<StockDealsSectionData | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [coverage, setCoverage] = useState<Coverage>(null);
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockDealsSectionAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) {
          setData(r.data.data);
          setSource(r.data.source);
          setAsOf(r.data.asOf);
          setNote(r.data.note);
          setCoverage(r.data.data.coverage);
          setEmpty(r.data.empty);
        } else {
          setError(r.error ?? "Failed to load bulk & block deals");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  const eyebrow =
    data && data.dealCount > 0
      ? `${data.bulkCount} bulk · ${data.blockCount} block`
      : undefined;

  return (
    <SectionShell
      title="Bulk & block deals"
      Icon={Handshake}
      eyebrow={eyebrow}
      loading={loading}
      error={error}
      empty={empty}
      // MONEY-1255 — the coverage WINDOW is the load-bearing half here and the
      // reason this note is assembled rather than dropped: without it a reader
      // cannot tell "no print above the disclosure threshold" from "our
      // backfill does not reach that far", and `coverageNote` says which.
      emptyNote={[
        `We track every disclosed bulk and block print for ${symbol}. These files carry only trades above the disclosure threshold, and we hold none for this stock inside the covered window.`,
        coverageNote(coverage),
      ]
        .filter(Boolean)
        .join(" ")}
      source={source}
      asOf={asOf}
      note={note}
      skeleton={<DealsSkeleton />}
    >
      {data && (
        <div className="space-y-3">
          {/* MONEY-1205 — the window this section can speak for, said out loud.
              `asOf` is THIS STOCK's newest print, so a quiet name headlines a
              date from 2024 and reads as a dead feed. It is not: the covered
              window below is market-wide and current, which turns an old date
              back into what it is — this stock had nothing to disclose. */}
          <CoverageLine coverage={coverage} />
          {data.repeatClients.length > 0 && (
            <RepeatStrip
              clients={data.repeatClients}
              windowDays={data.windowDays}
              minPrints={data.minPrints}
            />
          )}
          <div className="space-y-2">
            {data.deals.map((d, i) => (
              <DealCard key={d.id ?? `${d.dateIso}-${i}`} deal={d} />
            ))}
          </div>
        </div>
      )}
    </SectionShell>
  );
}

/**
 * The feed's covered window, in one line.
 *
 * Renders NOTHING when the probe returned null or found no days — an unknown
 * window must not be dressed up as a known one, and the panel is complete
 * without it. `continuousFrom === null` means we cannot currently claim daily
 * coverage at all, so it says only what it measured: the newest print.
 */
/**
 * {@link CoverageLine} as a plain string — MONEY-1255.
 *
 * The empty box no longer renders JSX, so the coverage window it used to carry
 * has to reach the tooltip as text. Exported and pure so the two stay in step:
 * `empty-state-copy.test.ts` asserts the backfill caveat survives the flatten,
 * which it cannot do against markup.
 */
export function coverageNote(coverage: Coverage): string | null {
  if (!coverage || coverage.latestDay === null) return null;
  const latest = fmtIsoDay(coverage.latestDay);
  if (coverage.continuousFrom === null) {
    return `Newest disclosed print anywhere in this feed: ${latest}.`;
  }
  const from = fmtIsoDay(coverage.continuousFrom);
  return (
    `Daily coverage ${from} → ${latest} (${coverage.continuousDays} sessions). ` +
    `Earlier days are a partial backfill, so a gap before ${from} is not ` +
    "evidence that no print happened."
  );
}

function CoverageLine({
  coverage,
  className,
}: {
  coverage: Coverage;
  className?: string;
}) {
  if (!coverage || coverage.latestDay === null) return null;
  const latest = fmtIsoDay(coverage.latestDay);
  return (
    <p
      className={
        "text-[11.5px] italic leading-relaxed text-[var(--text-dim)] " +
        (className ?? "")
      }
    >
      {coverage.continuousFrom === null ? (
        <>Newest disclosed print anywhere in this feed: {latest}.</>
      ) : (
        <>
          Daily coverage {fmtIsoDay(coverage.continuousFrom)} → {latest} (
          {coverage.continuousDays} sessions). Earlier days are a partial
          backfill, so a gap before {fmtIsoDay(coverage.continuousFrom)} is not
          evidence that no print happened.
        </>
      )}
    </p>
  );
}

function RepeatStrip({
  clients,
  windowDays,
  minPrints,
}: {
  clients: RepeatRow[];
  windowDays: number;
  minPrints: number;
}) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <Repeat2 className="h-3.5 w-3.5 text-emerald-400" />
        <span className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
          Repeat counterparties · {windowDays}d
        </span>
      </div>
      <div className="space-y-2">
        {clients.map((c) => (
          <div
            key={c.key}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
            title={`${c.prints} disclosed prints in the last ${windowDays} days (threshold ${minPrints}). A repeat print is not by itself evidence of accumulation.`}
          >
            <span className="text-[13px] font-semibold text-[var(--text-primary)]">
              {c.clientName}
            </span>
            <span className="font-mono text-[11px] text-[var(--text-muted)]">
              {c.prints} prints · {c.buyPrints}B / {c.sellPrints}S
            </span>
            <span
              className={`ml-auto font-mono text-[12px] ${
                c.netQty === null
                  ? "text-[var(--text-muted)]"
                  : c.netQty > 0
                    ? "text-emerald-400"
                    : c.netQty < 0
                      ? "text-red-400"
                      : "text-[var(--text-primary)]"
              }`}
            >
              net {fmtNet(c.netQty)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DealCard({ deal }: { deal: DealRow }) {
  const sideStyle =
    deal.side === "BUY"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
      : deal.side === "SELL"
        ? "border-red-400/30 bg-red-400/10 text-red-400"
        : // The file omitted or garbled the side. Neutral, never assumed.
          "border-[var(--border-default)] bg-[var(--paper)] text-[var(--text-muted)]";

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] text-[var(--text-muted)]">
          {fmtDay(deal.dateIso)}
        </span>
        <span
          className={`rounded border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.5px] ${sideStyle}`}
        >
          {deal.side ?? "side n/a"}
        </span>
        <span className="rounded border border-[var(--border-default)] px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.5px] text-[var(--text-dim)]">
          {deal.dealType || "—"}
        </span>
        {deal.repeatClient && (
          <span
            title="This counterparty has more than one disclosed print in the window."
            className="flex items-center gap-1 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.5px] text-emerald-400"
          >
            <Repeat2 className="h-3 w-3" />
            repeat
          </span>
        )}
      </div>
      <div className="text-[13.5px] font-semibold leading-snug text-[var(--text-primary)]">
        {deal.clientName}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11.5px] text-[var(--text-dim)]">
        <span>Qty {fmtQty(deal.qty)}</span>
        <span>Avg {fmtInr(deal.avgPrice)}</span>
        <span>Value {fmtInr(deal.value, 0)}</span>
      </div>
      {/* Rendered only when the feed actually said something. `remarks` is null
          on `-` and when block.csv omits the column entirely. */}
      {deal.remarks && (
        <p className="mt-1.5 text-[11.5px] italic text-[var(--text-dim)]">
          {deal.remarks}
        </p>
      )}
    </div>
  );
}

/** Shimmer mirroring the populated layout: repeat strip, then deal rows. */
function DealsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
        <div className="mb-3 h-3 w-40 rounded bg-emerald-400/[0.10]" />
        <div className="h-4 w-2/3 rounded bg-white/[0.06]" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4"
        >
          <div className="mb-2 h-3 w-36 rounded bg-white/[0.04]" />
          <div className="mb-2 h-4 w-1/2 rounded bg-white/[0.06]" />
          <div className="h-3 w-2/5 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

export default StockDealsTab;
