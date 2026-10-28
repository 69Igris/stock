"use client";

/**
 * BrokerAccountsList - shared broker UI used by:
 *   - PromptOptionsPopover Connectors view (mode="connectors") with
 *     toggle + active-broker tracking
 *   - StockMentionPicker Brokers tab (mode="select") where clicking a
 *     row emits `onSelectBroker` so the chat composer can mention the
 *     account
 *
 * Visual structure mirrors the design exactly:
 *   - "Linked accounts · N/M active" header
 *   - Per-platform grouped card with logo + label + "+ Add" button
 *   - Per-account row: avatar + nickname + status pill / toggle +
 *     3-dot menu (Resync / Reconnect / Delete)
 *   - "Link a new broker" dashed CTA at bottom
 *
 * The 3-dot menu and "Add account" CTA both portal-render so they
 * float above clipping ancestors.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePfConfirm } from "@/components/ui/use-confirm";
import {
  Link2,
  MoreVertical,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  getBrokerConnectionsAction,
  syncBrokerDataAction,
  disconnectBrokerAction,
  getOAuthUrlAction,
} from "@/lib/actions/broker-connection";
// De-shadowed (MONEY-620): the status/nickname/filter helpers live in the
// React-free broker-accounts-logic.ts so they can be unit-tested without this
// component's Clerk/server-action chain.
import {
  deriveBrokerStatus,
  deriveBrokerNickname,
  filterBrokerRows,
} from "./broker-accounts-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface BrokerAccountRow {
  id: string;
  platform: string; // lowercase brokerType (e.g. "zerodha")
  brokerType: string; // BrokerType enum value (e.g. "ZERODHA")
  platformLabel: string; // "Zerodha"
  nickname: string;
  status: "active" | "expired" | "never";
  meta: string;
  brand: string;
  logo: string | null;
}

interface PlatformGroup {
  platform: string;
  brokerType: string;
  platformLabel: string;
  brand: string;
  logo: string | null;
  items: BrokerAccountRow[];
}

// Brand palette + logo paths shared across views. Keys are the
// uppercase BrokerType enum value so the same lookup works for any
// BrokerConnection row out of the database.
export const BROKER_BRAND: Record<
  string,
  { label: string; brand: string; logo: string | null }
> = {
  ZERODHA: { label: "Zerodha", brand: "#387ed1", logo: "/brokers/zerodha.png" },
  UPSTOX: { label: "Upstox", brand: "#7b2ff7", logo: "/brokers/upstox.png" },
  GROWW: { label: "Groww", brand: "#5eb66e", logo: "/brokers/groww.png" },
  ANGEL_ONE: {
    label: "Angel One",
    brand: "#e85454",
    logo: "/brokers/angel.png",
  },
  ANGEL: { label: "Angel One", brand: "#e85454", logo: "/brokers/angel.png" },
  DHAN: { label: "Dhan", brand: "#f59e42", logo: "/brokers/dhan.png" },
  FYERS: { label: "Fyers", brand: "#2196f3", logo: "/brokers/fyers.png" },
  IBKR: {
    label: "Interactive Brokers",
    brand: "#d61f2a",
    logo: "/brokers/ibkr.png",
  },
  INTERACTIVE_BROKERS: {
    label: "Interactive Brokers",
    brand: "#d61f2a",
    logo: "/brokers/ibkr.png",
  },
};

// ── Add account button ─────────────────────────────────────────────

export function AddAccountButton({ brokerType }: { brokerType: string }) {
  const [busy, setBusy] = useState(false);
  const handleClick = async () => {
    setBusy(true);
    try {
      const res = await getOAuthUrlAction(
        brokerType as Parameters<typeof getOAuthUrlAction>[0]
      );
      if (res.success && res.url) {
        window.location.href = res.url;
      } else {
        window.location.href = `/brokers?connect=${brokerType.toLowerCase()}`;
      }
    } catch {
      window.location.href = `/brokers?connect=${brokerType.toLowerCase()}`;
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      title="Add another account"
      onClick={handleClick}
      disabled={busy}
      className="inline-flex items-center gap-1 font-semibold"
      style={{
        height: 22,
        padding: "0 7px",
        borderRadius: 6,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        color: "var(--text-dim)",
        cursor: busy ? "wait" : "pointer",
        fontSize: 10,
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Plus className="w-2.5 h-2.5" /> {busy ? "…" : "Add"}
    </button>
  );
}

// ── 3-dot row menu (portaled so it escapes overflow:hidden ancestors) ─

export function BrokerRowMenu({
  row,
  onSynced,
  onDeleted,
}: {
  row: BrokerAccountRow;
  onSynced: () => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"sync" | "delete" | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { confirm, confirmDialog } = usePfConfirm();
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null
  );

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menuWidth = 168;
    setMenuPos({
      top: r.bottom + 4,
      left: Math.max(8, r.right - menuWidth),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const handleResync = async () => {
    setBusy("sync");
    try {
      await syncBrokerDataAction(
        row.brokerType as Parameters<typeof syncBrokerDataAction>[0],
        ["holdings", "positions", "trades", "mutualFunds"],
        row.id
      );
      await onSynced();
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: `Disconnect "${row.nickname}"?`,
      description: "You'll need to re-link the account to sync it again.",
      confirmLabel: "Disconnect",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy("delete");
    try {
      await disconnectBrokerAction(
        row.brokerType as Parameters<typeof disconnectBrokerAction>[0],
        row.id
      );
      await onDeleted();
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  return (
    <>
      {confirmDialog}
      <button
        ref={triggerRef}
        type="button"
        aria-label="Account menu"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="grid place-items-center"
        style={{
          width: 22,
          height: 22,
          borderRadius: 5,
          marginLeft: 2,
          background: open ? "rgba(255,255,255,0.06)" : "transparent",
          border: 0,
          color: "var(--text-muted)",
          cursor: "pointer",
        }}
      >
        <MoreVertical className="w-3 h-3" />
      </button>
      {open &&
        menuPos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            className="overflow-hidden"
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              zIndex: 1000,
              minWidth: 168,
              borderRadius: 9,
              background: "var(--bg-primary, #16140e)",
              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow:
                "0 14px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(52,211,153,0.05)",
              padding: 4,
            }}
          >
            {row.status === "active" && (
              <button
                type="button"
                onClick={handleResync}
                disabled={busy !== null}
                className="w-full flex items-center gap-2 font-medium"
                style={{
                  padding: "7px 9px",
                  borderRadius: 6,
                  background: "transparent",
                  border: 0,
                  color: "var(--text-primary)",
                  fontSize: 11.5,
                  cursor: busy ? "wait" : "pointer",
                  textAlign: "left",
                  opacity: busy ? 0.5 : 1,
                }}
              >
                <RefreshCw
                  className={`w-3 h-3 ${busy === "sync" ? "animate-spin" : ""}`}
                  style={{ color: "var(--accent-primary)" }}
                />
                {busy === "sync" ? "Syncing…" : "Resync now"}
              </button>
            )}
            {(row.status === "expired" || row.status === "never") && (
              <a
                href={`/brokers?reconnect=${row.id}`}
                className="w-full flex items-center gap-2 font-medium"
                style={{
                  padding: "7px 9px",
                  borderRadius: 6,
                  background: "transparent",
                  border: 0,
                  color: "var(--text-primary)",
                  fontSize: 11.5,
                  textDecoration: "none",
                }}
                onClick={() => setOpen(false)}
              >
                <Link2 className="w-3 h-3" style={{ color: "#fbbf24" }} />
                {row.status === "expired" ? "Reconnect" : "Connect"}
              </a>
            )}
            <div
              className="my-0.5 mx-1 h-px"
              style={{ background: "rgba(255,255,255,0.05)" }}
            />
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy !== null}
              className="w-full flex items-center gap-2 font-medium"
              style={{
                padding: "7px 9px",
                borderRadius: 6,
                background: "transparent",
                border: 0,
                color: "#f87171",
                fontSize: 11.5,
                cursor: busy ? "wait" : "pointer",
                textAlign: "left",
                opacity: busy ? 0.5 : 1,
              }}
            >
              <Trash2 className="w-3 h-3" />
              {busy === "delete" ? "Removing…" : "Delete account"}
            </button>
          </div>,
          document.body
        )}
    </>
  );
}

// ── Status pill ────────────────────────────────────────────────────

function StatusPill({ status }: { status: BrokerAccountRow["status"] }) {
  if (status === "expired") {
    return (
      <span
        className="font-semibold"
        style={{
          padding: "3px 8px",
          borderRadius: 6,
          background: "rgba(251,191,36,0.08)",
          border: "1px solid rgba(251,191,36,0.20)",
          color: "#fbbf24",
          fontSize: 10,
          whiteSpace: "nowrap",
        }}
      >
        Token expired
      </span>
    );
  }
  if (status === "never") {
    return (
      <span
        className="font-semibold"
        style={{
          padding: "3px 8px",
          borderRadius: 6,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "var(--text-dim)",
          fontSize: 10,
          whiteSpace: "nowrap",
        }}
      >
        Not synced
      </span>
    );
  }
  return (
    <span
      className="font-semibold"
      style={{
        padding: "3px 8px",
        borderRadius: 6,
        background: "rgba(52,211,153,0.08)",
        border: "1px solid rgba(52,211,153,0.20)",
        color: "var(--accent-primary)",
        fontSize: 10,
        whiteSpace: "nowrap",
      }}
    >
      Active
    </span>
  );
}

// ── Hook to fetch + normalize broker connections ───────────────────

export function useBrokerConnections() {
  const [rows, setRows] = useState<BrokerAccountRow[] | null>(null);

  const refresh = useCallback(async () => {
    const res = await getBrokerConnectionsAction();
    if (!res.success || !res.data) {
      setRows([]);
      return;
    }
    setRows(
      // MONEY-837: the founder-only Connect app is not a data/mention source.
      res.data
        .filter((b) => b.broker !== "ZERODHA_CONNECT")
        .map((b) => {
          const meta = BROKER_BRAND[b.broker.toString().toUpperCase()] ?? {
            label: b.broker,
            brand: "#94a3b8",
            logo: null,
          };
          const status: BrokerAccountRow["status"] = deriveBrokerStatus(b);
          return {
            id: b.id,
            platform: b.broker.toString().toLowerCase(),
            brokerType: b.broker.toString(),
            platformLabel: meta.label,
            nickname: deriveBrokerNickname(b),
            status,
            meta: b.lastSync
              ? `Last sync ${new Date(b.lastSync).toLocaleDateString()}`
              : status === "never"
                ? "Never synced"
                : "-",
            brand: meta.brand,
            logo: meta.logo,
          };
        })
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { rows, refresh, setRows };
}

// ── List component ─────────────────────────────────────────────────

interface BrokerAccountsListProps {
  /** Filter rows + groups by this string (matched against label + nickname) */
  filter?: string;
  /** Called when a row is clicked - emits the picked account */
  onSelectAccount?: (row: BrokerAccountRow) => void;
}

export default function BrokerAccountsList({
  filter,
  onSelectAccount,
}: BrokerAccountsListProps) {
  const { rows, refresh } = useBrokerConnections();

  const filteredRows = useMemo(() => {
    if (!rows) return null;
    return filterBrokerRows(rows, filter);
  }, [rows, filter]);

  const platforms = useMemo<PlatformGroup[]>(() => {
    const groups: Record<string, PlatformGroup> = {};
    (filteredRows ?? []).forEach((b) => {
      if (!groups[b.platform]) {
        groups[b.platform] = {
          platform: b.platform,
          brokerType: b.brokerType,
          platformLabel: b.platformLabel,
          brand: b.brand,
          logo: b.logo,
          items: [],
        };
      }
      groups[b.platform]!.items.push(b);
    });
    return Object.values(groups);
  }, [filteredRows]);

  if (rows === null) {
    return (
      <div className="py-12 text-center text-xs text-[var(--text-muted)]">
        Loading…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 flex flex-col items-center text-center">
        <span
          className="grid place-items-center w-11 h-11 rounded-xl mb-3"
          style={{
            background: "rgba(52,211,153,0.06)",
            border: "1px solid rgba(52,211,153,0.15)",
            color: "var(--accent-primary)",
          }}
        >
          <Plug className="h-5 w-5" />
        </span>
        <div className="text-sm font-semibold text-[var(--text-primary)] mb-1">
          No brokers connected
        </div>
        <div className="text-[11.5px] text-[var(--text-dim)] leading-snug max-w-[260px] mb-4">
          Connect a broker so StockSage can read your holdings + trades.
        </div>
        <a
          href="/brokers"
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--accent-primary)] text-[#16140e] text-xs font-semibold"
          style={{ boxShadow: "0 0 20px rgba(52,211,153,0.25)" }}
        >
          <Plus className="h-3 w-3" /> Connect a broker
        </a>
      </div>
    );
  }

  return (
    <div className="px-2 pb-2 pt-1.5">
      <div className="flex items-center justify-between px-1.5 pt-1 pb-2">
        <span
          className="font-mono uppercase font-bold"
          style={{
            fontSize: 9.5,
            letterSpacing: 1.5,
            color: "var(--text-muted)",
          }}
        >
          Linked accounts
        </span>
        <span className="font-mono text-[10px] text-[var(--text-muted)]">
          <span className="text-[var(--accent-primary)]">{rows.length}</span> /{" "}
          {rows.length} accounts
        </span>
      </div>

      {platforms.map((p) => (
        <div
          key={p.platform}
          className="mb-2 overflow-hidden"
          style={{
            borderRadius: 12,
            background: "rgba(255,255,255,0.018)",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div
            className="flex items-center gap-2.5 px-3 py-2.5"
            style={{
              background: `linear-gradient(90deg, ${p.brand}14 0%, transparent 60%)`,
              borderBottom: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            <span
              className="grid place-items-center shrink-0 overflow-hidden"
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: p.logo ? "#fff" : p.brand,
                color: "#fff",
                fontFamily: "var(--font-mono)",
                fontWeight: 700,
                fontSize: 11,
              }}
            >
              {p.logo ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={p.logo}
                  alt={p.platformLabel}
                  width={26}
                  height={26}
                  style={{ width: 26, height: 26, objectFit: "contain" }}
                />
              ) : (
                p.platformLabel.charAt(0)
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-[var(--text-primary)] tracking-tight">
                {p.platformLabel}
              </div>
              <div className="font-mono text-[9.5px] text-[var(--text-muted)] mt-px">
                {p.items.length} account{p.items.length > 1 ? "s" : ""}
              </div>
            </div>
            <AddAccountButton brokerType={p.brokerType} />
          </div>
          <div className="p-1">
            {p.items.map((b) => {
              const Wrapper = onSelectAccount ? "button" : "div";
              return (
                <Wrapper
                  key={b.id}
                  {...(onSelectAccount
                    ? {
                        type: "button" as const,
                        onClick: () => onSelectAccount(b),
                      }
                    : {})}
                  className="w-full flex items-center gap-2.5 mb-0.5 last:mb-0 text-left"
                  style={{
                    padding: "8px 8px 8px 10px",
                    borderRadius: 8,
                    background: "transparent",
                    border: 0,
                    cursor: onSelectAccount ? "pointer" : "default",
                    color: "var(--text-primary)",
                  }}
                >
                  <span
                    className="grid place-items-center shrink-0 font-mono font-bold"
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 999,
                      background: `${b.brand}22`,
                      border: `1px solid ${b.brand}55`,
                      color: b.brand,
                      fontSize: 9,
                    }}
                  >
                    {b.nickname.charAt(0)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                      {b.nickname}
                    </div>
                    <div className="font-mono text-[10px] text-[var(--text-muted)] mt-0.5">
                      {b.meta}
                    </div>
                  </div>
                  <StatusPill status={b.status} />
                  <BrokerRowMenu
                    row={b}
                    onSynced={refresh}
                    onDeleted={refresh}
                  />
                </Wrapper>
              );
            })}
          </div>
        </div>
      ))}

      <a
        href="/brokers"
        className="w-full inline-flex items-center justify-center gap-2 mt-1 font-semibold"
        style={{
          padding: 11,
          borderRadius: 10,
          background: "transparent",
          border: "1px dashed rgba(52,211,153,0.25)",
          color: "var(--accent-primary)",
          fontSize: 12,
          textDecoration: "none",
        }}
      >
        <Plus className="w-3.5 h-3.5" /> Link a new broker
      </a>
    </div>
  );
}
