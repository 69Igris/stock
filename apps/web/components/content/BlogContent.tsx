"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

// BlockNote block types
interface BlockNoteBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: BlockNoteInlineContent[];
  children?: BlockNoteBlock[];
}

interface BlockNoteInlineContent {
  type: "text" | "link";
  text?: string;
  href?: string;
  content?: BlockNoteInlineContent[];
  styles?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    textColor?: string;
    backgroundColor?: string;
  };
}

interface BlogContentProps {
  content: string;
}

// Reading progress bar component
function ReadingProgressBar() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      const windowHeight = window.innerHeight;
      const documentHeight = document.documentElement.scrollHeight;
      const scrollTop = window.scrollY;
      const scrollableHeight = documentHeight - windowHeight;

      if (scrollableHeight > 0) {
        const scrollProgress = (scrollTop / scrollableHeight) * 100;
        setProgress(Math.min(100, Math.max(0, scrollProgress)));
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll(); // Initialize

    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div className="fixed top-0 left-0 right-0 h-1 bg-muted z-50">
      <div
        className="h-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-150"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

// Render inline content with styles
function renderInlineContent(
  content: BlockNoteInlineContent[]
): React.ReactNode {
  return content.map((item, index) => {
    if (item.type === "text") {
      let element: React.ReactNode = item.text || "";
      const styles = item.styles || {};

      if (styles.code) {
        element = (
          <code className="px-1.5 py-0.5 bg-muted rounded text-blue-400 font-mono text-sm">
            {element}
          </code>
        );
      }
      if (styles.bold) {
        element = <strong className="font-semibold">{element}</strong>;
      }
      if (styles.italic) {
        element = <em>{element}</em>;
      }
      if (styles.underline) {
        element = <u>{element}</u>;
      }
      if (styles.strikethrough) {
        element = <s className="text-muted-foreground">{element}</s>;
      }

      return <span key={index}>{element}</span>;
    }

    if (item.type === "link") {
      return (
        <a
          key={index}
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-400 hover:text-cyan-300 underline underline-offset-2 decoration-cyan-400/30 hover:decoration-cyan-400/60 transition-colors"
        >
          {item.content ? renderInlineContent(item.content) : item.text}
        </a>
      );
    }

    return null;
  });
}

// Render a single block
function renderBlock(block: BlockNoteBlock, index: number): React.ReactNode {
  const props = block.props || {};
  const content = block.content || [];
  const children = block.children || [];

  switch (block.type) {
    case "paragraph":
      if (content.length === 0) {
        return <div key={block.id} className="h-4" />;
      }
      return (
        <p key={block.id} className="text-foreground/80 leading-relaxed mb-4">
          {renderInlineContent(content)}
        </p>
      );

    case "heading":
      const level = (props.level as number) || 1;
      const HeadingTag = `h${level}` as keyof JSX.IntrinsicElements;
      const headingClasses = {
        1: "text-3xl font-bold text-foreground mt-8 mb-4",
        2: "text-2xl font-semibold text-foreground mt-6 mb-3",
        3: "text-xl font-semibold text-foreground mt-5 mb-2",
      };
      return (
        <HeadingTag
          key={block.id}
          className={headingClasses[level as 1 | 2 | 3] || headingClasses[3]}
        >
          {renderInlineContent(content)}
        </HeadingTag>
      );

    case "bulletListItem":
      return (
        <li key={block.id} className="text-foreground/80 mb-1">
          {renderInlineContent(content)}
          {children.length > 0 && (
            <ul className="list-disc list-inside ml-4 mt-1">
              {children.map((child, childIndex) =>
                renderBlock(child, childIndex)
              )}
            </ul>
          )}
        </li>
      );

    case "numberedListItem":
      return (
        <li key={block.id} className="text-foreground/80 mb-1">
          {renderInlineContent(content)}
          {children.length > 0 && (
            <ol className="list-decimal list-inside ml-4 mt-1">
              {children.map((child, childIndex) =>
                renderBlock(child, childIndex)
              )}
            </ol>
          )}
        </li>
      );

    case "checkListItem":
      const checked = props.checked as boolean;
      return (
        <li
          key={block.id}
          className="flex items-start gap-2 text-foreground/80 mb-1"
        >
          <span
            className={`mt-1 ${checked ? "text-green-500" : "text-muted-foreground"}`}
          >
            {checked ? "[x]" : "[ ]"}
          </span>
          <span className={checked ? "line-through text-muted-foreground" : ""}>
            {renderInlineContent(content)}
          </span>
        </li>
      );

    case "codeBlock":
      const language = (props.language as string) || "";
      return (
        <div key={block.id} className="mb-4">
          {language && (
            <div className="bg-card px-4 py-2 rounded-t-lg border border-b-0 border-border">
              <span className="text-xs text-muted-foreground uppercase">
                {language}
              </span>
            </div>
          )}
          <pre
            className={`bg-card p-4 overflow-x-auto border border-border ${
              language ? "rounded-b-lg" : "rounded-lg"
            }`}
          >
            <code className="text-sm font-mono text-foreground/80">
              {content.map((item) => item.text).join("")}
            </code>
          </pre>
        </div>
      );

    case "image":
      const imageUrl = props.url as string;
      const imageCaption = props.caption as string;
      const imageWidth = props.previewWidth as number;

      if (!imageUrl) return null;

      return (
        <figure key={block.id} className="mb-6">
          <div className="relative w-full overflow-hidden rounded-lg">
            <Image
              src={imageUrl}
              alt={imageCaption || "Blog image"}
              width={imageWidth || 800}
              height={400}
              className="w-full h-auto object-cover"
              unoptimized={imageUrl.startsWith("http")}
            />
          </div>
          {imageCaption && (
            <figcaption className="text-center text-sm text-muted-foreground mt-2">
              {imageCaption}
            </figcaption>
          )}
        </figure>
      );

    case "video":
      const videoUrl = props.url as string;
      const videoCaption = props.caption as string;

      // Check if it's a YouTube URL
      const youtubeMatch = videoUrl?.match(
        /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
      );

      if (youtubeMatch) {
        const videoId = youtubeMatch[1];
        return (
          <figure key={block.id} className="mb-6">
            <div className="relative w-full aspect-video rounded-lg overflow-hidden">
              <iframe
                src={`https://www.youtube.com/embed/${videoId}`}
                title={videoCaption || "YouTube video"}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="absolute inset-0 w-full h-full"
              />
            </div>
            {videoCaption && (
              <figcaption className="text-center text-sm text-muted-foreground mt-2">
                {videoCaption}
              </figcaption>
            )}
          </figure>
        );
      }

      // Regular video
      if (videoUrl) {
        return (
          <figure key={block.id} className="mb-6">
            <video src={videoUrl} controls className="w-full rounded-lg" />
            {videoCaption && (
              <figcaption className="text-center text-sm text-muted-foreground mt-2">
                {videoCaption}
              </figcaption>
            )}
          </figure>
        );
      }
      return null;

    case "youtube":
      // Custom YouTube block from BlockNote schema
      const ytUrl = props.url as string;
      if (ytUrl) {
        return (
          <figure key={block.id} className="mb-6">
            <div className="relative w-full aspect-video rounded-lg overflow-hidden">
              <iframe
                src={ytUrl}
                title="YouTube video"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="absolute inset-0 w-full h-full"
              />
            </div>
          </figure>
        );
      }
      // Empty YouTube block - skip silently
      return null;

    case "table":
      const tableContent = props.content as {
        type: string;
        text: string;
      }[][][];
      if (!tableContent || !Array.isArray(tableContent)) return null;

      return (
        <div key={block.id} className="mb-6 overflow-x-auto">
          <table className="w-full border-collapse border border-border rounded-lg">
            <tbody>
              {tableContent.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex === 0 ? "bg-muted" : ""}>
                  {row.map((cell, cellIndex) => {
                    const CellTag = rowIndex === 0 ? "th" : "td";
                    return (
                      <CellTag
                        key={cellIndex}
                        className={`border border-border px-4 py-2 text-foreground/80 ${
                          rowIndex === 0 ? "font-semibold text-foreground" : ""
                        }`}
                      >
                        {cell.map((item) => item.text).join("")}
                      </CellTag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "blockquote":
    case "quote":
      return (
        <blockquote
          key={block.id}
          className="border-l-4 border-blue-500 pl-4 py-2 mb-4 text-muted-foreground italic"
        >
          {renderInlineContent(content)}
        </blockquote>
      );

    case "file":
      const fileUrl = props.url as string;
      const fileName = props.name as string;
      if (!fileUrl) return null;

      return (
        <div key={block.id} className="mb-4">
          <a
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-muted hover:bg-accent rounded-lg text-cyan-400 transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            {fileName || "Download file"}
          </a>
        </div>
      );

    default:
      // Fallback for unknown block types - render content if available
      if (content.length > 0) {
        return (
          <p key={block.id} className="text-foreground/80 mb-4">
            {renderInlineContent(content)}
          </p>
        );
      }
      return null;
  }
}

// Group list items together
function groupListItems(blocks: BlockNoteBlock[]): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  let currentListType: string | null = null;
  let currentListItems: React.ReactNode[] = [];
  let listKey = 0;

  const flushList = () => {
    if (currentListItems.length > 0) {
      if (currentListType === "bulletListItem") {
        result.push(
          <ul
            key={`list-${listKey++}`}
            className="list-disc list-inside mb-4 space-y-1"
          >
            {currentListItems}
          </ul>
        );
      } else if (currentListType === "numberedListItem") {
        result.push(
          <ol
            key={`list-${listKey++}`}
            className="list-decimal list-inside mb-4 space-y-1"
          >
            {currentListItems}
          </ol>
        );
      } else if (currentListType === "checkListItem") {
        result.push(
          <ul key={`list-${listKey++}`} className="mb-4 space-y-1">
            {currentListItems}
          </ul>
        );
      }
      currentListItems = [];
      currentListType = null;
    }
  };

  blocks.forEach((block, index) => {
    const isListItem =
      block.type === "bulletListItem" ||
      block.type === "numberedListItem" ||
      block.type === "checkListItem";

    if (isListItem) {
      if (currentListType !== block.type) {
        flushList();
        currentListType = block.type;
      }
      currentListItems.push(renderBlock(block, index));
    } else {
      flushList();
      const rendered = renderBlock(block, index);
      if (rendered) {
        result.push(rendered);
      }
    }
  });

  flushList();
  return result;
}

export default function BlogContent({ content }: BlogContentProps) {
  const [blocks, setBlocks] = useState<BlockNoteBlock[]>([]);

  useEffect(() => {
    if (!content || !content.trim()) {
      setBlocks([]);
      return;
    }
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        setBlocks(parsed);
      } else {
        setBlocks([]);
      }
    } catch {
      // Content is not JSON - likely plain text saved from the editor fallback.
      // Convert each line into a paragraph block for proper rendering.
      const lines = content.split("\n").filter((l) => l.trim());
      setBlocks(
        lines.map((line, i) => ({
          id: `plain-${i}`,
          type: "paragraph",
          content: [{ type: "text" as const, text: line }],
        }))
      );
    }
  }, [content]);

  return (
    <>
      <ReadingProgressBar />
      <article className="prose prose-invert prose-slate max-w-none">
        {groupListItems(blocks)}
      </article>
    </>
  );
}
