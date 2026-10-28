"use client";

import { useState } from "react";

interface ResubscribeButtonProps {
  email: string;
}

/**
 * Client island — the only interactive element on the public unsubscribe page.
 * POSTs to /api/newsletter/subscribe and shows inline feedback so users don't
 * need a full-page reload to confirm their re-subscription request.
 */
export function ResubscribeButton({ email }: ResubscribeButtonProps) {
  const [label, setLabel] = useState("Resubscribe");
  const [disabled, setDisabled] = useState(false);

  async function handleClick() {
    setDisabled(true);
    setLabel("Sending…");

    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = (await res.json()) as { message?: string; error?: string };
      setLabel(data.message ?? data.error ?? "Check your inbox!");
    } catch {
      setLabel("Something went wrong — try again");
      setDisabled(false);
    }
  }

  return (
    <button
      type="button"
      className="btn-solid unsub-resub-btn"
      disabled={disabled}
      onClick={handleClick}
    >
      {label}
    </button>
  );
}
