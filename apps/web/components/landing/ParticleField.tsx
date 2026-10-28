"use client";

import { useRef, useEffect, useCallback } from "react";
import { useTheme } from "next-themes";

/** Canvas-based particle network background - theme-aware emerald dots and connecting lines. */
export function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();

  // Dark: bright emerald, low opacity (subtle on dark bg)
  // Light: darker emerald, higher opacity (visible on white bg)
  const getColors = useCallback(() => {
    const isDark = resolvedTheme === "dark";
    return {
      rgb: isDark ? "52,211,153" : "5,150,105",
      dotAlpha: isDark ? 0.18 : 0.25,
      lineAlpha: isDark ? 0.06 : 0.1,
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = (canvas.width = canvas.offsetWidth * 2);
    let h = (canvas.height = canvas.offsetHeight * 2);
    ctx.scale(2, 2);

    const count = Math.min(70, Math.floor((w * h) / 36000));
    const particles = Array.from({ length: count }, () => ({
      x: Math.random() * (w / 2),
      y: Math.random() * (h / 2),
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: Math.random() * 1.1 + 0.4,
    }));

    let raf: number;
    const draw = () => {
      const { rgb, dotAlpha, lineAlpha } = getColors();
      ctx.clearRect(0, 0, w / 2, h / 2);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w / 2;
        if (p.x > w / 2) p.x = 0;
        if (p.y < 0) p.y = h / 2;
        if (p.y > h / 2) p.y = 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${dotAlpha})`;
        ctx.fill();
      }
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i];
          const b = particles[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 130) {
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(${rgb},${lineAlpha * (1 - d / 130)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => cancelAnimationFrame(raf);
  }, [getColors]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none z-0 hidden md:block"
      aria-hidden="true"
    />
  );
}
