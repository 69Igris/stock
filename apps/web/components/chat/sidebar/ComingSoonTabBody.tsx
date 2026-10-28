"use client";

/**
 * Coming soon tab body — playful redesign (MONEY-483).
 *
 * Replaces the framer-motion orbital animation with a static but
 * playful pf-card sticker approach: tilted ink-filled icon tile,
 * bold serif headline, scan bar. Matches the tone of other sidebar
 * empty states without requiring framer-motion in a narrow column.
 *
 * For parity with ComingSoon full-page, the same framer-motion is
 * kept available — but the visual is now pf-system tokens so it
 * feels at home in the chat sidebar.
 */

import { motion } from "framer-motion";
import { Terminal, type LucideIcon } from "lucide-react";

interface Props {
  label: string;
  blurb?: string;
  Icon?: LucideIcon;
}

export default function ComingSoonTabBody({
  label,
  blurb,
  Icon = Terminal,
}: Props) {
  return (
    <div
      className="pf-noscrollbar"
      style={{ flex: 1, overflowY: "auto", padding: "32px 16px 24px" }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
          gap: 18,
        }}
      >
        {/* Playful pulsing icon mark */}
        <div style={{ position: "relative", width: 64, height: 64 }}>
          {/* Emerald glow */}
          <motion.div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 16,
              background:
                "radial-gradient(circle, rgba(52,211,153,0.3), rgba(52,211,153,0.04) 65%)",
              filter: "blur(12px)",
            }}
            animate={{ scale: [1, 1.1, 1], opacity: [0.5, 0.85, 0.5] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          />

          {/* Orbiting dot */}
          <motion.div
            style={{ position: "absolute", inset: -8 }}
            animate={{ rotate: 360 }}
            transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: "50%",
                transform: "translateX(-50%)",
                width: 5,
                height: 5,
                borderRadius: 999,
                background: "var(--emerald)",
                opacity: 0.8,
              }}
            />
          </motion.div>

          {/* Icon tile — tilted ink block */}
          <motion.div
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              borderRadius: 16,
              background: "var(--ink)",
              border: "2px solid var(--ink)",
              boxShadow: "4px 4px 0 var(--ink)",
              display: "grid",
              placeItems: "center",
              color: "var(--paper)",
              transform: "rotate(-4deg)",
            }}
            animate={{ y: [0, -4, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          >
            <Icon size={26} strokeWidth={2} />
          </motion.div>
        </div>

        {/* Copy */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: "1.5px",
              textTransform: "uppercase",
              color: "var(--emerald-text)",
            }}
          >
            {"// COMING SOON"}
          </div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: "var(--ink)",
              letterSpacing: -0.3,
              lineHeight: 1.1,
            }}
          >
            {label}
          </div>
          {blurb && (
            <div
              className="ser"
              style={{
                fontSize: 12.5,
                color: "var(--ink-3)",
                lineHeight: 1.4,
                maxWidth: 200,
              }}
            >
              {blurb}
            </div>
          )}
        </div>

        {/* Scan bar (pf-scan) */}
        <div
          className="pf-scan"
          style={{ width: "100%", maxWidth: 160 }}
          aria-hidden="true"
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: -10,
          }}
        >
          <motion.div
            style={{
              width: 5,
              height: 5,
              borderRadius: 999,
              background: "var(--emerald)",
            }}
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          />
          <span
            className="mono"
            style={{
              fontSize: 9.5,
              fontWeight: 700,
              letterSpacing: "1.2px",
              textTransform: "uppercase",
              color: "var(--ink-3)",
            }}
          >
            In Development
          </span>
        </div>
      </div>
    </div>
  );
}
