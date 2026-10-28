"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { collectExternalMedia } from "./sideload-logic";
import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core/extensions";
import type { PartialBlock } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import {
  DefaultReactSuggestionItem,
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import "@blocknote/core/style.css";
import "@blocknote/mantine/style.css";
import { blocknoteSchema } from "./schema";

// Debounce utility
function useDebouncedCallback<T extends (...args: Parameters<T>) => void>(
  callback: T,
  delay: number,
): (...args: Parameters<T>) => void {
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      const newTimeoutId = setTimeout(() => {
        callback(...args);
      }, delay);
      setTimeoutId(newTimeoutId);
    },
    [callback, delay, timeoutId],
  );
}

/**
 * Upload handler for images, videos, and audio - uploads to GCS via /api/upload endpoint
 */
async function uploadFile(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      (error as Record<string, string>).error || "Failed to upload file",
    );
  }

  const data = (await response.json()) as { url: string };
  return data.url;
}

// YouTube slash menu item - inserts a youtube block
const insertYoutube = (
  editor: typeof blocknoteSchema.BlockNoteEditor,
): DefaultReactSuggestionItem => ({
  title: "YouTube Video",
  onItemClick: () => {
    insertOrUpdateBlockForSlashMenu(editor, { type: "youtube" });
  },
  group: "Media",
  aliases: ["youtube", "video", "yt", "embed"],
  subtext: "Embed a YouTube video",
});

interface BlockNoteEditorProps {
  initialContent?: string;
  onChange?: (content: string) => void;
  placeholder?: string;
  editable?: boolean;
}

export function BlockNoteEditorComponent({
  initialContent,
  onChange,
  placeholder = "Start writing your content...",
  editable = true,
}: BlockNoteEditorProps) {
  // Parse initial content
  const parsedInitialContent = useMemo(() => {
    if (!initialContent) return undefined;
    try {
      const parsed = JSON.parse(initialContent);
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

      const isBlockNote = parsed.every(
        (block: unknown) =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          typeof (block as Record<string, unknown>).type === "string",
      );
      if (!isBlockNote) return undefined;

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
      if (initialContent.trim()) {
        return [
          {
            type: "paragraph" as const,
            content: [
              { type: "text" as const, text: initialContent, styles: {} },
            ],
          },
        ] as PartialBlock[];
      }
      return undefined;
    }
  }, [initialContent]);

  const editor = useCreateBlockNote({
    initialContent: parsedInitialContent,
    uploadFile,
    schema: blocknoteSchema,
  });

  const debouncedOnChange = useDebouncedCallback(
    useCallback(
      (newContent: string) => {
        onChange?.(newContent);
      },
      [onChange],
    ),
    500,
  );

  // Paste sideloading: when content is pasted with external <img>/<video> URLs
  // or inline base64 data URLs, re-upload them to GCS (server-side, CORS-safe)
  // and swap the block URL so published posts never hot-link a third-party host.
  // BlockNote's own `uploadFile` only covers File/Blob (picker/drop/paste-file).
  const processingRef = useRef<Set<string>>(new Set());
  const sideloadExternalMedia = useCallback(async () => {
    const externals = collectExternalMedia(
      editor.document as unknown as Parameters<typeof collectExternalMedia>[0],
    );
    for (const { id, url } of externals) {
      if (processingRef.current.has(id)) continue;
      processingRef.current.add(id);
      try {
        const res = await fetch("/api/upload-from-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        if (res.ok) {
          const data = (await res.json()) as { url?: string };
          if (data.url) {
            editor.updateBlock(id, {
              props: { url: data.url },
            } as Parameters<typeof editor.updateBlock>[1]);
          }
        }
      } catch {
        // Leave the original URL on failure — never disrupt the author.
      } finally {
        processingRef.current.delete(id);
      }
    }
  }, [editor]);

  const handleEditorChange = useCallback(() => {
    // Fire-and-forget: re-host any freshly-pasted external media. After a swap
    // the URL is a GCS URL, so subsequent scans skip it (no loop).
    void sideloadExternalMedia();
    if (!onChange) return;
    const content = JSON.stringify(editor.document);
    debouncedOnChange(content);
  }, [editor, onChange, debouncedOnChange, sideloadExternalMedia]);

  const { resolvedTheme } = useTheme();

  // Custom slash menu: default items + YouTube
  const getSlashMenuItems = useCallback(
    (ed: typeof blocknoteSchema.BlockNoteEditor) => [
      ...getDefaultReactSlashMenuItems(ed),
      insertYoutube(ed),
    ],
    [],
  );

  return (
    <div className="blocknote-editor-wrapper">
      <BlockNoteView
        editor={editor}
        editable={editable}
        onChange={handleEditorChange}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        slashMenu={false}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(getSlashMenuItems(editor), query)
          }
        />
      </BlockNoteView>

      <style jsx global>{`
        .blocknote-editor-wrapper {
          min-height: 500px;
        }
        .blocknote-editor-wrapper .bn-editor {
          background-color: transparent;
        }
        .blocknote-editor-wrapper .bn-container {
          background-color: transparent;
        }
        .blocknote-editor-wrapper [data-node-type="blockContainer"] {
          padding: 0.25rem 0;
        }
        /* Style for headings */
        .blocknote-editor-wrapper h1 {
          font-size: 2rem;
          font-weight: 700;
          line-height: 1.2;
          margin-bottom: 0.5rem;
        }
        .blocknote-editor-wrapper h2 {
          font-size: 1.5rem;
          font-weight: 600;
          line-height: 1.3;
          margin-bottom: 0.5rem;
        }
        .blocknote-editor-wrapper h3 {
          font-size: 1.25rem;
          font-weight: 600;
          line-height: 1.4;
          margin-bottom: 0.5rem;
        }
        /* Code blocks */
        .blocknote-editor-wrapper pre {
          background-color: rgb(30 41 59);
          border-radius: 0.5rem;
          padding: 1rem;
          overflow-x: auto;
        }
        .blocknote-editor-wrapper code {
          font-family:
            ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 0.875rem;
        }
        /* Lists */
        .blocknote-editor-wrapper ul,
        .blocknote-editor-wrapper ol {
          padding-left: 1.5rem;
        }
        /* Tables */
        .blocknote-editor-wrapper table {
          width: 100%;
          border-collapse: collapse;
        }
        .blocknote-editor-wrapper th,
        .blocknote-editor-wrapper td {
          border: 1px solid rgb(51 65 85);
          padding: 0.5rem;
        }
        /* Images */
        .blocknote-editor-wrapper img {
          max-width: 100%;
          border-radius: 0.5rem;
        }
        /* Placeholder text */
        .blocknote-editor-wrapper [data-placeholder]::before {
          color: rgb(100 116 139);
        }
      `}</style>
    </div>
  );
}

export default BlockNoteEditorComponent;
