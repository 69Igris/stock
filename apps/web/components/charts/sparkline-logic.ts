/**
 * Sparkline client-side scaling logic (sibling of `./Sparkline.tsx`).
 *
 * MONEY-620 (task #193): the `Sparkline.tsx` renderer used to compute its own
 * min/max + y-scaling inline —
 *   `max = Math.max(...data); min = Math.min(...data);
 *    range = max - min || 1;
 *    y = height - ((v - min) / range) * height` —
 * which is UNGUARDED against non-finite poison:
 *   - a single `NaN`/`Infinity` bar makes `Math.min(...)`/`Math.max(...)` go
 *     non-finite, which makes EVERY `y` coordinate `NaN` → the polyline `points`
 *     attribute is all `NaN` → the whole sparkline silently vanishes;
 *   - a flat series (`max === min`) hit `range = 0 || 1 = 1`, pinning the line
 *     to the very bottom (`y = height`) instead of reading as flat.
 *
 * The poison-safe math already exists, fully tested, as a PURE (zero-import,
 * Prisma-free) module in the service layer:
 *   `packages/services/src/sparkline-logic.ts`
 * and the LIVE `sparkline.service.ts` calls `sanitizeCloses` so every series it
 * hands out is already poison-free.
 *
 * Rather than re-implement (which would be a shadow that can silently diverge
 * from the service path and from `sparkline-logic-unit.test.ts`), this sibling
 * RE-EXPORTS that single source of truth so `Sparkline.tsx` renders with the
 * exact same guarded bytes. The import is a DIRECT deep path to the pure module,
 * NOT the `@usemoney/services` barrel — the barrel re-exports Prisma/GCS/etc.
 * and `Sparkline.tsx` is a `"use client"` component, so pulling the barrel into
 * the client bundle would break webpack. The target module has zero imports, so
 * this deep import drags nothing extra into the client bundle.
 */

export {
  finite,
  sanitizeCloses,
  sparklineExtent,
  scaleSparklineToViewBox,
  sparklinePointsAttr,
} from "../../../../packages/services/src/sparkline-logic";

export type {
  SparklineExtent,
  SparklinePoint,
  ScaleSparklineOptions,
} from "../../../../packages/services/src/sparkline-logic";
