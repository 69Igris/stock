"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  Check,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@usemoney/ui/dropdown-menu";
import type {
  SideChatHistory,
  SideChatHistoryEntry,
} from "@/hooks/useSideChatHistory";
import { groupChatsByDate } from "@/lib/chat-history/group-by-date";

/**
 * Past-chats browser for the tool-driven side panels — Ask FIRE and Ask
 * Screener (MONEY-1245).
 *
 * ## Why this is a component and not more panel JSX
 *
 * `useSideChatHistory` was extracted because both panels needed the same
 * behaviour and its own header says history "is not going to become the third
 * instance" of the twin-panel copy-paste problem. The RENDERING still got
 * copied though: both panels carried a byte-identical `showHistory ? …` block,
 * so search, rename and archive would each have had to be written twice. This
 * is that block, once.
 *
 * ## What it restores
 *
 * The pre-redesign chat sidebar had search, rename, archive/unarchive and an
 * Active/Archived split; the in-panel list that replaced it had only open and
 * delete. Every server action needed was already built and simply unexposed,
 * so this is wiring rather than new machinery.
 *
 * The interaction model is the old sidebar's (inline rename committing on
 * Enter/blur and cancelling on Escape, a per-row overflow menu). The styling
 * is deliberately NOT the old sidebar's: that file was Tailwind/shadcn over
 * the Terminal-Luxe tokens, while these panels are inline-styled over the
 * playful set, and pasting the old markup in would render a visually foreign
 * block inside the rail.
 */

const SEARCH_DEBOUNCE_MS = 250;

export default function SideChatHistoryList({
  history,
  onOpen,
}: {
  history: SideChatHistory;
  /** Load and display a past chat. The panel owns what "open" means. */
  onOpen: (id: string) => void;
}) {
  const { entries, isLoadingEntries, refreshEntries } = history;

  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);

  /* Today / Yesterday / Last 7 Days / … — the part of the old sidebar that
     actually did the finding. A flat list with a date stamp per row is legible
     at five chats and useless at fifty. Recomputed per render rather than
     memoised on `entries`: the bucket an entry belongs to depends on the
     CLOCK as well as the list, so a memo keyed on `entries` alone would keep
     showing "Today" after midnight. The list is capped at 25, so this is a
     25-element loop. */
  const groups = groupChatsByDate(entries);

  // The first run is the panel opening the list, which should feel instant;
  // later runs are keystrokes and get debounced. One effect covers both so a
  // mount cannot double-fetch.
  const isFirstRunRef = useRef(true);
  useEffect(() => {
    const delay = isFirstRunRef.current ? 0 : SEARCH_DEBOUNCE_MS;
    isFirstRunRef.current = false;
    const t = setTimeout(() => {
      void refreshEntries({ search, archived });
    }, delay);
    return () => clearTimeout(t);
  }, [search, archived, refreshEntries]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* ── Search + Active/Archived ─────────────────────────────────── */}
      <div
        className="shrink-0 px-3 pt-3 pb-2 space-y-2"
        style={{ borderBottom: "1px solid var(--rule-soft)" }}
      >
        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
            style={{ color: "var(--ink-3)" }}
            aria-hidden
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
            className="w-full rounded-lg pl-8 pr-2"
            style={{
              height: 30,
              fontSize: 12,
              color: "var(--ink)",
              background: "var(--paper-2)",
              border: "1.5px solid var(--rule-soft)",
              outline: "none",
            }}
          />
        </div>

        <div
          className="flex rounded-lg p-0.5"
          style={{ background: "var(--paper-2)" }}
          role="tablist"
          aria-label="Chat state"
        >
          {[
            { label: "Active", value: false },
            { label: "Archived", value: true },
          ].map((t) => {
            const selected = archived === t.value;
            return (
              <button
                key={t.label}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setArchived(t.value)}
                className="flex-1 rounded-md"
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: "4px 0",
                  color: selected ? "var(--on-pop)" : "var(--ink-3)",
                  background: selected ? "var(--pop-2)" : "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── List ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isLoadingEntries ? (
          <div className="flex items-center justify-center py-8">
            <Loader2
              className="h-4 w-4 animate-spin"
              style={{ color: "var(--ink-3)" }}
            />
          </div>
        ) : entries.length === 0 ? (
          <div className="text-center py-8 px-2">
            <MessageSquare
              className="h-7 w-7 mx-auto mb-2"
              style={{ color: "var(--ink-3)", opacity: 0.5 }}
              aria-hidden
            />
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
              {search
                ? "No chats match that search."
                : archived
                  ? "No archived chats."
                  : "No saved chats yet. Ask something and it will be kept here."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <div key={group.label} className="space-y-1.5">
                <div
                  className="mono px-0.5"
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ink-4, var(--ink-3))",
                  }}
                >
                  {group.label}
                </div>
                {group.entries.map((e) => (
                  <HistoryRow
                    key={e.id}
                    entry={e}
                    onOpen={() => onOpen(e.id)}
                    onRename={(title) => void history.rename(e.id, title)}
                    onToggleArchive={() =>
                      void history.setArchived(e.id, !e.isArchived)
                    }
                    onDelete={() => void history.remove(e.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({
  entry,
  onOpen,
  onRename,
  onToggleArchive,
  onDelete,
}: {
  entry: SideChatHistoryEntry;
  onOpen: () => void;
  onRename: (title: string) => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape cancels by blurring, but blur also commits — without this flag the
  // cancel path would save the very edit it is meant to discard.
  const cancelledRef = useRef(false);
  /**
   * Set while the ⋯ menu is closing into a rename.
   *
   * Radix returns focus to the menu TRIGGER when the menu closes, and that
   * happens AFTER this row has flipped to edit mode and the effect below has
   * focused the input — so the focus landed on the trigger and the caret never
   * appeared. The user had to click the field to start typing.
   * `onCloseAutoFocus` is where that restore is suppressed.
   */
  const openingRenameRef = useRef(false);

  useEffect(() => {
    if (!isEditing) return;
    // Deferred a frame: the menu is still unmounting on the tick that sets
    // `isEditing`, and focusing before it finishes hands focus straight back.
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [isEditing]);

  const startRename = useCallback(() => {
    setDraft(entry.title);
    cancelledRef.current = false;
    openingRenameRef.current = true;
    setIsEditing(true);
  }, [entry.title]);

  const commit = useCallback(() => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setIsEditing(false);
      return;
    }
    setIsEditing(false);
    // An all-whitespace title is a clear, not a title. `rename("")` sends null
    // and the server restores the derived one, which is what the user means by
    // emptying the field.
    if (draft.trim() !== entry.title) onRename(draft);
  }, [draft, entry.title, onRename]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    setIsEditing(false);
  }, []);

  return (
    <div
      className="group flex items-start gap-2 rounded-lg px-2.5 py-2"
      style={{ border: "1.5px solid var(--rule-soft)" }}
    >
      {isEditing ? (
        /* The input and its two buttons are ONE flex row so the buttons sit
           beside the field rather than under it in a 380px rail. */
        <div className="flex-1 flex items-center gap-1" style={{ minWidth: 0 }}>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={100}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // Stop the key reaching the panel's own Escape/Enter handling
                // and any parent form.
                e.preventDefault();
                e.stopPropagation();
                commit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancel();
              }
            }}
            onBlur={commit}
            aria-label="Chat title"
            className="flex-1 rounded px-1.5 py-0.5"
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: "var(--ink)",
              background: "var(--paper-2)",
              border: "1.5px solid var(--rule-soft)",
              outline: "none",
              minWidth: 0,
            }}
          />
          {/* Explicit Save / Cancel.
              On a touch keyboard there is no reliable Enter and no obvious
              place to tap to blur, so keyboard-only commit left mobile users
              with no way to finish a rename at all.
              `onMouseDown`/`onTouchStart` preventDefault is what makes these
              work: without it the press blurs the input first, `onBlur` fires
              `commit`, the row leaves edit mode and unmounts the button —
              so the click never lands, and Cancel would silently SAVE. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onClick={commit}
            className="pf-bf sm shrink-0"
            title="Save name"
            aria-label="Save name"
            style={{ padding: "4px 6px" }}
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.preventDefault()}
            onClick={cancel}
            className="pf-bf sm shrink-0"
            title="Cancel"
            aria-label="Cancel rename"
            style={{ padding: "4px 6px" }}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex-1 text-left"
          title="Open this chat"
          style={{ minWidth: 0 }}
        >
          <div
            className="truncate"
            style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}
          >
            {entry.title}
          </div>
          {entry.preview && (
            <div
              className="truncate"
              style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}
            >
              {entry.preview}
            </div>
          )}
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              color: "var(--ink-4, var(--ink-3))",
              marginTop: 3,
            }}
          >
            {new Date(entry.lastMessageAt).toLocaleDateString()}
          </div>
        </button>
      )}

      {!isEditing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="pf-bf sm shrink-0"
              title="Chat actions"
              aria-label={`Actions for chat: ${entry.title}`}
              style={{ padding: "4px 7px" }}
            >
              <MoreHorizontal className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            // Radix restores focus to the trigger when the menu closes. That
            // runs AFTER "Rename" has flipped the row into edit mode, so it
            // took focus straight back off the input and the caret never
            // appeared — the user had to click the field to start typing.
            // Suppressed only for that path, so Escape/outside-dismiss still
            // return focus to the trigger for keyboard users.
            onCloseAutoFocus={(e) => {
              if (openingRenameRef.current) {
                openingRenameRef.current = false;
                e.preventDefault();
              }
            }}
          >
            <DropdownMenuItem
              onClick={startRename}
              style={{ fontSize: 12 }}
              aria-label="Rename chat"
            >
              <Pencil className="h-3.5 w-3.5 mr-2" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onToggleArchive}
              style={{ fontSize: 12 }}
            >
              {entry.isArchived ? (
                <>
                  <ArchiveRestore className="h-3.5 w-3.5 mr-2" />
                  Unarchive
                </>
              ) : (
                <>
                  <Archive className="h-3.5 w-3.5 mr-2" />
                  Archive
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onDelete}
              style={{ fontSize: 12, color: "var(--negative, #dc2626)" }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
