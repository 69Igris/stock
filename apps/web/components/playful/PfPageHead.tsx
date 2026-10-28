import type { ReactNode } from "react";

/**
 * Playful page header (MONEY-485 L2) — the design's signature `pf-ph`
 * composition: a mono eyebrow with a pulsing dot, a bold display headline
 * (callers pass `.ser` for serif accents and `.hl-gold` for highlights),
 * an Instrument-Serif italic sub-line, and an optional right-aligned
 * actions slot. Styling lives in playful-app.css (`.pf-ph`), which is
 * responsive (stacks below the actions on narrow viewports via flex-wrap).
 *
 * Purely presentational + additive — drop it in atop any page without
 * touching that page's data or behaviour.
 */
export function PfPageHead({
  eyebrow,
  title,
  sub,
  right,
  className,
  dataWalkthrough,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  className?: string;
  // Optional walkthrough anchor placed on the real `.pf-ph` box, so a tour
  // step can spotlight the page header without a layout-shifting wrapper.
  dataWalkthrough?: string;
}) {
  return (
    <div
      className={`pf-ph${className ? ` ${className}` : ""}`}
      data-walkthrough={dataWalkthrough}
    >
      <div className="l">
        {eyebrow ? (
          <div className="eyebrow">
            <span className="d" aria-hidden />
            {eyebrow}
          </div>
        ) : null}
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {right ? <div className="r">{right}</div> : null}
    </div>
  );
}

export default PfPageHead;
