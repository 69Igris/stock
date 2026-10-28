"use client";

/**
 * DeleteAccountDialog (MONEY-391)
 *
 * Two-step confirmation:
 *   Step 1 — warning + reason textarea + "Type DELETE" + Send OTP button
 *   Step 2 — 6-digit OTP entry + Permanently delete account button
 *
 * After successful delete, signs the user out via Clerk and redirects to
 * /home with a toast. There is no undo path.
 */

import { useState, useTransition } from "react";
import { useClerk } from "@clerk/nextjs";
import { AlertTriangle, Loader2, Mail, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { clearCachedPlan } from "@/lib/subscription/plan-cache";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  requestDeleteOtpAction,
  confirmDeleteAccountAction,
} from "@/lib/actions/account";

type Step = "warning" | "otp";

interface DeleteAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteAccountDialog({
  open,
  onOpenChange,
}: DeleteAccountDialogProps) {
  const { signOut } = useClerk();
  const [step, setStep] = useState<Step>("warning");
  const [typedConfirm, setTypedConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [otp, setOtp] = useState("");
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setStep("warning");
    setTypedConfirm("");
    setReason("");
    setOtp("");
    setMaskedEmail(null);
    setExpiresAt(null);
    setError(null);
  }

  function handleClose(next: boolean) {
    if (!next && pending) return; // can't close mid-delete
    if (!next) reset();
    onOpenChange(next);
  }

  /**
   * MONEY-144 - server actions set `requiresSignOut` when the caller's
   * Clerk session is valid but the DB user is already gone (the
   * worker pipeline cascaded). Surface a friendly toast, close the
   * dialog, and force-signout instead of showing a confusing inline
   * error like "User not found in database".
   */
  function handleGhostSession() {
    onOpenChange(false);
    toast.success("Your account is already deleted. Signing you out.");
    // MONEY-1134 — the account is gone; its billing tier must not stay in this
    // browser's localStorage for the next person to hydrate.
    clearCachedPlan();
    void signOut({ redirectUrl: "/" });
  }

  function handleSendOtp() {
    setError(null);
    if (typedConfirm !== "DELETE") {
      setError("Type DELETE exactly (case-sensitive)");
      return;
    }
    startTransition(async () => {
      const res = await requestDeleteOtpAction();
      if (!res.success) {
        if (res.requiresSignOut) {
          handleGhostSession();
          return;
        }
        setError(res.error ?? "Failed to send OTP");
        return;
      }
      setMaskedEmail(res.maskedEmail ?? null);
      setExpiresAt(res.expiresAt ?? null);
      setStep("otp");
      toast.success(`Confirmation code sent to ${res.maskedEmail}`);
    });
  }

  function handleConfirmDelete() {
    setError(null);
    if (!/^\d{6}$/.test(otp)) {
      setError("Enter the 6-digit code from your email");
      return;
    }
    startTransition(async () => {
      const res = await confirmDeleteAccountAction({
        otp,
        typedConfirmation: typedConfirm,
        reason: reason.trim() || undefined,
      });
      if (!res.success) {
        if (res.requiresSignOut) {
          handleGhostSession();
          return;
        }
        setError(res.error ?? "Delete failed");
        return;
      }
      // MONEY-445: Server has done the minimum (verified OTP, published
      // Pub/Sub job) and returned. The worker takes over from here in
      // strict order: Clerk delete (first, kills session) -> snapshot ->
      // Dodo cancel -> confirmation email -> User row delete (last).
      // Close the dialog before awaiting signOut so the user perceives
      // an instant logout (signOut has a redirect + token revocation
      // round-trip that we don't want gating the UI).
      onOpenChange(false);
      toast.success(
        "Your account is being deleted. We will email you when it is done."
      );
      // MONEY-1134 — this is the strongest case for clearing it: the user just
      // asked us to delete everything about them, and `um_plan_v1` would
      // otherwise survive in this browser after the account is gone.
      clearCachedPlan();
      void signOut({ redirectUrl: "/" });
    });
  }

  const expiresMinutes = expiresAt
    ? Math.max(
        0,
        Math.floor((new Date(expiresAt).getTime() - Date.now()) / 60000)
      )
    : null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-md"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "var(--shadow-hard)",
          color: "var(--ink)",
        }}
      >
        {step === "warning" ? (
          <>
            <DialogHeader className="text-left">
              <div className="flex items-center gap-3">
                <div
                  className="grid place-items-center flex-shrink-0"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 9,
                    background: "rgba(185,28,28,0.1)",
                    border: "1.5px solid #b91c1c",
                    color: "#b91c1c",
                    transform: "rotate(-3deg)",
                  }}
                >
                  <ShieldAlert className="h-5 w-5" />
                </div>
                <div>
                  <DialogTitle
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      letterSpacing: "-0.4px",
                      color: "#b91c1c",
                    }}
                  >
                    Permanently delete account
                  </DialogTitle>
                  <DialogDescription
                    className="mono"
                    style={{
                      color: "var(--ink-3)",
                      fontSize: 11,
                      letterSpacing: "0.5px",
                      marginTop: 2,
                    }}
                  >
                    This action cannot be undone.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div
              className="space-y-3 text-[13px]"
              style={{ color: "var(--ink-2)" }}
            >
              <p>
                Deleting your account will permanently and immediately remove:
              </p>
              <div
                style={{
                  padding: 12,
                  background: "var(--rule-softer)",
                  borderRadius: 9,
                  border: "1.5px dashed var(--ink)",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--ink-3)",
                    letterSpacing: "1px",
                    fontWeight: 700,
                  }}
                >
                  WHAT GETS DELETED
                </div>
                <ul
                  className="list-disc"
                  style={{
                    margin: "8px 0 0 18px",
                    padding: 0,
                    color: "var(--ink-2)",
                    lineHeight: 1.55,
                  }}
                >
                  <li>Connected broker accounts and encrypted credentials</li>
                  <li>
                    All holdings, positions, trades, and mutual fund records
                  </li>
                  <li>Paper portfolio, FIRE scenarios, and watchlists</li>
                  <li>AI chat history, roasts, research, and documents</li>
                  <li>
                    Your active subscription — Dodo billing will be cancelled
                    immediately and any remaining time will be lost
                  </li>
                  <li>
                    This email will be blocked from creating a new UseMoney
                    account for 24 hours
                  </li>
                </ul>
              </div>
              <p style={{ color: "#b91c1c", fontWeight: 700, paddingTop: 2 }}>
                Permanent and irreversible — even support cannot recover this
                data once deleted.
              </p>
            </div>

            <div className="space-y-2">
              <label
                className="mono"
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  fontWeight: 700,
                }}
              >
                Reason (optional, helps us improve)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value.slice(0, 500))}
                placeholder="What made you decide to leave?"
                rows={2}
                className="pf-input"
              />
            </div>

            <div className="space-y-2">
              <label
                style={{
                  display: "block",
                  fontSize: 12,
                  color: "var(--ink-2)",
                  fontWeight: 700,
                }}
              >
                Type{" "}
                <span
                  className="mono"
                  style={{
                    padding: "1px 6px",
                    background: "rgba(185,28,28,0.12)",
                    color: "#b91c1c",
                    borderRadius: 4,
                    fontWeight: 700,
                  }}
                >
                  DELETE
                </span>{" "}
                to confirm
              </label>
              <input
                value={typedConfirm}
                onChange={(e) => setTypedConfirm(e.target.value)}
                placeholder="DELETE"
                autoComplete="off"
                className="pf-input mono"
              />
            </div>

            {error && (
              <div
                className="flex items-start gap-2 text-[12.5px]"
                style={{
                  borderRadius: 8,
                  background: "rgba(185,28,28,0.1)",
                  border: "1.5px solid rgba(185,28,28,0.4)",
                  padding: "8px 12px",
                  color: "#b91c1c",
                }}
              >
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-2 sm:justify-end">
              <button
                onClick={() => handleClose(false)}
                disabled={pending}
                className="pf-bf sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSendOtp}
                disabled={pending || typedConfirm !== "DELETE"}
                className="pf-bf sm danger disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Send confirmation code
              </button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="text-left">
              <div className="flex items-center gap-3">
                <div
                  className="grid place-items-center flex-shrink-0"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 9,
                    background: "var(--emerald-bg)",
                    border: "1.5px solid var(--emerald)",
                    color: "var(--emerald)",
                    transform: "rotate(-3deg)",
                  }}
                >
                  <Mail className="h-5 w-5" />
                </div>
                <div>
                  <DialogTitle
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      letterSpacing: "-0.4px",
                      color: "var(--ink)",
                    }}
                  >
                    Enter confirmation code
                  </DialogTitle>
                  <DialogDescription
                    className="mono"
                    style={{
                      color: "var(--ink-3)",
                      fontSize: 11,
                      letterSpacing: "0.5px",
                      marginTop: 2,
                    }}
                  >
                    Sent to {maskedEmail ?? "your email"}
                    {expiresMinutes != null
                      ? ` · expires in ~${expiresMinutes} min`
                      : ""}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-2">
              <label
                className="mono"
                style={{
                  fontSize: 12,
                  color: "var(--ink-2)",
                  fontWeight: 700,
                }}
              >
                6-digit code
              </label>
              <input
                value={otp}
                onChange={(e) =>
                  setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="pf-input mono text-center"
                style={{ fontSize: 20, letterSpacing: "6px" }}
              />
            </div>

            {error && (
              <div
                className="flex items-start gap-2 text-[12.5px]"
                style={{
                  borderRadius: 8,
                  background: "rgba(185,28,28,0.1)",
                  border: "1.5px solid rgba(185,28,28,0.4)",
                  padding: "8px 12px",
                  color: "#b91c1c",
                }}
              >
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-2 flex-col-reverse sm:flex-row sm:justify-end">
              <button
                onClick={() => setStep("warning")}
                disabled={pending}
                className="pf-bf sm disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={pending || otp.length !== 6}
                className="pf-bf sm danger disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Permanently delete account
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
