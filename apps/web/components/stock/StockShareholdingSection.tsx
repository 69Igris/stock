"use client";

/**
 * Shareholding pattern — MONEY-1204 (P14 / 14c.4).
 *
 * Quarterly promoter / FII / DII / public split with QoQ deltas and a pledge
 * trend, read from `shareholding_patterns` (NSE, primary) and falling back to
 * the Tickertape copy in `stock_shareholding` when NSE has filed nothing.
 *
 * ## Why this component exists at all
 *
 * `packages/services/src/provenance.ts` names THIS panel as the case the whole
 * envelope was built for: it silently swaps providers under a condition the
 * reader cannot observe, and the two providers disagree. So the three things
 * this file must do, in order of importance:
 *
 * 1. **Branch on the envelope's `empty`, never on `quarters.length === 0`.**
 *    Those are different questions once a fallback exists. Zero NSE rows with a
 *    populated Tickertape series is not empty; zero rows because NSE has not
 *    published this symbol is not an error. `SectionShell` owns the branch and
 *    the envelope owns the answer.
 * 2. **Show the `fallback` chip AND say why in the body.** The chip is the
 *    label; the note is the explanation, and a fallback explained only inside a
 *    `title=` tooltip is a fallback most readers never see. Escalated to amber
 *    when the copy is older than the staleness bound — a panel that stopped
 *    updating a year ago is indistinguishable from a quiet register otherwise.
 * 3. **Never print 0% for "not reported".** Every percentage on both providers
 *    is nullable, and the legacy `StockShareholdingTab` this replaces coerced
 *    them with `?? 0` at the render boundary (its own comment flags that as
 *    MONEY-1146). A dash is the truth; a zero is a filing nobody made.
 *
 * ## Deltas are deliberately not colour-coded
 *
 * A rising promoter stake is not universally good and a rising pledge is not
 * universally bad. Colouring the QoQ column green/red would state a judgement
 * the filing does not make — the same reason `StockInsiderTimeline` renders an
 * unrecognised action in a neutral chip. Sign and magnitude carry the whole
 * fact; the reader supplies the opinion.
 *
 * Theme-aware tokens for neutrals; accents use the literal Tailwind palette,
 * which is the established split across `components/stock/*`.
 */

import { useEffect, useState, type ReactNode } from "react";
import { PieChart } from "lucide-react";
import {
  getStockOwnershipBreakdownAction,
  getStockShareholdingSectionAction,
  type StockOwnershipBreakdownData,
  type StockShareholdingSectionData,
} from "@/lib/actions/stock-sections-ownership";
import {
  SectionEmptyInline,
  SectionShell,
  sourceLabel,
  type SectionProvenance,
} from "./SectionShell";

type Quarter = StockShareholdingSectionData["quarters"][number];
type PledgePoint = StockShareholdingSectionData["pledgeTrend"][number];
type BreakdownLeg = StockOwnershipBreakdownData["legs"][number];

interface StockShareholdingSectionProps {
  symbol: string;
  exchange?: string;
  className?: string;
}

/** "54.32%" / "—". Absence is a dash; `0` is a real disclosed holding. */
function pct(v: number | null | undefined, dp = 2): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(dp)}%`;
}

/** Signed QoQ change in percentage POINTS. Null propagates to a dash. */
function delta(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined) return "—";
  // `-0.00` is a rounding artefact of a genuinely tiny move; print it as 0.00
  // rather than implying a direction the number does not support.
  const rounded = Number(v.toFixed(dp));
  if (rounded === 0) return "0.00";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(dp)}`;
}

const COLUMNS: Array<{
  key: "promoterPct" | "pledgedPct" | "fiiPct" | "diiPct" | "publicPct";
  label: string;
  title: string;
}> = [
  { key: "promoterPct", label: "Promoter", title: "Promoter & promoter group" },
  {
    key: "pledgedPct",
    label: "Pledged",
    title: "Promoter shares pledged, as a share of the promoter holding",
  },
  { key: "fiiPct", label: "FII", title: "Foreign institutional investors" },
  { key: "diiPct", label: "DII", title: "Domestic institutional investors" },
  { key: "publicPct", label: "Public", title: "Public & others" },
];

export function StockShareholdingSection({
  symbol,
  exchange = "NSE",
  className = "",
}: StockShareholdingSectionProps) {
  const [data, setData] = useState<StockShareholdingSectionData | null>(null);
  const [prov, setProv] = useState<SectionProvenance>({});
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The breakdown is a SEPARATE table with its own coverage, so it gets its own
  // request and its own empty state. Folding it into the call above would let a
  // symbol with no breakdown row blank the pattern table beside it — and the
  // two are populated by different legs of the sync, so that divergence is the
  // normal case rather than the edge one.
  const [breakdown, setBreakdown] =
    useState<StockOwnershipBreakdownData | null>(null);
  const [breakdownEmpty, setBreakdownEmpty] = useState(false);
  const [breakdownLoading, setBreakdownLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStockShareholdingSectionAction({ symbol, exchange })
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
          // The ENVELOPE decides emptiness, not the array length — see the
          // header note. A fallback that supplied rows is not empty even when
          // the primary returned none.
          setEmpty(r.data.empty);
        } else {
          setError(r.error ?? "Failed to load shareholding pattern");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  useEffect(() => {
    let cancelled = false;
    setBreakdownLoading(true);
    getStockOwnershipBreakdownAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        // A failed breakdown is NOT surfaced as a section error: the panel it
        // sits under has its own data and its own error state, and taking the
        // whole shareholding table down because one sub-card's read threw would
        // trade a missing card for a missing section. It renders as absent, the
        // same as no rows.
        if (r.success) {
          setBreakdown(r.data.data);
          setBreakdownEmpty(r.data.empty);
        } else {
          setBreakdown(null);
          setBreakdownEmpty(true);
        }
      })
      .finally(() => {
        if (!cancelled) setBreakdownLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  const quarters = data?.quarters ?? [];
  const stale = data?.stale ?? false;

  return (
    <SectionShell
      title="Shareholding pattern"
      Icon={PieChart}
      eyebrow={
        quarters.length > 0
          ? `${quarters.length} quarter${quarters.length === 1 ? "" : "s"}`
          : undefined
      }
      loading={loading}
      error={error}
      empty={empty}
      // MONEY-1205 — the copy this note replaces used to read "Neither has
      // published one for this stock yet", which is a claim about the EXCHANGE
      // and is false: NSE publishes a shareholding pattern for every listed
      // company. Measured on prod, `shareholding_patterns` holds 440 symbols
      // out of ~10,500, because the sync walks the universe and has not come
      // round to most of it. The gap is OURS.
      //
      // MONEY-1255 made the visible body generic. That distinction is the
      // reason this note exists rather than being deleted with the sentence:
      // "there is nothing to find" and "we have not looked yet" are different
      // facts and only one of them tells a reader to come back.
      emptyNote={
        `We read the quarterly shareholding pattern for ${symbol} from NSE ` +
        "and from BSE — whichever exchange filed it — and fall back to a " +
        "labelled third-party copy when neither has one. We have not fetched " +
        "it for this stock yet: our sync is still working through the market, " +
        "so this is a gap in our coverage rather than in the exchange's " +
        "filings."
      }
      skeleton={<ShareholdingSkeleton />}
      className={className}
      {...prov}
    >
      {data && (
        <div className="space-y-4">
          {/* The fallback, said out loud. The chip in the header labels it; this
              is the sentence that explains it, because a downgrade a reader has
              to hover to discover is a downgrade they will not discover. */}
          {prov.fallback && (
            <p
              className={
                "font-mono text-[10.5px] uppercase leading-relaxed tracking-[1px] " +
                (stale ? "text-amber-400" : "text-[var(--text-muted)]")
              }
            >
              {prov.note ??
                "Neither NSE nor BSE has published a shareholding pattern for this symbol — showing a third-party copy."}
              {stale && " Nothing has refreshed it since."}
            </p>
          )}

          <QuarterTable quarters={quarters} />
          <PledgeTrend points={data.pledgeTrend} />
          <OwnershipBreakdownCard
            symbol={symbol}
            section={breakdown}
            empty={breakdownEmpty}
            loading={breakdownLoading}
          />
        </div>
      )}
    </SectionShell>
  );
}

/** Newest quarter first, each figure carrying its QoQ change underneath. */
function QuarterTable({ quarters }: { quarters: Quarter[] }) {
  if (quarters.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)]">
      <table className="w-full min-w-[560px] text-left">
        <thead>
          <tr className="border-b border-[var(--border-default)]">
            <Th>Quarter</Th>
            {COLUMNS.map((c) => (
              <Th key={c.key} align="right" title={c.title}>
                {c.label}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {quarters.map((q, i) => (
            <tr
              // Index-suffixed, and the row order is stable (newest-first, from
              // the server) so this does not churn identity across renders.
              //
              // The server now returns ONE row per quarter — a quarter both
              // exchanges filed is deduped in buildShareholdingSection. This
              // key stays defensive anyway: `quarter` is a FREE-TEXT column
              // (undatable labels are kept verbatim), so uniqueness is not a
              // property the type system or the schema guarantees to a renderer.
              key={`${q.quarter}-${i}`}
              className="border-b border-[var(--border-default)] last:border-0"
            >
              <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11.5px] text-[var(--text-secondary)]">
                {q.label}
              </td>
              {COLUMNS.map((c) => (
                <td key={c.key} className="px-4 py-2.5 text-right">
                  <div className="font-mono text-[12.5px] tabular-nums text-[var(--text-primary)]">
                    {pct(q[c.key])}
                  </div>
                  <div className="font-mono text-[10px] tabular-nums text-[var(--text-dim)]">
                    {/* QoQ vs the IMMEDIATELY older quarter in this series;
                        null when that quarter did not report the field. */}
                    {delta(q.deltas[c.key])}
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The institutional split, from `shareholding_breakdown` — MONEY-1255.
 *
 * ## Why a sub-card and not a section
 *
 * It answers a NARROWER version of the question the table above answers, from a
 * different table with different coverage, and it is one quarter deep rather
 * than twelve. A second `SectionShell` beside the first would read as two
 * competing shareholding panels; nested under it, the relationship is obvious —
 * this is the DII line broken open.
 *
 * ## The rules it inherits
 *
 * - **null is not zero.** `—` means the filing did not report the category.
 *   Bank of Baroda's `GovernmentsMember` is a filed `0`; BEDMUTHA files no
 *   institutional members at all. Rendering both as "0.00%" would state that a
 *   holder reported nil where nobody filed anything.
 * - **no colour on a delta.** Same reason the quarter table above is
 *   uncoloured: a rising FII stake is not universally good, and colouring it
 *   states a judgement the filing does not make.
 * - **theme tokens only** for every neutral.
 */
function OwnershipBreakdownCard({
  symbol,
  section,
  empty,
  loading,
}: {
  symbol: string;
  section: StockOwnershipBreakdownData | null;
  empty: boolean;
  loading: boolean;
}) {
  // No skeleton: this sits UNDER a section that has already painted, so a
  // shimmer here reads as the page still loading rather than as one card
  // arriving. It appears when it has something to say.
  if (loading) return null;

  const legs = section?.legs ?? [];
  const shares = section?.shares;
  const shown: Array<[string, string | null]> = [
    ["Total", shares?.total ?? null],
    ["Promoter", shares?.promoter ?? null],
    ["FII", shares?.fii ?? null],
    ["DII", shares?.dii ?? null],
    ["Public", shares?.public ?? null],
  ];
  const counts = shown.filter((c): c is [string, string] => c[1] !== null);

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
          Ownership breakdown
        </span>
        <span className="h-px flex-1 bg-[var(--rule-soft)]" />
        {section?.label && (
          <span className="font-mono text-[10.5px] text-[var(--text-dim)]">
            {section.label}
          </span>
        )}
        {section?.source && (
          <span
            // The chip that A3.1 exists for, restated at sub-card scale: this
            // table is written by two different legs (NSE's attached filing and
            // BSE's own payload) and they are not interchangeable.
            title={`Source: ${sourceLabel(section.source)}`}
            className="cursor-help rounded border border-[var(--rule-soft)] px-1.5 py-px font-mono text-[9.5px] uppercase tracking-[1px] text-[var(--text-muted)]"
          >
            {sourceLabel(section.source)}
          </span>
        )}
      </div>

      {empty || section === null || legs.every((l) => l.pct === null) ? (
        // The shared inline body — no dashed box, because a box inside a
        // section that HAS data reads as a broken layout. The WHY rides in the
        // tooltip, which is where MONEY-1255 put every section-specific
        // sentence.
        <SectionEmptyInline
          note={
            `The category-by-category filing for ${symbol} — mutual funds, ` +
            "insurance, banks, government, retail — is parsed from a separate " +
            "document from the summary above, and we have not read one for " +
            "this stock yet."
          }
        />
      ) : (
        <>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--border-default)]">
                <Th>Holder</Th>
                <Th align="right">Latest</Th>
                <Th
                  align="right"
                  title={
                    section.comparable && section.prevLabel
                      ? `Change in percentage points vs ${section.prevLabel}`
                      : "No comparable prior quarter on file — see the note below"
                  }
                >
                  QoQ
                </Th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg) => (
                <BreakdownRow key={leg.key} leg={leg} />
              ))}
              {/* Derived, and only when BOTH legs reported — see
                  `institutionalTotal`. A total assembled around a missing leg
                  is short by exactly that leg with nothing on screen to say so. */}
              {section.institutionalPct !== null && (
                <tr className="border-t border-[var(--border-default)]">
                  <td
                    title="FII + DII, shown only when the filing reported both"
                    className="cursor-help whitespace-nowrap py-2 pr-3 font-mono text-[11.5px] uppercase tracking-[0.5px] text-[var(--text-secondary)]"
                  >
                    Institutional
                  </td>
                  <td className="py-2 text-right font-mono text-[12.5px] tabular-nums text-[var(--text-primary)]">
                    {pct(section.institutionalPct)}
                  </td>
                  <td className="py-2 text-right font-mono text-[11px] tabular-nums text-[var(--text-dim)]">
                    {delta(section.institutionalDeltaPct)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {counts.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border-default)] pt-2.5 font-mono text-[10px] text-[var(--text-dim)]">
              <span className="uppercase tracking-[1px] text-[var(--text-muted)]">
                Shares
              </span>
              {counts.map(([label, value]) => (
                <span key={label}>
                  {label} {groupIndianDigits(value)}
                </span>
              ))}
            </div>
          )}

          {!section.comparable && (
            <p className="mt-2.5 font-mono text-[10px] leading-relaxed text-[var(--text-dim)]">
              {section.prevLabel
                ? `No quarter-on-quarter change: the previous quarter on file is ${section.prevLabel}, not the one immediately before ${section.label}.`
                : "No quarter-on-quarter change: this is the only quarter on file."}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One holder row.
 *
 * The percentage-POINT delta is what renders; the RELATIVE change rides in the
 * tooltip, because the two answer different questions and only one of them is
 * always defined. A leg that went 0 → 0.4 has no percentage change at all —
 * `changePct` is null there rather than `Infinity` — and the point delta says
 * "+0.40", which is the honest sentence.
 */
function BreakdownRow({ leg }: { leg: BreakdownLeg }) {
  const rel =
    leg.changePct === null
      ? null
      : `${leg.changePct > 0 ? "+" : ""}${leg.changePct.toFixed(2)}% relative`;
  return (
    <tr className="border-b border-[var(--border-default)] last:border-0">
      <td
        title={leg.title}
        className={
          "cursor-help whitespace-nowrap py-2 pr-3 font-mono text-[11.5px] text-[var(--text-secondary)]" +
          // Nested legs are components of the DII total above them, never
          // addends to it. The indent is the only thing on screen that says so.
          (leg.nested ? " pl-4 text-[var(--text-muted)]" : "")
        }
      >
        {leg.nested ? `· ${leg.label}` : leg.label}
      </td>
      <td className="py-2 text-right font-mono text-[12.5px] tabular-nums text-[var(--text-primary)]">
        {pct(leg.pct)}
      </td>
      <td
        title={rel ?? undefined}
        className={
          "py-2 text-right font-mono text-[11px] tabular-nums text-[var(--text-dim)]" +
          (rel ? " cursor-help" : "")
        }
      >
        {delta(leg.deltaPct)}
      </td>
    </tr>
  );
}

/**
 * Indian digit grouping on the STRING — `"644150300"` → `"64,41,50,300"`.
 *
 * On the string and not on a Number, because these arrive as decimal strings
 * precisely so no share count has to survive a float. Converting here to insert
 * commas would undo that at the last step, and `Intl.NumberFormat` on a 12-digit
 * count is exactly where the digits would go.
 *
 * Exported so the grouping is tested directly rather than only through a
 * render — it is the one place a share count could still be corrupted after
 * surviving BigInt, the wire and the service.
 */
export function groupIndianDigits(value: string): string {
  const m = /^(-?)(\d+)$/.exec(value);
  if (!m) return value;
  const [, sign = "", digits = ""] = m;
  if (digits.length <= 3) return `${sign}${digits}`;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  // Everything above the last three digits groups in TWOS — 1,00,00,000, not
  // 10,000,000. Built right-to-left so a leading group of one digit is kept.
  const grouped = rest.replace(/\B(?=(\d{2})+$)/g, ",");
  return `${sign}${grouped},${last3}`;
}

/**
 * Pledge trend, oldest → newest.
 *
 * A null is a GAP, not a zero pledge, so it renders as a dashed stub rather
 * than a flat bar at the baseline: a quarter nobody reported must not look like
 * a quarter with nothing pledged. The whole strip is suppressed when no quarter
 * reported a figure at all — an all-gaps chart says nothing and implies a lot.
 */
function PledgeTrend({ points }: { points: PledgePoint[] }) {
  const reported = points.filter(
    (p): p is PledgePoint & { pledgedPct: number } => p.pledgedPct !== null
  );
  if (reported.length === 0) return null;

  // Scaled against the series max (floored at 1%) so a register that never
  // exceeds 2% is still legible, instead of five invisible slivers.
  const max = Math.max(1, ...reported.map((p) => p.pledgedPct));

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[1px] text-[var(--text-muted)]">
          Promoter pledge trend
        </span>
        <span className="h-px flex-1 bg-[var(--rule-soft)]" />
        <span className="font-mono text-[10.5px] text-[var(--text-dim)]">
          {reported.length}/{points.length} reported
        </span>
      </div>
      <div className="flex h-16 items-end gap-1.5">
        {points.map((p) => {
          if (p.pledgedPct === null) {
            return (
              <div
                key={p.quarter}
                title={`${p.label}: not reported`}
                className="h-full flex-1 cursor-help rounded-sm border border-dashed border-[var(--rule-soft)]"
              />
            );
          }
          // Floor at 2% of the track so a genuine 0.00% pledge still draws a
          // visible baseline tick and is not mistaken for a gap.
          const h = Math.max(2, (p.pledgedPct / max) * 100);
          return (
            <div
              key={p.quarter}
              title={`${p.label}: ${p.pledgedPct.toFixed(2)}% pledged`}
              className="flex h-full flex-1 cursor-help items-end"
            >
              <div
                style={{ height: `${h}%` }}
                className="w-full rounded-sm bg-amber-400/70"
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[9.5px] uppercase tracking-[1px] text-[var(--text-dim)]">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

function Th({
  children,
  align = "left",
  title,
}: {
  children: ReactNode;
  align?: "left" | "right";
  title?: string;
}) {
  return (
    <th
      title={title}
      className={`px-4 py-2 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)] ${
        align === "right" ? "text-right" : "text-left"
      } ${title ? "cursor-help" : ""}`}
    >
      {children}
    </th>
  );
}

/** Shimmer mirroring the real layout: a quarter table, then the pledge strip. */
function ShareholdingSkeleton() {
  return (
    <div className="space-y-3">
      <div className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
        <div className="mb-3 h-3 w-28 rounded bg-emerald-400/[0.10]" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="mb-2 h-4 w-full rounded bg-white/[0.06]" />
        ))}
      </div>
      <div className="animate-pulse rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-4">
        <div className="mb-3 h-3 w-32 rounded bg-white/[0.04]" />
        <div className="h-16 rounded bg-white/[0.05]" />
      </div>
    </div>
  );
}

export default StockShareholdingSection;
