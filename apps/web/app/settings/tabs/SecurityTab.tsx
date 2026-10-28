"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import {
  AlertTriangle,
  Laptop,
  Smartphone,
  Monitor,
  ShieldCheck,
} from "lucide-react";
import { SetSection, SetRow } from "./primitives";
import { DeleteAccountDialog } from "@/components/settings/DeleteAccountDialog";
import BrokerConsentModal from "@/components/brokers/BrokerConsentModal";

interface SecurityTabProps {
  isDemoMode: boolean;
}

function SessionRow({
  device,
  location,
  time,
  current,
  iconKind,
  last,
}: {
  device: string;
  location: string;
  time: string;
  current?: boolean;
  iconKind: "laptop" | "phone" | "monitor";
  last?: boolean;
}) {
  const Icon =
    iconKind === "laptop"
      ? Laptop
      : iconKind === "phone"
        ? Smartphone
        : Monitor;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "14px 22px",
        borderBottom: last ? 0 : "1px dashed var(--rule-soft)",
      }}
    >
      <div
        className="pf-av-sq"
        style={{
          width: 34,
          height: 34,
          borderRadius: 8,
          transform: "rotate(-3deg)",
          background: "var(--paper)",
          color: "var(--ink-2)",
        }}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--ink)",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {device}
          </span>
          {current && (
            <span
              className="pf-pill emerald"
              style={{ fontSize: 9.5, flexShrink: 0 }}
            >
              This device
            </span>
          )}
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
          {location} · {time}
        </div>
      </div>
      {!current && (
        <button type="button" className="pf-bf sm">
          Revoke
        </button>
      )}
    </div>
  );
}

export default function SecurityTab({ isDemoMode }: SecurityTabProps) {
  const { user } = useUser();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [consentReviewOpen, setConsentReviewOpen] = useState(false);

  const has2FA = user?.totpEnabled || user?.twoFactorEnabled || false;
  const passkeysCount = user?.passkeys?.length || 0;
  const lastSignInAt = user?.lastSignInAt ? new Date(user.lastSignInAt) : null;
  const passwordChangedRecently = user?.passwordEnabled
    ? "Password set"
    : "Not set";

  return (
    <div className="flex flex-col gap-4">
      {/* Authentication — password row also lives here for muscle memory */}
      <SetSection title="Authentication">
        <SetRow
          label="Password"
          value={passwordChangedRecently}
          onClick={() => {}}
          locked={isDemoMode}
        />
        <SetRow
          label="Two-factor (2FA)"
          hint="Authenticator app via Clerk"
          value={
            <span
              className={`pf-pill${has2FA ? " emerald" : ""}`}
              style={
                has2FA
                  ? { fontSize: 9.5 }
                  : {
                      fontSize: 9.5,
                      background: "rgba(245,158,11,0.12)",
                      color: "#b45309",
                      borderColor: "#b45309",
                    }
              }
            >
              <ShieldCheck className="h-3 w-3" />
              {has2FA ? "Enabled" : "Disabled"}
            </span>
          }
          onClick={() => {}}
          locked={isDemoMode}
        />
        <SetRow
          label="Backup codes"
          value={has2FA ? "Generate codes" : "Enable 2FA first"}
          mono
          onClick={() => {}}
          locked={isDemoMode || !has2FA}
        />
        <SetRow
          label="Passkeys"
          hint="Sign in with Touch ID / Face ID"
          value={
            passkeysCount > 0
              ? `${passkeysCount} device${passkeysCount === 1 ? "" : "s"}`
              : "Add"
          }
          onClick={() => {}}
          locked={isDemoMode}
          last
        />
      </SetSection>

      {/* Active sessions - Clerk doesn't expose other session list to client
          today, so we render the current device prominently. */}
      <SetSection
        title="Active sessions"
        desc="Devices currently signed into your account. This device shown — manage others in your Clerk account portal."
      >
        <SessionRow
          device="This browser"
          location={
            typeof navigator !== "undefined"
              ? navigator.platform || "Web"
              : "Web"
          }
          time={
            lastSignInAt
              ? `Active · last signed in ${lastSignInAt.toLocaleDateString()}`
              : "Active now"
          }
          current
          iconKind="laptop"
          last
        />
      </SetSection>

      {/* MONEY-505: SEBI IA Reg 18(9) AI-advisory disclosure — re-presentable
          for the audit-trail requirement. */}
      <SetSection
        title="Consent & disclosures"
        desc="The AI-advisory disclosure you accepted. StockSage is informational AI, not SEBI-registered advice."
      >
        <SetRow
          label="AI-advisory disclosure"
          hint="SEBI IA Reg 18(9)"
          value="Review"
          onClick={() => setConsentReviewOpen(true)}
          last
        />
      </SetSection>
      <BrokerConsentModal
        open={consentReviewOpen}
        reviewOnly
        onClose={() => setConsentReviewOpen(false)}
      />

      {/* Danger zone — coral/red bordered card */}
      <div
        className="pf-card flat"
        style={{
          padding: 0,
          overflow: "hidden",
          borderColor: "#b91c1c",
        }}
      >
        <div
          style={{
            padding: "14px 22px",
            borderBottom: "1.5px dashed rgba(185,28,28,0.3)",
            background: "rgba(185,28,28,0.06)",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: "#b91c1c",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Danger zone
          </div>
          <div style={{ fontSize: 12.5, color: "var(--ink-3)", marginTop: 2 }}>
            Permanent. Cannot be undone.
          </div>
        </div>
        <div
          style={{
            padding: "14px 22px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            borderBottom: "1px dashed var(--rule-soft)",
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
              Sign out everywhere
            </div>
            <div
              style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}
            >
              Revoke all sessions including this one.
            </div>
          </div>
          <button
            type="button"
            disabled={isDemoMode}
            className="pf-bf sm danger"
          >
            Sign out all
          </button>
        </div>
        <div
          style={{
            padding: "14px 22px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
              Delete account
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--ink-3)",
                marginTop: 2,
                lineHeight: 1.4,
              }}
            >
              Permanently delete your account, holdings, paper data, and cancel
              any active subscription. Cannot be undone.
            </div>
          </div>
          <button
            type="button"
            disabled={isDemoMode}
            onClick={() => setDeleteOpen(true)}
            className="pf-bf sm danger"
          >
            Delete account
          </button>
        </div>
      </div>

      <DeleteAccountDialog open={deleteOpen} onOpenChange={setDeleteOpen} />
    </div>
  );
}
