"use client";

/**
 * IPO board — MONEY-1204 (P14 / 14d.3).
 *
 * Three tabs over `upcoming_ipos`: forthcoming, currently bidding, recently
 * listed.
 *
 * ## "Currently bidding" is an IST calendar question
 *
 * `issueEnd` is stored as UTC midnight of the IST closing day. Comparing it to
 * `Date.now()` marks the issue closed at 05:30 IST, so it vanishes for the
 * whole of its own final day — the one day the tab matters. The service
 * resolves the IST day key once and the pure bucketer compares day keys, so
 * this component never does date arithmetic at all. It renders what it is
 * given.
 *
 * ## Every date and price is nullable
 *
 * Issues get postponed, bands get revised, windows get extended mid-issue. A
 * missing band renders `—`, never `₹0`; a missing window renders "dates not
 * announced", and rows NSE has published with neither dates nor a usable status
 * get their own honest section instead of being dropped.
 */

import { useEffect, useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { SectionShell, formatAsOf } from "@/components/stock/SectionShell";
import {
  getIpoSectionsAction,
  type IpoSectionsData,
} from "@/lib/actions/discover-sections";

type IpoView = IpoSectionsData["current"][number];
type TabId = "current" | "upcoming" | "recent";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "current", label: "Bidding now" },
  { id: "upcoming", label: "Upcoming" },
  { id: "recent", label: "Recently listed" },
];

/** "₹100 – ₹105", "₹100" when the band is a point, `—` when unannounced. */
export function formatBand(min: number | null, max: number | null): string {
  const fmt = (v: number) => `₹${v.toLocaleString("en-IN")}`;
  if (min === null && max === null) return "—";
  if (min !== null && max !== null)
    return min === max ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
  return fmt((min ?? max) as number);
}

/** "14 Aug – 16 Aug 2026", or an honest "Dates not announced". */
export function formatWindow(start: string | null, end: string | null): string {
  const f = (d: string | null) =>
    d ? (formatAsOf(`${d}T00:00:00.000Z`) ?? d) : null;
  const a = f(start);
  const b = f(end);
  if (a && b) return `${a} – ${b}`;
  if (a) return `Opens ${a}`;
  if (b) return `Closes ${b}`;
  return "Dates not announced";
}

export interface IpoBoardProps {
  className?: string;
}

export function IpoBoard({ className = "" }: IpoBoardProps) {
  const [data, setData] = useState<IpoSectionsData | null>(null);
  const [prov, setProv] = useState<{
    source: string | null;
    asOf: string | null;
  }>({ source: null, asOf: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getIpoSectionsAction()
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setData(res.data.data);
          setProv({ source: res.data.source, asOf: res.data.asOf });
          setError(null);
        } else {
          setError(res.error);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load IPO calendar");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Land on the tab that has something in it — an open window first, because
  // that is the only one a user can act on today.
  const defaultTab: TabId = useMemo(() => {
    if (!data) return "current";
    if (data.current.length > 0) return "current";
    if (data.upcoming.length > 0) return "upcoming";
    return "recent";
  }, [data]);
  const activeTab = tab ?? defaultTab;

  const rows: IpoView[] = data ? data[activeTab] : [];
  const totals = data
    ? data.current.length + data.upcoming.length + data.recent.length
    : 0;

  return (
    <SectionShell
      title="IPOs"
      Icon={CalendarClock}
      eyebrow={
        data
          ? `as on ${formatAsOf(`${data.today}T00:00:00.000Z`) ?? data.today}`
          : undefined
      }
      loading={loading}
      error={error}
      empty={!loading && !error && totals === 0}
      emptyMessage="We track NSE's public-issue calendar. Nothing is open or scheduled right now."
      source={prov.source}
      asOf={prov.asOf}
      className={className}
    >
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}
      >
        {TABS.map((t) => {
          const count = data ? data[t.id].length : 0;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-pressed={t.id === activeTab}
              className="mono"
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                border: "1.5px solid var(--ink)",
                background: t.id === activeTab ? "var(--ink)" : "transparent",
                color: t.id === activeTab ? "var(--paper)" : "var(--ink)",
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                cursor: "pointer",
              }}
            >
              {t.label} ({count})
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div
          style={{
            borderRadius: 14,
            border: "2px dashed var(--rule-soft, var(--ink-3))",
            padding: "34px 20px",
            textAlign: "center",
            fontSize: 13,
            fontStyle: "italic",
            color: "var(--ink-3)",
          }}
        >
          {activeTab === "current"
            ? "No issue is accepting bids today."
            : activeTab === "upcoming"
              ? "Nothing scheduled yet."
              : "Nothing has listed in the last 30 days."}
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 12,
          }}
        >
          {rows.map((v) => (
            <IpoCard key={`${v.symbol}|${v.issueStart ?? "tbd"}`} ipo={v} />
          ))}
        </div>
      )}

      {data && data.unplaced.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: 1,
              textTransform: "uppercase",
              color: "var(--ink-3)",
              marginBottom: 6,
            }}
          >
            Announced, dates not fixed
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.unplaced.map((v) => (
              <span
                key={v.symbol}
                className="mono"
                style={{
                  padding: "3px 9px",
                  borderRadius: 999,
                  border: "1px solid var(--rule-soft, var(--ink-3))",
                  fontSize: 10.5,
                  color: "var(--ink-3)",
                }}
              >
                {v.symbol}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </SectionShell>
  );
}

function IpoCard({ ipo }: { ipo: IpoView }) {
  return (
    <div className="pf-card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{ fontWeight: 800, fontSize: 14, letterSpacing: "-0.2px" }}
        >
          {ipo.symbol}
        </span>
        {ipo.isSme ? (
          <span
            className="mono"
            style={{
              fontSize: 9,
              letterSpacing: 1,
              padding: "1px 6px",
              borderRadius: 999,
              border: "1px solid var(--ink-3)",
              color: "var(--ink-3)",
            }}
          >
            SME
          </span>
        ) : null}
        {ipo.closesToday ? (
          <span
            className="mono"
            style={{
              marginLeft: "auto",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 1,
              padding: "2px 7px",
              borderRadius: 999,
              background: "var(--pop-1, #ef4444)",
              color: "var(--paper)",
            }}
          >
            LAST DAY
          </span>
        ) : null}
      </div>

      {ipo.companyName ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--ink-2, var(--ink-3))",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {ipo.companyName}
        </div>
      ) : null}

      <dl
        style={{
          marginTop: 10,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          rowGap: 4,
          columnGap: 10,
          fontSize: 12,
        }}
      >
        <Row
          label="Window"
          value={formatWindow(ipo.issueStart, ipo.issueEnd)}
        />
        {/* Null band renders `—`. `₹0` would read as a free issue. */}
        <Row label="Band" value={formatBand(ipo.priceMin, ipo.priceMax)} />
        <Row
          label="Lot"
          value={
            ipo.lotSize === null ? "—" : ipo.lotSize.toLocaleString("en-IN")
          }
        />
        {ipo.listingDate ? (
          <Row
            label="Listed"
            value={
              formatAsOf(`${ipo.listingDate}T00:00:00.000Z`) ?? ipo.listingDate
            }
          />
        ) : null}
      </dl>

      {ipo.phase === "CURRENT" && ipo.daysToClose !== null ? (
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 8 }}
        >
          {ipo.daysToClose === 0
            ? "Closes today"
            : `${ipo.daysToClose} day${ipo.daysToClose === 1 ? "" : "s"} left`}
        </div>
      ) : ipo.phase === "UPCOMING" && ipo.daysToOpen !== null ? (
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 8 }}
        >
          Opens in {ipo.daysToOpen} day{ipo.daysToOpen === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          color: "var(--ink-3)",
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, textAlign: "right", fontWeight: 600 }}>
        {value}
      </dd>
    </>
  );
}

export default IpoBoard;
