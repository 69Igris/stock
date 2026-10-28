"use client";

import Link from "next/link";
import {
  UserPlus,
  Link2,
  Activity,
  Upload,
  Sparkles,
  FileSpreadsheet,
  Flame,
  Crown,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { gettingStartedSteps } from "@/app/help/lib/getting-started-data";

const iconMap: Record<string, LucideIcon> = {
  UserPlus,
  Link2,
  Activity,
  Upload,
  Sparkles,
  FileSpreadsheet,
  Flame,
  Crown,
};

const STEP_ACCENTS = [
  "var(--emerald)",
  "var(--pop-3)",
  "var(--pop-5)",
  "var(--pop-1)",
  "var(--pop-2)",
  "var(--pop-4)",
] as const;

export default function GettingStartedTab() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        maxWidth: 720,
      }}
    >
      {gettingStartedSteps.map((step, idx) => {
        const Icon = iconMap[step.icon] ?? Activity;
        const accent = STEP_ACCENTS[idx % STEP_ACCENTS.length];
        return (
          <div
            key={step.step}
            className="pf-card"
            style={{
              padding: "16px 18px",
              display: "flex",
              alignItems: "flex-start",
              gap: 16,
            }}
          >
            {/* Step number badge */}
            <span
              className="mono"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: accent,
                color: accent === "var(--pop-2)" ? "#1d1d1b" : "#fff",
                border: "1.5px solid var(--ink)",
                display: "grid",
                placeItems: "center",
                fontSize: 13,
                fontWeight: 800,
                transform: "rotate(-2deg)",
                flexShrink: 0,
              }}
            >
              {step.step}
            </span>

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 4,
                }}
              >
                <Icon
                  style={{ width: 14, height: 14, color: "var(--ink-3)" }}
                />
                <h3
                  style={{
                    fontSize: 14,
                    fontWeight: 800,
                    color: "var(--ink)",
                    margin: 0,
                    letterSpacing: -0.2,
                  }}
                >
                  {step.title}
                </h3>
              </div>
              <p
                style={{
                  fontFamily: "Instrument Serif, serif",
                  fontStyle: "italic",
                  fontSize: 14,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                  margin: "0 0 12px",
                }}
              >
                {step.description}
              </p>
              <Link href={step.href} style={{ textDecoration: "none" }}>
                <span
                  className="pf-bf sm"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  {step.linkLabel}
                  <ArrowRight style={{ width: 11, height: 11 }} />
                </span>
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}
