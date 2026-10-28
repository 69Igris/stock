"use client";

import type { TextBlock } from "@usemoney/types";
import ReactMarkdown from "react-markdown";
import Link from "next/link";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import "./chat-blocks.css";

interface TextBlockRendererProps {
  block: TextBlock;
}

export default function TextBlockRenderer({ block }: TextBlockRendererProps) {
  // MONEY-457: scrub SEBI-restricted recommendation language from chat prose.
  const safeContent = stripRecommendationLanguage(block.content);
  return (
    <div className="cb-text">
      <ReactMarkdown
        components={{
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul>{children}</ul>,
          ol: ({ children }) => <ol>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong>{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          code: ({ children }) => <code>{children}</code>,
          pre: ({ children }) => <pre>{children}</pre>,
          a: ({ href, children }) => <Link href={href || "#"}>{children}</Link>,
          hr: () => <hr />,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
        }}
      >
        {safeContent}
      </ReactMarkdown>
    </div>
  );
}
