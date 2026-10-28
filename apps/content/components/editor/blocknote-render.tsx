"use client";

import { useMemo } from "react";
import { useTheme } from "next-themes";
import { BlockNoteEditor } from "@blocknote/core";
import type { PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import "@blocknote/core/style.css";
import "@blocknote/mantine/style.css";
import { blocknoteSchema } from "./schema";

interface BlockNoteRenderProps {
  /**
   * Content as JSON string (BlockNote document format)
   */
  content: string;
  /**
   * Optional className for the wrapper
   */
  className?: string;
}

/**
 * Read-only BlockNote renderer component
 * Used for previewing content without editing capabilities
 */
export function BlockNoteRender({
  content,
  className = "",
}: BlockNoteRenderProps) {
  // Parse the content
  const parsedContent = useMemo(() => {
    if (!content) return undefined;
    try {
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

      const isBlockNote = parsed.every(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          typeof (block as Record<string, unknown>).type === "string",
      );
      if (!isBlockNote) return undefined;

      // Deep sanitize: strip IDs, ensure text items have styles
      const sanitizeBlock = (
        block: Record<string, unknown>,
      ): Record<string, unknown> => {
        const { id, ...rest } = block;
        if (Array.isArray(rest.content)) {
          rest.content = rest.content.map((item: Record<string, unknown>) => {
            if (item.type === "text" && !item.styles) {
              return { ...item, styles: {} };
            }
            return item;
          });
        }
        if (Array.isArray(rest.children)) {
          rest.children = rest.children.map((child: Record<string, unknown>) =>
            sanitizeBlock(child),
          );
        }
        return rest;
      };

      return parsed.map(sanitizeBlock) as PartialBlock[];
    } catch {
      if (content.trim()) {
        return [
          {
            type: "paragraph" as const,
            content: [{ type: "text" as const, text: content, styles: {} }],
          },
        ] as PartialBlock[];
      }
      return undefined;
    }
  }, [content]);

  const { resolvedTheme } = useTheme();

  // Create a read-only editor instance with custom schema (for YouTube blocks etc.)
  const editor = useCreateBlockNote({
    initialContent: parsedContent,
    schema: blocknoteSchema,
  });

  if (!parsedContent) {
    return (
      <div className={`text-slate-400 ${className}`}>No content to display</div>
    );
  }

  return (
    <div className={`blocknote-render-wrapper ${className}`}>
      <BlockNoteView
        editor={editor}
        editable={false}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
      />
      <style jsx global>{`
        .blocknote-render-wrapper {
          min-height: 100px;
        }
        .blocknote-render-wrapper .bn-editor {
          background-color: transparent;
        }
        .blocknote-render-wrapper .bn-container {
          background-color: transparent;
        }
        .blocknote-render-wrapper [data-node-type="blockContainer"] {
          padding: 0.25rem 0;
        }
        /* Hide the side menu in read-only mode */
        .blocknote-render-wrapper .bn-side-menu {
          display: none;
        }
        /* Style for headings */
        .blocknote-render-wrapper h1 {
          font-size: 2rem;
          font-weight: 700;
          line-height: 1.2;
          margin-bottom: 0.5rem;
        }
        .blocknote-render-wrapper h2 {
          font-size: 1.5rem;
          font-weight: 600;
          line-height: 1.3;
          margin-bottom: 0.5rem;
        }
        .blocknote-render-wrapper h3 {
          font-size: 1.25rem;
          font-weight: 600;
          line-height: 1.4;
          margin-bottom: 0.5rem;
        }
        /* Code blocks */
        .blocknote-render-wrapper pre {
          background-color: rgb(30 41 59);
          border-radius: 0.5rem;
          padding: 1rem;
          overflow-x: auto;
        }
        .blocknote-render-wrapper code {
          font-family:
            ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.875rem;
        }
        /* Lists */
        .blocknote-render-wrapper ul,
        .blocknote-render-wrapper ol {
          padding-left: 1.5rem;
        }
        /* Tables */
        .blocknote-render-wrapper table {
          width: 100%;
          border-collapse: collapse;
        }
        .blocknote-render-wrapper th,
        .blocknote-render-wrapper td {
          border: 1px solid rgb(51 65 85);
          padding: 0.5rem;
        }
        /* Images */
        .blocknote-render-wrapper img {
          max-width: 100%;
          border-radius: 0.5rem;
        }
        /* YouTube embeds - render them as iframes */
        .blocknote-render-wrapper p:has(> .youtube-embed) {
          aspect-ratio: 16 / 9;
          width: 100%;
        }
      `}</style>
    </div>
  );
}

/**
 * Convert BlockNote JSON content to HTML string
 * Useful for static rendering or email content
 */
export async function blockNoteToHtml(content: string): Promise<string> {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      return "";
    }

    // Create a temporary editor to convert content
    const editor = BlockNoteEditor.create({
      initialContent: parsed as PartialBlock[],
    });

    // Use BlockNote's built-in HTML serializer
    const html = await editor.blocksToHTMLLossy(editor.document);
    return html;
  } catch {
    return "";
  }
}

/**
 * Convert HTML to BlockNote JSON format
 * Useful for importing content from other sources
 */
export async function htmlToBlockNote(html: string): Promise<string> {
  try {
    const editor = BlockNoteEditor.create();
    const blocks = await editor.tryParseHTMLToBlocks(html);
    return JSON.stringify(blocks);
  } catch {
    return "[]";
  }
}

export default BlockNoteRender;
