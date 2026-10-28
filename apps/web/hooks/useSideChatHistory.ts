"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { Content } from "@google/genai";
import {
  saveChatHistoryAction,
  listChatHistoriesAction,
  getChatHistoryByIdAction,
  deleteChatHistoryAction,
  renameChatHistoryAction,
  archiveChatHistoryAction,
  unarchiveChatHistoryAction,
} from "@/lib/actions/chat-history";

/**
 * Persistence + history browsing for the tool-driven SIDE chats — Ask FIRE and
 * Ask Screener (MONEY-1245).
 *
 * Both panels previously kept their conversation in a bare `useRef`, so a
 * refresh or a navigation lost it entirely and there was nothing to see or
 * delete. Everything needed already existed — the `ChatHistory` model is
 * page-scoped and all eight actions (save/list/get/delete/archive/rename) were
 * built for the main StockSage chat — so this hook is the missing wiring, not
 * new machinery.
 *
 * It lives in ONE place on purpose. AskFirePanel and AskScreenerPanel are
 * near-identical twins, and every fix in this branch had to be written twice
 * because of it; history is not going to become the third instance of that.
 *
 * Two things are persisted per chat:
 *
 *   `messages`          the visible transcript, in the {role, content,
 *                       timestamp} shape /chat-history's viewer renders.
 *   `toolConversation`  the raw Gemini turns (functionCall/functionResponse).
 *                       These are what actually drove the plan or screen
 *                       edits, so a resume without them looks continuous to
 *                       the user while the model restarts with no idea what it
 *                       already changed.
 */

export interface SideChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface SideChatHistoryEntry {
  id: string;
  title: string;
  preview?: string;
  lastMessageAt: Date;
  isArchived: boolean;
}

/**
 * Which slice of this page's history to show. Owned by the caller (the panel
 * renders the search box and the active/archived tabs), passed in on each
 * refresh rather than held here, so the hook has no opinion about view state.
 */
export interface SideChatHistoryQuery {
  /** Server-side match over page name, path and message content. */
  search?: string;
  /** `true` lists archived chats instead of active ones. Defaults to false. */
  archived?: boolean;
}

interface UseSideChatHistoryOptions {
  /** Route this chat belongs to, e.g. "/fire". Scopes the history list. */
  pagePath: string;
  /** Display name for the saved row, e.g. "Ask FIRE". */
  pageName: string;
  /** Lucide icon name stored for the /chat-history list. */
  pageIcon?: string;
}

export interface SideChatHistory {
  /** Id of the chat being appended to; null until the first save. */
  chatId: string | null;
  /** Past chats for this page, newest first. Loaded on demand. */
  entries: SideChatHistoryEntry[];
  isLoadingEntries: boolean;
  /** Persist the current turn. Safe to call after every completed turn. */
  save: (
    messages: SideChatMessage[],
    conversation: Content[],
    scenarioName?: string
  ) => Promise<void>;
  /** Fetch the history list for this page. */
  refreshEntries: (query?: SideChatHistoryQuery) => Promise<void>;
  /** Load one past chat; returns its transcript + tool turns to replay. */
  load: (
    id: string
  ) => Promise<{ messages: SideChatMessage[]; conversation: Content[] } | null>;
  /** Delete a past chat and drop it from the list. */
  remove: (id: string) => Promise<boolean>;
  /**
   * Give a past chat a custom title. An empty title clears it, which restores
   * the derived title (first user message) rather than leaving the row blank.
   */
  rename: (id: string, title: string) => Promise<boolean>;
  /**
   * Archive or unarchive a past chat. The row leaves the current list either
   * way, because a list is showing exactly one of the two states.
   */
  setArchived: (id: string, archived: boolean) => Promise<boolean>;
  /** Forget the current chat id so the next save starts a new row. */
  startNew: () => void;
}

/** A stored message can predate any given field; narrow defensively. */
function toSideChatMessages(raw: unknown): SideChatMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m, i) => {
    if (!m || typeof m !== "object") return [];
    const rec = m as Record<string, unknown>;
    const role = rec.role === "user" ? "user" : "assistant";
    const content = typeof rec.content === "string" ? rec.content : "";
    if (!content) return [];
    return [
      {
        id: typeof rec.id === "string" ? rec.id : `restored-${i}`,
        role,
        content,
      },
    ];
  });
}

/** Map a stored row to the shape the panel list renders. */
function toEntry(c: {
  id: string;
  title?: string;
  pageName: string;
  preview?: string;
  lastMessageAt: Date;
  isArchived: boolean;
}): SideChatHistoryEntry {
  return {
    id: c.id,
    title: c.title || c.pageName,
    preview: c.preview,
    lastMessageAt: c.lastMessageAt,
    isArchived: c.isArchived,
  };
}

export function useSideChatHistory({
  pagePath,
  pageName,
  pageIcon,
}: UseSideChatHistoryOptions): SideChatHistory {
  const [chatId, setChatId] = useState<string | null>(null);
  const [entries, setEntries] = useState<SideChatHistoryEntry[]>([]);
  const [isLoadingEntries, setIsLoadingEntries] = useState(false);

  // The id is read inside async callbacks that may have been created before
  // the first save returned, so keep a ref alongside the state.
  const chatIdRef = useRef<string | null>(null);
  // Saves are fire-and-forget from the turn loop; this stops two turns landing
  // concurrently and each creating its own row.
  const isSavingRef = useRef(false);

  useEffect(() => {
    chatIdRef.current = chatId;
  }, [chatId]);

  const save = useCallback(
    async (
      messages: SideChatMessage[],
      conversation: Content[],
      scenarioName?: string
    ) => {
      // Nothing to save until the user has actually said something. The
      // service enforces this too, but returning early avoids a round-trip on
      // every panel open.
      if (messages.some((m) => m.role === "user") === false) return;
      if (isSavingRef.current) return;

      isSavingRef.current = true;
      try {
        const result = await saveChatHistoryAction(
          pagePath,
          pageName,
          pageIcon,
          messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: new Date(),
          })),
          chatIdRef.current ?? undefined,
          scenarioName,
          conversation
        );
        if (result.success && result.data?.chatId && !chatIdRef.current) {
          chatIdRef.current = result.data.chatId;
          setChatId(result.data.chatId);
        }
      } catch {
        // History is best-effort: a failed save must never break the chat the
        // user is in the middle of.
      } finally {
        isSavingRef.current = false;
      }
    },
    [pagePath, pageName, pageIcon]
  );

  // Search refreshes as the user types, so responses can land out of order: a
  // slow request for "rel" finishing after a fast one for "reliance" would
  // repaint the older results and leave the list disagreeing with the box.
  // Only the newest request is allowed to write.
  const requestSeqRef = useRef(0);
  // The view the list is currently showing, so a mutation that needs the
  // server's answer (a cleared title reverts to the derived one) can re-fetch
  // the SAME slice instead of silently resetting to the default tab.
  const lastQueryRef = useRef<SideChatHistoryQuery>({});

  const refreshEntries = useCallback(
    async (query: SideChatHistoryQuery = {}) => {
      const seq = ++requestSeqRef.current;
      lastQueryRef.current = query;
      setIsLoadingEntries(true);
      try {
        const search = query.search?.trim();
        const res = await listChatHistoriesAction({
          pagePath,
          isArchived: query.archived ?? false,
          sortBy: "lastMessage",
          order: "desc",
          limit: 25,
          // Omitted rather than passed empty: the service treats a blank
          // searchQuery as "no filter", but sending the key anyway would make
          // an empty box look like a deliberate match-everything query.
          ...(search ? { searchQuery: search } : {}),
        });
        if (seq !== requestSeqRef.current) return;
        if (res.success && res.data) setEntries(res.data.chats.map(toEntry));
      } catch {
        // Leave whatever list we had; the panel shows an empty state.
      } finally {
        if (seq === requestSeqRef.current) setIsLoadingEntries(false);
      }
    },
    [pagePath]
  );

  const load = useCallback(async (id: string) => {
    try {
      const res = await getChatHistoryByIdAction(id);
      if (!res.success || !res.data) return null;
      const chat = res.data;

      // `toolConversation` is ABSENT on every StockSage row and on every row
      // written before MONEY-1245 — that is not corruption, it just means the
      // chat had no tool loop. Missing => replay the transcript only.
      const conversation = Array.isArray(chat.toolConversation)
        ? (chat.toolConversation as Content[])
        : [];

      chatIdRef.current = id;
      setChatId(id);
      return { messages: toSideChatMessages(chat.messages), conversation };
    } catch {
      return null;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      const res = await deleteChatHistoryAction(id);
      if (!res.success) return false;
      setEntries((prev) => prev.filter((e) => e.id !== id));
      // Deleting the chat you are sitting in must not leave the next save
      // writing to a row that no longer exists.
      if (chatIdRef.current === id) {
        chatIdRef.current = null;
        setChatId(null);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const rename = useCallback(
    async (id: string, title: string) => {
      const next = title.trim();
      try {
        // `null` clears the custom title. The service then falls back to the
        // derived one, which is why an empty box is a reset and not a blank
        // row.
        const res = await renameChatHistoryAction(id, next || null);
        if (!res.success) return false;
        if (next) {
          setEntries((prev) =>
            prev.map((e) => (e.id === id ? { ...e, title: next } : e))
          );
        } else {
          // Only the server knows the derived title (first user message), so
          // clearing has to re-read rather than guess. Re-fetch the SAME slice
          // the list is showing.
          await refreshEntries(lastQueryRef.current);
        }
        return true;
      } catch {
        return false;
      }
    },
    [refreshEntries]
  );

  const setArchived = useCallback(async (id: string, archived: boolean) => {
    try {
      const res = archived
        ? await archiveChatHistoryAction(id)
        : await unarchiveChatHistoryAction(id);
      if (!res.success) return false;
      // A list shows exactly one of the two states, so the row leaves the
      // current view whichever direction it moved.
      setEntries((prev) => prev.filter((e) => e.id !== id));
      // Archiving the chat you are currently in must not leave the next turn
      // appending to a row the user just filed away.
      if (archived && chatIdRef.current === id) {
        chatIdRef.current = null;
        setChatId(null);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const startNew = useCallback(() => {
    chatIdRef.current = null;
    setChatId(null);
  }, []);

  return {
    chatId,
    entries,
    isLoadingEntries,
    save,
    refreshEntries,
    load,
    remove,
    rename,
    setArchived,
    startNew,
  };
}

/**
 * Consume a `?chatId=` deep link once.
 *
 * /chat-history resumes a saved chat by routing to the page that owns it with
 * `?chatId=<id>` appended. StockSage has always read that param; the side
 * panels never did, so "open" on an Ask FIRE or Ask Screener row navigated to
 * the right page and then did nothing at all — no error, just a fresh empty
 * chat, which reads as the history being broken rather than unimplemented.
 *
 * The param is stripped once consumed. Two reasons: a refresh should not
 * re-resume a chat the user has since moved on from, and the screener
 * continuously re-serialises its own URL state, so a lingering id would keep
 * being written back long after it stopped meaning anything.
 *
 * The strip is a URL-BAR touch-up, not a navigation, so it forwards
 * `window.history.state` — that object carries Next's `__NA` marker, and
 * dropping it turns `replaceState` into a real router dispatch. See the header
 * of lib/navigation/url-sync-logic.ts, where that distinction is spelled out.
 */
export function useChatIdFromUrl(onResume: (id: string) => void): void {
  const searchParams = useSearchParams();
  const chatId = searchParams?.get("chatId") ?? null;
  // Guards against re-firing when `onResume` is a fresh closure each render.
  const consumedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!chatId || consumedRef.current === chatId) return;
    consumedRef.current = chatId;
    onResume(chatId);

    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("chatId");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [chatId, onResume]);
}
