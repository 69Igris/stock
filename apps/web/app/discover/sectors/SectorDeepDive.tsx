"use client";

/**
 * SectorDeepDive — playful (pf-*) re-skin (MONEY-485).
 *
 * Renders the full 8-component panel that appears BELOW the heatmap
 * when a sector is selected. Loads real data via
 * getSectorDeepDiveAction. All numeric fields are nullable — when
 * fundamentals or correlation aren't yet computed the corresponding card
 * renders a placeholder so the layout never collapses.
 *
 * The two institutional-picks cards (MONEY-268) are the one place where an
 * absence is spelled out in three ways rather than one: a failed read, an empty
 * window, and a window with prints are all distinguishable on screen.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Filter, Loader2, AlertCircle } from "lucide-react";
import { seasonFromOrdinal } from "@usemoney/core/market-data/results-season";
import {
  getResultsCalendarAction,
  getSectorDeepDiveAction,
  type ResultsCalendar,
  type SectorDeepDive,
  type SectorInstitutionalPick,
} from "@/lib/actions/sector-deep-dive";
import { EmptyState } from "@/components/empty/EmptyState";
import { classifySectorDeepDiveError } from "@/lib/actions/sector-deep-dive-messages";

interface Props {
  sectorName: string;
  onClose: () => void;
}

function fmtLakhCr(mcap: number): string {
  const lakhCr = mcap / 100_000_000_000_000;
  if (lakhCr >= 1) return `₹${lakhCr.toFixed(1)}L Cr`;
  const cr = mcap / 10_000_000;
  if (cr >= 1000) return `₹${(cr / 1000).toFixed(1)}K Cr`;
  return `₹${cr.toFixed(0)} Cr`;
}

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/**
 * RESULTS CALENDAR — MONEY-1217.
 *
 * Replaces the month grid that this panel used to render. That grid asked
 * `UpcomingEvent` for the next 30 days and drew a cell for every calendar day
 * whether or not anything was announced, with a green "0 events" pill on top.
 * Measured on prod 2026-08-19 the whole market had **7** earnings rows inside
 * that window, so what every sector actually got was a month of blank cells
 * captioned "0 events" — which reads as "this sector has no earnings this
 * month". We cannot make that claim: NSE intimates board-meeting dates ~2-3
 * weeks ahead, so an empty date overwhelmingly means "not announced yet".
 *
 * Three things changed, and each one is load-bearing:
 *
 *   1. THE UNIT IS A RESULTS SEASON, not a rolling window. Indian companies
 *      report in four bursts bounded by SEBI's 45/60-day filing deadlines
 *      (`@usemoney/core/market-data/results-season`), and mid-August sits
 *      between two of them. A rolling window is empty most of the year through
 *      no fault of the feed.
 *   2. ONLY DAYS WITH DATA ARE RENDERED. One row per announced day. There is no
 *      cell for a day we know nothing about, so the surface makes no claim
 *      about it.
 *   3. THE EMPTY STATE SAYS WHY. "No results dates announced yet" plus the
 *      publication lead-time — never a count pill over an empty grid.
 *
 * The two selectors match the segmented control the heatmap's timeframe picker
 * uses (`SectorsHeatmap.tsx`), so this reads as the same family of control
 * rather than a third idiom on the same page.
 */
function ResultsCalendarCard({
  sector,
  initial,
  constituents,
}: {
  sector: string;
  initial: ResultsCalendar;
  constituents: SectorDeepDive["constituents"];
}) {
  /**
   * The season the payload was built for — the current-or-next one — and the
   * anchor the prev/next buttons are relative to.
   *
   * Anchoring on the PAYLOAD's season rather than on the current selection
   * keeps the three buttons stable as the user pages: a next-relative-to-
   * selection control would walk the whole calendar away from today with no
   * way back, and the labels would change under the cursor on every click.
   */
  const anchor = initial.season.ordinal;
  const [ordinal, setOrdinal] = useState(anchor);
  const [scope, setScope] = useState<"sector" | "stock">("sector");
  const [symbol, setSymbol] = useState(constituents[0]?.symbol ?? "");
  const [override, setOverride] = useState<ResultsCalendar | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The payload already answers exactly one selection: this sector, this
  // season. Re-fetching it on mount would be a query for data we are holding.
  const isInitial = ordinal === anchor && scope === "sector";
  const calendar = isInitial ? initial : override;

  const seasonOptions = useMemo(
    () => [-1, 0, 1].map((delta) => seasonFromOrdinal(anchor + delta)),
    [anchor]
  );

  useEffect(() => {
    if (isInitial) {
      setOverride(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Scope "stock" with nothing to pick is not a query — a sector with no
    // quoted constituents would otherwise send `symbol: ""`, which the action
    // rejects, surfacing an error where the honest answer is "nothing to show".
    if (scope === "stock" && !symbol) {
      setOverride(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getResultsCalendarAction(
      scope === "stock"
        ? { scope: "stock", symbol, seasonOrdinal: ordinal }
        : { scope: "sector", sector, seasonOrdinal: ordinal }
    )
      .then((res) => {
        // `cancelled` guards the classic out-of-order resolve: click prev then
        // next quickly and the slower first response would otherwise land last
        // and paint the wrong season.
        if (cancelled) return;
        if (res.success && res.data) {
          setOverride(res.data);
        } else {
          setOverride(null);
          setError(res.error ?? "Could not load the results calendar");
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setOverride(null);
        setError("Could not load the results calendar");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isInitial, ordinal, scope, symbol, sector]);

  const seasonLabel =
    calendar?.season.label ?? seasonFromOrdinal(ordinal).label;

  return (
    <div className="pf-card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <div className="ttl">RESULTS CALENDAR</div>
        {/* The count pill renders ONLY when there is something to count. A
            "0 events" badge is the exact claim this rewrite exists to stop
            making, so the zero case gets prose (below) and no badge. */}
        {calendar != null && calendar.total > 0 && (
          <span className="pf-pill emerald" style={{ fontSize: 10 }}>
            {calendar.total} {calendar.total === 1 ? "date" : "dates"}
          </span>
        )}
        {loading && (
          <Loader2
            className="h-3.5 w-3.5 animate-spin"
            style={{ color: "var(--ink-3)" }}
          />
        )}
        <div style={{ flex: 1 }} />
        {/* Scope selector */}
        <SegmentedControl
          options={[
            { value: "sector", label: "SECTOR" },
            { value: "stock", label: "STOCK" },
          ]}
          value={scope}
          onChange={(v) => setScope(v === "stock" ? "stock" : "sector")}
        />
        {/* Season selector — three fixed windows around the current one. */}
        <SegmentedControl
          options={seasonOptions.map((s) => ({
            value: String(s.ordinal),
            label: s.label,
          }))}
          value={String(ordinal)}
          onChange={(v) => setOrdinal(Number(v))}
        />
      </div>

      {scope === "stock" && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <label
            className="mono"
            htmlFor="results-calendar-stock"
            style={{ fontSize: 10.5, color: "var(--ink-3)" }}
          >
            STOCK
          </label>
          <select
            id="results-calendar-stock"
            className="mono"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            style={{
              padding: "5px 8px",
              borderRadius: 6,
              border: "1.5px solid var(--ink)",
              background: "var(--paper)",
              color: "var(--ink)",
              fontSize: 11.5,
            }}
          >
            {constituents.map((c) => (
              <option key={c.symbol} value={c.symbol}>
                {c.symbol}
              </option>
            ))}
          </select>
          {/* Said out loud rather than implied: the picker lists the preview
              constituents the payload carries (top 12 by m-cap), not the whole
              sector, and a reader who does not find their stock here should
              know that is a scope limit and not an absence of results. */}
          <span
            className="mono"
            style={{ fontSize: 10.5, color: "var(--ink-3)" }}
          >
            top {constituents.length} by m-cap
          </span>
        </div>
      )}

      {error != null ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--ink-2)",
            padding: "12px 0",
          }}
        >
          <AlertCircle
            className="h-3.5 w-3.5"
            style={{ color: "var(--pop-2)", flexShrink: 0 }}
          />
          <span>{error}</span>
        </div>
      ) : calendar == null || calendar.days.length === 0 ? (
        /* The honest empty state. It distinguishes "not announced yet" from
           "nothing happens", which the old 0-events grid could not. */
        <div
          style={{
            fontSize: 12.5,
            color: "var(--ink-3)",
            lineHeight: 1.6,
            padding: "12px 0",
          }}
        >
          No results dates announced yet for {seasonLabel}. NSE publishes
          board-meeting dates ~2–3 weeks before results.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {calendar.days.map((day) => (
            <div
              key={day.date}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,110px) minmax(0,1fr)",
                gap: 12,
                alignItems: "baseline",
                borderTop: "1.5px solid var(--rule-soft)",
                paddingTop: 8,
              }}
            >
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-2)",
                  fontWeight: 700,
                }}
              >
                {fmtCalendarDay(day.date)}
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                }}
              >
                {day.events.map((e) => (
                  <span
                    key={`${day.date}-${e.symbol}`}
                    title={e.title}
                    style={{
                      display: "inline-flex",
                      alignItems: "baseline",
                      gap: 6,
                      borderRadius: 6,
                      border: "1.5px solid var(--rule-soft)",
                      background: "var(--rule-softer)",
                      padding: "3px 8px",
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 11.5,
                        fontWeight: 800,
                        color: "var(--emerald-text)",
                      }}
                    >
                      {e.symbol}
                    </span>
                    {e.name != null && (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--ink-3)",
                          maxWidth: 220,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {e.name}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Tue 20 Oct" from a `YYYY-MM-DD` key.
 *
 * Parsed back through `Date.UTC` and formatted in UTC, because the key itself is
 * a UTC calendar day: `new Date("2026-10-20")` in a timezone behind UTC renders
 * as the 19th, which would silently shift every date on this calendar by one day
 * for a reader west of Greenwich.
 */
function fmtCalendarDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * The page's segmented-control idiom, extracted so the two selectors above and
 * the heatmap's timeframe picker cannot drift apart visually.
 */
function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 3,
        padding: 3,
        border: "1.5px solid var(--ink)",
        borderRadius: 8,
        background: "var(--paper)",
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="mono"
            aria-pressed={active}
            style={{
              padding: "5px 10px",
              borderRadius: 5,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.3,
              cursor: "pointer",
              background: active ? "var(--ink)" : "transparent",
              color: active ? "var(--paper)" : "var(--ink-3)",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default function SectorDeepDiveComponent({
  sectorName,
  onClose,
}: Props) {
  const [data, setData] = useState<SectorDeepDive | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [constituentSort, setConstituentSort] = useState<
    "mcap" | "day" | "oneY" | "pe"
  >("mcap");

  // Bumped by "Try again" to re-run the effect without remounting.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getSectorDeepDiveAction({ sector: sectorName })
      .then((res) => {
        if (cancelled) return;
        if (!res.success || !res.data) {
          setError(
            res.success ? "Empty response" : (res.error ?? "Unknown error")
          );
          return;
        }
        setData(res.data);
      })
      // MONEY-1092 - this `.catch` is the difference between an error the
      // user can act on and a spinner that never stops. The action has its
      // own try/catch, so the only way this promise REJECTS is at transport
      // level - which is exactly what a platform function timeout produces,
      // and exactly what this panel used to hit. Without it `setLoading`
      // never ran and the spinner was permanent.
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't reach the server."
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sectorName, reloadNonce]);

  const sortedConstituents = useMemo(() => {
    if (!data) return [];
    const arr = [...data.constituents];
    arr.sort((a, b) => {
      if (constituentSort === "mcap") return b.mcap - a.mcap;
      if (constituentSort === "day") return b.dayPct - a.dayPct;
      if (constituentSort === "oneY")
        return (b.oneYPct ?? -Infinity) - (a.oneYPct ?? -Infinity);
      if (constituentSort === "pe")
        return (a.pe ?? Infinity) - (b.pe ?? Infinity);
      return 0;
    });
    return arr;
  }, [data, constituentSort]);

  if (loading) {
    // A bare spinner said nothing about WHAT was loading. This panel opens
    // below an already-rendered sector table, so an unlabelled spinner reads
    // as "the page is stuck" rather than "your drill-down is on its way" —
    // and it names the sector, which is the only thing distinguishing this
    // load from the one the user may have just triggered on another row.
    return (
      <div
        className="pf-card"
        style={{
          padding: "36px 0",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
        }}
        role="status"
        aria-live="polite"
      >
        <Loader2
          className="h-5 w-5 animate-spin"
          style={{ color: "var(--emerald)" }}
          aria-hidden
        />
        <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--ink)" }}>
          Loading {sectorName}
        </div>
        <div
          className="ser"
          style={{ fontSize: 12.5, color: "var(--ink-3)", fontStyle: "italic" }}
        >
          Building the sector breakdown — constituents, valuation and
          performance.
        </div>
      </div>
    );
  }

  if (error || !data) {
    // MONEY-1092 - was a bespoke dashed box with no title and no way out.
    // EmptyState is the company standard (15+ consumers), and the Retry
    // action is the point: a transient timeout is the common case here, so
    // the user needs a button, not a sentence.
    // Three outcomes, not two. A 25s TIMEOUT is the common failure on the
    // heavy sectors and it is not a breakage — saying "didn't come back"
    // implied one, which is both wrong and unactionable. See
    // lib/actions/sector-deep-dive-messages.ts for the measurements.
    const kind = classifySectorDeepDiveError(error);
    const notFound = kind === "not-found";
    const timedOut = kind === "timeout";

    const title = notFound
      ? `Nothing in ${sectorName} yet`
      : timedOut
        ? `${sectorName} took too long to load`
        : `Couldn't load ${sectorName}`;

    const description = notFound
      ? "No listed instruments are mapped here right now."
      : timedOut
        ? // Says what happened, why this sector specifically, and that the
          // retry is likely to work — the second attempt usually hits a warm
          // cache, which is the actual reason it succeeds.
          "This is one of the larger sectors, and the breakdown didn't finish in time. Trying again is usually enough — the second attempt is normally much faster."
        : "The sector breakdown didn't come back. This is usually temporary.";

    return (
      <EmptyState
        icon={AlertCircle}
        muted={notFound}
        color="var(--pop-2)"
        title={title}
        description={description}
        action={
          notFound
            ? undefined
            : {
                label: "Try again",
                onClick: () => setReloadNonce((n) => n + 1),
              }
        }
        secondaryAction={
          onClose ? { label: "Close", onClick: onClose } : undefined
        }
      />
    );
  }

  const screenerHref = `/discover/screener?stocks.sector=${encodeURIComponent(data.name)}`;
  const ytdPerf = data.ytdPerf ?? 0;
  const niftyYtdPerf = data.niftyYtdPerf ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* MONEY-1092 - the action can serve a last-known-good copy up to 24h
          old and stamps it `stale`. The heatmap grew a banner for exactly
          this; the panel had the field on its type and rendered nothing, so
          an hours-old drill-down looked identical to live data. Every
          weighted figure below (P/E, P/B, beta, m-cap) would be that old. */}
      {data.stale && (
        <div
          className="pf-card flat"
          style={{
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          <AlertCircle
            className="h-3.5 w-3.5"
            style={{ color: "var(--pop-2)", flexShrink: 0 }}
          />
          <span>
            Live data unavailable — these figures are as of{" "}
            <span className="mono">
              {new Date(data.staleSince ?? Date.now()).toLocaleTimeString(
                "en-IN",
                { hour: "2-digit", minute: "2-digit" }
              )}
            </span>
            .
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {/* Identity row */}
      <div className="pf-card">
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <h2
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: "var(--emerald-text)",
                  letterSpacing: -0.5,
                  margin: 0,
                }}
              >
                {data.name}
              </h2>
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 1.2,
                  color: "var(--ink-3)",
                  fontWeight: 700,
                }}
              >
                SECTOR · {data.count} CONSTITUENTS
              </span>
            </div>
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                marginTop: 6,
                flexWrap: "wrap",
                fontSize: 11.5,
              }}
            >
              <span
                className={`pf-pill ${ytdPerf >= 0 ? "emerald" : "coral"}`}
                style={{ fontSize: 10.5 }}
              >
                {fmtPct(ytdPerf)} YTD
              </span>
              <span style={{ color: "var(--ink-3)" }}>
                vs NIFTY 50 {fmtPct(niftyYtdPerf)} YTD
              </span>
              <span style={{ color: "var(--ink-3)" }}>
                · m-cap {fmtLakhCr(data.totalMcap)}
              </span>
            </div>
          </div>
          <Link href={screenerHref} className="pf-bf sm">
            <Filter className="h-3 w-3" /> Open in screener
          </Link>
          <button
            onClick={onClose}
            className="pf-bf sm"
            style={{ padding: 6 }}
            title="Close"
          >
            <ArrowRight className="h-4 w-4 rotate-180" />
          </button>
        </div>
      </div>

      {/* 4-stat hero cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
        }}
      >
        <HeroStat
          label="WEIGHTED P/E"
          value={data.weighted.pe.value}
          fmt={(v) => v.toFixed(1)}
          caption="vs index 22.1"
          color="var(--emerald-text)"
        />
        <HeroStat
          label="WEIGHTED P/B"
          value={data.weighted.pb.value}
          fmt={(v) => v.toFixed(1)}
          caption="vs 5y avg"
          color="var(--pop-2-text)"
        />
        <HeroStat
          label="DIV YIELD"
          value={data.weighted.divYield.value}
          fmt={(v) => `${v.toFixed(2)}%`}
          caption="vs NIFTY"
          color="var(--pop-5-text)"
        />
        <HeroStat
          label="BETA · 1Y"
          value={data.weighted.beta.value}
          fmt={(v) => v.toFixed(2)}
          caption={data.weighted.beta.descriptor}
          color="var(--ink)"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3.5 items-start">
        {/* Constituents table */}
        <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1.5px dashed var(--rule-soft)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div className="ttl">CONSTITUENTS</div>
            <span className="pf-pill outline" style={{ fontSize: 10 }}>
              {/* MONEY-1092 - this said "12 stocks" for a 209-stock sector:
                  it was labelling the length of the PREVIEW slice as the
                  sector's size, directly under a header reading "200
                  CONSTITUENTS". Show the real count; the preview size is
                  stated in the footer below. */}
              {data.count.toLocaleString("en-IN")} stocks
            </span>
            <div style={{ flex: 1 }} />
            <span
              className="mono"
              style={{ fontSize: 10.5, color: "var(--ink-3)" }}
            >
              weighted by m-cap
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="pf-tbl">
              <thead>
                <tr>
                  <Th
                    label="SYMBOL"
                    onClick={() => setConstituentSort("mcap")}
                  />
                  <Th label="NAME" />
                  <Th
                    label="M-CAP"
                    onClick={() => setConstituentSort("mcap")}
                    right
                    active={constituentSort === "mcap"}
                  />
                  <Th
                    label="DAY"
                    onClick={() => setConstituentSort("day")}
                    right
                    active={constituentSort === "day"}
                  />
                  <Th
                    label="1Y"
                    onClick={() => setConstituentSort("oneY")}
                    right
                    active={constituentSort === "oneY"}
                  />
                  <Th
                    label="P/E"
                    onClick={() => setConstituentSort("pe")}
                    right
                    active={constituentSort === "pe"}
                  />
                  <Th label="TREND" right />
                </tr>
              </thead>
              <tbody>
                {sortedConstituents.map((c) => (
                  <tr key={c.symbol}>
                    <td style={{ paddingLeft: 16 }}>
                      <Link
                        href={`/stock/${c.symbol}`}
                        className="hover:underline"
                      >
                        <span
                          className="tk"
                          style={{ color: "var(--emerald-text)" }}
                        >
                          {c.symbol}
                        </span>
                      </Link>
                    </td>
                    <td>
                      <span
                        className="nm"
                        style={{
                          display: "inline-block",
                          maxWidth: 180,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          verticalAlign: "bottom",
                        }}
                      >
                        {c.name}
                      </span>
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {fmtLakhCr(c.mcap)}
                    </td>
                    <td
                      className={`num ${c.dayPct >= 0 ? "pos" : "neg"}`}
                      style={{ textAlign: "right" }}
                    >
                      {fmtPct(c.dayPct)}
                    </td>
                    <td
                      className={`num ${(c.oneYPct ?? 0) >= 0 ? "pos" : "neg"}`}
                      style={{ textAlign: "right" }}
                    >
                      {fmtPct(c.oneYPct)}
                    </td>
                    <td
                      className="num"
                      style={{ textAlign: "right", color: "var(--ink-3)" }}
                    >
                      {c.pe == null ? "—" : c.pe.toFixed(1)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div
                        style={{ display: "flex", justifyContent: "flex-end" }}
                      >
                        <TrendSpark data={c.trend} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            style={{
              padding: "8px 16px",
              borderTop: "1.5px dashed var(--rule-soft)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 11,
              color: "var(--ink-3)",
            }}
          >
            <span>
              {/* Now honest on both halves: the preview really is the top N
                  by market cap, and `count` is the true sector size rather
                  than the old take:200 cap. */}
              Top {data.constituents.length} by m-cap ·{" "}
              {data.count.toLocaleString("en-IN")} in sector
            </span>
            <Link
              href={screenerHref}
              className="mono hover:underline"
              style={{ color: "var(--emerald-text)" }}
            >
              View full screener →
            </Link>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Correlation */}
          <div className="pf-card">
            <div className="ttl" style={{ marginBottom: 12 }}>
              CORRELATION · {data.name.toUpperCase()} vs PEER SECTORS
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {data.correlation.map((c) => {
                const pct = (c.value + 1) / 2; // -1..1 → 0..1
                const barColor =
                  c.value >= 0.5
                    ? "rgba(52,211,153,.7)"
                    : c.value >= 0
                      ? "rgba(52,211,153,.4)"
                      : c.value >= -0.3
                        ? "rgba(251,191,36,.5)"
                        : "rgba(248,113,113,.5)";
                return (
                  <div
                    key={c.peer}
                    className="mono"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 11,
                    }}
                  >
                    <span
                      style={{
                        width: 80,
                        color: "var(--ink-2)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.peer.replace("Nifty ", "")}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        borderRadius: 999,
                        background: "var(--rule-softer)",
                        overflow: "hidden",
                        border: "1px solid var(--rule-soft)",
                      }}
                    >
                      <div
                        style={{
                          width: `${pct * 100}%`,
                          height: "100%",
                          background: barColor,
                        }}
                      />
                    </div>
                    <span
                      style={{
                        width: 48,
                        textAlign: "right",
                        color: c.value >= 0 ? "var(--emerald-text)" : "#b91c1c",
                      }}
                    >
                      {c.value.toFixed(2)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Institutional picks (MONEY-268).
           *
           * These two cards were "TOP FII PICK" / "TOP DII PICK" and were
           * hidden, because per-symbol FII/DII flow does not exist: NSE's
           * cash-flow file is market-wide (`institutional_flows` is keyed
           * (date, category, segment), 8 rows on prod, no `symbol` column) and
           * the ticket's model — sector flow × index weight — would have
           * printed a national aggregate times a weight as a per-stock fact.
           *
           * What replaces them is a narrower claim the data actually supports:
           * the largest disclosed BULK/BLOCK prints among this sector's
           * constituents. The ranking is arithmetic over exchange-reported
           * prints; only the per-row chip is a name-derived classification, and
           * its unmatched answer is the honest "Institutional".
           *
           * The titles deliberately do NOT say FII or DII. A card headed "Top
           * FII buys" whose rows are mostly chipped "Institutional" would be
           * making the claim in the header that the rows refuse to make.
           */}
          <PicksPanel
            title="TOP INSTITUTIONAL BUYS"
            side="buy"
            picks={data.institutionalPicks?.buys ?? []}
            sessions={data.institutionalPicks?.sessions ?? null}
            failed={data.institutionalPicks === null}
          />
          <PicksPanel
            title="TOP INSTITUTIONAL SELLS"
            side="sell"
            picks={data.institutionalPicks?.sells ?? []}
            sessions={data.institutionalPicks?.sessions ?? null}
            failed={data.institutionalPicks === null}
          />
        </div>
      </div>

      {/* Results calendar — UNHIDDEN by MONEY-1217.
       *
       * It was hidden (MONEY-1218) because it rendered a 30-day month grid with
       * a green "0 events" pill for essentially every sector, which reads as
       * "this sector has no earnings this month" — a claim an empty query
       * cannot support.
       *
       * The diagnosis in that comment was half right, and the wrong half is
       * worth keeping written down because it is the reason this took a
       * rewrite rather than a widened query. It blamed the ~102-symbol tracked
       * list, but `gatherTargetSymbols` bounds only the YAHOO FALLBACK; the
       * NSE leg is whole-universe and `upcoming_events` already carries 766
       * NSE-sourced earnings rows spanning the listed market. What was actually
       * empty was the WINDOW: 30 future earnings rows platform-wide on
       * 2026-08-19, 7 of them inside 30 days, because mid-August sits between
       * two results seasons. Every sector`s grid was correctly reporting a real
       * seasonal gap in a unit that made it look like a data failure.
       *
       * So the calendar is back on a SEASON basis, listing only the days that
       * have data. See `ResultsCalendarCard` above.
       */}
      <ResultsCalendarCard
        sector={data.name}
        initial={data.earnings}
        constituents={data.constituents}
      />
    </div>
  );
}

function Th({
  label,
  onClick,
  right,
  active,
}: {
  label: string;
  onClick?: () => void;
  right?: boolean;
  active?: boolean;
}) {
  return (
    <th
      onClick={onClick}
      style={{
        textAlign: right ? "right" : "left",
        cursor: onClick ? "pointer" : "default",
        color: active ? "var(--emerald-text)" : undefined,
        paddingLeft: label === "SYMBOL" ? 16 : undefined,
      }}
    >
      {label}
    </th>
  );
}

function HeroStat({
  label,
  value,
  fmt,
  caption,
  color,
}: {
  label: string;
  value: number | null;
  fmt: (v: number) => string;
  caption: string;
  color: string;
}) {
  return (
    <div className="pf-card flat" style={{ padding: 16 }}>
      <div
        className="mono"
        style={{
          fontSize: 9.5,
          letterSpacing: 1,
          color: "var(--ink-3)",
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        className="mono"
        style={{ fontSize: 24, fontWeight: 800, marginTop: 4, color }}
      >
        {value == null ? "—" : fmt(value)}
      </div>
      <div
        className="mono"
        style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 4 }}
      >
        {caption}
      </div>
    </div>
  );
}

function TrendSpark({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 70;
  const h = 22;
  const pts = data
    .map(
      (v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`
    )
    .join(" ");
  const positive = data[data.length - 1]! >= data[0]!;
  return (
    <svg width={w} height={h} className="block">
      <polyline
        points={pts}
        fill="none"
        stroke={positive ? "#4ade80" : "#f87171"}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Net traded value, honest at every magnitude.
 *
 * The old `fmtCr` printed whole crore only, so a real net of ₹40,000 rendered
 * "₹0 Cr" — a row the card had just ranked as a top buy, displaying as
 * nothing. The prints in a quiet sector are genuinely small (prod's
 * Telecommunication card tops out under a lakh), so the unit steps down rather
 * than the number rounding away.
 */
function fmtDealValue(rupees: number): string {
  const sign = rupees < 0 ? "−" : "+";
  const abs = Math.abs(rupees);
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

/** FII / DII / Institutional, as a pill. */
function ClientChip({ cls }: { cls: SectorInstitutionalPick["clientClass"] }) {
  return (
    <span
      className="pf-pill outline mono"
      style={{
        fontSize: 8.5,
        padding: "1px 5px",
        letterSpacing: 0.2,
        color: "var(--ink-3)",
        whiteSpace: "nowrap",
      }}
      title={
        cls === "INSTITUTIONAL"
          ? "The counterparty name did not match a known FII or DII pattern. " +
            "NSE does not publish a participant category with these prints."
          : `Counterparty name matches a known ${cls} pattern`
      }
    >
      {cls === "INSTITUTIONAL" ? "Institutional" : cls}
    </span>
  );
}

function PicksPanel({
  title,
  side,
  picks,
  sessions,
  failed,
}: {
  title: string;
  side: "buy" | "sell";
  picks: SectorInstitutionalPick[];
  /** Sessions the window covered, for the caption. Null when unknown. */
  sessions: number | null;
  /** The read failed — distinct from a window with no prints in it. */
  failed: boolean;
}) {
  const tone = side === "buy" ? "var(--emerald-text)" : "#b91c1c";
  return (
    <div className="pf-card flat" style={{ padding: 16 }}>
      <div className="ttl" style={{ fontSize: 10.5, marginBottom: 8 }}>
        {title}
      </div>
      {picks.length === 0 ? (
        <div
          style={{ fontSize: 11.5, color: "var(--ink-3)", padding: "8px 0" }}
        >
          {/* Two different absences, said differently. An honest zero is a fact
              about the sector; a failed read is a fact about us, and collapsing
              them is what made the previous version of this card unreadable. */}
          {failed
            ? "Couldn't load bulk & block deals just now."
            : "No bulk or block deals in this sector this week"}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {picks.map((p) => (
            <div
              key={p.symbol}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                fontSize: 11.5,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                }}
              >
                <Link
                  href={`/stock/${encodeURIComponent(p.symbol)}`}
                  className="mono"
                  style={{
                    fontWeight: 800,
                    color: "var(--emerald-text)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={p.securityName || p.symbol}
                >
                  {p.symbol}
                </Link>
                <ClientChip cls={p.clientClass} />
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  whiteSpace: "nowrap",
                }}
              >
                <span className="mono" style={{ color: tone }}>
                  {fmtDealValue(p.netValue)}
                </span>
                <span
                  className="mono"
                  style={{ fontSize: 9, color: "var(--ink-3)" }}
                  title={`${p.dealCount} disclosed print${p.dealCount === 1 ? "" : "s"}; largest counterparty ${p.dominantClient}`}
                >
                  {p.dealCount}×
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      {/*
        The caption describes where the numbers came from, so it may only appear
        when numbers are on screen. Rendered unconditionally it contradicted the
        empty state directly above it — the card said there was nothing and
        then captioned itself with a metric, which reads as a feed that broke
        rather than one with nothing to report.
      */}
      {picks.length > 0 ? (
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            color: "var(--ink-3)",
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px dashed var(--rule-soft)",
          }}
        >
          From bulk &amp; block deals reported to the exchange, last{" "}
          {sessions ?? 7} sessions.
        </div>
      ) : null}
    </div>
  );
}
