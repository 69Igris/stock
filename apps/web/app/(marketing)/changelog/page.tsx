import "./page.css";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingAuthCta } from "../MarketingAuthCta";
import {
  GROUP_LABELS,
  PAGE_SIZE,
  RELEASES,
  type Release,
  type ReleaseGroup,
} from "./releases";

export const metadata: Metadata = {
  title: "Changelog · UseMoney AI",
  description:
    "What we actually shipped this week. A bootstrapped, solo-founder beta in public.",
  alternates: { canonical: "https://usemoney.ai/changelog" },
};

interface SearchParams {
  page?: string;
}

/**
 * Clamp a possibly-bogus page query to the valid range so the marketing page
 * never 404s on a stale link. `?page=99` on a 2-page list just shows page 2.
 */
function parsePage(raw: string | undefined, totalPages: number): number {
  const n = parseInt(raw || "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > totalPages) return totalPages;
  return n;
}

function ReleaseGroupBlock({ group }: { group: ReleaseGroup }) {
  const label = group.label ?? GROUP_LABELS[group.type];
  return (
    <div className="change-group">
      <h4 className={group.type}>{label}</h4>
      <ul>
        {group.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function ReleaseCard({ release }: { release: Release }) {
  return (
    <article className="release" id={release.id}>
      <div className="meta">
        <div className="ver">
          {release.verPrimary}
          {release.verSerif ? (
            <span className="ser">{release.verSerif}</span>
          ) : null}
        </div>
        <div className="date">{release.date}</div>
        <span className={`tag ${release.tag.variant}`}>
          {release.tag.label}
        </span>
      </div>
      <div className="body">
        <h3>{release.title}</h3>
        <p className="intro">{release.intro}</p>
        {release.groups.map((group, i) => (
          <ReleaseGroupBlock key={i} group={group} />
        ))}
      </div>
    </article>
  );
}

/**
 * Server-rendered pagination footer. Mirrors the /blog footer style — same
 * mono font, same arrow glyphs — so the two surfaces feel like siblings.
 */
function Pagination({
  page,
  pages,
  total,
}: {
  page: number;
  pages: number;
  total: number;
}): ReactNode {
  if (pages <= 1) return null;
  return (
    <div className="changelog-pagination">
      {page > 1 ? (
        <Link className="btn-flat" href={`/changelog?page=${page - 1}`}>
          ← Previous
        </Link>
      ) : (
        <span className="spacer" />
      )}
      <span className="status">
        Page {page} of {pages} · {total} releases
      </span>
      {page < pages ? (
        <Link className="btn-flat" href={`/changelog?page=${page + 1}`}>
          Next →
        </Link>
      ) : (
        <span className="spacer" />
      )}
    </div>
  );
}

export default async function ChangelogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const total = RELEASES.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = parsePage(params.page, pages);

  const start = (page - 1) * PAGE_SIZE;
  const pageReleases = RELEASES.slice(start, start + PAGE_SIZE);

  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            Changelog · updated weekly
          </div>
          <h1>
            What we <span className="ser">actually</span>{" "}
            <span className="hl">shipped.</span>
          </h1>
          <p className="lede">
            Updated weekly. No quarterly roadmaps.{" "}
            <b>
              No &quot;coming soon&quot; · only &quot;shipped&quot; and &quot;in
              progress.&quot;
            </b>
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container-narrow">
          <div className="rss-bar">
            <div className="left">
              <b>Continuous releases</b> · always free to read
            </div>
            <div className="right">
              <a href="/blog">Blog</a>
              <Link href="/about">About</Link>
            </div>
          </div>

          {pageReleases.map((release) => (
            <ReleaseCard key={release.id} release={release} />
          ))}

          <Pagination page={page} pages={pages} total={total} />
        </div>
      </section>

      <section className="big-cta">
        <div className="container">
          <h2>
            Want to know <span className="hl">what&apos;s next?</span>
          </h2>
          <p>We ship every week and share it here. Come see for yourself.</p>
          <div className="cta-row">
            <MarketingAuthCta />
            <Link className="btn-flat" href="/about">
              About the founder →
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
