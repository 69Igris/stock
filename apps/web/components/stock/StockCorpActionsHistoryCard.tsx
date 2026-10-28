"use client";

/**
 * Corporate actions & dividends — persisted HISTORY card for the Stock detail
 * "News & events" tab (MONEY-797 / C3b).
 *
 * Unlike the recent-window `StockCorpActionsCard`, this reads the persisted
 * `CorporateAction` history (DB-first, with a live read-through warm-up on an
 * empty DB) and shows the full timeline plus a dividend-trend sub-view. The card
 * collapses to nothing when there's no history so the tab stays clean.
 *
 * Descriptive only — dates, type, details, value/ratio. No recommendation, no
 * advice (SEBI-neutral exchange-filing data).
 */

import { useEffect, useState } from "react";
import { CalendarClock, Coins } from "lucide-react";
import {
  getCorporateActionsHistoryAction,
  type CorporateActionHistoryRow,
} from "@/lib/actions/stock-tabs";
import { SectionEmpty } from "./SectionShell";

interface Props {
  symbol: string;
  exchange: string;
}

const TYPE_COLOR: Record<string, string> = {
  DIVIDEND: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  SPLIT: "text-sky-400 border-sky-400/30 bg-sky-400/10",
  BONUS: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  RIGHTS: "text-violet-400 border-violet-400/30 bg-violet-400/10",
  BUYBACK: "text-rose-400 border-rose-400/30 bg-rose-400/10",
  AGM: "text-slate-400 border-slate-400/30 bg-slate-400/10",
};

function typeClass(t: string): string {
  return (
    TYPE_COLOR[t.toUpperCase()] ??
    "text-[var(--text-secondary)] border-[var(--border-default)] bg-white/[0.03]"
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    // timeZone IS REQUIRED — MONEY-1527. "en-IN" sets the LOCALE, not the
    // zone. `iso` is a bare "YYYY-MM-DD", which parses as UTC midnight and is
    // then formatted in the VIEWER's zone: a browser in America/New_York
    // renders 2022-07-28 as "27 Jul 2022". The card would then disagree by a
    // day with the chart glyph on the same page, which is the exact outcome
    // `stock-tabs.ts` computes this string in IST to prevent.
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** "DIVIDEND" + value 10 → "₹10 / share"; SPLIT/BONUS → the ratio. */
function valueLabel(a: CorporateActionHistoryRow): string | null {
  const t = a.actionType.toUpperCase();
  if (t === "DIVIDEND" && a.value != null) {
    return `₹${a.value} / share`;
  }
  if ((t === "BONUS" || t === "SPLIT" || t === "RIGHTS") && a.ratio) {
    return a.ratio;
  }
  return null;
}

export function StockCorpActionsHistoryCard({ symbol, exchange }: Props) {
  const [actions, setActions] = useState<CorporateActionHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCorporateActionsHistoryAction(symbol, exchange)
      .then((r) => {
        if (cancelled) return;
        if (r.success) setActions(r.data.actions);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  if (loading) {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4 mb-5">
        <div className="h-4 w-52 bg-white/[0.06] rounded animate-pulse mb-3" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-5 bg-white/[0.04] rounded animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  // MONEY-1147 — this used to `return null` when there was no history, which
  // was right while the card was stacked ABOVE the news list (collapsing kept
  // that tab clean). Now that Corporate actions is its own section, returning
  // null renders an unexplained blank panel and looks broken. Say so instead.
  //
  // Note this genuinely means "no corporate actions on record", not "the fetch
  // failed": `getCorporateActionsHistoryAction` warms from NSE and reads the
  // `CorporateAction` table, and plenty of symbols simply have never declared
  // a dividend, split or bonus.
  if (actions.length === 0) {
    // MONEY-1255 — the dashed box was a byte-identical copy of
    // `SectionShell`'s. The sentence it carried is one of the nine that mean
    // something, so it is demoted rather than dropped: this branch genuinely
    // means "nothing on record", NOT "the fetch failed" (see the note above),
    // and that is exactly the distinction the tooltip has to keep.
    return (
      <SectionEmpty
        note={
          `No dividend, split or bonus is on record for ${symbol}. ` +
          "Corporate actions appear here once the company declares them."
        }
      />
    );
  }

  const dividends = actions.filter((a) => a.actionType === "DIVIDEND");

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <CalendarClock className="h-4 w-4 text-emerald-400" />
        <h3 className="font-display text-[15px] font-bold tracking-[-0.2px]">
          Corporate actions &amp; dividends
        </h3>
        <span className="font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)] ml-1">
          NSE history
        </span>
      </div>

      {/* ── Full timeline (newest ex-date first) ── */}
      <div className="space-y-2">
        {actions.slice(0, 24).map((a, i) => {
          const vl = valueLabel(a);
          return (
            <div
              key={`${a.actionType}-${a.exDate}-${i}`}
              className="grid grid-cols-[120px_1fr_auto] items-start gap-3 py-1.5 border-t border-[var(--border-default)] first:border-t-0"
            >
              <span
                title={a.actionType}
                className={`block max-w-full truncate rounded-md border px-2 py-0.5 font-mono text-[9.5px] font-semibold tracking-[0.5px] uppercase ${typeClass(a.actionType)}`}
              >
                {a.actionType}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-[var(--text-secondary)] truncate">
                  {a.details || "—"}
                </div>
                <div className="font-mono text-[10.5px] text-[var(--text-dim)] mt-0.5">
                  Ex-date {fmtDate(a.exDate)} · Record {fmtDate(a.recordDate)}
                </div>
              </div>
              {vl ? (
                <span className="font-mono text-[11.5px] font-semibold text-[var(--text-secondary)] whitespace-nowrap">
                  {vl}
                </span>
              ) : (
                <span className="font-mono text-[11.5px] text-[var(--text-dim)]">
                  —
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Dividend-history sub-view (amount + ex-date trend) ── */}
      {dividends.length > 0 && (
        <div className="mt-4 pt-3 border-t border-[var(--border-default)]">
          <div className="flex items-center gap-2 mb-2">
            <Coins className="h-3.5 w-3.5 text-emerald-400" />
            <h4 className="font-mono text-[10px] tracking-[1px] uppercase text-[var(--text-muted)]">
              Dividend history
            </h4>
          </div>
          <div className="flex flex-wrap gap-2">
            {dividends.slice(0, 12).map((d, i) => (
              <div
                key={`div-${d.exDate}-${i}`}
                className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-2.5 py-1.5"
              >
                <div className="font-mono text-[12px] font-semibold text-emerald-400">
                  {d.value != null ? `₹${d.value}` : "—"}
                </div>
                <div className="font-mono text-[9.5px] text-[var(--text-dim)] mt-0.5">
                  {fmtDate(d.exDate)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default StockCorpActionsHistoryCard;
