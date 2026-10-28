"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallbackContent?: string;
  onChange?: (content: string) => void;
}

interface State {
  hasError: boolean;
}

/**
 * Extract readable text from BlockNote JSON content.
 * Falls back to raw string if parsing fails.
 */
function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return content;

    const texts: string[] = [];
    for (const block of parsed) {
      if (Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item.type === "text" && typeof item.text === "string") {
            texts.push(item.text);
          }
        }
      }
    }
    return texts.join("\n\n") || content;
  } catch {
    return content;
  }
}

/**
 * Error boundary that catches BlockNote initialization errors
 * (e.g. NaN from invalid initialContent format).
 * Falls back to a plain textarea showing extracted text.
 */
export class EditorErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      const displayText = extractText(this.props.fallbackContent || "");

      return (
        <div className="space-y-3">
          <div className="text-sm text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
            This post uses a legacy content format. Editing as plain text.
          </div>
          {this.props.onChange ? (
            <textarea
              defaultValue={displayText}
              onChange={(e) => this.props.onChange?.(e.target.value)}
              placeholder="Enter text or type '/' for commands"
              className="w-full min-h-[400px] bg-transparent text-foreground placeholder:text-muted-foreground/60 outline-none ring-0 resize-none text-base leading-relaxed"
            />
          ) : (
            <div className="text-foreground text-base leading-relaxed whitespace-pre-wrap">
              {displayText}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
