import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@usemoney/database";
import type { Metadata } from "next";
import { resolveOgImage } from "@/lib/seo/og-image";
import "./page.css";

interface PageParams {
  slug: string;
}

interface GlossaryTermDetail {
  id: string;
  title: string;
  content: string;
  excerpt: string | null;
  postUrl: string;
  publishDate: Date | null;
  featureImage: string | null;
  metadataTitle: string | null;
  metadataDescription: string | null;
  metadataImageUrl: string | null;
  metadataKeywords: string | null;
  tags: {
    id: string;
    name: string;
    slug: string;
    color: string | null;
  }[];
}

interface RelatedTerm {
  id: string;
  title: string;
  excerpt: string | null;
  postUrl: string;
}

interface AdjacentTerms {
  prev: { title: string; postUrl: string } | null;
  next: { title: string; postUrl: string } | null;
}

async function getGlossaryTerm(
  slug: string
): Promise<GlossaryTermDetail | null> {
  const post = await prisma.post.findFirst({
    where: {
      postUrl: slug,
      contentType: "GLOSSARY",
      contentPlatform: "STOCKBOOK",
      status: "PUBLISHED",
    },
    select: {
      id: true,
      title: true,
      content: true,
      excerpt: true,
      postUrl: true,
      publishDate: true,
      featureImage: true,
      metadataTitle: true,
      metadataDescription: true,
      metadataImageUrl: true,
      metadataKeywords: true,
      tags: {
        include: {
          tag: {
            select: { id: true, name: true, slug: true, color: true },
          },
        },
      },
    },
  });

  if (!post) return null;

  return {
    id: post.id,
    title: post.title,
    content: post.content,
    excerpt: post.excerpt,
    postUrl: post.postUrl,
    publishDate: post.publishDate,
    featureImage: post.featureImage,
    metadataTitle: post.metadataTitle,
    metadataDescription: post.metadataDescription,
    metadataImageUrl: post.metadataImageUrl,
    metadataKeywords: post.metadataKeywords,
    tags: post.tags.map((t) => ({
      id: t.tag.id,
      name: t.tag.name,
      slug: t.tag.slug,
      color: t.tag.color,
    })),
  };
}

async function getRelatedTerms(
  currentId: string,
  tagIds: string[]
): Promise<RelatedTerm[]> {
  if (tagIds.length === 0) return [];
  const relatedPosts = await prisma.post.findMany({
    where: {
      id: { not: currentId },
      contentType: "GLOSSARY",
      contentPlatform: "STOCKBOOK",
      status: "PUBLISHED",
      tags: { some: { tagId: { in: tagIds } } },
    },
    select: { id: true, title: true, excerpt: true, postUrl: true },
    take: 6,
    orderBy: { title: "asc" },
  });
  return relatedPosts;
}

async function getAdjacentTerms(currentTitle: string): Promise<AdjacentTerms> {
  const [prevTerm, nextTerm] = await Promise.all([
    prisma.post.findFirst({
      where: {
        contentType: "GLOSSARY",
        contentPlatform: "STOCKBOOK",
        status: "PUBLISHED",
        title: { lt: currentTitle },
      },
      select: { title: true, postUrl: true },
      orderBy: { title: "desc" },
    }),
    prisma.post.findFirst({
      where: {
        contentType: "GLOSSARY",
        contentPlatform: "STOCKBOOK",
        status: "PUBLISHED",
        title: { gt: currentTitle },
      },
      select: { title: true, postUrl: true },
      orderBy: { title: "asc" },
    }),
  ]);
  return { prev: prevTerm, next: nextTerm };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { slug } = await params;
  const term = await getGlossaryTerm(slug);
  if (!term) return { title: "Term Not Found · Glossary" };

  const title = term.metadataTitle || `${term.title} · Glossary`;
  const description =
    term.metadataDescription ||
    term.excerpt ||
    `Learn the definition of ${term.title} in our financial glossary.`;
  // metadataImageUrl → featureImage → site default, always absolute.
  const imageUrl = resolveOgImage(term);

  return {
    title,
    description,
    keywords: term.metadataKeywords || undefined,
    openGraph: {
      title,
      description,
      type: "article",
      url: `https://usemoney.ai/glossary/${term.postUrl}`,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: title }],
      publishedTime: term.publishDate
        ? new Date(term.publishDate).toISOString()
        : undefined,
    },
    twitter: {
      card: "summary_large_image" as const,
      title,
      description,
      images: [imageUrl],
    },
    alternates: {
      canonical: `https://usemoney.ai/glossary/${term.postUrl}`,
    },
  };
}

// BlockNote → React nodes. Renders the same subset we care about
// (paragraph, heading L1-3, bullet + numbered lists, inline text + links).
// No HTML strings → no dangerouslySetInnerHTML → no XSS surface.
type InlineContent = {
  type?: string;
  text?: string;
  content?: InlineContent[];
  href?: string;
};
type Block = {
  type?: string;
  content?: InlineContent[];
  props?: { level?: number };
};

function sanitizeHref(href: string): string {
  if (!href) return "#";
  try {
    const url = new URL(href, "https://usemoney.ai");
    if (url.protocol === "javascript:") return "#";
    return href;
  } catch {
    return href.startsWith("/") ? href : "#";
  }
}

function renderInline(
  inline: InlineContent[],
  keyPrefix: string
): React.ReactNode[] {
  return inline.map((item, i) => {
    const key = `${keyPrefix}-${i}`;
    if (item.type === "text") {
      return <span key={key}>{item.text || ""}</span>;
    }
    if (item.type === "link" && item.content) {
      return (
        <a
          key={key}
          href={sanitizeHref(item.href || "#")}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderInline(item.content, key)}
        </a>
      );
    }
    return null;
  });
}

function renderBlocks(content: string): React.ReactNode {
  let blocks: Block[];
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return <p>{content}</p>;
    blocks = parsed as Block[];
  } catch {
    return <p>{content}</p>;
  }

  const nodes: React.ReactNode[] = [];
  let listBuf: React.ReactNode[] = [];
  let listKind: "ul" | "ol" | null = null;

  const flushList = () => {
    if (listKind === "ul") {
      nodes.push(<ul key={`l-${nodes.length}`}>{listBuf}</ul>);
    } else if (listKind === "ol") {
      nodes.push(<ol key={`l-${nodes.length}`}>{listBuf}</ol>);
    }
    listBuf = [];
    listKind = null;
  };

  blocks.forEach((block, i) => {
    const inline = block.content || [];
    const key = `b-${i}`;

    if (block.type === "bulletListItem") {
      if (listKind !== "ul") flushList();
      listKind = "ul";
      listBuf.push(<li key={key}>{renderInline(inline, key)}</li>);
      return;
    }
    if (block.type === "numberedListItem") {
      if (listKind !== "ol") flushList();
      listKind = "ol";
      listBuf.push(<li key={key}>{renderInline(inline, key)}</li>);
      return;
    }

    flushList();

    if (block.type === "paragraph") {
      nodes.push(<p key={key}>{renderInline(inline, key)}</p>);
    } else if (block.type === "heading") {
      const level = Math.min(Math.max(block.props?.level || 1, 1), 3);
      const inner = renderInline(inline, key);
      if (level === 1) nodes.push(<h1 key={key}>{inner}</h1>);
      else if (level === 2) nodes.push(<h2 key={key}>{inner}</h2>);
      else nodes.push(<h3 key={key}>{inner}</h3>);
    }
  });

  flushList();
  return nodes;
}

export default async function GlossaryTermPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { slug } = await params;
  const term = await getGlossaryTerm(slug);
  if (!term) notFound();

  const [relatedTerms, adjacentTerms] = await Promise.all([
    getRelatedTerms(
      term.id,
      term.tags.map((t) => t.id)
    ),
    getAdjacentTerms(term.title),
  ]);

  const firstChar = term.title.charAt(0);
  const letter = /\d/.test(firstChar) ? "#" : firstChar.toUpperCase();

  return (
    <section className="section" style={{ padding: "60px 0" }}>
      <div className="container-narrow">
        <Link href="/glossary" className="term-back">
          ← Back to Glossary
        </Link>

        <div className="term-header">
          <span className="L">{letter}</span>
          <h1>{term.title}</h1>
        </div>

        {term.tags.length > 0 && (
          <div className="term-tags">
            {term.tags.map((tag) => (
              <span key={tag.id} className="tag-pill">
                {tag.name}
              </span>
            ))}
          </div>
        )}

        <article className="term-def">
          <div className="prose">{renderBlocks(term.content)}</div>
        </article>

        <nav className="term-nav">
          {adjacentTerms.prev ? (
            <Link href={`/glossary/${adjacentTerms.prev.postUrl}`}>
              <div className="lbl">← Previous</div>
              <div className="nm">{adjacentTerms.prev.title}</div>
            </Link>
          ) : (
            <div />
          )}
          {adjacentTerms.next ? (
            <Link
              href={`/glossary/${adjacentTerms.next.postUrl}`}
              style={{ textAlign: "right" }}
            >
              <div className="lbl">Next →</div>
              <div className="nm">{adjacentTerms.next.title}</div>
            </Link>
          ) : (
            <div />
          )}
        </nav>

        {relatedTerms.length > 0 && (
          <>
            <h2 className="related-h">
              <span className="ser">Related</span> terms
            </h2>
            <div className="related-grid">
              {relatedTerms.map((r) => (
                <Link key={r.id} href={`/glossary/${r.postUrl}`}>
                  <div className="t">{r.title}</div>
                  {r.excerpt && <p>{r.excerpt}</p>}
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
