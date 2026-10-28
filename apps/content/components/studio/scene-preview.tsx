"use client";

import type { ReactNode } from "react";

/**
 * Live, client-side preview of a video-studio Timeline — a filmstrip of mini 9:16
 * brand cards rendered from the Timeline JSON as you edit. No server/Chromium: the
 * pixel-exact frames come from the worker render; this is the fast "what's in the
 * reel" view (scene type, headline with italic + gold-highlight markup, stat,
 * caption, disclaimer). SEBI cues (disclaimer) are surfaced so editors can spot-check.
 */

interface PreviewScene {
  id?: string;
  type?: string;
  kicker?: string;
  headline?: string;
  subtext?: string;
  stat?: { kicker?: string; value?: string; label?: string };
  voiceover?: { text?: string };
  disclaimer?: boolean;
  durationSec?: number;
  veoPrompt?: string;
}
interface PreviewTimeline {
  scenes?: PreviewScene[];
  brandTheme?: string;
}

/**
 * Render *word* → serif italic and ==word== → gold highlight as React nodes.
 * React escapes text children, so this is XSS-safe (no dangerouslySetInnerHTML).
 */
function renderMarkup(s?: string): ReactNode {
  if (!s) return null;
  const nodes: ReactNode[] = [];
  const re = /==([^=]+)==|\*([^*]+)\*/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) nodes.push(s.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(
        <mark
          key={key++}
          style={{
            background: "#fbbf24",
            color: "#1d1d1b",
            padding: "0 2px",
            borderRadius: 2,
          }}
        >
          {m[1]}
        </mark>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(
        <em
          key={key++}
          style={{ fontStyle: "italic", fontFamily: "Georgia, serif" }}
        >
          {m[2]}
        </em>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes;
}

export function ScenePreview({ json }: { json: string }) {
  let tl: PreviewTimeline | null = null;
  try {
    tl = JSON.parse(json) as PreviewTimeline;
  } catch {
    tl = null;
  }
  const scenes = tl?.scenes ?? [];
  if (scenes.length === 0) {
    return (
      <p className="text-xs text-neutral-500">
        Live preview unavailable — the Timeline JSON is empty or invalid.
      </p>
    );
  }
  const dark = tl?.brandTheme === "dark";
  const paper = dark ? "#060b18" : "#f7f3e6";
  const ink = dark ? "#f1f5f9" : "#1d1d1b";

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {scenes.map((s, i) => (
        <div
          key={s.id ?? i}
          className="relative flex aspect-[9/16] w-[150px] shrink-0 flex-col overflow-hidden rounded-lg border-2 border-neutral-900 p-2.5 shadow-[2px_2px_0_0_#1d1d1b]"
          style={{ background: paper, color: ink }}
        >
          {/* lockup */}
          <div className="flex items-center gap-1 text-[8px] font-extrabold">
            <span
              className="rounded-sm px-1"
              style={{ background: ink, color: paper }}
            >
              U
            </span>
            UseMoney<span style={{ color: "#16a34a" }}>AI</span>
          </div>

          {/* body */}
          <div className="flex flex-1 flex-col justify-center gap-1">
            {(s.kicker || s.stat?.kicker) && (
              <div className="font-mono text-[7px] uppercase tracking-wide text-neutral-500">
                {s.kicker ?? s.stat?.kicker}
              </div>
            )}
            {s.type === "stat" && s.stat ? (
              <div className="font-mono text-2xl font-extrabold leading-none">
                {s.stat.value}
              </div>
            ) : s.type === "veo" ? (
              <div className="text-[9px] italic text-neutral-500">
                🎥 Veo B-roll
                <div className="mt-0.5 text-[7px] not-italic">
                  {(s.veoPrompt ?? "").slice(0, 70)}…
                </div>
              </div>
            ) : (
              <div className="text-[11px] font-extrabold leading-tight">
                {renderMarkup(s.headline)}
              </div>
            )}
            {s.stat?.label && (
              <div className="text-[8px] text-neutral-500">{s.stat.label}</div>
            )}
            {s.subtext && (
              <div className="text-[8px] text-neutral-500">{s.subtext}</div>
            )}
          </div>

          {/* caption (voiceover) */}
          {s.voiceover?.text && (
            <div className="mt-1 line-clamp-2 rounded border border-neutral-300 bg-white/80 px-1 py-0.5 text-center text-[7px]">
              {s.voiceover.text}
            </div>
          )}

          {/* foot: disclaimer + scene index/duration */}
          <div className="mt-1 flex items-center justify-between text-[6px] text-neutral-500">
            <span>{s.disclaimer ? "⚠ edu only" : ""}</span>
            <span>
              {i + 1}/{scenes.length}
              {typeof s.durationSec === "number" ? ` · ${s.durationSec}s` : ""}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
