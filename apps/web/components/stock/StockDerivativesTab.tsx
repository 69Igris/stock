"use client";

/**
 * F&O section — MONEY-1204 (P14 / 14c.3).
 *
 * Reads `DerivativeSummary` (futures OI + change, basis, rollover, PCR, max
 * pain, the OI-buildup quadrant), `SlbPosition` (securities lending open
 * interest, the closest thing NSE publishes to short interest), `MwplDaily`
 * (market-wide position limit utilisation) and `StockFlag` kind `FO_BAN`.
 *
 * ## Three things this component refuses to do
 *
 * 1. **Render for a cash-only stock.** `isFno` is a hard gate: a non-F&O name
 *    returns null from here entirely, because an empty F&O tab reads as a
 *    broken page rather than as "this stock has no derivatives". This is the
 *    ONE place a `return null` is right, and it is a gate on the section
 *    existing, not an empty state — when the stock IS an F&O name, every panel
 *    below owns a real empty state.
 * 2. **Collapse the SLB series ladder.** MONEY-1201 measured that summing
 *    across series discarded 84.2% of open borrow interest while reporting
 *    success. The headline is a total; the ladder that produced it is one hover
 *    away and its rung count is on screen.
 * 3. **Show an MWPL all-clear.** `utilisationPct` is NULL on every row today,
 *    so the ≥80% warning is built and simply does not render — a stock with no
 *    denominator must not look like a stock measured at 12%. Ban proximity that
 *    IS knowable comes from the published `FO_BAN` flag instead.
 *
 * ## Short selling lives here now — MONEY-1205
 *
 * `SHORT_SELLING` was one of the seven kinds in the page-header flag strip,
 * where it read "Short sold 1,06,000 (ended)" — a recurring QUANTITY dressed as
 * a warning that had lapsed. It is the SLB borrow's twin: disclosed short sales
 * and open lending positions are the two halves of the only short-interest
 * picture India publishes, and they are legible side by side and nowhere else.
 *
 * It is fetched from the same `getStockFlagsAction` the header uses, so this is
 * a second READER of one cached payload, not a second query path. A failure is
 * silent for the same reason the header's is: the panel is supplementary, and
 * the F&O section is complete without it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Layers, AlertTriangle } from "lucide-react";
import {
  getStockDerivativesAction,
  getStockFlagsAction,
  type StockDerivativesData,
  type StockFlagsAndIndexesData,
} from "@/lib/actions/stock-sections-market";
import { SectionShell, SectionEmptyInline, formatAsOf } from "./SectionShell";

/** The short-selling badge + its history rows, lifted out of the flags payload. */
interface ShortSellingView {
  /** Decoded headline, e.g. "1,06,000 shares sold short". */
  display: string;
  /** Trading day the disclosure describes (ISO). */
  date: string;
  /** Newest-first prior disclosures, already decoded service-side. */
  history: Array<{ date: string; display: string }>;
  source: string | null;
}

interface StockDerivativesTabProps {
  symbol: string;
  exchange: string;
  className?: string;
  /**
   * Fired once the gate is known, so the PARENT can drop the tab entirely.
   *
   * Without it the only place `isFno` is knowable is inside this component,
   * which means a cash-only stock shows a tab, a skeleton, and then nothing —
   * a worse experience than the empty tab the gate exists to prevent. The
   * component still self-gates (it renders null) so it is safe to mount
   * unconditionally; this is the hook for hiding the tab label too.
   */
  onFnoResolved?: (isFno: boolean) => void;
}

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-IN");
}

function fixed(n: number | null | undefined, dp = 2): string {
  return n === null || n === undefined ? "—" : n.toFixed(dp);
}

function signedPct(n: number | null | undefined, dp = 2): string {
  return n === null || n === undefined
    ? "—"
    : `${n > 0 ? "+" : ""}${n.toFixed(dp)}%`;
}

export function StockDerivativesTab({
  symbol,
  exchange,
  className,
  onFnoResolved,
}: StockDerivativesTabProps) {
  const [data, setData] = useState<StockDerivativesData | null>(null);
  const [meta, setMeta] = useState<{
    source: string | null;
    asOf: string | null;
    empty: boolean;
    note?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shortSelling, setShortSelling] = useState<ShortSellingView | null>(
    null
  );

  // Short selling, from the flags payload the page header already fetches. Its
  // own effect: an F&O read that fails must not blank the short-selling panel,
  // and a flags read that fails must not fail the section. Keyed identically,
  // so it runs exactly once per symbol like every other section here.
  useEffect(() => {
    let cancelled = false;
    setShortSelling(null);
    getStockFlagsAction({ symbol, exchange })
      .then((r) => {
        if (cancelled || !r.success) return;
        setShortSelling(pickShortSelling(r.data.data, r.data.source));
      })
      // Silent by design — see the note at the top of this file. The server
      // action has already logged the cause.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockDerivativesAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) {
          setData(r.data.data);
          setMeta({
            source: r.data.source,
            asOf: r.data.asOf,
            empty: r.data.empty,
            note: r.data.note,
          });
          onFnoResolved?.(r.data.data.isFno);
        } else {
          setError(r.error ?? "Failed to load derivatives data");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `onFnoResolved` is intentionally out of the dep list: it is a notification
    // sink, and an inline arrow from the parent would otherwise re-fire the
    // whole fetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, exchange]);

  // The GATE, not an empty state: this stock has no derivatives at all, so the
  // section does not exist for it. Everything below assumes `isFno`.
  if (!loading && !error && data && !data.isFno) return null;

  const s = data?.summary ?? null;
  const ban = data?.ban ?? null;

  return (
    <SectionShell
      title="Futures & options"
      Icon={Layers}
      eyebrow={
        s?.nearFutExpiry ? `Expiry ${formatAsOf(s.nearFutExpiry)}` : undefined
      }
      loading={loading}
      error={error}
      empty={meta?.empty ?? false}
      // MONEY-1255 — demoted to the tooltip. "Nothing has been published"
      // is the exchange's silence, not ours: a cash-only name is simply not in
      // the F&O file, which is a fact about the stock a reader can act on.
      emptyNote={
        "We derive open interest, basis, rollover and max pain from the " +
        `exchange's daily derivatives file. Nothing has been published for ${symbol} yet.`
      }
      skeleton={<DerivativesSkeleton />}
      source={meta?.source}
      asOf={meta?.asOf}
      note={meta?.note}
      className={className}
    >
      <div className="space-y-3">
        {ban?.active && (
          <div
            className={
              "flex items-start gap-2 rounded-xl border border-red-400/30 bg-red-400/[0.08] p-3 " +
              "text-[13px] text-red-400"
            }
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-semibold">In the F&amp;O ban period</div>
              <div className="text-[12px] opacity-80">
                Only position-reducing trades are allowed.{" "}
                {ban.observedSessions > 1
                  ? `${ban.runReachesWindowEdge ? "At least " : ""}${
                      ban.observedSessions
                    } consecutive sessions, since ${formatAsOf(ban.since)}.`
                  : `Since ${formatAsOf(ban.date)}.`}
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Panel title="Open interest">
            <Row label="Futures OI (all expiries)" value={num(s?.futOi)} />
            <Row
              label="Change vs prev day"
              value={num(s?.futOiChange)}
              sub={signedPct(s?.futOiChangePct)}
              accent={toneOf(s?.futOiChange)}
            />
            <Row label="Near-expiry OI" value={num(s?.nearFutOi)} />
            {s?.buildup ? (
              <div
                className="mt-2 rounded-lg border border-[var(--border-default)] p-2"
                title={s.buildup.detail}
              >
                <div className="font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
                  Buildup
                </div>
                <div
                  className={
                    "text-[14px] font-semibold " +
                    (s.buildup.bias === "BULLISH"
                      ? "text-emerald-400"
                      : "text-amber-400")
                  }
                >
                  {s.buildup.label}
                </div>
                <div className="text-[11.5px] text-[var(--text-dim)]">
                  Price {s.buildup.priceDirection === "UP" ? "↑" : "↓"} · OI{" "}
                  {s.buildup.oiDirection === "UP" ? "↑" : "↓"}
                </div>
              </div>
            ) : (
              // A flat day is not a quadrant — `classifyOiBuildup` returns null
              // rather than manufacturing a directional call.
              <Row label="Buildup" value="—" sub="no directional day" />
            )}
          </Panel>

          <Panel title="Pricing">
            <Row label="Futures basis" value={signedPct(s?.futBasisPct)} />
            <Row label="Near-future close" value={fixed(s?.nearFutClose)} />
            <Row label="Underlying close" value={fixed(s?.underlyingClose)} />
            <Row
              label="Max pain"
              value={fixed(s?.maxPain, 0)}
              sub={
                s?.maxPainExpiry
                  ? `expiry ${formatAsOf(s.maxPainExpiry)}`
                  : undefined
              }
            />
            {/* Rollover is a rollover-WEEK statistic. Outside the window it is
                a real number answering a question nobody asked, so it is gated
                on the summary's own trading day, not on the value existing. */}
            {s?.isExpiryWeek ? (
              <Row label="Rollover" value={`${fixed(s.rolloverPct, 1)}%`} />
            ) : (
              <Row label="Rollover" value="—" sub="shown in expiry week only" />
            )}
          </Panel>

          <Panel title="Options skew">
            <Row label="PCR (open interest)" value={fixed(s?.pcrOi)} />
            <Row label="PCR (volume)" value={fixed(s?.pcrVol)} />
            <Row label="Call OI" value={num(s?.callOi)} />
            <Row label="Put OI" value={num(s?.putOi)} />
            <Row
              label="Call / Put volume"
              value={`${num(s?.callVol)} / ${num(s?.putVol)}`}
            />
          </Panel>

          <SlbPanel slb={data?.slb ?? null} slbDate={data?.slbDate ?? null} />
          {/* MONEY-1205 — the SLB borrow's twin, moved out of the page header
              where it was a quantity pretending to be a warning. */}
          <ShortSellingPanel short={shortSelling} />
          <MwplPanel mwpl={data?.mwpl ?? null} />
        </div>
      </div>
    </SectionShell>
  );
}

function toneOf(n: number | null | undefined): string | undefined {
  if (n === null || n === undefined) return undefined;
  return n > 0 ? "text-emerald-400" : n < 0 ? "text-amber-400" : undefined;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[12.5px] text-[var(--text-dim)]">{label}</span>
      <span className="text-right">
        <span
          className={
            "text-[13.5px] font-semibold " +
            (accent ?? "text-[var(--text-primary)]")
          }
        >
          {value}
        </span>
        {sub && (
          <span className="ml-1.5 font-mono text-[10.5px] text-[var(--text-muted)]">
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Lift the `SHORT_SELLING` badge out of the flags payload.
 *
 * Reads `badges`, NOT `headline`: `selectHeadlineStockFlagBadges` deliberately
 * excludes this kind from the page header, which is the whole reason the panel
 * exists here. The full set is what `badges` is for.
 *
 * `display` comes from the service's shared decoder, so this panel and the
 * mobile `/v1/stocks/:symbol/flags` response read the same sentence rather than
 * each formatting `{"qty":91}` their own way.
 */
function pickShortSelling(
  flags: StockFlagsAndIndexesData,
  envelopeSource: string | null
): ShortSellingView | null {
  const rows = flags.history?.SHORT_SELLING ?? [];
  const badge = (flags.badges ?? []).find((b) => b.kind === "SHORT_SELLING");
  const newest = rows[0] ?? null;
  if (!badge && !newest) return null;
  const date = badge?.date ?? newest?.date ?? null;
  if (date === null) return null;
  const display = newest?.display ?? badge?.label ?? null;
  if (display === null) return null;
  return {
    display,
    date,
    // Newest first, already decoded. The head is the headline, so the ladder
    // below it starts at the second row.
    history: rows
      .slice(1, 8)
      .map((r) => ({ date: r.date, display: r.display ?? r.value })),
    source: badge?.source ?? envelopeSource,
  };
}

/**
 * Disclosed short sales — the borrow's twin.
 *
 * NOT dated "(ended)" and not toned as a warning. NSE publishes this file on
 * the days a short sale was disclosed, so the datum is "this much, on this
 * day", and the older disclosures underneath are what turn one number into a
 * trend a reader can judge.
 */
function ShortSellingPanel({ short }: { short: ShortSellingView | null }) {
  return (
    <Panel title="Disclosed short selling">
      {short === null ? (
        // MONEY-1255 — NSE publishes this file only on days a short sale was
        // disclosed, so an absence really is "none disclosed" rather than a
        // fetch we have not run. That stays in the tooltip.
        <SectionEmptyInline note="No short sales have been disclosed for this stock." />
      ) : (
        <>
          <Row
            label="Latest disclosure"
            value={short.display}
            sub={formatAsOf(short.date) ?? undefined}
          />
          {short.history.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-[var(--rule-soft)] pt-2">
              {short.history.map((row, i) => (
                <div
                  key={`${row.date}-${i}`}
                  className="flex items-baseline justify-between gap-2 text-[11.5px]"
                >
                  <span className="font-mono text-[var(--text-muted)]">
                    {formatAsOf(row.date)}
                  </span>
                  <span className="truncate text-right text-[var(--text-dim)]">
                    {row.display}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * Securities-lending open interest.
 *
 * The total is the headline; the PER-SERIES ladder is the hover, and the rung
 * count is always visible so a reader can tell a one-series name from a
 * nine-series one without opening anything.
 */
function SlbPanel({
  slb,
  slbDate,
}: {
  slb: StockDerivativesData["slb"];
  slbDate: string | null;
}) {
  return (
    <Panel title="Securities lending (SLB)">
      {!slb || slb.seriesCount === 0 ? (
        <SectionEmptyInline note="No open borrow positions have been published for this stock." />
      ) : (
        <>
          <Row
            label="Open quantity"
            value={num(slb.totalOpenQty)}
            sub={`${slb.seriesCount} series`}
          />
          <Row
            label="Open value"
            value={
              slb.totalOpenValue === null
                ? "—"
                : `₹${slb.totalOpenValue.toLocaleString("en-IN", {
                    maximumFractionDigits: 0,
                  })}`
            }
          />
          {slbDate && <Row label="As of" value={formatAsOf(slbDate) ?? "—"} />}
          <div className="mt-2 space-y-1 border-t border-[var(--rule-soft)] pt-2">
            {slb.series.map((rung, i) => (
              <div
                key={`${rung.series ?? "unspecified"}-${i}`}
                className="flex items-center justify-between gap-2 text-[11.5px]"
                title={
                  rung.expiryDate
                    ? `Expiry ${formatAsOf(rung.expiryDate)}`
                    : undefined
                }
              >
                <span className="font-mono text-[var(--text-muted)]">
                  {rung.series ?? "unspecified"}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-[var(--text-dim)]">
                    {num(rung.openQty)}
                  </span>
                  {rung.sharePct !== null && (
                    <span className="w-10 text-right font-mono text-[10.5px] text-[var(--text-muted)]">
                      {rung.sharePct.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

/**
 * Market-wide position limit.
 *
 * `band === null` means the limit itself is unpublished — which is EVERY row
 * today, because `MwplDaily.mwpl` has no source and the model forbids
 * substituting another denominator. The warning is built and gated; it renders
 * the moment a real MWPL feed lands and not one day earlier.
 */
function MwplPanel({ mwpl }: { mwpl: StockDerivativesData["mwpl"] }) {
  return (
    <Panel title="Market-wide position limit">
      {!mwpl ? (
        <SectionEmptyInline note="No market-wide position-limit row has been published for this stock." />
      ) : (
        <>
          <Row label="Notional OI" value={num(mwpl.notionalOi)} />
          <Row label="Futures-equivalent OI" value={num(mwpl.futEquivOi)} />
          <Row
            label="Utilisation"
            value={
              mwpl.utilisationPct === null
                ? "—"
                : `${mwpl.utilisationPct.toFixed(1)}%`
            }
            sub={mwpl.band === null ? "limit not published" : undefined}
            accent={
              mwpl.band === "NEAR_BAN"
                ? "text-red-400"
                : mwpl.band === "WATCH"
                  ? "text-amber-400"
                  : undefined
            }
          />
          {(mwpl.band === "WATCH" || mwpl.band === "NEAR_BAN") && (
            <div
              className={
                "mt-2 flex items-start gap-2 rounded-lg border p-2 text-[12px] " +
                (mwpl.band === "NEAR_BAN"
                  ? "border-red-400/30 bg-red-400/[0.08] text-red-400"
                  : "border-amber-400/30 bg-amber-400/[0.08] text-amber-400")
              }
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {mwpl.band === "NEAR_BAN"
                  ? "At or above 95% of the market-wide limit — an F&O ban is imminent."
                  : "Above 80% of the market-wide limit — approaching an F&O ban."}
              </span>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function DerivativesSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4"
        >
          <div className="mb-3 h-3 w-24 rounded bg-emerald-400/[0.10]" />
          {Array.from({ length: 4 }).map((__, j) => (
            <div key={j} className="mb-2 flex justify-between gap-3">
              <div className="h-3 w-1/2 rounded bg-white/[0.04]" />
              <div className="h-3 w-1/4 rounded bg-white/[0.06]" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default StockDerivativesTab;
