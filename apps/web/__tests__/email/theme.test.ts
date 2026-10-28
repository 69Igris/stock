/**
 * MONEY-878: email cream-theme + dark mode + one-click unsubscribe headers.
 *
 * Renders the REAL templates from `@usemoney/email/templates` via
 * `@react-email/render` and asserts the brand contract: the cream/ink/emerald
 * palette (not the removed blue/navy), a `prefers-color-scheme: dark` block, the
 * SEBI footer, social links on editorial emails, and no unsubscribe on security
 * emails. Also pins `buildListUnsubscribeHeaders` (RFC 8058).
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";

type Render = (
  el: React.ReactElement,
  opts?: { plainText?: boolean }
) => Promise<string>;

let render: Render;
/* eslint-disable @typescript-eslint/no-explicit-any */
let mod: any;
let templates: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

before(async () => {
  render = (await import("@react-email/render")).render as Render;
  mod = await import("@usemoney/email");
  templates = await import("@usemoney/email/templates");
});

describe("buildListUnsubscribeHeaders (RFC 8058)", () => {
  it("builds the one-click header pair from an HTTPS URL", () => {
    const url =
      "https://usemoney.ai/api/newsletter/unsubscribe?email=a%40b.com&token=xyz";
    const h = mod.buildListUnsubscribeHeaders(url);
    assert.strictEqual(h["List-Unsubscribe"], `<${url}>`);
    assert.strictEqual(
      h["List-Unsubscribe-Post"],
      "List-Unsubscribe=One-Click"
    );
  });

  it("prepends a mailto when provided", () => {
    const h = mod.buildListUnsubscribeHeaders(
      "https://x/y",
      "founder@usemoney.ai"
    );
    assert.strictEqual(
      h["List-Unsubscribe"],
      "<mailto:founder@usemoney.ai>, <https://x/y>"
    );
  });
});

describe("Email theme exports", () => {
  it("SEBI_DISCLAIMER is a non-empty entity-level disclaimer", () => {
    assert.ok(typeof mod.SEBI_DISCLAIMER === "string");
    assert.ok(mod.SEBI_DISCLAIMER.length > 40);
    assert.match(mod.SEBI_DISCLAIMER, /SEBI-registered/i);
  });

  it("SOCIAL_LINKS are the four real accounts over https", () => {
    const labels = mod.SOCIAL_LINKS.map((s: { label: string }) => s.label);
    assert.deepStrictEqual(labels, ["X", "LinkedIn", "YouTube", "Instagram"]);
    for (const s of mod.SOCIAL_LINKS) {
      assert.match(s.href, /^https:\/\//);
    }
  });
});

describe("Rendered chrome — cream theme, dark mode, SEBI", () => {
  it("declares light-only color-scheme; no dark @media (MONEY-887)", async () => {
    const html = await render(
      React.createElement(templates.WelcomeEmail, { name: "Asha" })
    );
    // Dark theme removed (MONEY-887) — emails always render the cream design,
    // because the markdown body inlines colors that can't flip + the logo is a
    // raster PNG. Light-only opt-out keeps it readable in iOS Mail / Gmail.
    assert.doesNotMatch(html, /prefers-color-scheme:\s*dark/);
    assert.match(html, /name="color-scheme"[^>]*content="light"/);
  });

  it("uses emerald, never the removed blue CTA or navy", async () => {
    const html = await render(
      React.createElement(templates.WelcomeEmail, { name: "Asha" })
    );
    assert.match(html, /#16a34a/i); // emerald primary
    assert.doesNotMatch(html, /#2563eb/i); // removed blue CTA
    assert.doesNotMatch(html, /#1a1a2e/i); // removed navy text
  });

  it("footer carries the SEBI disclaimer", async () => {
    const html = await render(
      React.createElement(templates.WelcomeEmail, { name: "Asha" }),
      { plainText: true }
    );
    assert.match(html, /not a SEBI-registered Investment Adviser/i);
  });
});

describe("Per-template chrome rules", () => {
  it("editorial newsletter shows social links + an unsubscribe", async () => {
    const html = await render(
      React.createElement(templates.NewsletterIssueEmail, {
        title: "Weekly digest",
        excerpt: "this week in markets",
        postUrl: "https://usemoney.ai/newsletter/weekly",
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
      })
    );
    assert.match(html, /x\.com\/usemoneyAI/);
    assert.match(html, /unsubscribe/i);
  });

  it("security OTP email renders the code and NO unsubscribe", async () => {
    const html = await render(
      React.createElement(templates.DeleteAccountOtpEmail, {
        name: "Asha",
        otp: "482913",
        expiresInMinutes: 10,
      }),
      { plainText: true }
    );
    assert.match(html, /482913/);
    assert.doesNotMatch(html, /unsubscribe/i);
  });
});

describe("Footer redesign — hosted icons + conditional feedback widget", () => {
  it("renders social text links in the editorial footer", async () => {
    const html = await render(
      React.createElement(templates.NewsletterIssueEmail, {
        title: "Weekly digest",
        excerpt: "markets",
        postUrl: "https://usemoney.ai/newsletter/weekly",
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
      })
    );
    assert.match(html, /x\.com\/usemoneyAI/);
    assert.match(html, /linkedin\.com\/company\/usemoneyai/);
  });

  it("hides the feedback widget app-wide while disabled (MONEY-886)", async () => {
    const html = await render(
      React.createElement(templates.WelcomeEmail, { name: "Asha" }),
      { plainText: true }
    );
    // EMAIL_FEEDBACK_WIDGET_ENABLED = false until /api/email/feedback is fixed.
    assert.doesNotMatch(html, /Was this email useful/i);
  });

  it("omits the feedback widget on negative/security emails (account-deleted)", async () => {
    const html = await render(
      React.createElement(templates.AccountDeletedEmail, { name: "Asha" }),
      { plainText: true }
    );
    assert.doesNotMatch(html, /Was this email useful/i);
  });

  it("renders the brand logo and the AI wordmark", async () => {
    const html = await render(
      React.createElement(templates.WelcomeEmail, { name: "Asha" })
    );
    assert.match(html, /icon-square-192\.png/);
    assert.match(html, /em-ai/);
  });

  it("shows the Ask-AI assistant row + tagline on a normal email", async () => {
    const html = await render(
      React.createElement(templates.WelcomeEmail, { name: "Asha" })
    );
    assert.match(html, /\/email\/ai\/claude\.png/);
    assert.match(html, /Ask AI about UseMoney AI/i);
    // All five assistant brand PNGs render in the footer row.
    for (const name of ["claude", "chatgpt", "perplexity", "gemini", "grok"]) {
      assert.match(html, new RegExp(`/email/ai/${name}\\.png`));
    }
    // New footer tagline carries the serif-italic "Intelligently." accent.
    assert.match(html, /Intelligently\./);
  });

  it("omits the Ask-AI row + tagline on a security email (account-deleted)", async () => {
    const html = await render(
      React.createElement(templates.AccountDeletedEmail, { name: "Asha" })
    );
    // hideSocials gates the entire tagline / socials / Ask-AI block off.
    assert.doesNotMatch(html, /\/email\/ai\/claude\.png/);
    assert.doesNotMatch(html, /Ask AI about UseMoney AI/i);
    assert.doesNotMatch(html, /Intelligently/);
  });
});

describe("Newsletter name personalization", () => {
  it("defaults the greeting to 'Hi there,' with no merge-tag leak", async () => {
    const html = await render(
      React.createElement(templates.NewsletterIssueEmail, {
        title: "Weekly digest",
        excerpt: "markets",
        postUrl: "https://usemoney.ai/newsletter/weekly",
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
      })
    );
    // React SSR inserts <!-- --> between adjacent text segments, so strip
    // comments before matching the assembled "Hi there," greeting.
    assert.match(html.replace(/<!--.*?-->/g, ""), /Hi there,/);
    assert.doesNotMatch(html, /\{\{\{/); // no literal Resend tag ever leaks
  });

  it("carries the Resend first-name merge tag when broadcasting", async () => {
    const html = await render(
      React.createElement(templates.NewsletterIssueEmail, {
        title: "Weekly digest",
        excerpt: "markets",
        // Broadcasts pass the tag; Resend substitutes per-contact at send time.
        firstName: "{{{contact.first_name|there}}}",
        postUrl: "https://usemoney.ai/newsletter/weekly",
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
      })
    );
    assert.match(html, /\{\{\{contact\.first_name\|there\}\}\}/);
  });

  it("greets by the real first name on individual sends", async () => {
    const html = await render(
      React.createElement(templates.NewsletterIssueEmail, {
        title: "Weekly digest",
        excerpt: "markets",
        firstName: "Shaswat",
        postUrl: "https://usemoney.ai/newsletter/weekly",
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
      })
    );
    assert.match(html.replace(/<!--.*?-->/g, ""), /Hi Shaswat,/);
  });

  it("newsletter-verify (individual send) greets by name when provided", async () => {
    const html = await render(
      React.createElement(templates.NewsletterVerifyEmail, {
        verifyUrl: "https://usemoney.ai/api/newsletter/verify?token=x",
        name: "Asha",
      }),
      { plainText: true }
    );
    assert.match(html, /Hi Asha,/);
  });

  it("newsletter-welcome (individual send) greets by name when provided", async () => {
    const html = await render(
      React.createElement(templates.NewsletterWelcomeEmail, {
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
        name: "Rahul",
      }),
      { plainText: true }
    );
    assert.match(html, /in, Rahul\./i); // heading renders uppercased
  });
});

describe("Newsletter Ask-AI — deterministic summarize_post dispatch (MONEY-887)", () => {
  it("dispatches summarize_post by slug (bypasses the classifier), not a free-text prompt", async () => {
    const html = await render(
      React.createElement(templates.NewsletterIssueEmail, {
        title: "Weekly digest",
        excerpt: "markets",
        slug: "weekly-digest",
        postUrl: "https://usemoney.ai/newsletter/weekly-digest",
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
      })
    );
    // React Email encodes `&` as `&amp;` in hrefs; decode before matching.
    const clean = html.replace(/&amp;/g, "&");
    assert.match(clean, /stocksage\?tool=summarize_post/);
    assert.match(clean, /toolParams=/);
    // Slug travels inside the URL-encoded toolParams JSON: {"slug":"weekly-digest"}.
    assert.match(html, /%22slug%22%3A%22weekly-digest%22/);
    // It must NOT fall back to the free-text prompt that collapsed to a
    // generic portfolio summary.
    assert.doesNotMatch(clean, /stocksage\?prompt=Summarise/i);
  });

  it("falls back to the free-text prompt path when no slug is provided", async () => {
    const html = await render(
      React.createElement(templates.NewsletterIssueEmail, {
        title: "Weekly digest",
        excerpt: "markets",
        postUrl: "https://usemoney.ai/newsletter/weekly-digest",
        unsubscribeUrl:
          "https://usemoney.ai/api/newsletter/unsubscribe?email=a&token=b",
      })
    );
    assert.match(html, /stocksage\?prompt=/);
    assert.doesNotMatch(html, /tool=summarize_post/);
  });
});
