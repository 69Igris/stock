import type { Metadata, Viewport } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import "./playful-app.css";
import "./chat-blocks.css";
// MONEY-490/671: StockSage v2 design system — fully scoped under `.ssx`
// (inert until a `.ssx` container renders design components). Dark via
// next-themes `html.dark`. Generated from .design-ref/ss*.css.
import "./stocksage/ssx.css";
import { PostHogProvider } from "../components/PostHogProvider";
import { ThemedToaster } from "@/components/ThemedToaster";
import IDBCacheManager from "@/components/IDBCacheManager";
import DemoSessionGuard from "@/components/DemoSessionGuard";
import OneTapGate from "@/components/OneTapGate";
import { DatadogRumProvider } from "../components/DatadogRumProvider";
import { SidebarProvider } from "@/components/SidebarContext";
import { CommandPaletteProvider } from "@/components/CommandPalette";
import TopBar from "@/components/TopBar";
import GlobalMobileBottomNav from "@/components/GlobalMobileBottomNav";
import ScrollToTop from "@/components/ScrollToTop";
import TermsGate from "@/components/TermsGate";
import SessionGuard from "@/components/SessionGuard";
import { WalkthroughProvider } from "@/components/walkthrough";
import { TooltipProvider } from "@usemoney/ui/tooltip";

const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-dm-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai"
  ),
  title: {
    default: "UseMoney AI - Use money. Intelligently.",
    template: "%s | UseMoney",
  },
  description:
    "AI-powered trading portfolio management for Indian markets. Unify every broker, ask AI anything, paper-trade, and plan FIRE - all in one command center.",
  keywords: [
    "UseMoney",
    "portfolio management",
    "AI trading",
    "multi-broker",
    "NSE",
    "BSE",
    "Zerodha",
    "Upstox",
    "Dhan",
    "Angel One",
    "Groww",
    "Fyers",
    "paper trading",
    "FIRE calculator",
    "stock research",
    "India",
  ],
  authors: [{ name: "UseMoney AI · DIS Digital LLP" }],
  creator: "UseMoney",
  publisher: "UseMoney",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_IN",
    url: "/",
    siteName: "UseMoney AI",
    title: "UseMoney AI - Use money. Intelligently.",
    description:
      "AI-powered trading portfolio management for Indian markets. Unify every broker, ask AI anything, paper-trade, and plan FIRE.",
    images: [
      {
        url: "/og-website.png",
        width: 1200,
        height: 630,
        alt: "UseMoney AI - portfolio command center for Indian markets",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@usemoneyAI",
    creator: "@usemoneyAI",
    title: "UseMoney AI - Use money. Intelligently.",
    description:
      "AI portfolio command center for Indian markets. Multi-broker. Paper trading. FIRE planning.",
    images: [
      {
        url: "/og-website.png",
        alt: "UseMoney AI - portfolio command center for Indian markets",
      },
    ],
  },
  // Square icon (no round-off) - these come from the design bundle and
  // live alongside the rounded /icon.svg used inside the app sidebar.
  // Browsers prefer the SVG; the explicit PNG sizes give legacy + Windows
  // tile fallbacks that match exactly.
  icons: {
    icon: [
      { url: "/icon-square.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-square-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-square-64.png", type: "image/png", sizes: "64x64" },
      { url: "/icon-square-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [
      { url: "/icon-square-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  manifest: "/manifest.json",
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  // Bias social-app in-app browsers (Instagram / WhatsApp / Twitter / etc.)
  // toward opening shared UseMoney links in the OS browser. Combined with
  // the in-app-browser detection in HeroSection + SignInModal, this reduces
  // the number of users hitting Google's `disallowed_useragent` OAuth wall.
  // See MONEY-211.
  referrer: "no-referrer-when-downgrade",
  other: {
    "msapplication-TileColor": "#16140e",
    "msapplication-TileImage": "/icon-square-192.png",
    "article:publisher": "https://www.linkedin.com/company/usemoneyai",
    // Disable iOS Smart App Banner (no native app yet - banner forces in-app
    // browser preview behaviour that interferes with OAuth)
    "apple-itunes-app": "app-id=DISABLED",
    // App Links hint: tells Facebook/Meta apps that the canonical home for
    // this content is the web URL, encouraging fall-through to the OS browser.
    "al:web:should_fallback": "true",
  },
};

// Next 14 deprecated `themeColor` on the metadata export - every page
// inheriting from the root layout was emitting "Unsupported metadata
// themeColor" warnings during static generation. Move it to the
// dedicated `viewport` export so the warning vanishes and the
// browser still picks up the dark theme color.
export const viewport: Viewport = {
  themeColor: "#16140e",
};

// Static JSON-LD payloads stringified once at module-load. Both objects
// are literal (no user input), so injecting them inline at <head> via
// `dangerouslySetInnerHTML` carries no XSS surface - Next.js's own JSON-LD
// guide uses the same pattern.
const JSON_LD_BLOBS: string[] = [
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "UseMoney AI",
    alternateName: "UseMoney",
    url: "https://usemoney.ai",
    logo: "https://usemoney.ai/icon-square-512.png",
    description:
      "AI-powered trading portfolio management platform for Indian stock markets.",
    founder: "DIS Digital LLP",
    sameAs: [
      "https://twitter.com/usemoneyAI",
      "https://www.linkedin.com/company/usemoneyai",
      "https://www.instagram.com/usemoneyai",
      "https://www.youtube.com/@usemoneyAI",
      "https://www.reddit.com/r/usemoney",
    ],
  }),
  JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "UseMoney AI",
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    // MONEY-482: structured-data offer now references the launch-offer
    // PRO Monthly entry price (₹249). Lifetime is retired and grandfathered
    // for existing customers only; we no longer advertise it.
    offers: {
      "@type": "Offer",
      price: "249",
      priceCurrency: "INR",
      description: "PRO Monthly — unlimited broker sync + research credits",
    },
    image: "https://usemoney.ai/og-website.png",
    url: "https://usemoney.ai",
  }),
];

import {
  QuotesBaseUrlProvider,
  UdfBaseUrlProvider,
} from "@/components/charts/UdfBaseUrlProvider";
import { getUdfBaseUrl } from "@/lib/market/udf-target";
import { getQuotesBaseUrl } from "@/lib/market/quotes-target";

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // MONEY-1468 (A3) — resolve the `/udf` origin ONCE, here, and carry it to
  // every chart through a context. It cannot be read in the chart itself: the
  // decision is a `PlatformConfig` row (server-only) and the chart is a client
  // component. Resolving per call site would mean six places to get right and
  // one silent miss; this is one.
  //
  // Never throws — it returns the legacy `/api/market/udf` on any failure,
  // including Mongo being down, because falling back costs latency nobody
  // notices while falling forward blanks every chart.
  const [udfBaseUrl, quotesBaseUrl] = await Promise.all([
    getUdfBaseUrl(),
    getQuotesBaseUrl(),
  ]);

  return (
    <ClerkProvider
      // Clerk v7: sign-out destination is configured here (moved off
      // <UserButton>/<ThemedUserButton>, which no longer accept
      // `afterSignOutUrl`). Preserves the prior "/home" landing on sign-out.
      afterSignOutUrl="/home"
      signInFallbackRedirectUrl="/launch"
      signUpFallbackRedirectUrl="/dashboard"
      localization={{
        unstable__errors: {
          form_identifier_exists:
            "This email is currently unavailable. If you recently deleted your account, you can sign up again 24 hours after deletion.",
          form_identifier_exists__email_address:
            "This email is currently unavailable. If you recently deleted your account, you can sign up again 24 hours after deletion.",
        },
      }}
    >
      <html lang="en" suppressHydrationWarning>
        <head>
          {/* JSON-LD structured data - sourced verbatim from the brand-asset
              design bundle (banners/metadata.html). Helps Google Knowledge
              Graph + LinkedIn show the right Organization details.
              Content is fully static (compile-time literal), no user input. */}
          {JSON_LD_BLOBS.map((blob, i) => (
            <script
              // eslint-disable-next-line react/no-danger
              key={i}
              type="application/ld+json"
              dangerouslySetInnerHTML={{ __html: blob }}
            />
          ))}
        </head>
        <body
          className={`${dmSans.variable} ${jetbrainsMono.variable} font-sans`}
          suppressHydrationWarning
        >
          <ThemeProvider attribute="class" defaultTheme="light">
            <PostHogProvider>
              <DatadogRumProvider />
              {/* MONEY-440: OneTapGate suppresses the One-Tap prompt
                  inside in-app browsers (Instagram/WhatsApp/FB/Twitter)
                  where Google rejects OAuth with `disallowed_useragent`.
                  Both force URLs are kept inside the gate so existing
                  users (sign-in) AND brand-new users (sign-up via Google)
                  land on /dashboard - without signUpForceRedirectUrl,
                  new-user one-taps fall back to the post-signup default
                  which can route through /home. */}
              <OneTapGate />
              <DemoSessionGuard />
              <IDBCacheManager />
              <TooltipProvider delayDuration={0}>
                <SessionGuard />
                <TermsGate>
                  <SidebarProvider>
                    <CommandPaletteProvider>
                      <WalkthroughProvider>
                        <TopBar />
                        <UdfBaseUrlProvider value={udfBaseUrl}>
                          <QuotesBaseUrlProvider value={quotesBaseUrl}>
                            {children}
                          </QuotesBaseUrlProvider>
                        </UdfBaseUrlProvider>
                        <GlobalMobileBottomNav />
                      </WalkthroughProvider>
                    </CommandPaletteProvider>
                  </SidebarProvider>
                </TermsGate>
              </TooltipProvider>
              <ScrollToTop />
              <ThemedToaster />
            </PostHogProvider>
          </ThemeProvider>
        </body>
      </html>
    </ClerkProvider>
  );
}
