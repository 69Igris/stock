"use client";

import { useState } from "react";
import { Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";

// Very lightweight email regex — rejects obvious non-emails client-side
// while the API still validates with Zod on the server.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function NewsletterSubscribe() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!EMAIL_RE.test(email.trim())) {
      setErrorMsg("Please enter a valid email address.");
      return;
    }

    setStatus("loading");

    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = (await res.json()) as { message?: string; error?: string };

      if (!res.ok) {
        const msg = data.error ?? "Something went wrong. Please try again.";
        setErrorMsg(msg);
        toast.error(msg);
        setStatus("idle");
        return;
      }

      const successMsg =
        data.message ?? "Check your inbox to confirm your subscription!";
      setStatus("success");
      setEmail("");
      toast.success(successMsg);
    } catch {
      const msg = "Something went wrong. Please try again.";
      setErrorMsg(msg);
      toast.error(msg);
      setStatus("idle");
    }
  };

  return (
    <div
      style={{
        background: "var(--paper)",
        border: "1.5px solid var(--ink)",
        borderRadius: "12px",
        padding: "24px",
        boxShadow: "4px 4px 0 var(--ink)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: "16px" }}>
        {/* Icon */}
        <div
          style={{
            padding: "10px",
            background: "var(--emerald-bg)",
            borderRadius: "8px",
            border: "1.5px solid var(--ink)",
            flexShrink: 0,
          }}
        >
          <Mail
            style={{ width: "20px", height: "20px", color: "var(--emerald)" }}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontSize: "16px",
              fontWeight: 700,
              color: "var(--ink)",
              marginBottom: "4px",
            }}
          >
            Stay Updated
          </h3>
          <p
            style={{
              fontSize: "13px",
              color: "var(--ink-3)",
              marginBottom: "16px",
            }}
          >
            Market insights, trading strategies, and portfolio tips — delivered
            to your inbox.
          </p>

          {status === "success" ? (
            <p
              style={{
                fontSize: "13px",
                color: "var(--emerald-text)",
                fontWeight: 600,
              }}
            >
              Check your inbox to confirm your subscription!
            </p>
          ) : (
            <form
              onSubmit={handleSubmit}
              style={{ display: "flex", flexDirection: "column", gap: "10px" }}
            >
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <input
                  type="email"
                  className="pf-input"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  disabled={status === "loading"}
                  required
                  aria-label="Email address"
                  style={{ flex: "1 1 180px", minWidth: 0 }}
                />
                <button
                  type="submit"
                  className="pf-bs"
                  disabled={status === "loading"}
                  style={{ flexShrink: 0, whiteSpace: "nowrap" }}
                >
                  {status === "loading" ? (
                    <>
                      <Loader2
                        style={{
                          width: "14px",
                          height: "14px",
                          animation: "spin 1s linear infinite",
                        }}
                      />
                      Subscribing…
                    </>
                  ) : (
                    "Subscribe to Updates"
                  )}
                </button>
              </div>

              {errorMsg && (
                <p
                  role="alert"
                  style={{
                    fontSize: "12px",
                    color: "var(--pop-1-text)",
                    marginTop: "2px",
                  }}
                >
                  {errorMsg}
                </p>
              )}
            </form>
          )}

          <p
            style={{
              fontSize: "11px",
              color: "var(--ink-4)",
              marginTop: "12px",
            }}
          >
            No spam · Unsubscribe at any time
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Newsletter card for the public blog page. Reuses the blog's `.newsletter-card`
 * CSS (the always-dark band, the "every other Sunday" heading/copy, the meta
 * line) so the visual design is unchanged, but submits via client-side fetch
 * instead of a native <form action> POST. That keeps the user on the page with
 * inline success/error feedback rather than navigating to a raw JSON 500 from
 * the API route.
 */
export function BlogNewsletterCard() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);

    if (!EMAIL_RE.test(email.trim())) {
      setErrorMsg("Please enter a valid email address.");
      return;
    }

    setStatus("loading");

    try {
      const res = await fetch("/api/newsletter/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      const data = (await res.json()) as { message?: string; error?: string };

      if (!res.ok) {
        const msg = data.error ?? "Something went wrong. Please try again.";
        setErrorMsg(msg);
        toast.error(msg);
        setStatus("idle");
        return;
      }

      const okMsg =
        data.message ?? "Check your inbox to confirm your subscription!";
      setSuccessMsg(okMsg);
      setStatus("success");
      setEmail("");
      toast.success(okMsg);
    } catch {
      const msg = "Something went wrong. Please try again.";
      setErrorMsg(msg);
      toast.error(msg);
      setStatus("idle");
    }
  };

  return (
    <div className="newsletter-card">
      <h3>
        A long read in your inbox,{" "}
        <span className="hl">every other Sunday.</span>
      </h3>
      <p>
        No marketing emails. No daily summaries. Just one well-written essay
        every two weeks. Cancel anytime — the link is in every email.
      </p>

      {status === "success" ? (
        <p
          role="status"
          style={{
            marginTop: "30px",
            fontFamily: "'JetBrains Mono', monospace",
            fontStyle: "normal",
            fontSize: "14px",
            fontWeight: 600,
            color: "#f7f3e6",
            position: "relative",
          }}
        >
          {successMsg ?? "Check your inbox to confirm your subscription!"}
        </p>
      ) : (
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            name="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (errorMsg) setErrorMsg(null);
            }}
            disabled={status === "loading"}
            required
            aria-label="Email address"
          />
          <button type="submit" disabled={status === "loading"}>
            {status === "loading" ? "Subscribing…" : "Subscribe →"}
          </button>
        </form>
      )}

      {errorMsg && (
        <p
          role="alert"
          style={{
            marginTop: "12px",
            fontFamily: "'JetBrains Mono', monospace",
            fontStyle: "normal",
            fontSize: "12.5px",
            color: "#ff9b8a",
            position: "relative",
          }}
        >
          {errorMsg}
        </p>
      )}

      <div className="meta">Sent every other Sunday IST · no spam, ever</div>
    </div>
  );
}
