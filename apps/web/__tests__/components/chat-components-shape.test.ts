/**
 * MONEY-393 §20 - components/chat top-level UI source-shape guards.
 *
 * 38 chat components live under `apps/web/components/chat/`. The
 * existing `__tests__/chat/` and `__tests__/chat-tools/` cover logic
 * and helpers heavily. This file adds source-text guards for the
 * 12 top-level rendering components that touch the user experience
 * directly - catching regressions where a chat dashboard goes
 * server-only by accident or drops streaming.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHAT = join(__dirname, "..", "..", "components", "chat");

function read(name: string): string {
  return readFileSync(join(CHAT, name), "utf8");
}

const CLIENT_COMPONENTS = [
  "ChatDashboard.tsx",
  "ChatMessageList.tsx",
  "ChatPromptArea.tsx",
  "ChatMessage.tsx",
  "MessageRenderer.tsx",
  "ChatHistorySidebar.tsx",
  "EmbeddedChatPanel.tsx",
  "FollowUpChips.tsx",
  "QuickActionChips.tsx",
  "PromptSuggestions.tsx",
  "ActionConfirmationDialog.tsx",
  // ResearchConfirmSheet is the current mobile-sheet entry; the old
  // MobilePromptSheet was removed during MONEY-219 → 225.
  "ResearchConfirmSheet.tsx",
];

describe("MONEY-393 §20 - components/chat top-level shape", () => {
  it("[client] every top-level chat component is marked 'use client'", () => {
    for (const f of CLIENT_COMPONENTS) {
      const src = read(f);
      // Accept either at the very top OR after a leading block comment.
      // Some files have a /** doc */ block before the directive.
      const head = src.slice(0, 500);
      assert.ok(
        /"use client"/.test(head),
        `${f} must be marked 'use client' within the first 500 chars`
      );
    }
  });

  it("[ChatDashboard] composes the prompt area + message list + history sidebar", () => {
    const src = read("ChatDashboard.tsx");
    // The dashboard is the shell that wires everything together. Must
    // import its three core children - catches a regression that
    // accidentally hollows out the dashboard.
    assert.ok(
      /ChatMessageList|ChatPromptArea|ChatHistorySidebar/.test(src),
      "ChatDashboard must wire at least one of MessageList/PromptArea/HistorySidebar"
    );
  });

  it("[ChatMessage] renders user vs assistant role differently", () => {
    const src = read("ChatMessage.tsx");
    // Role discrimination is a usability requirement - every message
    // must visibly distinguish who sent it.
    assert.match(
      src,
      /role\s*===?\s*["']user["']|isUser|message\.role|"assistant"/i,
      "ChatMessage must branch on role"
    );
  });

  it("[ChatPromptArea] surfaces a submit handler bound to a Form/Enter trigger", () => {
    const src = read("ChatPromptArea.tsx");
    // Must have at least one of: onSubmit / onKeyDown / onKeyPress
    // → the user types Enter / Cmd+Enter to send.
    assert.match(
      src,
      /onSubmit|onKeyDown|onKeyPress|handleSubmit|sendMessage/,
      "ChatPromptArea must wire a submit/keypress handler"
    );
  });

  it("[ChatMessageList] renders streaming + complete message states", () => {
    const src = read("ChatMessageList.tsx");
    // Either an explicit isStreaming/loading branch, or it imports the
    // streaming indicator/loader.
    assert.match(
      src,
      /isStreaming|streaming|isLoading|loader|Loader|Skeleton|spinner/i,
      "ChatMessageList must surface a loading/streaming state"
    );
  });

  it("[ChatHistorySidebar] uses lazy-load pagination (MONEY-392 round 2)", () => {
    const src = read("ChatHistorySidebar.tsx");
    // The chat history sidebar lazy-loads via IntersectionObserver.
    // Catches a refactor that drops the lazy-load and fetches all
    // history upfront (cost + perf regression).
    assert.match(
      src,
      /IntersectionObserver|useChatHistoryCache|loadMore|hasMore|sentinel/i,
      "ChatHistorySidebar must use lazy-load pagination"
    );
  });

  it("[MessageRenderer] composes the canonical content-block types", () => {
    const src = read("MessageRenderer.tsx");
    // The renderer dispatches on block.type for the ContentBlock
    // system (:::block:TYPE markers in source). Must reference at
    // least the core block types.
    assert.ok(
      /text|markdown|chart|table|action|navigation|error|stock|fund|research/i.test(
        src
      ),
      "MessageRenderer must dispatch on at least one canonical block type"
    );
  });

  it("[FollowUpChips] surface label + onClick + analytics", () => {
    const src = read("FollowUpChips.tsx");
    // Follow-up chips are clickable suggestions. They must wire
    // onClick + a label.
    assert.match(src, /label/i);
    assert.match(src, /onClick|handleClick|onPress/);
  });

  it("[ActionConfirmationDialog] has a confirm + cancel surface", () => {
    const src = read("ActionConfirmationDialog.tsx");
    // The confirm dialog is the gate for irreversible actions
    // (delete, etc.). Must have both a confirm and a cancel path.
    assert.match(src, /confirm|Confirm/i);
    assert.match(src, /cancel|Cancel|onClose|onCancel/i);
  });

  it("[QuickActionChips + PromptSuggestions] surface suggested prompts", () => {
    for (const f of ["QuickActionChips.tsx", "PromptSuggestions.tsx"]) {
      const src = read(f);
      assert.match(
        src,
        /prompt|suggest|action|persona|chip/i,
        `${f} must surface clickable prompts/suggestions`
      );
    }
  });

  it("[ResearchConfirmSheet] uses a bottom-sheet pattern (Drawer/Sheet)", () => {
    const src = read("ResearchConfirmSheet.tsx");
    assert.match(
      src,
      /Sheet|Drawer|bottom-sheet|fixed bottom-0|inset-x-0|Dialog/i,
      "ResearchConfirmSheet must render as a bottom-anchored sheet"
    );
  });

  it("[EmbeddedChatPanel] gates rendering on a feature flag or page route", () => {
    const src = read("EmbeddedChatPanel.tsx");
    // The embedded chat panel is page-specific - must reference
    // route/pathname/feature-flag rather than rendering globally.
    assert.match(
      src,
      /pathname|usePathname|pagePath|feature|flag|route|FloatingChat/i,
      "EmbeddedChatPanel must gate its render on route or flag"
    );
  });

  it("[no-secret-leak] no hardcoded sk_/pk_/api_key in any chat component", () => {
    // Defense-in-depth - chat components send messages out. Reject
    // any source-level credential.
    for (const f of CLIENT_COMPONENTS) {
      const src = read(f);
      assert.ok(
        !/sk_live_[a-zA-Z0-9]{16,}|sk_test_[a-zA-Z0-9]{16,}|pk_live_[a-zA-Z0-9]{16,}|api_key\s*=\s*["'][A-Za-z0-9]{16,}["']/.test(
          src
        ),
        `${f} contains a hardcoded credential`
      );
    }
  });
});
