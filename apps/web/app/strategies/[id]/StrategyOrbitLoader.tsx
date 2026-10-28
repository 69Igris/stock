"use client";

/**
 * StrategyOrbitLoader - design Images #51, #53.
 *
 * Big circular orbit loader used by the Backtest + Forward pages
 * while a worker job is running. Three orbiting icons + a centered
 * primary icon + a title + subtitle + a thin progress bar + 3 step
 * pills underneath.
 */

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

interface OrbitIcon {
  Icon: LucideIcon;
  color: string;
  delaySec: number;
}

interface StepPill {
  id: string;
  label: string;
  state: "queued" | "running" | "done";
}

interface Props {
  CenterIcon: LucideIcon;
  centerColor: string;
  orbit: OrbitIcon[];
  title: string;
  subtitle: string;
  steps: StepPill[];
}

export default function StrategyOrbitLoader({
  CenterIcon,
  centerColor,
  orbit,
  title,
  subtitle,
  steps,
}: Props) {
  // Drive a 0-100 progress over ~3.5s. Live worker progress can override
  // this once MONEY-425 is wired by passing `progress` as a prop later.
  const [progress, setProgress] = useState(8);
  useEffect(() => {
    const interval = setInterval(() => {
      setProgress((p) => (p < 92 ? p + 2 : p));
    }, 80);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="relative w-[180px] h-[180px] mb-6">
        {/* Outer orbit ring */}
        <div
          className="absolute inset-0 rounded-full border border-[var(--border-default)]"
          aria-hidden
        />

        {/* Orbiting icons - distributed evenly */}
        {orbit.map((o, i) => {
          const angle = (i / orbit.length) * Math.PI * 2 - Math.PI / 2;
          const radius = 88;
          const x = Math.cos(angle) * radius + 90;
          const y = Math.sin(angle) * radius + 90;
          return (
            <div
              key={i}
              className="absolute w-7 h-7 rounded-md flex items-center justify-center -translate-x-1/2 -translate-y-1/2"
              style={{
                left: x,
                top: y,
                animation: `strat-orbit-pulse 2.4s ease-in-out infinite`,
                animationDelay: `${o.delaySec}s`,
              }}
              aria-hidden
            >
              <o.Icon className={`h-4 w-4 ${o.color}`} />
            </div>
          );
        })}

        {/* Center icon */}
        <div
          className="absolute inset-0 flex items-center justify-center"
          aria-hidden
        >
          <CenterIcon className={`h-12 w-12 ${centerColor}`} />
        </div>

        {/* Rotating shimmer ring */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, rgba(52,211,153,0.4) 70deg, transparent 140deg)",
            mask: "radial-gradient(circle, transparent 78px, black 80px, black 90px, transparent 92px)",
            WebkitMask:
              "radial-gradient(circle, transparent 78px, black 80px, black 90px, transparent 92px)",
            animation: "strat-orbit-spin 3.5s linear infinite",
          }}
          aria-hidden
        />
      </div>

      <h2 className="font-display text-[22px] font-bold tracking-[-0.3px] text-foreground m-0 mb-2 text-center">
        {title}
      </h2>
      <div className="font-mono text-[12.5px] text-muted-foreground flex items-center gap-2 mb-4">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        {subtitle}
      </div>

      <div className="w-full max-w-[480px] h-1.5 rounded-full bg-[var(--bg-card)] overflow-hidden mb-5">
        <div
          className="h-full bg-[linear-gradient(90deg,#34d399,#10b981)] transition-all duration-100"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex gap-3 flex-wrap justify-center">
        {steps.map((s) => {
          const dotClass =
            s.state === "done"
              ? "bg-emerald-400"
              : s.state === "running"
                ? "bg-cyan-400 animate-pulse"
                : "bg-muted-foreground/40";
          const labelClass =
            s.state === "done"
              ? "text-emerald-300"
              : s.state === "running"
                ? "text-cyan-300"
                : "text-muted-foreground";
          return (
            <div
              key={s.id}
              className={`inline-flex items-center gap-2 font-mono text-[11.5px] ${labelClass}`}
            >
              <span className={`w-2 h-2 rounded-full ${dotClass}`} />
              {s.label}
            </div>
          );
        })}
      </div>

      <style jsx global>{`
        @keyframes strat-orbit-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @keyframes strat-orbit-pulse {
          0%,
          100% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 0.6;
          }
          50% {
            transform: translate(-50%, -50%) scale(1.15);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}
