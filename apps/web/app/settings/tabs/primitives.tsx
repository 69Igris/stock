"use client";

import { ReactNode } from "react";
import { ChevronRight, Lock } from "lucide-react";

/**
 * Shared Settings primitives — playful "Terminal Luxe" idiom (MONEY-485).
 * Built on the .pf-* foundation in app/playful-app.css (theme-aware tokens
 * via html.dark). Sections are bordered .pf-card-style panels with a dashed
 * header rule; rows are left-aligned with a serif/mono value on the right and
 * a chevron affordance when interactive.
 */

export function SetCard({
  children,
  className = "",
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`pf-card flat ${className}`}
      style={{ padding: 0, overflow: "hidden", ...style }}
    >
      {children}
    </div>
  );
}

export function SetSection({
  title,
  desc,
  children,
}: {
  title?: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SetCard>
      {(title || desc) && (
        <div
          style={{
            padding: "14px 22px",
            borderBottom: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          {title && (
            <div
              style={{
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: -0.3,
                color: "var(--ink)",
              }}
            >
              {title}
            </div>
          )}
          {desc && (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                marginTop: 2,
                lineHeight: 1.5,
              }}
            >
              {desc}
            </div>
          )}
        </div>
      )}
      <div>{children}</div>
    </SetCard>
  );
}

export function SetRow({
  label,
  value,
  hint,
  mono = false,
  onClick,
  danger = false,
  last = false,
  locked = false,
}: {
  label: ReactNode;
  value?: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
  onClick?: () => void;
  danger?: boolean;
  last?: boolean;
  locked?: boolean;
}) {
  const interactive = onClick && !locked;
  return (
    <div
      onClick={interactive ? onClick : undefined}
      className="set-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 22px",
        borderBottom: last ? 0 : "1px dashed var(--rule-soft)",
        cursor: interactive ? "pointer" : "default",
        opacity: locked ? 0.55 : 1,
        transition: "background .12s",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: danger ? "#b91c1c" : "var(--ink)",
          }}
        >
          {label}
        </div>
        {hint && (
          <div
            className={mono ? "mono" : undefined}
            style={{
              fontSize: 11.5,
              color: "var(--ink-3)",
              marginTop: 3,
              fontFamily: locked ? "'JetBrains Mono', monospace" : undefined,
            }}
          >
            {hint}
          </div>
        )}
      </div>
      {value && (
        <div
          className={mono ? "mono" : undefined}
          style={{
            fontSize: 12.5,
            color: "var(--ink-2)",
            textAlign: "right",
            whiteSpace: "nowrap",
            fontFamily: mono ? "'JetBrains Mono', monospace" : undefined,
          }}
        >
          {value}
        </div>
      )}
      {interactive && (
        <ChevronRight
          className="h-3.5 w-3.5 flex-shrink-0"
          style={{ color: "var(--ink-3)" }}
        />
      )}
      {locked && (
        <Lock
          className="h-3 w-3 flex-shrink-0"
          style={{ color: "var(--ink-3)" }}
        />
      )}
    </div>
  );
}

export function SetToggle({
  label,
  hint,
  on,
  onChange,
  locked = false,
  last = false,
  demo = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  on: boolean;
  onChange: (next: boolean) => void;
  locked?: boolean;
  last?: boolean;
  /**
   * Locked specifically because the app is in demo mode. Surfaces a
   * "Sign in to manage" hint. Other lock reasons (a save in flight, an
   * unconfigured audience) keep the descriptive `hint` — e.g. "Not yet active".
   */
  demo?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "14px 22px",
        borderBottom: last ? 0 : "1px dashed var(--rule-soft)",
        opacity: locked ? 0.55 : 1,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
          {label}
        </div>
        {hint && (
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 3 }}>
            {demo ? "Sign in to manage" : hint}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-pressed={on}
        onClick={() => !locked && onChange(!on)}
        disabled={locked}
        className={`pf-toggle${on ? " on" : ""}`}
        style={{ cursor: locked ? "not-allowed" : "pointer" }}
      />
    </div>
  );
}

/** Mono-uppercase tracked label used as a section caption inside cards */
export function SetCaption({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        textTransform: "uppercase",
        fontWeight: 700,
        color: "var(--ink-4)",
        letterSpacing: 1.2,
      }}
    >
      {children}
    </div>
  );
}
