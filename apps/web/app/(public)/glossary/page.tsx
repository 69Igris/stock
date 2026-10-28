import Link from "next/link";
import { prisma } from "@usemoney/database";
import "./page.css";

export const metadata = {
  title: "Financial Glossary",
  description:
    "132 terms across Indian stock markets, mutual funds, F&O, FIRE planning, and tax. Ask StockSage about any of these in the context of your portfolio.",
  keywords:
    "financial glossary, stock market terms, trading terminology, investment definitions, finance dictionary",
  openGraph: {
    title: "Financial Glossary - UseMoney",
    description:
      "132 terms across Indian stock markets, mutual funds, F&O, FIRE planning, and tax. Ask StockSage about any of these in the context of your portfolio.",
    type: "website",
    url: "https://usemoney.ai/glossary",
    images: [
      {
        url: "/og-website.png",
        width: 1200,
        height: 630,
        alt: "UseMoney Financial Glossary",
      },
    ],
  },
  twitter: {
    card: "summary_large_image" as const,
    title: "Financial Glossary - UseMoney",
    description:
      "Comprehensive glossary of stock market, trading, and investment terminology.",
    images: ["/og-website.png"],
  },
  alternates: {
    canonical: "https://usemoney.ai/glossary",
  },
};

interface GlossaryTerm {
  id: string;
  title: string;
  excerpt: string | null;
  postUrl: string;
  letter: string;
}

interface SearchParams {
  q?: string;
}

async function getGlossaryTerms(
  searchQuery?: string
): Promise<Map<string, GlossaryTerm[]>> {
  const posts = await prisma.post.findMany({
    where: {
      contentType: "GLOSSARY",
      contentPlatform: "STOCKBOOK",
      status: "PUBLISHED",
      ...(searchQuery && {
        OR: [
          { title: { contains: searchQuery, mode: "insensitive" } },
          { excerpt: { contains: searchQuery, mode: "insensitive" } },
        ],
      }),
    },
    select: { id: true, title: true, excerpt: true, postUrl: true },
    orderBy: { title: "asc" },
  });

  const grouped = new Map<string, GlossaryTerm[]>();
  posts.forEach((post) => {
    const firstChar = post.title.charAt(0).toUpperCase();
    const letter = /\d/.test(firstChar) ? "#" : firstChar;
    if (!grouped.has(letter)) grouped.set(letter, []);
    grouped.get(letter)!.push({
      id: post.id,
      title: post.title,
      excerpt: post.excerpt,
      postUrl: post.postUrl,
      letter,
    });
  });

  return grouped;
}

export default async function GlossaryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const searchQuery = params.q || undefined;
  const grouped = await getGlossaryTerms(searchQuery);
  const letters = Array.from(grouped.keys()).sort((a, b) => {
    if (a === "#") return -1;
    if (b === "#") return 1;
    return a.localeCompare(b);
  });
  const allLetters = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];
  const totalTerms = Array.from(grouped.values()).reduce(
    (acc, terms) => acc + terms.length,
    0
  );

  return (
    <>
      <section className="page-head">
        <div className="container">
          <div className="eyebrow">
            <span className="d" />
            {totalTerms} terms · NSE &amp; BSE first
          </div>
          <h1>
            Financial <span className="ser">glossary.</span>{" "}
            <span className="hl">Indian markets,</span> in plain English.
          </h1>
          <p className="lede">
            Indian-market-first definitions. Ask StockSage about any of these in
            the context of what you actually own.
          </p>

          {/* Search */}
          <form className="glos-search" action="/glossary" method="get">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="search"
              name="q"
              defaultValue={searchQuery || ""}
              placeholder="Search terms — XIRR, STCG, LTP, …"
              style={{
                flex: 1,
                border: 0,
                background: "transparent",
                font: "inherit",
                fontSize: 15,
                outline: 0,
                color: "var(--ink)",
              }}
            />
            <span className="count">{totalTerms} terms</span>
          </form>

          {/* A-Z jumper */}
          <div className="az">
            {allLetters.map((L) => {
              const has = grouped.has(L);
              return has ? (
                <a key={L} href={`#letter-${L}`}>
                  {L}
                </a>
              ) : (
                <a key={L} className="empty">
                  {L}
                </a>
              );
            })}
          </div>
        </div>
      </section>

      <section className="section" style={{ padding: "40px 0" }}>
        <div className="container">
          {letters.length === 0 ? (
            <div className="glos-empty">
              <p>
                {searchQuery
                  ? `No results for “${searchQuery}”.`
                  : "Glossary terms will appear here once published."}
              </p>
              {searchQuery && <Link href="/glossary">← clear search</Link>}
            </div>
          ) : (
            letters.map((letter) => (
              <div
                key={letter}
                id={`letter-${letter}`}
                className="letter-block"
              >
                <div className="head">
                  <span className="L">{letter}</span>
                  <span className="meta">
                    {grouped.get(letter)!.length} term
                    {grouped.get(letter)!.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="term-grid">
                  {grouped.get(letter)!.map((term) => (
                    <Link
                      key={term.id}
                      href={`/glossary/${term.postUrl}`}
                      className="term"
                    >
                      <div className="t">{term.title}</div>
                      {term.excerpt && <p>{term.excerpt}</p>}
                    </Link>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}
