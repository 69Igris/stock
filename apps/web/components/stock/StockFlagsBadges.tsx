"use client";

/**
 * Exchange flags + index chips — MONEY-1204 (P14 / 14c.1).
 *
 * The first product surface for `stock_flags`, a ~7.5M-row table that has been
 * accruing NSE's surveillance, price-band, series-change, short-selling, F&O-ban
 * and 52-week publications since P4.5 with no reader at all.
 *
 * ## This is an INLINE BADGE STRIP, not a section. Do not give it a SectionShell.
 *
 * It mounts inside the stock page's `<h1>` row (`app/stock/[symbol]/client.tsx`),
 * in a `display:flex; align-items:baseline` list beside the `NSE · SYMBOL` and
 * `EQ` pills. That slot has a different contract from a tab body, and the two
 * are genuinely incompatible:
 *
 *   - `SectionShell` is documented to NEVER return null — an empty tab must say
 *     "we track this and the exchange has not published it", because a blank tab
 *     reads as a broken page. Correct, for a tab.
 *   - This slot needs the OPPOSITE. A flag is an exception by definition, so the
 *     common case is "none", and a titled `<h3>`, a shimmer, or a dashed
 *     `px-6 py-10` empty box would land in the headline of every clean stock.
 *
 * An earlier revision used `SectionShell` here and produced exactly that: every
 * stock page rendered a four-pill shimmer inside the `<h1>`, then either a
 * titled section or a large dashed box, wrapped onto its own flex line. Hence
 * the three `return null`s below — they are the mount contract, not laziness.
 *
 * Because there is no header row to hang `SectionShell`'s `ml-auto` provenance
 * chip on, provenance moves into the badge tooltips instead: feed id, the flags'
 * newest published day, and any envelope note. It is not dropped.
 *
 * ## It renders `headline`, NOT `badges` — MONEY-1205
 *
 * The mount contract above says a flag is an exception by definition. The strip
 * shipped contradicting it on ~100% of stock pages, because two of the seven
 * kinds publish for the WHOLE CASH UNIVERSE every session: measured on prod
 * 2026-08-17, `PRICE_BAND` 3,489 rows and `WK52_HIGH_LOW` 3,325. Every stock
 * therefore carried at least two "flags" and the strip's presence carried no
 * information at all.
 *
 * `headline` is `badges` narrowed by `selectHeadlineStockFlagBadges` in
 * `@usemoney/core/market-data` — one rule table, shared with the alert
 * evaluator and the login briefing, rather than a taste re-implemented here.
 * Nothing is lost: the full set is still in `badges` and every row is still in
 * `history`. The two kinds that left have better homes and were MOVED there
 * rather than dropped — 52-week extremes to the header metric grid and its
 * `DayRangeBar label="52W range"`, short selling to the SLB panel in
 * `StockDerivativesTab` (a short-sale disclosure is the borrow's twin).
 *
 * Three rendering rules carry the section's meaning:
 *
 *   - **Surveillance codes are decoded HERE, never in the DB.** `GSM STAGE - I`
 *     is stored verbatim and turned into "GSM Stage I" at this boundary, so a
 *     better decode table improves rows written years ago. Wording the table
 *     does not recognise renders as the raw code rather than disappearing.
 *     The HISTORY POPOVER is the one place that stays raw: `display` decodes
 *     every other kind out of stored JSON, and SURVEILLANCE deliberately keeps
 *     NSE's own bytes, because the code is the point there.
 *   - **`since` can be a lower bound.** The service reads a bounded page per
 *     kind; when a run fills that page the badge says "since at least", because
 *     the alternative is a confident wrong start date the reader cannot check.
 *   - **A STATE flag that is no longer current still renders**, greyed and
 *     dated. A stock that left GSM last month is a different fact from one that
 *     was never flagged, and only one of them is worth attention today. A POINT
 *     flag NEVER renders "(ended)": a band change is a one-day event, so it was
 *     never "in force" and cannot end — `isCurrent` on a POINT badge means
 *     RECENT, and "(ended)" on HDFCBANK's 21-May-2024 band change was a false
 *     statement about a fact two years into its own past.
 *
 * Theme-aware tokens for neutrals, literal Tailwind for accents — the house
 * split in `components/stock/*`. No hex literals.
 */

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  getStockFlagsAction,
  type StockFlagsAndIndexesData,
} from "@/lib/actions/stock-sections-market";
import { formatAsOf, sourceLabel } from "./SectionShell";

type Badge = StockFlagsAndIndexesData["badges"][number];
type IndexChip = StockFlagsAndIndexesData["indexes"][number];
type HistoryRow = NonNullable<
  StockFlagsAndIndexesData["history"][string]
>[number];

interface StockFlagsBadgesProps {
  symbol: string;
  exchange: string;
  className?: string;
}

/** Tone → accent. Neutrals stay on `var(--…)`; only the accent is literal. */
const TONE: Record<Badge["tone"], string> = {
  critical: "border-red-400/30 bg-red-400/10 text-red-400",
  warn: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  info: "border-sky-400/30 bg-sky-400/10 text-sky-400",
  neutral: "border-violet-400/30 bg-violet-400/10 text-violet-400",
};

const STALE =
  "border-[var(--border-default)] bg-[var(--gradient-card)] text-[var(--text-muted)]";

interface FlagsMeta {
  source: string | null;
  asOf: string | null;
  empty: boolean;
  fallback?: boolean;
  note?: string;
}

export function StockFlagsBadges({
  symbol,
  exchange,
  className,
}: StockFlagsBadgesProps) {
  const [data, setData] = useState<StockFlagsAndIndexesData | null>(null);
  const [meta, setMeta] = useState<FlagsMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [openKind, setOpenKind] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setOpenKind(null);
    getStockFlagsAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) {
          setData(r.data.data);
          setMeta({
            source: r.data.source,
            asOf: r.data.asOf,
            empty: r.data.empty,
            fallback: r.data.fallback,
            note: r.data.note,
          });
        } else {
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  // No skeleton. Reserving space in the `<h1>` row would promise content that
  // most stocks never have, so a placeholder is a layout shift on the majority
  // of pages to avoid one on the minority. The badges simply appear.
  if (loading) return null;

  // A failed load renders as "no flags". That is a deliberate trade, not a
  // swallowed error: the server action already logs the cause, and the only
  // alternative in this slot is a red box wedged into the page headline. The
  // strip is supplementary — the stock page is fully usable without it.
  if (failed || !data) return null;

  // `headline`, not `badges`. See the note at the top of this file: `badges` is
  // the COMPLETE set (the screener and the research tool both need it), and
  // rendering it here put a "flag" strip on every stock in the market.
  //
  // `?? []` covers exactly one case — an envelope cached before this shipped,
  // which has no `headline` key. Falling back to the OLD `badges` there would
  // reinstate the cry-wolf strip for the whole 6-hour closed-market TTL, so the
  // fallback goes the other way: render nothing, which is the new common case
  // anyway, and the next cache fill is correct.
  const badges = data.headline ?? [];
  const indexes = data.indexes ?? [];

  // `empty` is the authority — it is the envelope's answer to "is there
  // anything here", which is a different question from `rows.length === 0` once
  // a fallback source exists. The array check behind it is a render guard, not
  // a second opinion: an envelope that claims content but yields no chips would
  // otherwise emit a childless flex item and open a stray gap in the `<h1>`.
  //
  // NOTE (MONEY-1205): with `headline` in place this is now the ~99% path, not
  // the minority one. That is the feature, and it is why the three `return
  // null`s above and here are load-bearing rather than defensive: a shimmer, an
  // `<h3>` or a dashed empty box would now land in the headline of almost every
  // stock page rather than most of them.
  if (meta?.empty ?? true) return null;
  if (badges.length === 0 && indexes.length === 0) return null;

  const asOf = meta?.asOf ?? null;
  const feed = meta?.source ?? null;
  const note = meta?.note ?? null;

  return (
    <div className={"flex flex-wrap items-center gap-1.5 " + (className ?? "")}>
      {badges.map((b) => (
        <FlagBadge
          key={`${b.kind}:${b.raw}`}
          badge={b}
          history={data.history?.[b.kind] ?? []}
          asOf={asOf}
          feed={feed}
          note={note}
          open={openKind === `${b.kind}:${b.raw}`}
          onToggle={() =>
            setOpenKind((cur) =>
              cur === `${b.kind}:${b.raw}` ? null : `${b.kind}:${b.raw}`
            )
          }
        />
      ))}

      {indexes.length > 0 && (
        <>
          <span
            title={
              meta?.fallback
                ? "Index membership is from the current-constituents snapshot — join dates unavailable"
                : undefined
            }
            className={
              "font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]" +
              (meta?.fallback ? " cursor-help" : "")
            }
          >
            {meta?.fallback ? "Indices*" : "Indices"}
          </span>
          {indexes.map((chip) => (
            <IndexPill key={chip.indexId} chip={chip} />
          ))}
        </>
      )}
    </div>
  );
}

function FlagBadge({
  badge,
  history,
  asOf,
  feed,
  note,
  open,
  onToggle,
}: {
  badge: Badge;
  history: HistoryRow[];
  asOf: string | null;
  feed: string | null;
  note: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const since = formatAsOf(badge.since);
  const on = formatAsOf(badge.date);
  const published = formatAsOf(asOf);
  // "since at least" when the run filled the fetched page — the start date is a
  // lower bound, not a fact, and saying otherwise would be unfalsifiable.
  const run =
    badge.observedSessions > 1
      ? `${badge.runReachesWindowEdge ? "since at least" : "since"} ${since} · ${
          badge.observedSessions
        }${badge.runReachesWindowEdge ? "+" : ""} sessions`
      : `on ${on}`;

  // ── STATE vs POINT (MONEY-1205) ──────────────────────────────────────────
  //
  // A STATE flag is a standing condition: "in force?" and "when did it end?"
  // are real questions, so `isCurrent === false` earns the greyed "(ended)".
  //
  // A POINT flag is a dated one-off — NSE publishes a band change or a series
  // change only on the day it happened. It is never in force, so it can never
  // end, and `isCurrent` on one means RECENT (inside
  // POINT_EVENT_RECENCY_DAYS), not live. Rendering "(ended)" for it is not a
  // stale label but a false statement, which is how HDFCBANK's 21-May-2024
  // band change became a 2026 header badge that had "ended".
  //
  // `shape === null` is a kind the policy table has never seen. It is grouped
  // with POINT on purpose: guessing that an unknown NSE family is a standing
  // state is the exact mistake this branch exists to stop making, and a plain
  // dated event is the claim that survives being wrong.
  const isState = badge.shape === "STATE";
  const endedSuffix = isState && !badge.isCurrent;

  // Provenance lives here because the inline slot has no header to carry a
  // chip. Same three facts a `SectionShell` chip would show — feed, as-of, note.
  const tip = [
    badge.detail,
    isState
      ? badge.isCurrent
        ? run
        : `Last seen ${on} — no longer in force`
      : // Dated event wording for POINT and for unknown kinds. No "in force",
        // no "ended", no run length: one day is the whole fact.
        `Published ${on} — a one-day event, not a standing flag` +
        (badge.shape === null
          ? ". We do not recognise this flag family, so it is dated rather than treated as a state."
          : ""),
    badge.series ? `Series ${badge.series}` : null,
    badge.raw !== badge.label ? `Published as: ${badge.raw}` : null,
    badge.source
      ? `Feed: ${badge.source}`
      : feed
        ? `Feed: ${sourceLabel(feed)}`
        : null,
    published ? `Flags as of ${published}` : null,
    note,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        title={tip}
        aria-expanded={open}
        className={
          "flex items-center gap-1 rounded-full border px-2.5 py-1 " +
          "font-mono text-[10.5px] uppercase tracking-[0.5px] transition-colors " +
          (badge.isCurrent ? TONE[badge.tone] : STALE)
        }
      >
        <span className="normal-case tracking-normal">{badge.label}</span>
        {endedSuffix && (
          <span className="normal-case tracking-normal opacity-70">
            (ended)
          </span>
        )}
        {!isState && on !== null && (
          // The DATE is the suffix for a point event — it is half the fact, and
          // it is what stops a two-year-old band change reading as news.
          <span className="normal-case tracking-normal opacity-70">{on}</span>
        )}
        {history.length > 0 && (
          <ChevronDown
            className={
              "h-3 w-3 transition-transform " + (open ? "rotate-180" : "")
            }
          />
        )}
      </button>

      {open && history.length > 0 && (
        <div
          className={
            "absolute left-0 top-full z-20 mt-1.5 max-h-64 w-64 overflow-y-auto " +
            "rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-2 shadow-lg"
          }
        >
          <div className="mb-1.5 px-1 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
            {badge.kind.replace(/_/g, " ")} · last {history.length}
          </div>
          <ul className="space-y-0.5">
            {history.map((row, i) => (
              <li
                key={`${row.date}-${i}`}
                className="flex items-baseline justify-between gap-2 rounded px-1 py-0.5 text-[11.5px]"
              >
                <span className="font-mono text-[var(--text-muted)]">
                  {formatAsOf(row.date)}
                </span>
                {/* `display` — the ONE shared decoder (`formatStockFlagValue`),
                    computed service-side so the popover, `/v1/stocks/:symbol/
                    flags`, the research tool and the alert writers all read the
                    same sentence. Before it, this row rendered stored JSON at a
                    user: `{"band":"5"}`.

                    SURVEILLANCE IS THE EXCEPTION and stays byte-identical to
                    `value`. Decoding a surveillance code is deliberate
                    elsewhere (the badge LABEL does it), and this popover is the
                    one place the raw code is the point — it is what makes the
                    verbatim column checkable against what NSE published.
                    `?? row.value` covers an envelope cached before `display`
                    existed. */}
                <span
                  className="truncate text-right text-[var(--text-dim)]"
                  title={row.value}
                >
                  {badge.kind === "SURVEILLANCE"
                    ? row.value
                    : (row.display ?? row.value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function IndexPill({ chip }: { chip: IndexChip }) {
  const added = formatAsOf(chip.addedOn);
  const seen = formatAsOf(chip.lastSeen);
  const tip = [
    // `addedOn: null` is "already a member when we started looking" — a
    // different claim from "joined on our first snapshot", and the model
    // refuses to conflate them, so neither does the tooltip.
    added ? `Added ${added}` : "Member since before our records began",
    seen ? `Confirmed ${seen}` : null,
    chip.fallback
      ? "From the current-constituents snapshot — join dates unavailable"
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span
      title={tip}
      className={
        "cursor-help rounded-full border border-emerald-400/25 bg-emerald-400/[0.08] " +
        "px-2.5 py-1 text-[11px] font-semibold text-emerald-400"
      }
    >
      {chip.label}
    </span>
  );
}

export default StockFlagsBadges;
