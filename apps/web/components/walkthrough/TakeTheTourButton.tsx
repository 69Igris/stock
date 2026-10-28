"use client";

/**
 * Small reusable button that re-fires a page-specific walkthrough.
 * Dispatches `walkthrough:restart` with the given tour version so the
 * provider re-enters the tour even if the user has already seen it.
 */
export default function TakeTheTourButton({
  version,
  className,
  label = "Take the tour",
}: {
  version: string;
  className?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("walkthrough:restart", { detail: version })
          );
        }
      }}
      className={
        className ??
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono text-[var(--text-muted)] hover:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
      }
      aria-label={label}
    >
      <span className="font-bold tracking-[0.5px] uppercase">{label}</span>
    </button>
  );
}
