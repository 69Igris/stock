"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Input } from "@usemoney/ui/input";
import { cn } from "@usemoney/utils";
import {
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  Pencil,
  Check,
  MessageSquare,
  Loader2,
  Flame,
  BarChart3,
  PieChart,
  Calculator,
  TrendingUp,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@usemoney/ui/dropdown-menu";
import {
  deleteChatHistoryAction,
  renameChatHistoryAction,
  type ChatHistoryRecord,
} from "@/lib/actions/chat-history";
import { useChatHistoryCache } from "@/hooks/useChatHistoryCache";
import { emitChatHistoryEvent } from "@/lib/chat-history/event-bus";
import { toast } from "sonner";
import { usePfConfirm } from "@/components/ui/use-confirm";
import ChatSidebarTabs, { type ChatSidebarTab } from "./ChatSidebarTabs";
import FeedsTabBody from "./sidebar/FeedsTabBody";
import AlertsTabBody from "./sidebar/AlertsTabBody";
import NotifsTabBody from "./sidebar/NotifsTabBody";
import { useOptionalChatContext } from "@/lib/chat/ChatContext";
import { detectSymbolsFromMessages } from "@/lib/chat/detect-symbols";
import { loadCustomFeeds } from "@/app/discover/news/feed-storage";
import { listAlertsAction } from "@/lib/actions/alerts";
import { getHoldingsAction } from "@/lib/actions/holdings";
import { isNewsAndEventsVisible } from "@/lib/config/coming-soon-flags";
import ComingSoonTabBody from "./sidebar/ComingSoonTabBody";
import { Rss, BellRing as BellRingIcon } from "lucide-react";
import { useUser } from "@clerk/nextjs";

interface ChatHistorySidebarProps {
  currentChatId?: string;
  onNewChat: () => void;
  onSelectChat: (chatId: string) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  className?: string;
}

// De-shadowed (MONEY-620): the pure date-grouping + kind-detection helpers live
// in chat-history-logic.ts (React-free) so they can be unit-tested without this
// component's Clerk/server-action chain. Re-exported here so existing importers
// keep their import path.
import {
  groupChatsByDate,
  detectChatKind,
  toggleSelect as toggleSelectInSet,
  isAllSelected,
  partitionDeleteResults,
  dropSucceeded,
  type GroupedChats,
} from "./chat-history-logic";

export { groupChatsByDate, detectChatKind };
export type { GroupedChats };

const KIND_ICON: Record<ReturnType<typeof detectChatKind>, LucideIcon> = {
  roast: Flame,
  compare: BarChart3,
  research: TrendingUp,
  portfolio: PieChart,
  fire: Calculator,
  screen: Search,
  stock: TrendingUp,
  generic: MessageSquare,
};

function getChatTitle(chat: ChatHistoryRecord): string {
  // Prefer custom title if set
  if (chat.customTitle) return chat.customTitle;

  // Fall back to first user message
  if (!Array.isArray(chat.messages)) return "New conversation";
  const userMsg = chat.messages.find((m) => m.role === "user");
  if (!userMsg) return "New conversation";
  const content = userMsg.content || "";
  // Strip mention context prefix
  const cleaned = content.replace(/^\[Mentioned:.*?\]\s*/, "");
  return cleaned.length > 60 ? cleaned.slice(0, 60) + "..." : cleaned;
}

function ChatGroup({
  label,
  chats,
  currentChatId,
  onSelectChat,
  onDelete,
  onRename,
  onSelectAll,
  selectMode,
  selectedIds,
  onToggleSelect,
}: {
  label: string;
  chats: ChatHistoryRecord[];
  currentChatId?: string;
  onSelectChat: (chatId: string) => void;
  onDelete: (chatId: string) => void;
  onRename: (chatId: string, title: string) => void;
  onSelectAll: () => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (chatId: string) => void;
}) {
  if (chats.length === 0) return null;

  return (
    <div className="mb-4">
      <p
        className="mono px-3 mb-1"
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: "1.3px",
          textTransform: "uppercase",
          color: "var(--ink-4)",
        }}
      >
        {label}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {(chats ?? []).map((chat) => (
          <ChatRow
            key={chat.id}
            chat={chat}
            isActive={chat.id === currentChatId}
            onSelect={() => onSelectChat(chat.id)}
            onDelete={() => onDelete(chat.id)}
            onRename={(title) => onRename(chat.id, title)}
            onSelectAll={onSelectAll}
            selectMode={selectMode}
            isChecked={selectedIds.has(chat.id)}
            onToggleSelect={() => onToggleSelect(chat.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ChatRow({
  chat,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onSelectAll,
  selectMode,
  isChecked,
  onToggleSelect,
}: {
  chat: ChatHistoryRecord;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  onSelectAll: () => void;
  selectMode: boolean;
  isChecked: boolean;
  onToggleSelect: () => void;
}) {
  const KindIcon = KIND_ICON[detectChatKind(chat)];
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleRowClick = () => {
    if (isEditing) return;
    if (selectMode) onToggleSelect();
    else onSelect();
  };

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startRename = () => {
    setDraft(getChatTitle(chat));
    setIsEditing(true);
  };
  const commitRename = () => {
    const title = draft.trim();
    setIsEditing(false);
    if (title && title !== getChatTitle(chat)) onRename(title);
  };

  // Active row: gold fill + ink border + subtle washi-tape tilt (per design)
  const activeStyle = isActive && !selectMode;

  return (
    <div
      className="group"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 8px",
        borderRadius: 7,
        border: activeStyle
          ? "1.5px solid var(--ink)"
          : isChecked
            ? "1.5px solid var(--emerald)"
            : "1.5px solid transparent",
        background: activeStyle
          ? "var(--pop-2)"
          : isChecked
            ? "var(--emerald-bg)"
            : "transparent",
        color: activeStyle ? "var(--on-pop)" : "var(--ink-2)",
        fontWeight: activeStyle ? 700 : 500,
        cursor: "pointer",
        boxShadow: activeStyle ? "2px 2px 0 var(--ink)" : "none",
        transition: "background 0.12s, border-color 0.12s",
        fontSize: 12.5,
        fontFamily: "inherit",
      }}
      onMouseEnter={(e) => {
        if (!activeStyle && !isChecked)
          e.currentTarget.style.background = "var(--rule-softer)";
      }}
      onMouseLeave={(e) => {
        if (!activeStyle && !isChecked)
          e.currentTarget.style.background = "transparent";
      }}
      onClick={handleRowClick}
    >
      {selectMode ? (
        <span
          style={
            isChecked
              ? {
                  background: "var(--emerald)",
                  color: "var(--paper)",
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }
              : {
                  border: "1.5px solid var(--rule-soft)",
                  background: "transparent",
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  flexShrink: 0,
                }
          }
          aria-hidden
        >
          {isChecked && <Check className="h-3 w-3" strokeWidth={3} />}
        </span>
      ) : (
        <KindIcon
          className="h-3.5 w-3.5 shrink-0"
          style={{
            opacity: activeStyle ? 1 : 0.6,
            color: activeStyle ? "var(--on-pop)" : "var(--ink-3)",
          }}
        />
      )}

      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitRename();
            else if (e.key === "Escape") setIsEditing(false);
          }}
          onBlur={commitRename}
          maxLength={120}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            fontFamily: "inherit",
            fontWeight: "inherit",
            color: "var(--ink)",
            background: "var(--paper)",
            border: "1.5px solid var(--ink)",
            borderRadius: 5,
            padding: "2px 6px",
            outline: "none",
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontSize: 12.5,
          }}
        >
          {getChatTitle(chat)}
        </span>
      )}

      {!selectMode && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="opacity-0 group-hover:opacity-100 shrink-0 p-0.5 rounded transition-opacity"
              style={{
                background: "transparent",
                border: "none",
                color: activeStyle ? "var(--on-pop)" : "var(--ink-3)",
                cursor: "pointer",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={4}
            className="min-w-[170px] p-1 rounded-lg"
            style={{
              background: "var(--paper)",
              border: "1.5px solid var(--ink)",
              boxShadow: "3px 3px 0 var(--ink)",
            }}
          >
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                startRename();
              }}
              className="text-xs rounded-md cursor-pointer"
              style={{ color: "var(--ink)" }}
            >
              <Pencil
                className="h-3.5 w-3.5 mr-2"
                style={{ color: "var(--ink-3)" }}
              />
              Rename
            </DropdownMenuItem>
            <div
              className="my-0.5 mx-1"
              style={{ height: 1, background: "var(--rule-soft)" }}
            />
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="text-xs rounded-md cursor-pointer"
              style={{ color: "var(--pop-1-text)" }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete
            </DropdownMenuItem>
            <div
              className="my-0.5 mx-1"
              style={{ height: 1, background: "var(--rule-soft)" }}
            />
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onSelectAll();
              }}
              className="text-xs rounded-md cursor-pointer"
              style={{ color: "var(--ink)" }}
            >
              <Check
                className="h-3.5 w-3.5 mr-2"
                style={{ color: "var(--emerald-text)" }}
              />
              Select all & delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export default function ChatHistorySidebar({
  currentChatId,
  onNewChat,
  onSelectChat,
  collapsed = false,
  onToggle,
  className,
}: ChatHistorySidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [activeTab, setActiveTab] = useState<ChatSidebarTab>("chats");
  const { confirm, confirmDialog } = usePfConfirm();

  // News & Events live-for-this-user check. Until Clerk has hydrated
  // (isLoaded === false), email is undefined and the helper returns
  // false — that keeps the coming-soon UI on initial render rather
  // than flashing live UI to non-allowlisted accounts.
  const { user: clerkUser } = useUser();
  const newsAndEventsLive = isNewsAndEventsVisible(
    clerkUser?.primaryEmailAddress?.emailAddress
  );

  // Pull a small set of likely tickers from the active chat — feeds /
  // alerts use this to surface "Build from this chat" quick-actions.
  const chatCtx = useOptionalChatContext();
  const detectedSymbols = useMemo(() => {
    if (!chatCtx?.messages?.length) return [] as string[];
    return detectSymbolsFromMessages(
      chatCtx.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
      }))
    );
  }, [chatCtx?.messages]);

  // Real-time counts for the tab strip — fetched once per mount so the
  // badges aren't hardcoded. Refreshed on activeTab change so creates
  // from inside a tab body bump the count immediately.
  const [feedsCount, setFeedsCount] = useState(0);
  const [alertsCount, setAlertsCount] = useState(0);
  useEffect(() => {
    // When News & Events is FF-gated to coming-soon, neither tab can
    // accept creates — keep the badges at zero so they match the body
    // state. Skip the network roundtrips entirely.
    if (!newsAndEventsLive) {
      setFeedsCount(0);
      setAlertsCount(0);
      return;
    }
    // Feeds = custom feeds in localStorage + virtual portfolio feed if
    // the user has holdings.
    const customCount = loadCustomFeeds().length;
    setFeedsCount(customCount);
    let cancelled = false;
    void (async () => {
      const [h, a] = await Promise.all([
        getHoldingsAction().catch(() => null),
        listAlertsAction().catch(() => null),
      ]);
      if (cancelled) return;
      const hasPortfolio =
        h?.success && (h.data?.holdings?.length ?? 0) > 0 ? 1 : 0;
      setFeedsCount(customCount + hasPortfolio);
      if (a?.success && Array.isArray(a.data)) setAlertsCount(a.data.length);
    })();
    return () => {
      cancelled = true;
    };
    // Re-run when activeTab changes so creates from inside a body
    // refresh the badge without a page reload. Also re-run when
    // newsAndEventsLive flips (e.g. Clerk hydrates for an allowlisted
    // account) so the badges populate without a reload.
  }, [activeTab, newsAndEventsLive]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Archived view is disabled while archive is removed from the menu -
  // hardcode `false` so the cache always returns the active list.
  const showArchived = false;

  const {
    chats,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    invalidate,
    setChats,
  } = useChatHistoryCache({
    isArchived: showArchived,
    searchQuery: debouncedQuery,
  });

  // IntersectionObserver sentinel - when the user scrolls to the bottom of
  // the list, load the next page (25 more chats).
  //
  // MONEY-392 regression fix: keeping `loadMore` out of the effect deps
  // (via a ref) so the observer is re-created only when `hasMore` /
  // `loading` flip. Including `loadMore` caused the observer to remount
  // on every state change inside `loadMore` (loadingMore + totalCount
  // updates), which fired the sentinel callback in an infinite loop on
  // pages where the chat list was short enough that the sentinel stayed
  // in view through the whole pagination.
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el || !hasMore || loadingMore || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadMoreRef.current();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loadingMore, loading]);

  // Debounce search input
  useEffect(() => {
    const timeout = setTimeout(
      () => setDebouncedQuery(searchQuery),
      searchQuery ? 300 : 0
    );
    return () => clearTimeout(timeout);
  }, [searchQuery]);

  // Refresh chat list when currentChatId changes (new chat saved)
  useEffect(() => {
    invalidate();
  }, [currentChatId, invalidate]);

  const handleSelectChat = useCallback(
    (chatId: string) => {
      onSelectChat(chatId);
      // Background-revalidate the list across tabs so opens never show stale state.
      emitChatHistoryEvent({ type: "chat-opened", chatId });
    },
    [onSelectChat]
  );

  const handleDelete = async (chatId: string) => {
    const result = await deleteChatHistoryAction(chatId);
    if (result?.success) {
      toast.success("Chat deleted");
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (chatId === currentChatId) {
        onNewChat();
      }
      // Cross-tab refresh; same-tab already updated optimistically above.
      emitChatHistoryEvent({ type: "chat-mutated", chatId });
    }
  };

  const handleRename = async (chatId: string, title: string) => {
    // Optimistic — show the new title immediately, then persist.
    setChats((prev) =>
      prev.map((c) => (c.id === chatId ? { ...c, customTitle: title } : c))
    );
    const result = await renameChatHistoryAction(chatId, title);
    if (result?.success) {
      emitChatHistoryEvent({ type: "chat-mutated", chatId });
    } else {
      toast.error("Couldn't rename chat");
      invalidate();
    }
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const enterSelectAll = () => {
    setSelectMode(true);
    setSelectedIds(new Set(chats.map((c) => c.id)));
  };

  const toggleSelect = (chatId: string) => {
    setSelectedIds((prev) => toggleSelectInSet(prev, chatId));
  };

  const allSelected = isAllSelected(selectMode, chats, selectedIds);

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const ok = await confirm({
      title: `Delete ${ids.length} chat${ids.length > 1 ? "s" : ""}?`,
      description: "This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const results = await Promise.allSettled(
      ids.map((id) => deleteChatHistoryAction(id))
    );
    const { succeeded } = partitionDeleteResults(ids, results);
    if (succeeded.length > 0) {
      const succeededSet = new Set(succeeded);
      setChats((prev) => dropSucceeded(prev, succeededSet));
      if (currentChatId && succeededSet.has(currentChatId)) {
        onNewChat();
      }
      toast.success(
        `Deleted ${succeeded.length} chat${succeeded.length > 1 ? "s" : ""}`
      );
      // Cross-tab refresh
      emitChatHistoryEvent({ type: "chat-mutated" });
    }
    if (succeeded.length < ids.length) {
      toast.error(`Failed to delete ${ids.length - succeeded.length}`);
    }
    exitSelectMode();
  };

  if (collapsed) return null;

  const grouped = groupChatsByDate(chats);

  return (
    <div
      className={cn(
        "pf-app flex flex-col h-full w-[260px] shrink-0",
        className
      )}
      style={{ borderRight: "2px solid var(--ink)" }}
    >
      {confirmDialog}
      {/* 4-tab strip per design - Chats / Feeds / Alerts / Notifs */}
      <ChatSidebarTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        chatsCount={chats.length}
        feedsCount={feedsCount}
        alertsCount={alertsCount}
        onToggle={onToggle}
      />

      {activeTab === "feeds" &&
        (newsAndEventsLive ? (
          <FeedsTabBody detectedSymbols={detectedSymbols} />
        ) : (
          <ComingSoonTabBody
            label="Feeds"
            blurb="Custom news streams from your portfolio + watchlists, landing here next."
            Icon={Rss}
          />
        ))}
      {activeTab === "alerts" &&
        (newsAndEventsLive ? (
          <AlertsTabBody detectedSymbols={detectedSymbols} />
        ) : (
          <ComingSoonTabBody
            label="Alerts"
            blurb="Price, volume, news & custom-rule alerts — wiring the worker pipeline now."
            Icon={BellRingIcon}
          />
        ))}
      {activeTab === "notifs" && <NotifsTabBody />}

      {activeTab === "chats" && (
        <>
          {/* RECENT CHATS section header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 14px 6px",
            }}
          >
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                color: "var(--ink-3)",
                fontWeight: 700,
              }}
            >
              Recent chats
            </span>
            <button
              type="button"
              onClick={onNewChat}
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                border: "1.25px solid var(--ink)",
                background: "var(--paper)",
                color: "var(--ink)",
                display: "grid",
                placeItems: "center",
                cursor: "pointer",
                boxShadow: "1.5px 1.5px 0 var(--ink)",
              }}
              aria-label="New chat"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>

          {/* Search */}
          <div style={{ padding: "0 12px 12px" }}>
            <div style={{ position: "relative" }}>
              <span
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--ink-3)",
                  display: "flex",
                  pointerEvents: "none",
                }}
              >
                <Search className="h-3 w-3" />
              </span>
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search chats..."
                className="h-auto border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                style={{
                  width: "100%",
                  background: "var(--paper)",
                  border: "1.5px solid var(--ink)",
                  borderRadius: 8,
                  padding: "7px 10px 7px 28px",
                  fontSize: 12.5,
                  color: "var(--ink)",
                  fontFamily: "inherit",
                }}
              />
            </div>
          </div>

          {/* Select-mode action bar */}
          {selectMode && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                borderBottom: "1.5px dashed var(--rule-soft)",
                background: "var(--paper-2)",
              }}
              data-testid="bulk-action-bar"
            >
              <button
                type="button"
                onClick={() =>
                  allSelected
                    ? setSelectedIds(new Set())
                    : setSelectedIds(new Set(chats.map((c) => c.id)))
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--ink)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <span
                  style={
                    allSelected
                      ? {
                          background: "var(--emerald)",
                          color: "var(--paper)",
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                          display: "grid",
                          placeItems: "center",
                        }
                      : {
                          border: "1.5px solid var(--rule-soft)",
                          background: "transparent",
                          width: 14,
                          height: 14,
                          borderRadius: 3,
                        }
                  }
                  aria-hidden
                >
                  {allSelected && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                {allSelected ? "Deselect all" : "Select all"}
              </button>
              <span
                className="mono"
                style={{
                  marginLeft: "auto",
                  fontSize: 10,
                  color: "var(--ink-4)",
                }}
              >
                {selectedIds.size}/{chats.length}
              </span>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={selectedIds.size === 0}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "4px 8px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--pop-1-text)",
                  background: "transparent",
                  border: "1px solid var(--pop-1)",
                  cursor: "pointer",
                  opacity: selectedIds.size === 0 ? 0.4 : 1,
                  fontFamily: "inherit",
                }}
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
              <button
                type="button"
                onClick={exitSelectMode}
                style={{
                  width: 22,
                  height: 22,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 5,
                  border: "1px solid var(--rule-soft)",
                  background: "transparent",
                  color: "var(--ink-3)",
                  cursor: "pointer",
                }}
                aria-label="Exit select mode"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Chat list */}
          <div
            className="pf-noscrollbar"
            style={{ flex: 1, overflowY: "auto", padding: "0 10px 18px" }}
          >
            {loading ? (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: "32px 0",
                }}
              >
                <Loader2
                  className="h-4 w-4 animate-spin"
                  style={{ color: "var(--ink-4)" }}
                />
              </div>
            ) : chats.length === 0 ? (
              <div style={{ textAlign: "center", padding: "32px 16px" }}>
                <MessageSquare
                  className="h-8 w-8 mx-auto mb-2"
                  style={{ color: "var(--ink-4)" }}
                />
                <p
                  className="ser"
                  style={{ fontSize: 12.5, color: "var(--ink-3)" }}
                >
                  {searchQuery ? "No chats found" : "No conversations yet"}
                </p>
              </div>
            ) : (
              <>
                <ChatGroup
                  label="Today"
                  chats={grouped.today}
                  currentChatId={currentChatId}
                  onSelectChat={handleSelectChat}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onSelectAll={enterSelectAll}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                />
                <ChatGroup
                  label="Yesterday"
                  chats={grouped.yesterday}
                  currentChatId={currentChatId}
                  onSelectChat={handleSelectChat}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onSelectAll={enterSelectAll}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                />
                <ChatGroup
                  label="Last week"
                  chats={grouped.lastWeek}
                  currentChatId={currentChatId}
                  onSelectChat={handleSelectChat}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onSelectAll={enterSelectAll}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                />
                <ChatGroup
                  label="Older"
                  chats={grouped.older}
                  currentChatId={currentChatId}
                  onSelectChat={handleSelectChat}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onSelectAll={enterSelectAll}
                  selectMode={selectMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                />

                {/* Lazy-load sentinel */}
                {hasMore && (
                  <div
                    ref={loadMoreSentinelRef}
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      padding: "16px 0",
                    }}
                    aria-hidden="true"
                  >
                    {loadingMore ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        style={{ color: "var(--ink-4)" }}
                      />
                    ) : (
                      <span style={{ height: 4, width: 4 }} />
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
