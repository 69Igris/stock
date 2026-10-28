import Link from "next/link";
import {
  getFeaturedBlogPostsAction,
  getBlogPostsAction,
  getTagsAction,
} from "@/lib/actions/content";
import type { PostListItem } from "@usemoney/types";
import { BlogNewsletterCard } from "@/components/content/NewsletterSubscribe";
import "./page.css";

export const metadata = {
  title: "Blog",
  description:
    "Long reads on Indian markets, the product, and the occasional rant about ITR forms.",
  alternates: { canonical: "https://usemoney.ai/blog" },
  openGraph: {
    title: "Blog · UseMoney",
    description:
      "Long reads on Indian markets, the product, and the occasional rant about ITR forms.",
    type: "website",
    url: "https://usemoney.ai/blog",
    images: [
      {
        url: "/og-website.png",
        width: 1200,
        height: 630,
        alt: "UseMoney Blog",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog · UseMoney",
    description:
      "Long reads on Indian markets, the product, and the occasional rant about ITR forms.",
    images: ["/og-website.png"],
  },
};

interface SearchParams {
  page?: string;
  search?: string;
  tag?: string;
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

export default async function BlogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const page = parseInt(params.page || "1", 10);
  const search = params.search || undefined;
  const tagSlug = params.tag || undefined;

  const [{ posts, total, pages }, featuredPosts, tags] = await Promise.all([
    getBlogPostsAction({ page, limit: 9, search, tagSlug }),
    page === 1 && !search && !tagSlug
      ? getFeaturedBlogPostsAction(1)
      : Promise.resolve([] as PostListItem[]),
    getTagsAction(),
  ]);

  const featured = featuredPosts[0];
  // If the featured post is already in the paginated list, dedupe.
  const gridPosts = featured
    ? posts.filter((p) => p.id !== featured.id)
    : posts;

  const tagOptions = tags
    .filter((t) => t.name)
    .slice(0, 6)
    .map((t) => ({ slug: t.slug, name: t.name }));

  const isEmpty = posts.length === 0 && !featured;

  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Blog · long reads on Indian markets &amp; the product
          </div>
          <h1>
            Notes on the market, the product, and the{" "}
            <span className="hl">occasional rant.</span>
          </h1>
          <p className="lede">
            We write about what&apos;s actually moving in NSE/BSE, what
            we&apos;re building, and what we&apos;re learning.{" "}
            <b>No SEO filler</b> — just the kind of long read we&apos;d want to
            read.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          {(tagOptions.length > 0 || tagSlug) && (
            <div className="filter-row">
              <Link href="/blog" className={!tagSlug ? "on" : undefined}>
                All
              </Link>
              {tagOptions.map((t) => (
                <Link
                  key={t.slug}
                  href={`/blog?tag=${encodeURIComponent(t.slug)}`}
                  className={tagSlug === t.slug ? "on" : undefined}
                >
                  {t.name}
                </Link>
              ))}
            </div>
          )}

          {featured && (
            <article className="feat-post">
              <Link
                href={`/blog/${featured.postUrl}`}
                className="img"
                aria-label={featured.title}
              >
                <span className="tag">
                  🔥 FEATURED · {readMinutes(featured)} MIN
                </span>
                <svg
                  viewBox="0 0 400 240"
                  preserveAspectRatio="none"
                  width="100%"
                  height="100%"
                  style={{ display: "block" }}
                >
                  <defs>
                    <linearGradient id="bgfg" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
                    </linearGradient>
                    <pattern
                      id="bgg"
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
                  <rect width="400" height="240" fill="url(#bgg)" />
                  <path
                    d="M0,180 L20,176 L40,184 L60,168 L80,172 L100,158 L120,162 L140,150 L160,154 L180,140 L200,144 L220,128 L240,132 L260,118 L280,108 L300,98 L320,82 L340,72 L360,56 L380,42 L400,30 L400,240 L0,240 Z"
                    fill="url(#bgfg)"
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
                  {featured.tags[0]?.name || "Featured"} ·{" "}
                  {readMinutes(featured)} min
                </div>
                <h2>
                  <Link href={`/blog/${featured.postUrl}`}>
                    {featured.title}
                  </Link>
                </h2>
                {featured.excerpt && <p>{featured.excerpt}</p>}
                <Link href={`/blog/${featured.postUrl}`} className="read-more">
                  Read the long read →
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
              {gridPosts.map((post) => (
                <Link
                  key={post.id}
                  href={`/blog/${post.postUrl}`}
                  className="post-card"
                >
                  <div className="cat">{post.tags[0]?.name || "Post"}</div>
                  <h3>{post.title}</h3>
                  {post.excerpt && <p>{post.excerpt}</p>}
                  <div className="meta">
                    {post.tags[0]?.name || "Post"} · {fmtDate(post.publishDate)}{" "}
                    · {readMinutes(post)} min
                  </div>
                </Link>
              ))}
            </div>
          ) : isEmpty ? (
            <div className="blog-empty">
              {search ? (
                <p>{`No posts matching "${search}".`}</p>
              ) : (
                <>
                  <p>
                    Building in public. Three posts shipping over the next two
                    weeks:
                  </p>
                  <ol>
                    <li>
                      Why we stopped leading with &ldquo;every broker&rdquo;
                      (and what we lead with now)
                    </li>
                    <li>
                      Walk-forward backtesting, explained without the math
                      degree
                    </li>
                    <li>
                      The pre-RIA period — what we can and cannot say, and why
                      we&apos;re fine with that
                    </li>
                  </ol>
                  <p>
                    Want them in your inbox the day they ship? Subscribe →{" "}
                    <Link href="/newsletter">/newsletter</Link>
                  </p>
                </>
              )}
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
                  href={`/blog?page=${page - 1}${tagSlug ? `&tag=${tagSlug}` : ""}${
                    search ? `&search=${encodeURIComponent(search)}` : ""
                  }`}
                >
                  ← Previous
                </Link>
              )}
              <span style={{ padding: "9px 14px", color: "var(--ink-3)" }}>
                Page {page} of {pages} · {total} posts
              </span>
              {page < pages && (
                <Link
                  className="btn-flat"
                  href={`/blog?page=${page + 1}${tagSlug ? `&tag=${tagSlug}` : ""}${
                    search ? `&search=${encodeURIComponent(search)}` : ""
                  }`}
                >
                  Next →
                </Link>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="section" style={{ background: "var(--paper-2)" }}>
        <div className="container-narrow">
          <BlogNewsletterCard />
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            Reading is good. <span className="hl">Trading</span>
            <br />
            is <span className="ser">better.</span>
          </h2>
          <p>
            Connect a broker in 60 seconds and put what you&apos;ve read to
            work.
          </p>
          <div className="cta-row">
            <Link className="btn-solid" href="/sign-up">
              Start free →
            </Link>
            <Link className="btn-flat" href="/features">
              See features
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
