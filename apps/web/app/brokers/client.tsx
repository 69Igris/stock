"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  RefreshCw,
  Unlink,
  Key,
  Link as LinkIcon,
  Loader2,
  ExternalLink,
  Lock,
  Upload,
  ShieldCheck,
} from "lucide-react";

import { TerminalLuxeShell } from "@/components/terminal-luxe/Shell";
import { PfPageHead } from "@/components/playful/PfPageHead";
import {
  BrokerLogo,
  toBrokerSlug,
} from "@/components/terminal-luxe/primitives";

import {
  getOAuthUrlAction,
  getBrokerConnectionsAction,
  getConnectFounderStatusAction,
  getBrokerGateStatusAction,
  disconnectBrokerAction,
  syncBrokerDataAction,
  getBrokerSyncJobStatusAction,
  connectWithApiKeyAction,
  updateBrokerAccountNameAction,
  type BrokerConnectionInfo,
} from "@/lib/actions/broker-connection";
import type { BrokerType } from "@usemoney/types/broker";
import { DemoBanner } from "@/components/DemoBanner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@usemoney/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@usemoney/ui/dialog";
import { Input } from "@usemoney/ui/input";
import { Label } from "@usemoney/ui/label";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import BrokerConsentModal from "@/components/brokers/BrokerConsentModal";
import { getBrokerConsentStatusAction } from "@/lib/actions/consent";

/* =====================================================================
   Broker catalog - display metadata. The OAuth/API-key flow lives in the
   server actions; this is just what we render.
   ===================================================================== */

interface BrokerCatalogEntry {
  id: BrokerType;
  name: string;
  desc: string;
  authType: "oauth" | "api_key";
  /** Brand colour for the rotated `.pf-av-sq` logo tile. */
  brand: string;
  /** 2-letter mono initials shown inside the logo tile. */
  initials: string;
  popular?: boolean;
  comingSoon?: boolean;
  /** MONEY-837: founder-only (paid Connect app) — hidden from the picker unless the viewer is a Connect founder. */
  founderOnly?: boolean;
}

const BROKERS: BrokerCatalogEntry[] = [
  {
    id: "ZERODHA",
    name: "Zerodha",
    desc: "India's largest discount broker (Kite Connect API)",
    authType: "oauth",
    brand: "#387ed1",
    initials: "ZE",
    popular: true,
  },
  {
    // MONEY-837: founder-only paid Kite Connect app — live quotes + intraday
    // candles. Token-capture only (no portfolio sync; the Personal app above
    // owns that). Hidden from the picker for everyone except Connect founders.
    id: "ZERODHA_CONNECT",
    name: "Zerodha Connect",
    desc: "Live quotes & intraday candles — founder only (paid Connect app)",
    authType: "oauth",
    brand: "#387ed1",
    initials: "ZC",
    founderOnly: true,
  },
  {
    id: "UPSTOX",
    name: "Upstox",
    desc: "Multi-asset broker, popular with traders (1-year token)",
    authType: "oauth",
    brand: "#7b2ff7",
    initials: "UP",
    comingSoon: true,
  },
  {
    id: "DHAN",
    name: "Dhan",
    desc: "Retail-friendly, fast execution (API key + token)",
    authType: "api_key",
    brand: "#f59e42",
    initials: "DH",
    comingSoon: true,
  },
  {
    id: "FYERS",
    name: "Fyers",
    desc: "Advanced charts + API-first",
    authType: "oauth",
    brand: "#2196f3",
    initials: "FY",
    comingSoon: true,
  },
  {
    id: "ANGEL_ONE",
    name: "Angel One",
    desc: "Full-service broker, SmartAPI",
    authType: "oauth",
    brand: "#e85454",
    initials: "AN",
    comingSoon: true,
  },
  {
    id: "GROWW",
    name: "Groww",
    desc: "Mobile-first, beginner-friendly",
    authType: "api_key",
    brand: "#5eb66e",
    initials: "GR",
    comingSoon: true,
  },
  {
    id: "HDFC",
    name: "HDFC Securities",
    desc: "Bank-backed, full-service",
    authType: "oauth",
    brand: "#004c8f",
    initials: "HD",
    comingSoon: true,
  },
  {
    id: "ICICI",
    name: "ICICI Direct",
    desc: "Bank-backed, full-service (Breeze API)",
    authType: "oauth",
    brand: "#ff6f00",
    initials: "IC",
    comingSoon: true,
  },
];

/* =====================================================================
   Page
   ===================================================================== */

// MONEY-839: a post-OAuth connect can briefly mount this page twice (the
// /brokers?success=… redirect), and a per-INSTANCE ref doesn't survive a remount
// → the success toast fired twice. A module-scoped flag dedupes across remounts;
// every real connect arrives via a fresh server redirect (full page load) which
// re-evaluates this module and resets the flag, so a genuine later connect still
// toasts exactly once.
let oauthToastHandled = false;

export default function BrokersPageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const hasShownToast = useRef(false);

  const [tab, setTab] = useState<"connected" | "available">("connected");
  const [connections, setConnections] = useState<BrokerConnectionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFounder, setIsFounder] = useState(false);
  const [gate, setGate] = useState<{
    isFree: boolean;
    trialExpired: boolean;
    remainingDays: number;
    atBrokerLimit: boolean;
  } | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  // MONEY-848: locks a connection's row (Sync / Re-auth / Unlink / "Add another")
  // while its unlink is in flight, so a mid-delete second click can't fire ops
  // against a connection that's being cascade-deleted.
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<BrokerType | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  const [apiKeyDialog, setApiKeyDialog] = useState<{
    open: boolean;
    broker: BrokerCatalogEntry | null;
  }>({ open: false, broker: null });
  const [consentModal, setConsentModal] = useState<{
    open: boolean;
    pending: BrokerCatalogEntry | null;
  }>({ open: false, pending: null });
  const [apiKeyForm, setApiKeyForm] = useState({
    clientId: "",
    accessToken: "",
  });

  const [disconnectDialog, setDisconnectDialog] = useState<{
    open: boolean;
    connectionId?: string;
    broker?: BrokerType;
    displayName: string;
  }>({ open: false, displayName: "" });

  // MONEY-1137: gate the demo signal on the signed-in user. /brokers is an
  // APP route (auth OR demo cookie), so a real user reaching it with a stale
  // `tradebook_demo_mode` flag would otherwise see the demo broker set and
  // demo-disabled connect actions over their real connections.
  const { user } = useUser();
  const isDemoMode = useIsDemoMode({ user });

  /* Switch to "Connected" if connections exist; otherwise "Add broker". */
  useEffect(() => {
    if (!isLoading) setTab(connections.length > 0 ? "connected" : "available");
  }, [isLoading, connections.length]);

  const loadConnections = useCallback(async () => {
    try {
      // MONEY-837: the brokers MANAGEMENT page is the one place that shows the
      // founder-only Connect connector, so it opts in.
      const result = await getBrokerConnectionsAction({
        includeConnectOnly: true,
      });
      if (result?.success && result?.data) setConnections(result.data);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // MONEY-837: reveal the founder-only "Zerodha Connect (live data)" card.
  useEffect(() => {
    void getConnectFounderStatusAction().then((r) => {
      if (r?.isFounder) setIsFounder(true);
    });
    // MONEY-837: free-tier gate status for the upgrade banner.
    void getBrokerGateStatusAction().then((g) => g && setGate(g));
  }, []);

  /* OAuth callback toast + finalize (MONEY-142) */
  useEffect(() => {
    if (hasShownToast.current || oauthToastHandled) return;
    const success = searchParams.get("success");
    const error = searchParams.get("error");
    const broker = searchParams.get("broker");
    if (success === "connected" && broker) {
      hasShownToast.current = true;
      oauthToastHandled = true;
      const brokerName = broker.charAt(0).toUpperCase() + broker.slice(1);
      // Strip the params first (so a refresh can't re-toast), then show a
      // brief "finalizing" loader while we pull the freshly-synced
      // connections and resolve it into the success toast.
      router.replace("/brokers");
      const toastId = toast.loading(`Finalizing ${brokerName} connection…`);
      void loadConnections().finally(() => {
        toast.success(`${brokerName} connected and synced!`, { id: toastId });
      });
    } else if (error) {
      hasShownToast.current = true;
      oauthToastHandled = true;
      // The callback route forwards the action's already-sanitized,
      // user-friendly reason (trial expired / security state / broker
      // error). Only the two stable short-codes are mapped here; any other
      // value is shown verbatim because it's already display-ready.
      const friendly =
        error === "auth_cancelled"
          ? "Connection cancelled."
          : error === "auth_failed"
            ? "Something went wrong while connecting your broker. Please try again, or contact support if the issue continues."
            : error;
      // Trial-expiry is the one failure with a clear next step → offer an
      // inline Upgrade shortcut and hold the toast a little longer.
      const isTrial = /trial|upgrade/i.test(friendly);
      toast.error(friendly, {
        duration: isTrial ? 10000 : 6000,
        ...(isTrial
          ? {
              action: {
                label: "Upgrade",
                onClick: () => router.push("/pricing"),
              },
            }
          : {}),
      });
      router.replace("/brokers");
    }
  }, [searchParams, router, loadConnections]);

  /* ── Group by broker for the design's per-broker card layout ── */
  const byBroker = useMemo(() => {
    const m = new Map<BrokerType, BrokerConnectionInfo[]>();
    connections.forEach((c) => {
      if (!m.has(c.broker)) m.set(c.broker, []);
      m.get(c.broker)!.push(c);
    });
    return m;
  }, [connections]);

  const connectedBrokers = useMemo(
    () => Array.from(byBroker.keys()),
    [byBroker]
  );

  const totalConnections = connections.length;
  const reauthCount = connections.filter(
    (c) => c.needsReauth || c.isExpired
  ).length;
  const liveCount = totalConnections - reauthCount;

  /* ── Actions ── */
  const startEdit = (c: BrokerConnectionInfo, fallback: string) => {
    setEditingId(c.id);
    setDraft(c.accountName || fallback);
    setTimeout(() => editInputRef.current?.focus(), 30);
  };

  const commitEdit = async () => {
    if (!editingId || !draft.trim()) {
      setEditingId(null);
      return;
    }
    const result = await updateBrokerAccountNameAction(editingId, draft.trim());
    if (result?.success) {
      toast.success("Account name updated");
      await loadConnections();
    } else {
      toast.error(result?.error || "Failed to update");
    }
    setEditingId(null);
  };

  // Runs the actual connect once consent is satisfied (OAuth redirect or the
  // API-key dialog). Extracted so the consent gate can re-invoke it.
  const proceedConnect = async (
    b: BrokerCatalogEntry,
    connectionId?: string
  ) => {
    if (b.authType === "api_key") {
      setApiKeyDialog({ open: true, broker: b });
      return;
    }
    setConnectingId(b.id);
    try {
      // MONEY-837: on re-auth, pass the connectionId so the callback binds to
      // and validates the specific account being re-authorised.
      const result = await getOAuthUrlAction(b.id, connectionId);
      if (result?.success && result?.url) {
        window.location.href = result.url;
      } else {
        toast.error(result?.error || "Failed to initiate connection");
        setConnectingId(null);
      }
    } catch {
      toast.error("Connection failed");
      setConnectingId(null);
    }
  };

  const handleConnect = async (
    b: BrokerCatalogEntry,
    connectionId?: string
  ) => {
    if (b.comingSoon) {
      toast.info(`${b.name} integration coming soon`);
      return;
    }
    // MONEY-505: SEBI IA Reg 18(9) — present + record the AI-advisory disclosure
    // before connecting a broker. Already-consented users proceed straight
    // through; first-timers see the consent modal, which records consent then
    // resumes the original connect.
    const consent = await getBrokerConsentStatusAction();
    if (!consent.accepted) {
      setConsentModal({ open: true, pending: b });
      return;
    }
    await proceedConnect(b, connectionId);
  };

  const handleApiKeyConnect = async () => {
    if (
      !apiKeyDialog.broker ||
      !apiKeyForm.clientId ||
      !apiKeyForm.accessToken
    ) {
      toast.error("Enter Client ID and Access Token");
      return;
    }
    setConnectingId(apiKeyDialog.broker.id);
    try {
      const result = await connectWithApiKeyAction(
        apiKeyDialog.broker.id,
        apiKeyForm.clientId,
        apiKeyForm.accessToken
      );
      if (result?.success) {
        toast.success(`${apiKeyDialog.broker.name} connected`);
        setApiKeyDialog({ open: false, broker: null });
        setApiKeyForm({ clientId: "", accessToken: "" });
        await loadConnections();
      } else {
        toast.error(result?.error || "Connection failed");
      }
    } finally {
      setConnectingId(null);
    }
  };

  const handleSync = async (c: BrokerConnectionInfo) => {
    setSyncingId(c.id);
    // MONEY-848: sync is WORKER-ONLY — syncBrokerDataAction only PUBLISHES the
    // job, so the old instant "Synced" toast was misleading (nothing had synced
    // yet). Request a confirmation email (syncEmail) and POLL the job (like the
    // tradebook does) so we can toast the REAL per-type counts on completion +
    // a second "email sent" toast. Non-blocking: we clear the spinner once the
    // job settles, but a long historical-less day sync finishes fast.
    try {
      const result = await syncBrokerDataAction(
        c.broker,
        ["holdings", "positions", "trades", "mutualFunds"],
        c.id,
        { syncEmail: true }
      );
      if (!result?.success) {
        toast.error(result?.error || "Sync failed");
        return;
      }
      toast.success("Sync started — fetching your latest data…");
      if (result.jobId) {
        void pollSyncJob(result.jobId);
      } else {
        // No jobId to poll (shouldn't happen) — just refresh.
        await loadConnections();
      }
    } finally {
      setSyncingId(null);
    }
  };

  // MONEY-848: poll a published sync job until it settles, then toast real
  // counts. Runs detached from the button spinner (the worker does the work);
  // bounded so it can never wedge. Best-effort — a poll error just stops.
  const pollSyncJob = async (jobId: string) => {
    const STEP = 3000;
    const MAX_MS = 5 * 60 * 1000;
    let waited = 0;
    while (waited < MAX_MS) {
      await new Promise((r) => setTimeout(r, STEP));
      waited += STEP;
      let res: Awaited<ReturnType<typeof getBrokerSyncJobStatusAction>> | null =
        null;
      try {
        res = await getBrokerSyncJobStatusAction(jobId);
      } catch {
        return;
      }
      if (!res || res.status === "UNKNOWN") continue;
      if (res.status === "PENDING" || res.status === "PROCESSING") continue;
      if (res.status === "FAILED") {
        toast.error(res.error || "Sync failed");
        return;
      }
      // COMPLETED — refresh the connection list (lastSync) + toast counts.
      await loadConnections();
      const s = res.synced || {};
      const total =
        res.total ??
        (s.holdings || 0) +
          (s.positions || 0) +
          (s.trades || 0) +
          (s.mutualFunds || 0);
      const parts: string[] = [];
      if (s.holdings != null) parts.push(`holdings ${s.holdings}`);
      if (s.positions != null) parts.push(`positions ${s.positions}`);
      if (s.trades != null) parts.push(`trades ${s.trades}`);
      if (s.mutualFunds != null) parts.push(`funds ${s.mutualFunds}`);
      toast.success(
        `Synced ${total} record${total === 1 ? "" : "s"}${
          parts.length ? ` (${parts.join(" · ")})` : ""
        }`
      );
      toast.success("Confirmation email sent");
      return;
    }
  };

  const confirmDisconnect = async () => {
    const { broker, connectionId, displayName } = disconnectDialog;
    if (!broker) return;
    // MONEY-848: lock this connection's row ops while the cascade delete runs.
    setDisconnectingId(connectionId ?? null);
    // Close the dialog immediately so the lock (disabled buttons) is visible.
    setDisconnectDialog({ open: false, displayName: "" });
    try {
      const result = await disconnectBrokerAction(broker, connectionId);
      if (result?.success) {
        toast.success(`${displayName} disconnected`);
        await loadConnections();
      } else {
        toast.error(result?.error || "Failed to disconnect");
      }
    } finally {
      setDisconnectingId(null);
    }
  };

  return (
    <TerminalLuxeShell
      active="brokers"
      title="Brokers"
      breadcrumb="Account"
      topbarRight={
        <button
          type="button"
          className="pf-bs sm um-hide-mobile"
          onClick={() => setTab("available")}
        >
          <Plus style={{ width: 13, height: 13 }} /> Connect new broker
        </button>
      }
    >
      {isDemoMode && <DemoBanner />}

      <PfPageHead
        eyebrow={`${connectedBrokers.length} CONNECTED · READ-ONLY OAUTH`}
        title={
          <>
            Every broker, <span className="ser">in one</span>{" "}
            <span className="hl-gold">ledger.</span>
          </>
        }
        sub="We sync holdings, positions and tradebook — we can never place orders."
      />

      {/* ── Stat strip (playful pf-stat tiles) ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div className="pf-card pf-stat tilt-l">
          <div className="l">Linked accounts</div>
          <div className="v">{totalConnections}</div>
          <div className="d" style={{ color: "var(--ink-3)" }}>
            {connectedBrokers.length}{" "}
            {connectedBrokers.length === 1 ? "broker" : "brokers"} ·
            multi-account
          </div>
        </div>
        <div className="pf-card pf-stat">
          <div className="l">Brokers</div>
          <div className="v">{connectedBrokers.length}</div>
          <div className="d" style={{ color: "var(--ink-3)" }}>
            Auto-synced daily
          </div>
        </div>
        <div
          className="pf-card pf-stat"
          style={
            reauthCount > 0
              ? undefined
              : {
                  background: "var(--emerald-bg)",
                  borderColor: "var(--emerald)",
                }
          }
        >
          <div className="l">Sync status</div>
          <div
            className="v"
            style={{
              fontSize: 22,
              color: reauthCount > 0 ? "var(--pop-1)" : "var(--emerald)",
            }}
          >
            {reauthCount > 0 ? `${reauthCount} re-auth` : "All healthy"}
          </div>
          <div className={`d ${reauthCount > 0 ? "neg" : "pos"}`}>
            {reauthCount > 0 ? "↻ Action needed" : `● ${liveCount} live`}
          </div>
        </div>
        <div className="pf-card pf-stat tilt-r">
          <div className="l">Encryption</div>
          <div className="v" style={{ fontSize: 20 }}>
            AES-256-GCM
          </div>
          <div className="d" style={{ color: "var(--ink-3)" }}>
            Read-only access
          </div>
        </div>
      </div>

      {/* MONEY-837: free-tier upgrade banner — after the 30-day trial, sync +
          connect/re-auth are disabled until the user upgrades. Styled like the
          holdings token-expiry banner. */}
      {gate?.isFree && gate.trialExpired && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            padding: "14px 16px",
            marginBottom: 18,
            borderRadius: 10,
            background: "rgba(248,113,113,.1)",
            border: "1.5px solid var(--pop-1)",
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: "var(--ink)",
              flex: 1,
              minWidth: 220,
              lineHeight: 1.5,
            }}
          >
            <strong>Your 30-day free trial has ended.</strong> Broker sync and
            re-authorisation are paused. Upgrade to Pro to keep your portfolio
            in sync.
          </span>
          <Link href="/settings?tab=billing" className="pf-bs sm">
            Upgrade →
          </Link>
        </div>
      )}

      {/* ── Tabs (playful segmented control) ── */}
      <div
        style={{
          display: "inline-flex",
          gap: 6,
          padding: 4,
          background: "var(--rule-softer)",
          borderRadius: 10,
          border: "1.5px solid var(--ink)",
          marginBottom: 18,
          maxWidth: "100%",
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
        }}
      >
        {(
          [
            ["connected", `Connected · ${totalConnections}`],
            ["available", "Add broker"],
          ] as const
        ).map(([id, lbl]) => {
          const a = tab === id;
          return (
            <button
              type="button"
              key={id}
              onClick={() => setTab(id)}
              style={{
                padding: "6px 14px",
                borderRadius: 7,
                border: 0,
                cursor: "pointer",
                background: a ? "var(--ink)" : "transparent",
                color: a ? "var(--paper)" : "var(--ink-3)",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.5,
                whiteSpace: "nowrap",
              }}
            >
              {lbl.toUpperCase()}
            </button>
          );
        })}
      </div>

      {/* CONNECTED TAB */}
      {tab === "connected" && (
        <>
          {connectedBrokers.length === 0 && !isLoading && (
            <div
              className="pf-card"
              style={{ padding: 36, textAlign: "center" }}
            >
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 13,
                  background: "var(--emerald)",
                  color: "var(--paper)",
                  display: "grid",
                  placeItems: "center",
                  border: "2px solid var(--ink)",
                  transform: "rotate(-3deg)",
                  boxShadow: "3px 3px 0 var(--ink)",
                  margin: "0 auto 16px",
                }}
              >
                <LinkIcon style={{ width: 24, height: 24 }} />
              </div>
              <div
                style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.4 }}
              >
                No brokers linked yet.
              </div>
              <div
                style={{
                  fontSize: 13.5,
                  color: "var(--ink-3)",
                  margin: "6px auto 16px",
                  maxWidth: 380,
                  lineHeight: 1.5,
                }}
              >
                Connect your first broker to auto-sync holdings, positions and
                trades — or import a CSV.
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                <button
                  type="button"
                  className="pf-bs sm"
                  onClick={() => setTab("available")}
                >
                  <Plus style={{ width: 13, height: 13 }} /> Connect a broker
                </button>
                <Link
                  href="/tradebook/import"
                  className="pf-bf sm"
                  style={{ textDecoration: "none" }}
                >
                  <Upload style={{ width: 13, height: 13 }} /> Import CSV
                </Link>
              </div>
            </div>
          )}

          {connectedBrokers.map((slug) => {
            const meta = BROKERS.find((b) => b.id === slug);
            const list = byBroker.get(slug) || [];
            // MONEY-848: true while ANY account of this broker is being unlinked
            // — freezes "Add another" + sibling Sync buttons (a cascade delete
            // clears this broker's caches and is briefly inconsistent).
            const brokerUnlinking =
              disconnectingId != null &&
              list.some((x) => x.id === disconnectingId);
            return (
              <div
                key={slug}
                className="pf-card"
                style={{ padding: 0, marginBottom: 14, overflow: "hidden" }}
              >
                {/* Broker header */}
                <div
                  style={{
                    padding: "16px 18px",
                    borderBottom: "1.5px dashed var(--rule-soft)",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <BrokerLogo slug={toBrokerSlug(slug as string)} size={42} />
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <h3
                        style={{
                          margin: 0,
                          fontSize: 17,
                          fontWeight: 800,
                          letterSpacing: -0.4,
                          color: "var(--ink)",
                        }}
                      >
                        {meta?.name || slug}
                      </h3>
                      <span className="pf-pill outline">
                        {list.length}{" "}
                        {list.length === 1 ? "ACCOUNT" : "ACCOUNTS"}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: "var(--ink-3)",
                        marginTop: 2,
                      }}
                    >
                      {meta?.desc}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pf-bf sm"
                    onClick={() => meta && handleConnect(meta)}
                    disabled={connectingId === slug || brokerUnlinking}
                  >
                    <Plus style={{ width: 13, height: 13 }} /> Add another{" "}
                    {meta?.name || slug}
                  </button>
                </div>

                {/* Per-account rows */}
                {list.map((a, i) => {
                  const stale = a.needsReauth || a.isExpired;
                  // MONEY-848: this exact account is being unlinked → lock all of
                  // its row ops. (`brokerUnlinking`, computed at the broker level
                  // above, also freezes sibling Sync buttons during the unlink.)
                  const isUnlinking = disconnectingId === a.id;
                  return (
                    <div
                      key={a.id}
                      style={{
                        padding: "14px 18px",
                        borderTop:
                          i === 0 ? "0" : "1px dashed var(--rule-soft)",
                        display: "flex",
                        gap: 14,
                        alignItems: "center",
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 220 }}>
                        {editingId === a.id ? (
                          <div style={{ marginBottom: 6 }}>
                            <input
                              ref={editInputRef}
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void commitEdit();
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              onBlur={commitEdit}
                              className="pf-input"
                              style={{
                                padding: "6px 10px",
                                fontWeight: 700,
                                fontSize: 14,
                                width: "min(100%, 320px)",
                              }}
                            />
                          </div>
                        ) : (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              marginBottom: 5,
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 700,
                                fontSize: 14.5,
                                color: "var(--ink)",
                              }}
                            >
                              {a.accountName || meta?.name || slug}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                startEdit(a, meta?.name || (slug as string))
                              }
                              title="Rename"
                              style={{
                                padding: 3,
                                background: "transparent",
                                border: 0,
                                color: "var(--ink-3)",
                                cursor: "pointer",
                                borderRadius: 4,
                                display: "inline-flex",
                              }}
                            >
                              <Pencil style={{ width: 12, height: 12 }} />
                            </button>
                            {stale ? (
                              <span className="pf-pill coral">↻ REAUTH</span>
                            ) : (
                              <span className="pf-pill emerald">● LIVE</span>
                            )}
                          </div>
                        )}
                        <div
                          style={{
                            display: "flex",
                            gap: 16,
                            flexWrap: "wrap",
                            fontFamily: "JetBrains Mono, monospace",
                            fontSize: 11.5,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {a.brokerUserId && (
                            <span>
                              <span style={{ color: "var(--ink-3)" }}>
                                user id
                              </span>{" "}
                              <span
                                style={{
                                  color: "var(--ink-2)",
                                  fontWeight: 700,
                                  padding: "1px 6px",
                                  background: "var(--rule-softer)",
                                  borderRadius: 4,
                                }}
                              >
                                {a.brokerUserId}
                              </span>
                            </span>
                          )}
                          {a.lastSync && (
                            <span>
                              <span style={{ color: "var(--ink-3)" }}>
                                last sync
                              </span>{" "}
                              <span
                                style={{
                                  color: stale
                                    ? "var(--pop-1)"
                                    : "var(--emerald)",
                                  fontWeight: 700,
                                }}
                              >
                                {new Date(a.lastSync).toLocaleString("en-IN", {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}
                              </span>
                            </span>
                          )}
                          {a.connectedAt && (
                            <span>
                              <span style={{ color: "var(--ink-3)" }}>
                                since
                              </span>{" "}
                              <span
                                style={{
                                  color: "var(--ink-2)",
                                  fontWeight: 700,
                                }}
                              >
                                {new Date(a.connectedAt).toLocaleDateString(
                                  "en-IN",
                                  { month: "short", year: "numeric" }
                                )}
                              </span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div
                        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                      >
                        {stale && (
                          <button
                            type="button"
                            className="pf-bf sm"
                            style={{
                              color: "var(--pop-1)",
                              borderColor: "var(--pop-1)",
                            }}
                            onClick={() => meta && handleConnect(meta, a.id)}
                            disabled={isUnlinking}
                          >
                            <Key style={{ width: 13, height: 13 }} /> Re-auth
                          </button>
                        )}
                        {/* MONEY-837: the Connect app captures a token only — it
                            never syncs portfolio data (the Personal app owns
                            sync), so no Sync button on the Connect card. Re-auth
                            (above, when the token expires) + Unlink remain. */}
                        {a.broker !== "ZERODHA_CONNECT" && (
                          <button
                            type="button"
                            className="pf-bf sm"
                            // MONEY-837: if the token is stale, Sync re-auths
                            // FIRST (the OAuth callback auto-syncs on return);
                            // otherwise it syncs directly.
                            onClick={() =>
                              stale && meta
                                ? handleConnect(meta, a.id)
                                : handleSync(a)
                            }
                            // MONEY-848: freeze Sync for any account of a broker
                            // while one of its connections is being unlinked.
                            disabled={syncingId === a.id || brokerUnlinking}
                          >
                            {syncingId === a.id ? (
                              <Loader2
                                style={{
                                  width: 13,
                                  height: 13,
                                  animation: "um-spin .9s linear infinite",
                                }}
                              />
                            ) : (
                              <RefreshCw style={{ width: 13, height: 13 }} />
                            )}{" "}
                            {stale ? "Re-auth & sync" : "Sync"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="pf-bf sm danger"
                          onClick={() =>
                            setDisconnectDialog({
                              open: true,
                              connectionId: a.id,
                              broker: a.broker,
                              displayName:
                                a.accountName || (meta?.name as string) || slug,
                            })
                          }
                          disabled={isUnlinking}
                        >
                          {isUnlinking ? (
                            <Loader2
                              style={{
                                width: 13,
                                height: 13,
                                animation: "um-spin .9s linear infinite",
                              }}
                            />
                          ) : (
                            <Unlink style={{ width: 13, height: 13 }} />
                          )}{" "}
                          {isUnlinking ? "Unlinking…" : "Unlink"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </>
      )}

      {/* AVAILABLE TAB */}
      {tab === "available" && (
        <>
          <p
            style={{
              color: "var(--ink-3)",
              fontSize: 13.5,
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              margin: "0 0 14px",
              lineHeight: 1.4,
            }}
          >
            Already have one connected? You can still add another account —
            UseMoney supports multiple logins per broker.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))",
              gap: 12,
            }}
          >
            {BROKERS.filter(
              (b) => !b.founderOnly || (isFounder && !isDemoMode)
            ).map((b) => {
              const existing = (byBroker.get(b.id) || []).length;
              return (
                <div
                  key={b.id}
                  className="pf-card"
                  style={{
                    padding: 18,
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                    position: "relative",
                    opacity: b.comingSoon ? 0.85 : 1,
                  }}
                >
                  {b.popular && (
                    <span
                      className="pf-pill gold"
                      style={{
                        position: "absolute",
                        top: -10,
                        right: 12,
                        fontSize: 9,
                      }}
                    >
                      ★ POPULAR
                    </span>
                  )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <BrokerLogo slug={toBrokerSlug(b.id)} size={42} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            fontSize: 15,
                            fontWeight: 800,
                            letterSpacing: -0.3,
                            color: "var(--ink)",
                          }}
                        >
                          {b.name}
                        </span>
                        {existing > 0 && (
                          <span className="pf-pill emerald">
                            ● {existing} LINKED
                          </span>
                        )}
                        {b.comingSoon && (
                          <span className="pf-pill violet">○ SOON</span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--ink-3)",
                          marginTop: 2,
                          lineHeight: 1.35,
                        }}
                      >
                        {b.desc}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={b.comingSoon ? "pf-bf sm" : "pf-bs sm"}
                    style={{ justifyContent: "center", width: "100%" }}
                    onClick={() => handleConnect(b)}
                    disabled={connectingId === b.id || b.comingSoon}
                  >
                    {connectingId === b.id ? (
                      <>
                        <Loader2
                          style={{
                            width: 13,
                            height: 13,
                            animation: "um-spin .9s linear infinite",
                          }}
                        />
                        Connecting…
                      </>
                    ) : b.comingSoon ? (
                      <>
                        <Lock style={{ width: 13, height: 13 }} /> Coming soon
                      </>
                    ) : (
                      <>
                        <ExternalLink style={{ width: 13, height: 13 }} />{" "}
                        {existing > 0 ? `Add another ${b.name}` : "Connect"}
                      </>
                    )}
                  </button>
                </div>
              );
            })}

            {/* CSV import fallback tile (matches design's broker grid) */}
            <Link
              href="/tradebook/import"
              className="pf-card"
              style={{
                padding: 18,
                display: "flex",
                flexDirection: "column",
                gap: 12,
                textDecoration: "none",
                color: "var(--ink)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div
                  className="pf-av-sq"
                  style={{
                    width: 42,
                    height: 42,
                    fontSize: 18,
                    borderRadius: 10,
                    background: "var(--rule-softer)",
                    color: "var(--ink-3)",
                  }}
                >
                  +
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 800,
                      letterSpacing: -0.3,
                      color: "var(--ink)",
                    }}
                  >
                    CSV import
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--ink-3)",
                      marginTop: 2,
                      lineHeight: 1.35,
                    }}
                  >
                    No API? Import a tradebook CSV from any broker — we dedupe
                    and reconcile.
                  </div>
                </div>
              </div>
              <span
                className="pf-bf sm"
                style={{ justifyContent: "center", width: "100%" }}
              >
                <Upload style={{ width: 13, height: 13 }} /> Import CSV
              </span>
            </Link>
          </div>
        </>
      )}

      {/* Security callout (design: emerald read-only OAuth strip) */}
      <div
        style={{
          marginTop: 18,
          padding: 14,
          background: "var(--emerald-bg)",
          border: "1.5px solid var(--emerald)",
          borderRadius: 12,
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <ShieldCheck
          style={{
            width: 18,
            height: 18,
            color: "var(--emerald)",
            flexShrink: 0,
          }}
        />
        <div
          style={{
            flex: 1,
            minWidth: 240,
            fontSize: 12.5,
            color: "var(--ink-2)",
            lineHeight: 1.5,
          }}
        >
          We{" "}
          <strong style={{ color: "var(--emerald)" }}>
            cannot place orders
          </strong>
          . Read-only OAuth, AES-256-GCM token encryption. Each connection is
          keyed by the broker user ID from their OAuth callback — link personal,
          HUF, spouse and family accounts on the same broker without conflicts,
          and rename any account anytime.
        </div>
      </div>

      {/* API key dialog */}
      <BrokerConsentModal
        open={consentModal.open}
        source="broker_connect"
        onAccepted={() => {
          const pending = consentModal.pending;
          setConsentModal({ open: false, pending: null });
          if (pending) void proceedConnect(pending);
        }}
        onClose={() => setConsentModal({ open: false, pending: null })}
      />

      <Dialog
        open={apiKeyDialog.open}
        onOpenChange={(open) =>
          !open && setApiKeyDialog({ open: false, broker: null })
        }
      >
        <DialogContent
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "var(--shadow-hard)",
            color: "var(--ink)",
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle
              className="flex items-center gap-2.5"
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "-0.4px",
                color: "var(--ink)",
              }}
            >
              {apiKeyDialog.broker && (
                <BrokerLogo
                  slug={toBrokerSlug(apiKeyDialog.broker.id)}
                  size={28}
                />
              )}
              Connect {apiKeyDialog.broker?.name}
            </DialogTitle>
            <DialogDescription
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                letterSpacing: "0.5px",
              }}
            >
              Enter your API credentials. They&apos;re encrypted at rest with
              AES-256-GCM.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label
                htmlFor="clientId"
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Client ID
              </Label>
              <Input
                id="clientId"
                className="pf-input"
                value={apiKeyForm.clientId}
                onChange={(e) =>
                  setApiKeyForm((f) => ({ ...f, clientId: e.target.value }))
                }
                placeholder="Enter your Client ID"
              />
            </div>
            <div className="space-y-1.5">
              <Label
                htmlFor="accessToken"
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Access Token
              </Label>
              <Input
                id="accessToken"
                type="password"
                className="pf-input"
                value={apiKeyForm.accessToken}
                onChange={(e) =>
                  setApiKeyForm((f) => ({ ...f, accessToken: e.target.value }))
                }
                placeholder="Enter your Access Token"
              />
            </div>
          </div>
          <DialogFooter className="sm:justify-end">
            <button
              type="button"
              className="pf-bf sm"
              onClick={() => setApiKeyDialog({ open: false, broker: null })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pf-bs sm disabled:opacity-50"
              onClick={handleApiKeyConnect}
              disabled={connectingId === apiKeyDialog.broker?.id}
            >
              {connectingId === apiKeyDialog.broker?.id ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting…
                </>
              ) : (
                "Connect"
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disconnect confirmation */}
      <AlertDialog
        open={disconnectDialog.open}
        onOpenChange={(open) =>
          !open && setDisconnectDialog({ open: false, displayName: "" })
        }
      >
        <AlertDialogContent
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "var(--shadow-hard)",
            color: "var(--ink)",
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "-0.4px",
                color: "#b91c1c",
              }}
            >
              Delete {disconnectDialog.displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription
              className="ser"
              style={{ fontSize: 16, color: "var(--ink-2)", lineHeight: 1.4 }}
            >
              This permanently deletes all data associated with this broker
              connection (holdings, positions, trades, mutual funds). This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="pf-bf sm mt-0">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDisconnect}
              className="pf-bf sm danger"
            >
              Delete All Data
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TerminalLuxeShell>
  );
}
