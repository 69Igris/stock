"use client";

/**
 * Peers tab for the Stock detail page (MONEY-244 v3.1).
 *
 * Renders a compact peer-comparison table sourced from `StockPeers`
 * (populated by the existing Tickertape scraper). Each row is a peer
 * with mcap / P/E / ROE / today's change% - clicking the row opens
 * the peer's detail page so the user can chain comparisons.
 *
 * `StockPeerRow.marketCap` is in CRORES — it is copied straight out of
 * `StockRatios.marketCap` by `peers-sync.service.ts` and passes through the
 * action, the service and `/v1` un-scaled. This file used to carry a local
 * `fmtMcap` that divided it by 1e7 as if it were rupees, so APOLLOTYRE's
 * ₹28,023 Cr became 0.0028 and `.toFixed(0)` rendered "₹0 Cr" — for EVERY row
 * in the market. That is MONEY-1144's exact failure a second time, on a second
 * surface, because the formatter was file-local and therefore unimportable and
 * untestable. It now uses the shared `formatMarketCapCrores`, which the
 * Fundamentals card on this same page already uses (MONEY-1255).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import {
  getStockPeersAction,
  type StockPeerRow,
} from "@/lib/actions/stock-tabs";
import { formatMarketCapCrores } from "@/app/stock/[symbol]/stock-format";
import { SectionEmpty } from "./SectionShell";

interface StockPeersTabProps {
  symbol: string;
  exchange: string;
}

function fmtNum(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return v.toFixed(digits);
}
function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function StockPeersTab({ symbol, exchange }: StockPeersTabProps) {
  const [peers, setPeers] = useState<StockPeerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockPeersAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) setPeers(r.data);
        else setError(r.error ?? "Failed to load peers");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Users className="h-4 w-4 text-emerald-400" />
        <h3 className="font-display text-[16px] font-bold tracking-[-0.2px]">
          Peers
        </h3>
        <span className="font-mono text-[10.5px] tracking-[1px] uppercase text-[var(--text-muted)] ml-2">
          Sector comparison
        </span>
      </div>

      {loading ? (
        <PeersTableSkeleton />
      ) : error ? (
        <div className="rounded-xl border border-red-400/20 bg-red-400/5 p-6 text-center text-red-400/80 text-sm">
          {error}
        </div>
      ) : peers.length === 0 ? (
        // MONEY-1255 — was a byte-identical copy of `SectionShell`'s dashed
        // box carrying its own sentence. Nothing provenance-bearing was lost:
        // "Peer data for X isn't available yet" said only what the generic
        // body says, and peers are DERIVED from our own instrument/ratio/quote
        // data, so an empty result is never an upstream publishing fact worth
        // distinguishing in a note.
        <SectionEmpty />
      ) : (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="bg-white/[0.02]">
                  <th className="px-4 py-2.5 text-left font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)]">
                    Symbol
                  </th>
                  <th className="px-4 py-2.5 text-left font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)]">
                    Name
                  </th>
                  <th className="px-4 py-2.5 text-right font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)]">
                    MCap
                  </th>
                  <th className="px-4 py-2.5 text-right font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)]">
                    P/E
                  </th>
                  <th className="px-4 py-2.5 text-right font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)]">
                    ROE
                  </th>
                  <th className="px-4 py-2.5 text-right font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)]">
                    Today
                  </th>
                </tr>
              </thead>
              <tbody>
                {peers.map((p) => {
                  const pos = (p.changePercent ?? 0) >= 0;
                  return (
                    <tr
                      key={p.symbol}
                      className="border-t border-[var(--border-default)] hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="px-4 py-2.5 font-mono font-bold text-emerald-400">
                        <Link
                          href={`/stock/${p.symbol}?exchange=NSE`}
                          className="hover:underline"
                        >
                          {p.symbol}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-secondary)] truncate max-w-[260px]">
                        {p.name}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[var(--text-secondary)]">
                        {formatMarketCapCrores(p.marketCap)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-[var(--text-dim)]">
                        {fmtNum(p.pe, 1)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-mono tabular-nums ${(p.roe ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {fmtNum(p.roe, 1)}%
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${pos ? "text-emerald-400" : "text-red-400"}`}
                      >
                        {fmtPct(p.changePercent)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Shimmer placeholder mirroring the populated peer table density. */
function PeersTableSkeleton() {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] overflow-hidden">
      <div className="grid grid-cols-6 gap-4 px-4 py-3 border-b border-[var(--border-default)] bg-white/[0.02]">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3 bg-white/[0.06] rounded animate-pulse" />
        ))}
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-6 gap-4 px-4 py-3 border-b last:border-b-0 border-[var(--border-default)] animate-pulse"
        >
          <div className="h-4 bg-emerald-400/[0.10] rounded" />
          <div className="h-4 bg-white/[0.04] rounded" />
          <div className="h-4 bg-white/[0.04] rounded" />
          <div className="h-4 bg-white/[0.04] rounded" />
          <div className="h-4 bg-white/[0.04] rounded" />
          <div className="h-4 bg-white/[0.04] rounded" />
        </div>
      ))}
    </div>
  );
}

export default StockPeersTab;
