"use client";

import { ThemedUserButton } from "@/components/ThemedUserButton";
import Image from "next/image";
import { useUser, useClerk } from "@clerk/nextjs";
import { Check, KeyRound, ShieldCheck } from "lucide-react";
import { SetSection, SetRow, SetCard } from "./primitives";
import { Button } from "@usemoney/ui/button";
import { demoSettings } from "@/lib/demo/data";

interface AccountTabProps {
  isDemoMode: boolean;
}

export default function AccountTab({ isDemoMode }: AccountTabProps) {
  const { user } = useUser();
  const { openUserProfile } = useClerk();

  // Surfaced prominently because users couldn't find where to change their
  // password (the bug that kicked off this redesign). Clerk owns the actual
  // flow — both buttons open the Clerk profile modal's Security section.
  const passwordEnabled = user?.passwordEnabled ?? false;
  const has2FA = user?.totpEnabled || user?.twoFactorEnabled || false;
  const openSecurity = () => {
    // Land the modal on Clerk's Security page (password + 2FA) instead of the
    // default Account page. Without __experimental_startPath the "Change
    // password" button dropped users on Account and they had to hunt for the
    // Security tab (MONEY-620 task 138). Clerk falls back to Account if the
    // path is ever renamed upstream, so this is safe.
    if (!isDemoMode) openUserProfile({ __experimental_startPath: "/security" });
  };

  const displayName = isDemoMode
    ? demoSettings.user.name
    : user?.fullName || user?.firstName || "User";
  const email = isDemoMode
    ? demoSettings.user.email
    : user?.primaryEmailAddress?.emailAddress ||
      user?.emailAddresses?.[0]?.emailAddress ||
      "—";
  const joinedDate = isDemoMode
    ? demoSettings.user.createdAt
    : user?.createdAt
      ? new Date(user.createdAt)
      : null;
  const joinedLabel = joinedDate
    ? joinedDate.toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
      })
    : "—";
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");

  // Linked OAuth accounts from Clerk - provider strings vary by Clerk version,
  // do a loose match on the trailing identifier rather than a strict literal.
  const linkedGoogle = user?.externalAccounts?.find((a) =>
    String(a.provider).includes("google")
  );
  const linkedApple = user?.externalAccounts?.find((a) =>
    String(a.provider).includes("apple")
  );
  const phoneNumber = user?.primaryPhoneNumber?.phoneNumber;
  const username = user?.username;

  const connectedPill = (
    <span className="pf-pill emerald" style={{ fontSize: 9.5 }}>
      <Check className="h-3 w-3" /> Linked
    </span>
  );
  const connectPill = (
    <span className="pf-pill outline" style={{ fontSize: 9.5 }}>
      Connect
    </span>
  );
  // MONEY-764: Apple sign-in isn't live yet — render a muted, non-interactive
  // pill instead of a dead "Connect" CTA. Same shape as connectPill but with
  // ink-3 text + soft border and no hover affordance (the row is locked too).
  const comingSoonPill = (
    <span
      className="pf-pill outline"
      style={{
        fontSize: 9.5,
        color: "var(--ink-3)",
        borderColor: "var(--rule-soft)",
        cursor: "default",
      }}
    >
      Coming soon
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ═══ Profile ═══ */}
      <SetSection
        title="Profile"
        desc="Personal details visible to support and on receipts."
      >
        {/* Avatar + name */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "22px 22px",
            borderBottom: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          {!isDemoMode && user?.imageUrl ? (
            <Image
              src={user.imageUrl}
              alt={displayName}
              width={56}
              height={56}
              className="w-14 h-14 object-cover"
              style={{
                borderRadius: 14,
                border: "2px solid var(--ink)",
                transform: "rotate(-3deg)",
                boxShadow: "var(--shadow-soft)",
              }}
            />
          ) : (
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: "var(--pop-3)",
                color: "#f7f3e6",
                display: "grid",
                placeItems: "center",
                fontWeight: 800,
                fontSize: 22,
                border: "2px solid var(--ink)",
                transform: "rotate(-3deg)",
                boxShadow: "var(--shadow-soft)",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {initials || "U"}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: -0.5,
                color: "var(--ink)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayName}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                marginTop: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {email} · joined {joinedLabel}
            </div>
          </div>
          {!isDemoMode ? (
            <ThemedUserButton />
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled
              className="border-border opacity-50 cursor-not-allowed"
            >
              Change avatar
            </Button>
          )}
        </div>

        {/* Detail rows */}
        <SetRow
          label="Full name"
          value={displayName}
          locked={isDemoMode}
          onClick={() => {}}
          hint={isDemoMode ? "Sign in to change" : undefined}
        />
        <SetRow
          label="Email"
          value={email}
          mono
          locked={isDemoMode}
          onClick={() => {}}
        />
        <SetRow
          label="Phone"
          value={phoneNumber || "Not set"}
          mono
          locked={isDemoMode}
          onClick={() => {}}
        />
        <SetRow
          label="Username"
          value={username ? `@${username}` : "Not set"}
          mono
          locked={isDemoMode}
          onClick={() => {}}
          last
        />
      </SetSection>

      {/* ═══ Sign-in & password — PROMINENT STICKER CARD ═══
          Addresses the "user couldn't find where to change their password"
          bug. --sticker-* tokens are PINNED gold-with-ink in BOTH themes
          (MONEY-764 round 2) — inner elements must use sticker tokens, not
          var(--ink)/var(--paper), which flip in dark and would invert on the
          pinned band. Both buttons open the Clerk-backed dialog. */}
      <div
        style={{
          padding: "16px 18px",
          border: "2px solid var(--sticker-fg)",
          borderRadius: 12,
          background: "var(--sticker-bg)",
          display: "flex",
          alignItems: "center",
          gap: 16,
          boxShadow: "var(--shadow-soft)",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: "var(--sticker-fg)",
            color: "var(--sticker-bg)",
            display: "grid",
            placeItems: "center",
            border: "1.5px solid var(--sticker-fg)",
            flexShrink: 0,
            transform: "rotate(4deg)",
          }}
        >
          <KeyRound className="h-[22px] w-[22px]" />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h4
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: "var(--sticker-fg)",
              letterSpacing: -0.3,
            }}
          >
            Sign-in &amp; password
          </h4>
          <p
            style={{
              marginTop: 3,
              fontSize: 13,
              color: "var(--sticker-dim)",
              lineHeight: 1.4,
            }}
          >
            {passwordEnabled
              ? "You sign in with email & password."
              : "You sign in with a linked account — add a password any time."}{" "}
            Two-factor is{" "}
            <strong style={{ color: "var(--sticker-fg)" }}>
              {has2FA ? "on" : "off"}
            </strong>
            . Change either right here.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={openSecurity}
            disabled={isDemoMode}
            className="pf-bs sm"
            style={{
              background: "var(--sticker-fg)",
              // Literal cream (= light --paper): var(--paper) flips near-black
              // in dark and would vanish on the pinned ink button.
              color: "#f7f3e6",
              borderColor: "var(--sticker-fg)",
              opacity: isDemoMode ? 0.5 : 1,
              cursor: isDemoMode ? "not-allowed" : "pointer",
            }}
          >
            <KeyRound className="h-3 w-3" />
            {passwordEnabled ? "Change password" : "Set a password"}
          </button>
          <button
            type="button"
            onClick={openSecurity}
            disabled={isDemoMode}
            className="pf-bf sm"
            style={{
              borderColor: "var(--sticker-fg)",
              color: "var(--sticker-fg)",
              background: "transparent",
              opacity: isDemoMode ? 0.5 : 1,
              cursor: isDemoMode ? "not-allowed" : "pointer",
            }}
          >
            <ShieldCheck className="h-3 w-3" />
            {has2FA ? "Manage 2FA" : "Enable 2FA"}
          </button>
        </div>
      </div>

      {/* ═══ Linked accounts ═══ */}
      <SetSection
        title="Linked sign-in methods"
        desc="Sign in faster — password changes here apply to all of them."
      >
        <SetRow
          label="Google"
          hint={linkedGoogle?.emailAddress || "Not linked"}
          value={linkedGoogle ? connectedPill : connectPill}
          onClick={() => {}}
        />
        {/* MONEY-764: Apple OAuth isn't enabled yet. When unlinked, the row is
            locked (no pointer/chevron via SetRow's locked prop) and shows the
            muted "Coming soon" pill. A linked Apple account renders exactly as
            before. */}
        <SetRow
          label="Apple"
          hint={linkedApple?.emailAddress || "Not linked"}
          value={linkedApple ? connectedPill : comingSoonPill}
          onClick={() => {}}
          locked={!linkedApple}
          last
        />
      </SetSection>

      {/* ═══ Investor profile — edit the onboarding answers any time ═══ */}
      <SetCard>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 22px",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>
              Investor profile
            </div>
            <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 2 }}>
              Tunes StockSage and your Beginner / Advanced dashboard. Update
              your experience, goals, risk &amp; style any time.
            </div>
          </div>
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => {
              if (typeof window !== "undefined")
                window.location.href = "/settings/investor-profile";
            }}
          >
            Edit profile
          </button>
        </div>
      </SetCard>

      {/* ═══ Sign out ═══ */}
      <SetCard>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 22px",
          }}
        >
          <div style={{ flex: 1, fontSize: 13, color: "var(--ink-3)" }}>
            Sign out from this device only.
          </div>
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => {
              if (typeof window !== "undefined") {
                window.location.href = "/sign-in?signOut=true";
              }
            }}
          >
            Sign out
          </button>
        </div>
      </SetCard>
    </div>
  );
}
