/**
 * MONEY-393 §18 - secure-content components: source-shape guards.
 *
 * The secure video / audio / document players + ScreenProtection
 * implement browser-based DRM. They're large React components
 * (500+ lines each) that need React DOM to exercise at runtime -
 * which the agreed scope excludes. Instead, source-text guards pin
 * the security contracts callers + ops depend on:
 *
 *   - "use client" directive (Next.js server-component crash otherwise)
 *   - DevTools detection / blur-on-hidden / context-menu disable
 *   - Watermarking includes user identifier
 *   - PremiumContentGate enforces a feature check
 *
 * Catches regressions where someone strips one of the anti-leak
 * features during a refactor.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(__dirname, "..", "..", "components");

function read(rel: string): string {
  return readFileSync(join(COMPONENTS, rel), "utf8");
}

describe("MONEY-393 §18 - secure-content components", () => {
  // ── ScreenProtection ─────────────────────────────────────────────

  it("[ScreenProtection] is a client module exporting Provider + hook + ProtectedMedia", () => {
    const src = read("security/ScreenProtection.tsx");
    assert.match(
      src,
      /^"use client"/m,
      "must be client (uses useState/useEffect)"
    );
    assert.match(
      src,
      /export\s+function\s+ScreenProtectionProvider\b/,
      "ScreenProtectionProvider must be exported"
    );
    assert.match(
      src,
      /export\s+const\s+useScreenProtection\b/,
      "useScreenProtection hook must be exported"
    );
    assert.match(
      src,
      /export\s+function\s+ProtectedMedia\b/,
      "ProtectedMedia wrapper must be exported"
    );
  });

  it("[ScreenProtection] documents the DRM features in the file header", () => {
    const src = read("security/ScreenProtection.tsx");
    // Three core protections that ops + legal documentation references.
    assert.match(src, /Anti-screenshot/i);
    assert.match(src, /Anti-screen recording/i);
    assert.match(src, /DevTools detection/i);
    assert.match(src, /Watermark/i);
  });

  it("[ScreenProtection] reads Clerk user to bind watermark to identity", () => {
    const src = read("security/ScreenProtection.tsx");
    assert.match(
      src,
      /useUser\b/,
      "watermark must include user identifier so a leaked screenshot traces back"
    );
  });

  it("[ScreenProtection] supports onSecurityViolation callback for telemetry", () => {
    const src = read("security/ScreenProtection.tsx");
    // The onSecurityViolation prop fires when devtools open, screenshot
    // attempt detected, etc. - required for the audit trail.
    assert.match(
      src,
      /onSecurityViolation\?:/,
      "onSecurityViolation prop must be declared so callers can log violations"
    );
  });

  it("[ScreenProtection] documents the inherent browser-DRM limit", () => {
    // Important honesty in the file header: this deters casual copying
    // but cannot defeat a determined attacker. The disclaimer must
    // stay or legal will assume hard-DRM guarantees.
    const src = read("security/ScreenProtection.tsx");
    assert.match(
      src,
      /Browser-based DRM has inherent limits|deters casual copying but cannot prevent/i
    );
  });

  // ── SecureVideoPlayer ────────────────────────────────────────────

  it("[SecureVideoPlayer] is a client component with forwardRef + handle", () => {
    const src = read("content/SecureVideoPlayer.tsx");
    assert.match(src, /^"use client"/m);
    assert.match(src, /export\s+interface\s+SecureVideoPlayerProps/);
    assert.match(src, /export\s+interface\s+SecureVideoPlayerRef/);
    assert.match(src, /forwardRef</);
  });

  it("[SecureVideoPlayer] disables the right-click context menu", () => {
    const src = read("content/SecureVideoPlayer.tsx");
    // Either an onContextMenu={(e) => e.preventDefault()} or a
    // controlsList="nodownload nofullscreen" - both block the casual
    // "save video as" path.
    assert.ok(
      /onContextMenu\s*=\s*\{|controlsList=/.test(src),
      "must block the right-click 'Save video as' surface"
    );
  });

  it("[SecureVideoPlayer] disables HTML5 download attribute on the <video> tag", () => {
    const src = read("content/SecureVideoPlayer.tsx");
    // controlsList="nodownload" or download="" attribute defeats the
    // built-in browser download UI.
    assert.match(
      src,
      /nodownload|noplaybackrate|disablePictureInPicture/i,
      "controlsList must include nodownload (or pictureInPicture disabled)"
    );
  });

  // ── SecureAudioPlayer ────────────────────────────────────────────

  it("[SecureAudioPlayer] is a client component with the same DRM hooks", () => {
    const src = read("content/SecureAudioPlayer.tsx");
    assert.match(src, /^"use client"/m);
    // Same DRM surface - context menu + controlsList nodownload.
    assert.ok(
      /onContextMenu\s*=\s*\{|controlsList=|nodownload/.test(src),
      "audio player must block the casual download/right-click surface"
    );
  });

  // ── SecureDocumentViewer ─────────────────────────────────────────

  it("[SecureDocumentViewer] is a client component", () => {
    const src = read("content/SecureDocumentViewer.tsx");
    assert.match(src, /^"use client"/m);
  });

  it("[SecureDocumentViewer] disables print + selection where possible", () => {
    const src = read("content/SecureDocumentViewer.tsx");
    // PDF viewing usually blocks print via CSS `@media print { display: none }`
    // or via JS keyboard intercept on Ctrl+P. Either should appear.
    assert.ok(
      /print|onCopy|userSelect|user-select|onContextMenu/i.test(src),
      "document viewer must block at least one of: print, copy, context menu, or selection"
    );
  });

  // ── PremiumContentGate ───────────────────────────────────────────

  it("[PremiumContentGate] enforces a subscription feature check before rendering", () => {
    const src = read("content/PremiumContentGate.tsx");
    assert.match(src, /^"use client"/m);
    // The gate must reference some access check (hasFeatureAccess,
    // canAccess, subscription, getSubscription, plan).
    assert.match(
      src,
      /hasFeatureAccess|canAccess|subscription|getSubscription|plan|tier|getMyPlanAction|FEATURE_ACCESS/i,
      "PremiumContentGate must consult subscription state before rendering"
    );
  });

  it("[PremiumContentGate] surfaces an upgrade CTA when access is denied", () => {
    const src = read("content/PremiumContentGate.tsx");
    // Either an explicit upgrade route mention or a 'Upgrade' / 'Pro'
    // user-facing string.
    assert.match(
      src,
      /Upgrade|upgrade|Premium|PRO|Subscribe|Get\s+Pro|paywall|signup/i,
      "PremiumContentGate must surface an upgrade CTA when blocked"
    );
  });

  // ── Cross-component: video player composes ScreenProtection ──

  it("[contract] SecureVideoPlayer composes ProtectedMedia + useScreenProtection", () => {
    // The video player is the highest-value DRM surface (paid courses
    // stream HLS here). Must wire into the ScreenProtection context.
    const video = read("content/SecureVideoPlayer.tsx");
    assert.match(
      video,
      /import\s*\{[^}]*ProtectedMedia[^}]*\}\s*from\s+["']\.\.\/security["']/,
      "SecureVideoPlayer must import ProtectedMedia from ../security"
    );
    assert.match(
      video,
      /useScreenProtection\(\)/,
      "SecureVideoPlayer must call useScreenProtection() to react to violations"
    );
    assert.match(
      video,
      /<ProtectedMedia\b/,
      "SecureVideoPlayer must wrap its render in <ProtectedMedia>"
    );
  });

  it("[contract] SecureAudioPlayer has its own blur-on-protection CSS (gap noted)", () => {
    // The audio player does NOT compose ScreenProtection - it carries
    // its own inline CSS (display:none on .protected-blur). Documented
    // as a known gap; long-term fix is to push it through
    // <ProtectedMedia> like the video player. The test pins the
    // current minimum: at least *some* protection CSS exists.
    const audio = read("content/SecureAudioPlayer.tsx");
    assert.match(
      audio,
      /display:\s*none\s*!important|protected-blur|blur\(|onContextMenu/,
      "SecureAudioPlayer must have at least one protection rule"
    );
  });

  // ── Content index re-exports the public surface ──────────────────

  it("[index] components/content/index.ts re-exports the secure players + gate", () => {
    const src = read("content/index.ts");
    assert.match(src, /SecureVideoPlayer/);
    assert.match(src, /SecureAudioPlayer/);
    assert.match(src, /SecureDocumentViewer/);
    assert.match(src, /PremiumContentGate/);
  });
});
