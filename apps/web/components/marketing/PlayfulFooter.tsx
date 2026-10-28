import Link from "next/link";
import Image from "next/image";

// AI assistants users can ask about UseMoney. Prompts mirror the OpenFunnel
// reference structure: "Summarize how X uses Y, Z, and W to help A do B.
// Focus on how X replaces … with …. Website: …" — Gemini/Grok drop the
// leading "Summarize" verb. Each vendor gets the prompt URL-encoded into
// the deep-link query so the chat opens with the right context loaded.
const SUMMARIZE_PROMPT =
  "Summarize how UseMoney AI uses multi-broker OAuth integration, conversational AI research, and Indian-markets-first design to help retail investors run their entire portfolio from a single workspace. Focus on how UseMoney AI replaces the spreadsheet-and-five-broker-tabs workflow with unified XIRR across Zerodha / Groww / Angel One / Upstox / Dhan / Fyers / HDFC Sky / ICICI Direct, AI chat grounded in your actual holdings, strategy builder + walk-forward backtesting, an INR-native FIRE calculator, and ITR-ready capital-gains reports. Website: https://usemoney.ai";

const ASK_PROMPT = SUMMARIZE_PROMPT.replace(/^Summarize how/, "How");

const e = (s: string) => encodeURIComponent(s);

const ASK_AI_TARGETS: Array<{
  href: string;
  label: string;
  brand: string; // brand color applied to the icon
  svg: React.ReactNode;
}> = [
  {
    // Anthropic Claude — official brand mark from /public/ai-logos/claude.png.
    href: `https://claude.ai/new?q=${e(SUMMARIZE_PROMPT)}`,
    label: "Claude",
    brand: "#D97757",
    svg: (
      <Image
        src="/ai-logos/claude.png"
        alt="Claude"
        width={16}
        height={16}
        style={{ width: 16, height: 16, objectFit: "contain" }}
      />
    ),
  },
  {
    // OpenAI ChatGPT — official 6-loop knot. OpenAI retired the teal-green
    // (#10A37F) for a monochrome mark; ink in light, cream in dark via
    // var(--ink) so the symbol stays legible on the playful surface in both.
    href: `https://chatgpt.com/?q=${e(SUMMARIZE_PROMPT)}`,
    label: "ChatGPT",
    brand: "var(--ink)",
    svg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .039.052v5.583a4.504 4.504 0 0 1-4.495 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    ),
  },
  {
    // Perplexity — icon-only compass-star. Path lifted from
    // /public/ai-logos/perplexity.svg (the wordmark file), keeping the
    // full-height vertical stroke (v36) that the existing
    // perplexity-icon.svg truncates to v25.5. Inlined with currentColor
    // stroke so it follows the brand teal via the wrapping <a> — same
    // pattern as Grok. viewBox 0 0 28 36 → icon renders ~12.4×16 inside a
    // 16×16 box (default preserveAspectRatio).
    href: `https://www.perplexity.ai/search/new?q=${e(SUMMARIZE_PROMPT)}`,
    label: "Perplexity",
    brand: "#20808D",
    svg: (
      <svg
        width="16"
        height="16"
        viewBox="0 0 28 36"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeMiterlimit="10"
      >
        <path d="m23.566,1.398l-9.495,9.504h9.495V1.398v2.602V1.398Zm-9.496,9.504L4.574,1.398v9.504h9.496Zm-.021-10.902v36m9.517-15.596l-9.495-9.504v13.625l9.495,9.504v-13.625Zm-18.991,0l9.496-9.504v13.625l-9.496,9.504v-13.625ZM.5,10.9v13.57h4.074v-4.066l9.496-9.504H.5Zm13.57,0l9.495,9.504v4.066h4.075v-13.57h-13.57Z" />
      </svg>
    ),
  },
  {
    // Google Gemini — 4-point sparkle in Google blue via currentColor (no
    // PNG / no wordmark, matches the other icon-only marks).
    href: `https://gemini.google.com/app?q=${e(ASK_PROMPT)}`,
    label: "Gemini",
    brand: "#4285F4",
    svg: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2 C12 7.5 16.5 12 22 12 C16.5 12 12 16.5 12 22 C12 16.5 7.5 12 2 12 C7.5 12 12 7.5 12 2 Z" />
      </svg>
    ),
  },
  {
    // Grok (xAI) — 2-path angular swoosh mark. Paths lifted from
    // /public/ai-logos/grok-icon.svg; rendered with currentColor so dark
    // theme can override via the brand CSS var to stay visible on dark.
    href: `https://grok.com/?q=${e(ASK_PROMPT)}`,
    label: "Grok",
    brand: "var(--grok-brand, #000000)",
    svg: (
      <svg width="16" height="16" viewBox="0 0 34 33" fill="currentColor">
        <path d="M13.2371 21.0407L24.3186 12.8506C24.8619 12.4491 25.6384 12.6057 25.8973 13.2294C27.2597 16.5185 26.651 20.4712 23.9403 23.1851C21.2297 25.8989 17.4581 26.4941 14.0108 25.1386L10.2449 26.8843C15.6463 30.5806 22.2053 29.6665 26.304 25.5601C29.5551 22.3051 30.562 17.8683 29.6205 13.8673L29.629 13.8758C28.2637 7.99809 29.9647 5.64871 33.449 0.844576C33.5314 0.730667 33.6139 0.616757 33.6964 0.5L29.1113 5.09055V5.07631L13.2343 21.0436" />
        <path d="M10.9503 23.0313C7.07343 19.3235 7.74185 13.5853 11.0498 10.2763C13.4959 7.82722 17.5036 6.82767 21.0021 8.2971L24.7595 6.55998C24.0826 6.07017 23.215 5.54334 22.2195 5.17313C17.7198 3.31926 12.3326 4.24192 8.67479 7.90126C5.15635 11.4239 4.0499 16.8403 5.94992 21.4622C7.36924 24.9165 5.04257 27.3598 2.69884 29.826C1.86829 30.7002 1.0349 31.5745 0.36364 32.5L10.9474 23.0341" />
      </svg>
    ),
  },
];

const SOCIALS: Array<{ href: string; label: string; svg: React.ReactNode }> = [
  {
    href: "https://x.com/usemoneyAI",
    label: "X",
    svg: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    ),
  },
  {
    href: "https://www.linkedin.com/company/usemoneyai",
    label: "LinkedIn",
    svg: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452z" />
      </svg>
    ),
  },
  {
    href: "https://www.youtube.com/@usemoneyAI",
    label: "YouTube",
    svg: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    ),
  },
  {
    href: "https://instagram.com/usemoneyai",
    label: "Instagram",
    svg: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
        <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
        <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
      </svg>
    ),
  },
  {
    href: "mailto:hello@usemoney.ai",
    label: "Email",
    svg: (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
        <polyline points="22,6 12,13 2,6" />
      </svg>
    ),
  },
];

export function PlayfulFooter() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="fbrand">
            <Link className="brand" href="/home">
              <span className="brand-mark">U</span>
              <span>
                UseMoney<span className="brand-ai">AI</span>
              </span>
            </Link>
            <h5 style={{ marginTop: 18 }}>
              Use money. <span className="ser">Intelligently.</span>
            </h5>
            <p>
              The AI-native workspace for Indian retail investors. NSE &amp; BSE
              first.
            </p>
            <div className="socials">
              {SOCIALS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  aria-label={s.label}
                  target={s.href.startsWith("mailto:") ? undefined : "_blank"}
                  rel={s.href.startsWith("mailto:") ? undefined : "noreferrer"}
                >
                  {s.svg}
                </a>
              ))}
            </div>
          </div>
          <div className="fcol">
            <h6>Product</h6>
            <ul>
              <li>
                <Link href="/features">Features</Link>
              </li>
              <li>
                <Link href="/integrations">Integrations</Link>
              </li>
              <li>
                <Link href="/roadmap">Roadmap</Link>
              </li>
              <li>
                <Link href="/changelog">Changelog</Link>
              </li>
              <li>
                <Link href="/sign-up">Start free</Link>
              </li>
            </ul>
          </div>
          <div className="fcol">
            <h6>Resources</h6>
            <ul>
              <li>
                <Link href="/docs">Docs</Link>
              </li>
              <li>
                <Link href="/glossary">Glossary</Link>
              </li>
              <li>
                <Link href="/blog">Blog</Link>
              </li>
              <li>
                {/* Newsletter lives on /blog (subscribe form anchored there). */}
                <Link href="/blog">Newsletter</Link>
              </li>
            </ul>
          </div>
          <div className="fcol">
            <h6>Company</h6>
            <ul>
              <li>
                <Link href="/about">About</Link>
              </li>
              <li>
                <Link href="/alternatives">Compare</Link>
              </li>
              <li>
                <Link href="/pricing">Pricing</Link>
              </li>
              <li>
                <Link href="/security">Security</Link>
              </li>
            </ul>
          </div>
          <div className="fcol">
            <h6>Legal</h6>
            <ul>
              <li>
                <Link href="/privacy">Privacy Policy</Link>
              </li>
              <li>
                <Link href="/terms">Terms of Service</Link>
              </li>
              <li>
                <Link href="/data-usage">Data Usage</Link>
              </li>
              <li>
                <Link href="/subprocessors">Subprocessors</Link>
              </li>
              <li>
                <Link href="/risk-disclosure">SEBI Risk Disclosure</Link>
              </li>
              <li>
                <Link href="/legal">All Legal</Link>
              </li>
            </ul>
          </div>
        </div>
        <div className="footer-bottom">
          <span>
            © 2026{" "}
            <a
              href="https://disdigital.in/"
              target="_blank"
              rel="noreferrer"
              className="dis-link"
            >
              DIS Digital LLP
            </a>{" "}
            · Made in India · All systems operational
          </span>
          <div className="ask-ai">
            <span className="ask-ai-label">Ask AI about UseMoney AI</span>
            <div className="ask-ai-row">
              {ASK_AI_TARGETS.map((a) => (
                <a
                  key={a.label}
                  href={a.href}
                  aria-label={`Ask ${a.label} about UseMoney`}
                  target="_blank"
                  rel="noreferrer"
                  title={`Ask ${a.label}`}
                  style={{ color: a.brand }}
                >
                  {a.svg}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
