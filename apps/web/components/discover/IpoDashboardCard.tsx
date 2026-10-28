"use client";

/**
 * Dashboard IPO card — MONEY-1204 (P14 / 14d.3).
 *
 * A side-card for the dashboard's right-hand column, live ONLY while a bidding
 * window is open (or one is imminent).
 *
 * ## It renders NOTHING when there is nothing
 *
 * `data.empty === true` means no issue is bidding and none is scheduled, and
 * this component returns `null` in that case — no card, no skeleton, no
 * placeholder. A permanent "No IPOs right now" tile would compete for space
 * with a user's actual portfolio on every quiet week of the year, which is most
 * weeks. That is the opposite of the section-level rule on a DETAIL page (where
 * an empty box explains that we track the thing and the exchange has not
 * published it); a dashboard tile has no page of its own to explain, so absence
 * is the honest render.
 *
 * It also renders nothing while loading — a card that pops in is better than a
 * skeleton that resolves to nothing on most days.
 *
 * ## The dates it shows are the SAME ones /discover/ipo shows
 *
 * The payload is derived from the same service call and the same IST day key,
 * so the card and the page cannot disagree about which issues are open — the
 * classic split-brain when a dashboard tile grows its own query.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, ArrowRight } from "lucide-react";
import {
  getIpoDashboardCardAction,
  type IpoDashboardData,
} from "@/lib/actions/discover-sections";

export interface IpoDashboardCardProps {
  limit?: number;
  className?: string;
}

export function IpoDashboardCard({
  limit = 3,
  className = "",
}: IpoDashboardCardProps) {
  const [data, setData] = useState<IpoDashboardData | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIpoDashboardCardAction({ limit })
      .then((res) => {
        if (cancelled) return;
        if (res.success) setData(res.data.data);
      })
      .catch(() => {
        /* A dashboard side-card must never surface a market-data failure as an
           error box next to a user's holdings. Silence is the degrade. */
      });
    return () => {
      cancelled = true;
    };
  }, [limit]);

  // Nothing open and nothing forthcoming ⇒ no card at all. See the header.
  if (!data || data.empty) return null;

  const open = data.open;
  const upcoming = data.nextOpen;

  return (
    <Link
      href="/discover/ipo"
      className={`pf-card ${className}`.trim()}
      style={{ display: "block", textDecoration: "none", color: "var(--ink)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <CalendarClock size={13} style={{ color: "var(--emerald)" }} />
        <span
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.2,
            textTransform: "uppercase",
          }}
        >
          {open.length > 0 ? "IPOs open now" : "IPO coming up"}
        </span>
        {data.closingToday.length > 0 ? (
          <span
            className="mono"
            style={{
              marginLeft: "auto",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.8,
              padding: "1px 6px",
              borderRadius: 999,
              background: "var(--pop-1, #ef4444)",
              color: "var(--paper)",
            }}
          >
            {data.closingToday.length} CLOSING TODAY
          </span>
        ) : null}
      </div>

      <div style={{ marginTop: 9, display: "grid", gap: 5 }}>
        {(open.length > 0 ? open : upcoming ? [upcoming] : []).map((v) => (
          <div
            key={`${v.symbol}|${v.issueStart ?? "tbd"}`}
            style={{ display: "flex", alignItems: "baseline", gap: 8 }}
          >
            <span style={{ fontWeight: 700, fontSize: 13 }}>{v.symbol}</span>
            {v.isSme ? (
              <span
                className="mono"
                style={{
                  fontSize: 8.5,
                  letterSpacing: 0.8,
                  color: "var(--ink-3)",
                }}
              >
                SME
              </span>
            ) : null}
            <span
              className="mono"
              style={{
                marginLeft: "auto",
                fontSize: 10,
                color: "var(--ink-3)",
              }}
            >
              {v.closesToday
                ? "closes today"
                : v.daysToClose !== null
                  ? `${v.daysToClose}d left`
                  : v.daysToOpen !== null
                    ? `opens in ${v.daysToOpen}d`
                    : // Null band / null window renders as an honest dash, never
                      // a fabricated date or a ₹0 price.
                      "—"}
            </span>
          </div>
        ))}
      </div>

      {data.openCount > open.length ? (
        <div
          className="mono"
          style={{ fontSize: 9.5, color: "var(--ink-3)", marginTop: 7 }}
        >
          +{data.openCount - open.length} more open
        </div>
      ) : null}

      <span
        className="pf-bf sm"
        style={{
          marginTop: 11,
          background: "var(--ink)",
          color: "var(--paper)",
          borderColor: "var(--ink)",
        }}
      >
        <ArrowRight size={12} /> IPO calendar
      </span>
    </Link>
  );
}

export default IpoDashboardCard;
