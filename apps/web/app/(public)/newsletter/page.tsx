import Link from "next/link";
import { Metadata } from "next";
import { getNewslettersAction } from "@/lib/actions/content";
import type { PostListItem } from "@usemoney/types";
// MONEY-1051 — reuse the blog list page's editorial (Playful) styles as the
// single source of truth for the shared list design (.feat-post / .post-grid /
// .post-card / .blog-empty). The global page-head / section / container / .hl
// classes load site-wide on the (public) route group, so no extra import.
import "../blog/page.css";

export const metadata: Metadata = {
  title: "Newsletter Archive",
  description:
    "Stay updated with UseMoney newsletters - market insights, trading strategies, and portfolio management tips for Indian investors.",
  keywords:
    "newsletter, market insights, trading strategies, portfolio management, Indian investors",
  openGraph: {
    title: "Newsletter Archive - UseMoney",
    description:
      "Stay updated with UseMoney newsletters - market insights, trading strategies, and portfolio management tips for Indian investors.",
    type: "website",
    url: "https://usemoney.ai/newsletter",
    images: [
      {
        url: "/og-website.png",
        width: 1200,
        height: 630,
        alt: "UseMoney Newsletter",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Newsletter Archive - UseMoney",
    description:
      "Stay updated with UseMoney newsletters - market insights, trading strategies, and portfolio management tips for Indian investors.",
    images: ["/og-website.png"],
  },
  alternates: {
    canonical: "https://usemoney.ai/newsletter",
  },
};

const ITEMS_PER_PAGE = 9;

interface NewsletterPageProps {
  searchParams: Promise<{ page?: string; tag?: string }>;
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

function readMinutes(post: PostListItem): number {
  const words = (post.excerpt || "").split(/\s+/).filter(Boolean).length;
  return Math.max(3, Math.min(15, Math.round(words / 50)));
}

function initials(name: string | null | undefined, fallback = "UM"): string {
  if (!name) return fallback;
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

export default async function NewsletterArchivePage({
  searchParams,
}: NewsletterPageProps) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10));
  const tag = params.tag || undefined;

  const { posts, total, pages } = await getNewslettersAction({
    page,
    limit: ITEMS_PER_PAGE,
    tagSlug: tag,
  });

  // There's no featured-newsletter flag/action, so promote the latest issue to
  // the hero on the first (unfiltered) page; the rest fill the grid.
  const featured = page === 1 && !tag ? posts[0] : undefined;
  const gridPosts = featured ? posts.slice(1) : posts;
  const isEmpty = posts.length === 0;

  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Newsletter · what we send subscribers, archived
          </div>
          <h1>
            Market notes, straight to your <span className="hl">inbox.</span>
          </h1>
          <p className="lede">
            Insights on NSE &amp; BSE, trading strategy, and portfolio
            management — the same issues our subscribers get, kept here as an
            archive.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          {featured && (
            <article className="feat-post">
              <Link
                href={`/newsletter/${featured.postUrl}`}
                className="img"
                aria-label={featured.title}
              >
                <span className="tag">
                  📬 LATEST · {readMinutes(featured)} MIN
                </span>
                <svg
                  viewBox="0 0 400 240"
                  preserveAspectRatio="none"
                  width="100%"
                  height="100%"
                  style={{ display: "block" }}
                >
                  <defs>
                    <linearGradient id="nlfg" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
                    </linearGradient>
                    <pattern
                      id="nlg"
                      width="40"
                      height="40"
                      patternUnits="userSpaceOnUse"
                    >
                      <path
                        d="M40 0H0V40"
                        fill="none"
                        stroke="rgba(255,255,255,0.05)"
                      />
                    </pattern>
                  </defs>
                  <rect width="400" height="240" fill="url(#nlg)" />
                  <path
                    d="M0,180 L20,176 L40,184 L60,168 L80,172 L100,158 L120,162 L140,150 L160,154 L180,140 L200,144 L220,128 L240,132 L260,118 L280,108 L300,98 L320,82 L340,72 L360,56 L380,42 L400,30 L400,240 L0,240 Z"
                    fill="url(#nlfg)"
                  />
                  <path
                    d="M0,180 L20,176 L40,184 L60,168 L80,172 L100,158 L120,162 L140,150 L160,154 L180,140 L200,144 L220,128 L240,132 L260,118 L280,108 L300,98 L320,82 L340,72 L360,56 L380,42 L400,30"
                    fill="none"
                    stroke="#34d399"
                    strokeWidth="1.8"
                  />
                </svg>
              </Link>
              <div className="body">
                <div className="cat">
                  {featured.tags[0]?.name || "Latest issue"} ·{" "}
                  {readMinutes(featured)} min
                </div>
                <h2>
                  <Link href={`/newsletter/${featured.postUrl}`}>
                    {featured.title}
                  </Link>
                </h2>
                {featured.excerpt && <p>{featured.excerpt}</p>}
                <Link
                  href={`/newsletter/${featured.postUrl}`}
                  className="read-more"
                >
                  Read this issue →
                </Link>
                <div className="meta">
                  <div className="avi">{initials(featured.author?.name)}</div>
                  <div className="info">
                    <b>{featured.author?.name || "UseMoney team"}</b>
                    <br />
                    {fmtDate(featured.publishDate)}
                  </div>
                </div>
              </div>
            </article>
          )}

          {gridPosts.length > 0 ? (
            <div className="post-grid">
              {gridPosts.map((newsletter) => (
                <Link
                  key={newsletter.id}
                  href={`/newsletter/${newsletter.postUrl}`}
                  className="post-card"
                >
                  <div className="cat">
                    {newsletter.tags[0]?.name || "Newsletter"}
                  </div>
                  <h3>{newsletter.title}</h3>
                  {newsletter.excerpt && <p>{newsletter.excerpt}</p>}
                  <div className="meta">
                    {newsletter.tags[0]?.name || "Newsletter"} ·{" "}
                    {fmtDate(newsletter.publishDate)} ·{" "}
                    {readMinutes(newsletter)} min
                  </div>
                </Link>
              ))}
            </div>
          ) : isEmpty ? (
            <div className="blog-empty">
              <p>
                {tag
                  ? `No newsletters tagged "${tag}" yet.`
                  : "No newsletters published yet. Check back soon!"}
              </p>
            </div>
          ) : null}

          {pages > 1 && (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: 8,
                marginTop: 40,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
              }}
            >
              {page > 1 && (
                <Link
                  className="btn-flat"
                  href={`/newsletter?page=${page - 1}${tag ? `&tag=${tag}` : ""}`}
                >
                  ← Previous
                </Link>
              )}
              <span style={{ padding: "9px 14px", color: "var(--ink-3)" }}>
                Page {page} of {pages} · {total}{" "}
                {total === 1 ? "newsletter" : "newsletters"}
              </span>
              {page < pages && (
                <Link
                  className="btn-flat"
                  href={`/newsletter?page=${page + 1}${tag ? `&tag=${tag}` : ""}`}
                >
                  Next →
                </Link>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
