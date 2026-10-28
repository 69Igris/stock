"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Plus, Key, Crown, Loader2, Circle } from "lucide-react";
import { SetSection } from "./primitives";
import {
  getBrokerConnectionsAction,
  type BrokerConnectionInfo,
} from "@/lib/actions/broker-connection";
import {
  BrokerLogo,
  toBrokerSlug,
} from "@/components/terminal-luxe/primitives";

interface IntegrationsTabProps {
  isDemoMode: boolean;
  isPro: boolean;
}

function formatBrokerName(b: string): string {
  return b
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}

function formatDate(d?: string): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export default function IntegrationsTab({
  isDemoMode,
  isPro,
}: IntegrationsTabProps) {
  const [brokers, setBrokers] = useState<BrokerConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getBrokerConnectionsAction();
      if (result?.success && result?.data) {
        setBrokers(result.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      {/* Connected brokers */}
      <SetSection
        title="Connected brokers"
        desc={
          <>
            Read-only summary. Manage in{" "}
            <Link
              href="/brokers"
              style={{ color: "var(--emerald-text)", fontWeight: 600 }}
              className="hover:underline"
            >
              Brokers →
            </Link>
          </>
        }
      >
        {loading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "40px 0",
              color: "var(--ink-3)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
            }}
          >
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading...
          </div>
        ) : brokers.length === 0 ? (
          <div
            style={{
              padding: "32px 22px",
              textAlign: "center",
              fontSize: 13,
              color: "var(--ink-3)",
            }}
          >
            No brokers connected yet. Visit{" "}
            <Link
              href="/brokers"
              style={{ color: "var(--emerald-text)" }}
              className="hover:underline"
            >
              Brokers →
            </Link>{" "}
            to add one.
          </div>
        ) : (
          brokers.map((b, i, a) => {
            const last = i === a.length - 1;
            const isLive =
              b.status === "CONNECTED" && !b.needsReauth && !b.isExpired;
            return (
              <div
                key={b.id}
                style={{
                  padding: "14px 22px",
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  borderBottom: last ? 0 : "1px dashed var(--rule-soft)",
                }}
              >
                <BrokerLogo slug={toBrokerSlug(b.broker)} size={34} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13.5,
                      color: "var(--ink)",
                      fontWeight: 700,
                    }}
                  >
                    {formatBrokerName(b.broker)}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      color: "var(--ink-3)",
                      marginTop: 3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {b.accountName || b.brokerUserId || b.id.slice(-8)} · linked{" "}
                    {formatDate(b.connectedAt)}
                  </div>
                </div>
                <span
                  className={`pf-pill${isLive ? " emerald" : ""}`}
                  style={
                    isLive
                      ? { fontSize: 10 }
                      : b.needsReauth
                        ? {
                            fontSize: 10,
                            background: "rgba(245,158,11,0.12)",
                            color: "#b45309",
                            borderColor: "#b45309",
                          }
                        : {
                            fontSize: 10,
                            background: "rgba(185,28,28,0.1)",
                            color: "#b91c1c",
                            borderColor: "#b91c1c",
                          }
                  }
                >
                  <Circle
                    className="h-2 w-2 fill-current"
                    style={{
                      animation: isLive ? "ph-pulse 2s infinite" : "none",
                    }}
                  />
                  {isLive ? "LIVE" : b.needsReauth ? "REAUTH" : b.status}
                </span>
              </div>
            );
          })
        )}
        <div
          style={{
            padding: "12px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
          }}
        >
          <Link
            href="/brokers"
            className="pf-bf sm"
            style={{ borderStyle: "dashed" }}
          >
            <Plus className="h-3 w-3" /> Connect another broker
          </Link>
        </div>
      </SetSection>

      {/* API tokens - PRO-gated */}
      <SetSection
        title="API tokens"
        desc={
          <>
            <span
              className="pf-pill emerald"
              style={{ fontSize: 9.5, marginRight: 6 }}
            >
              <Crown className="h-2.5 w-2.5" /> PRO
            </span>
            Programmatic access to your portfolio data. Rotate every 90 days.
          </>
        }
      >
        {!isPro ? (
          <div style={{ padding: "32px 22px", textAlign: "center" }}>
            <Key
              className="h-8 w-8 mx-auto"
              style={{ color: "var(--ink-4)", marginBottom: 12 }}
            />
            <div
              style={{
                fontSize: 13,
                color: "var(--ink)",
                fontWeight: 600,
                marginBottom: 4,
              }}
            >
              Upgrade to PRO for API access
            </div>
            <div
              style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 16 }}
            >
              10,000 API calls per month included.
            </div>
            <Link href="/pricing" className="pf-bs sm">
              Upgrade
            </Link>
          </div>
        ) : (
          <>
            <div
              style={{
                padding: "32px 22px",
                textAlign: "center",
                fontSize: 13,
                color: "var(--ink-3)",
              }}
            >
              No tokens yet. Generate one to start using the UseMoney API.
            </div>
            <div
              style={{
                padding: "12px 22px",
                borderTop: "1.5px dashed var(--rule-soft)",
              }}
            >
              <button
                type="button"
                disabled={isDemoMode}
                className="pf-bs sm"
                style={{
                  opacity: isDemoMode ? 0.5 : 1,
                  cursor: isDemoMode ? "not-allowed" : "pointer",
                }}
              >
                <Plus className="h-3 w-3" /> Generate token
              </button>
            </div>
          </>
        )}
      </SetSection>

      {/* Webhooks */}
      <SetSection
        title="Webhooks"
        desc="Push events to your URL. Signed with HMAC-SHA256."
      >
        <div style={{ padding: 22 }}>
          <label
            className="mono"
            style={{
              display: "block",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
              color: "var(--ink-4)",
              fontWeight: 700,
              marginBottom: 6,
            }}
          >
            Endpoint URL
          </label>
          <input
            type="url"
            placeholder="https://api.example.com/usemoney/hook"
            disabled={isDemoMode || !isPro}
            className="pf-input mono"
            style={{
              fontSize: 12.5,
              opacity: isDemoMode || !isPro ? 0.5 : 1,
            }}
          />
          <div
            style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}
          >
            {[
              "holding.updated",
              "tradebook.imported",
              "roast.generated",
              "alert.triggered",
              "paper.fill",
            ].map((e, i) => (
              <span
                key={e}
                className={`pf-pill${i < 3 ? " emerald" : " outline"}`}
                style={{ fontSize: 10.5, cursor: "pointer" }}
              >
                {e}
              </span>
            ))}
          </div>
        </div>
      </SetSection>
    </div>
  );
}
