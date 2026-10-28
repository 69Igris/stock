"use client";

/**
 * SignUpDeletionToast (MONEY-144)
 *
 * Mounted on the sign-up page. Listens for blur events on email
 * inputs (capture phase, so it works with Clerk's drop-in <SignUp>
 * component without coupling to its DOM structure). When the user
 * leaves an email field, calls POST /api/auth/signup-precheck.
 *
 * If the server returns `blocked: true`, shows a sonner toast with
 * the specific re-signup-available time. Otherwise stays silent —
 * Clerk's own signup form will handle the normal happy-path / generic
 * "email taken" cases.
 *
 * No leakage: the server endpoint only returns `blocked: true` for
 * emails matching an in-flight DeletedUserAudit row. Everything else
 * (active accounts, never-seen emails, errors, rate-limits) returns
 * `{ blocked: false }` so this component can't be used to enumerate
 * active users.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";

interface PrecheckResponse {
  blocked: boolean;
  availableAt?: string;
  reason?: string;
}

function formatAvailableAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "in 24 hours";
  return d.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function SignUpDeletionToast() {
  // De-dupe checks for the same email so tabbing through fields
  // doesn't refire the API call or re-toast.
  const lastCheckedRef = useRef<string>("");

  useEffect(() => {
    const handleBlur = async (e: Event): Promise<void> => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      // Clerk's email field is `name="emailAddress" type="email"`; also
      // match `type="email"` generically so a hypothetical future field
      // rename still works.
      const isEmailField =
        target.type === "email" || target.name === "emailAddress";
      if (!isEmailField) return;

      const email = target.value.trim().toLowerCase();
      // Cheap client-side filter: only check well-formed emails.
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      if (lastCheckedRef.current === email) return;
      lastCheckedRef.current = email;

      try {
        const res = await fetch("/api/auth/signup-precheck", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as PrecheckResponse;
        if (!data.blocked || !data.availableAt) return;

        toast.error(
          "This email was used for an account that was recently deleted.",
          {
            description: `For security, sign-up with this email is paused until ${formatAvailableAt(
              data.availableAt
            )}. Please use a different email or try again later.`,
            duration: 12000,
            id: "signup-deletion-block", // collapses to one toast on retoasts
          }
        );
      } catch {
        // Silently fail - Clerk's own signup form is the safety net.
      }
    };

    document.addEventListener("blur", handleBlur, true);
    return () => document.removeEventListener("blur", handleBlur, true);
  }, []);

  return null;
}
