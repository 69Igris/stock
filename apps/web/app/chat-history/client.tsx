"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import { Button } from "@usemoney/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@usemoney/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@usemoney/ui/dialog";
import { Badge } from "@usemoney/ui/badge";
import { Skeleton } from "@usemoney/ui/skeleton";
import { Input } from "@usemoney/ui/input";
import { toast } from "sonner";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import {
  MessageSquare,
  Archive,
  ArchiveRestore,
  Trash2,
  Filter,
  Calendar,
  ArrowUpDown,
  Clock,
  ExternalLink,
  Loader2,
  Search,
  X,
  Sparkles,
  Activity,
  Brain,
  GraduationCap,
  BookOpen,
  BarChart3,
  Briefcase,
  TrendingUp,
  LineChart,
  PieChart,
  type LucideIcon,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import Link from "next/link";
import {
  listChatHistoriesAction,
  archiveChatHistoryAction,
  unarchiveChatHistoryAction,
  deleteChatHistoryAction,
} from "@/lib/actions/chat-history";
import {
  emitChatHistoryEvent,
  subscribeChatHistoryEvents,
} from "@/lib/chat-history/event-bus";
import { DemoBanner } from "@/components/DemoBanner";
// Type-only import: `lib/db/chat-history` is a server module (Prisma +
// @usemoney/services). `import type` is fully erased at compile time so this
// client bundle never pulls the server runtime (MONEY-595 A01).
import type { ChatHistoryRecord } from "@/lib/db/chat-history";
import { PaginationControls } from "@/components/PaginationControls";
import { buildChatResumeHref } from "@/lib/navigation/url-sync-logic";
import { SIDE_CHAT_PAGE_NAMES } from "@/lib/chat-history/side-chat-scopes";

/** Explicit icon map instead of `import * as LucideIcons` (~200KB savings) */
const PAGE_ICON_MAP: Record<string, LucideIcon> = {
  MessageSquare,
  Sparkles,
  Activity,
  Brain,
  GraduationCap,
  BookOpen,
  BarChart3,
  Briefcase,
  TrendingUp,
  LineChart,
  PieChart,
};

// MONEY-392: Bumped from 10 → 25 so initial load shows a meaningful page
// (matches the sidebar's first-page lazy-load size).
const PAGE_SIZE = 25;

// Page mapping for display.
//
// The side-chat scopes are spread FIRST so the entries below win on collision:
// "/fire" is deliberately "FIRE Calculator" here (this map also labels the
// page filter, and the filter names the page, not the chat that lives on it),
// while the scope map calls it "Ask FIRE". The three Ask Screener scopes have
// no local entry, so they come through and stop rendering as raw paths.
const PAGE_DISPLAY_NAMES: Record<string, string> = {
  ...SIDE_CHAT_PAGE_NAMES,
  "/dashboard": "Dashboard",
  "/tradebook": "Tradebook",
  "/positions": "Positions",
  "/holdings": "Holdings",
  "/paper-trading": "Paper Trading",
  "/discover": "Discover",
  "/analysis": "Investment Analysis",
  "/tutor": "Financial Education",
  "/brokers": "Brokers",
  "/settings": "Settings",
  "/pricing": "Pricing",
  "/fire": "FIRE Calculator",
};

export default function ChatHistoryPage() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const [mounted, setMounted] = useState(false);

  const isDemoMode = useIsDemoMode({ user });

  const [chats, setChats] = useState<ChatHistoryRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPage, setSelectedPage] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"date" | "lastMessage">("lastMessage");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [showArchived, setShowArchived] = useState(false);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [selectedChat, setSelectedChat] = useState<ChatHistoryRecord | null>(
    null
  );
  const [viewChatDialogOpen, setViewChatDialogOpen] = useState(false);
  const [viewingChat, setViewingChat] = useState<ChatHistoryRecord | null>(
    null
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadChats = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await listChatHistoriesAction({
        pagePath: selectedPage === "all" ? undefined : selectedPage,
        isArchived: showArchived ? true : false,
        sortBy,
        order: sortOrder,
        searchQuery: debouncedSearchQuery.trim() || undefined,
        skip: currentPage * PAGE_SIZE,
        limit: PAGE_SIZE,
      });

      if (result?.success && result?.data) {
        setChats(Array.isArray(result.data.chats) ? result.data.chats : []);
        setTotalCount(result.data.totalCount ?? 0);
      } else {
        toast.error(result?.error || "Failed to load chat history");
      }
    } catch (error) {
      console.error("Error loading chats:", error);
      toast.error("Failed to load chat history");
    } finally {
      setIsLoading(false);
    }
  }, [
    selectedPage,
    sortBy,
    sortOrder,
    showArchived,
    debouncedSearchQuery,
    currentPage,
  ]);

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(0);
  }, [selectedPage, sortBy, sortOrder, showArchived, debouncedSearchQuery]);

  useEffect(() => {
    if (!mounted || !isLoaded) return;
    // Allow demo mode or authenticated users
    const demoMode = localStorage.getItem("tradebook_demo_mode") === "true";
    if (!user && !demoMode) {
      router.push("/home");
      return;
    }
    loadChats();
  }, [mounted, isLoaded, user, router, loadChats]);

  // Cross-tab sync: another tab created / archived / deleted / renamed a chat
  useEffect(() => {
    return subscribeChatHistoryEvents((event) => {
      if (event.type === "chat-created" || event.type === "chat-mutated") {
        loadChats();
      }
    });
  }, [loadChats]);

  const handleOpenChat = (chat: ChatHistoryRecord) => {
    // If archived or demo mode, open in dialog on same page
    if (chat.isArchived || isDemoMode) {
      setViewingChat(chat);
      setViewChatDialogOpen(true);
    } else {
      // Navigate to the page with chatId parameter. Built by merging query
      // params rather than concatenating "?chatId=": Ask Screener scopes its
      // history per mode, so `pagePath` can already carry "?mode=etf", and a
      // second "?" would fold the id into the mode value.
      router.push(buildChatResumeHref(chat.pagePath, chat.id));
    }
  };

  const handleArchive = async (chat: ChatHistoryRecord) => {
    try {
      const result = await archiveChatHistoryAction(chat.id);
      if (result?.success) {
        toast.success("Chat archived");
        loadChats();
        setArchiveDialogOpen(false);
        setSelectedChat(null);
        emitChatHistoryEvent({ type: "chat-mutated", chatId: chat.id });
      } else {
        toast.error(result?.error || "Failed to archive chat");
      }
    } catch (error) {
      console.error("Error archiving chat:", error);
      toast.error("Failed to archive chat");
    }
  };

  const handleUnarchive = async (chat: ChatHistoryRecord) => {
    try {
      const result = await unarchiveChatHistoryAction(chat.id);
      if (result?.success) {
        toast.success("Chat unarchived");
        loadChats();
        emitChatHistoryEvent({ type: "chat-mutated", chatId: chat.id });
      } else {
        toast.error(result?.error || "Failed to unarchive chat");
      }
    } catch (error) {
      console.error("Error unarchiving chat:", error);
      toast.error("Failed to unarchive chat");
    }
  };

  const handleDelete = async () => {
    if (!selectedChat) return;

    try {
      const result = await deleteChatHistoryAction(selectedChat.id);
      if (result?.success) {
        toast.success("Chat deleted");
        loadChats();
        setDeleteDialogOpen(false);
        const deletedId = selectedChat.id;
        setSelectedChat(null);
        emitChatHistoryEvent({ type: "chat-mutated", chatId: deletedId });
      } else {
        toast.error(result?.error || "Failed to delete chat");
      }
    } catch (error) {
      console.error("Error deleting chat:", error);
      toast.error("Failed to delete chat");
    }
  };

  const getPageIcon = (iconName?: string) => {
    if (!iconName) return MessageSquare;
    return PAGE_ICON_MAP[iconName] || MessageSquare;
  };

  const formatDate = (date: Date) => {
    const d = new Date(date);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  const getAllPages = () => {
    // Return all available pages from PAGE_DISPLAY_NAMES
    return Object.keys(PAGE_DISPLAY_NAMES).sort();
  };

  if (!mounted || !isLoaded) {
    return null;
  }

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="p-6 lg:p-8 pb-48 sm:pb-44">
          <div className="max-w-6xl mx-auto">
            {isDemoMode && <DemoBanner />}
            {/* Header */}
            <div className="mb-6">
              <div className="font-mono text-[11px] font-bold tracking-[1px] text-emerald-500 inline-flex items-center gap-1.5 mb-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                STOCKSAGE · HISTORY
              </div>
              <h1 className="font-display text-[30px] font-extrabold tracking-[-1px] text-foreground flex items-center gap-2 mb-2">
                <MessageSquare className="h-7 w-7 text-emerald-500" />
                Every chat, <span className="ser">right where</span>{" "}
                <span className="hl-gold">you left it.</span>
              </h1>
              <p className="text-[var(--ink-2)]">
                View and manage your saved chat conversations
              </p>
            </div>

            {/* Search Bar */}
            <Card className="mb-6 bg-card border-border">
              <CardContent className="p-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder="Search by page name or message content..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-10 pr-10 bg-muted border-border text-foreground placeholder:text-muted-foreground"
                  />
                  {searchQuery && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setSearchQuery("")}
                      className="absolute right-1 top-1/2 transform -translate-y-1/2 h-8 w-8 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Filters */}
            <Card className="mb-6 bg-card border-border">
              <CardHeader>
                <CardTitle className="text-foreground flex items-center gap-2">
                  <Filter className="h-5 w-5" />
                  Filters
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <div>
                    <label className="text-sm text-muted-foreground mb-2 block">
                      Page
                    </label>
                    <Select
                      value={selectedPage}
                      onValueChange={setSelectedPage}
                    >
                      <SelectTrigger className="bg-muted border-border text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-muted border-border">
                        <SelectItem
                          value="all"
                          className="text-foreground hover:bg-accent"
                        >
                          All Pages
                        </SelectItem>
                        {getAllPages().map((page) => (
                          <SelectItem
                            key={page}
                            value={page}
                            className="text-foreground hover:bg-accent"
                          >
                            {PAGE_DISPLAY_NAMES[page] || page}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm text-muted-foreground mb-2 block">
                      Sort By
                    </label>
                    <Select
                      value={sortBy}
                      onValueChange={(v) =>
                        setSortBy(v as "date" | "lastMessage")
                      }
                    >
                      <SelectTrigger className="bg-muted border-border text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-muted border-border">
                        <SelectItem
                          value="lastMessage"
                          className="text-foreground hover:bg-accent"
                        >
                          Last Message
                        </SelectItem>
                        <SelectItem
                          value="date"
                          className="text-foreground hover:bg-accent"
                        >
                          Created Date
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="text-sm text-muted-foreground mb-2 block">
                      Order
                    </label>
                    <Select
                      value={sortOrder}
                      onValueChange={(v) => setSortOrder(v as "asc" | "desc")}
                    >
                      <SelectTrigger className="bg-muted border-border text-foreground">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-muted border-border">
                        <SelectItem
                          value="desc"
                          className="text-foreground hover:bg-accent"
                        >
                          <div className="flex items-center gap-2">
                            <ArrowUpDown className="h-4 w-4" />
                            Newest First
                          </div>
                        </SelectItem>
                        <SelectItem
                          value="asc"
                          className="text-foreground hover:bg-accent"
                        >
                          <div className="flex items-center gap-2">
                            <ArrowUpDown className="h-4 w-4 rotate-180" />
                            Oldest First
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-end">
                    <Button
                      variant={showArchived ? "default" : "outline"}
                      onClick={() => setShowArchived(!showArchived)}
                      className="w-full bg-muted border-border text-foreground hover:bg-accent"
                    >
                      {showArchived ? (
                        <>
                          <ArchiveRestore className="h-4 w-4 mr-2" />
                          Show Active
                        </>
                      ) : (
                        <>
                          <Archive className="h-4 w-4 mr-2" />
                          Show Archived
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Results Count */}
            {debouncedSearchQuery && totalCount > 0 && (
              <div className="mb-4">
                <p className="text-sm text-muted-foreground">
                  Found {totalCount} chat{totalCount !== 1 ? "s" : ""} matching
                  &quot;{debouncedSearchQuery}&quot;
                </p>
              </div>
            )}

            {/* Chat List */}
            {isLoading ? (
              <div className="space-y-4">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Card key={i} className="bg-card border-border">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-3">
                            <Skeleton className="h-10 w-10 rounded-full" />
                            <div className="flex-1">
                              <Skeleton className="h-5 w-40 mb-1" />
                              <div className="flex items-center gap-4">
                                <Skeleton className="h-3 w-20" />
                                <Skeleton className="h-3 w-24" />
                              </div>
                            </div>
                          </div>
                          <Skeleton className="h-3 w-3/4 ml-[52px]" />
                        </div>
                        <div className="flex items-center gap-1">
                          <Skeleton className="h-8 w-8 rounded-md" />
                          <Skeleton className="h-8 w-8 rounded-md" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : chats.length === 0 ? (
              <Card className="bg-card border-border">
                <CardContent className="p-12 text-center">
                  <MessageSquare className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-foreground mb-2">
                    No chats found
                  </h3>
                  <p className="text-muted-foreground">
                    {debouncedSearchQuery
                      ? "No chats match your search query."
                      : showArchived
                        ? "You don't have any archived chats."
                        : "Start a conversation on any page to save your chat history."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {chats.map((chat) => {
                  const PageIcon = getPageIcon(chat.pageIcon);
                  const messageCount = Array.isArray(chat.messages)
                    ? chat.messages.length
                    : 0;
                  const lastMessage =
                    Array.isArray(chat.messages) && chat.messages.length > 0
                      ? (chat.messages[chat.messages.length - 1] as any)
                      : null;

                  return (
                    <Card
                      key={chat.id}
                      className="bg-card border-border hover:border-border transition-colors"
                    >
                      <CardContent className="p-6">
                        <div className="flex items-start justify-between">
                          <div
                            className="flex-1 cursor-pointer"
                            onClick={() => handleOpenChat(chat)}
                          >
                            <div className="flex items-center gap-3 mb-3">
                              <div className="h-10 w-10 rounded-full bg-blue-600/20 flex items-center justify-center">
                                <PageIcon className="h-5 w-5 text-blue-500" />
                              </div>
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <h3 className="text-lg font-semibold text-foreground">
                                    {chat.pageName &&
                                    chat.pageName !== "StockSage"
                                      ? chat.pageName
                                      : PAGE_DISPLAY_NAMES[chat.pagePath] ||
                                        chat.pagePath}
                                  </h3>
                                  {chat.isArchived && (
                                    <Badge
                                      variant="secondary"
                                      className="bg-muted text-foreground/80"
                                    >
                                      <Archive className="h-3 w-3 mr-1" />
                                      Archived
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                                  <span className="flex items-center gap-1">
                                    <MessageSquare className="h-4 w-4" />
                                    {messageCount} messages
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <Clock className="h-4 w-4" />
                                    {formatDate(chat.lastMessageAt)}
                                  </span>
                                </div>
                                {lastMessage && (
                                  <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
                                    {lastMessage.content}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 ml-4">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleOpenChat(chat)}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </Button>
                            {chat.isArchived ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleUnarchive(chat)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <ArchiveRestore className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setSelectedChat(chat);
                                  setArchiveDialogOpen(true);
                                }}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSelectedChat(chat);
                                setDeleteDialogOpen(true);
                              }}
                              className="text-red-400 hover:text-red-300"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}

                {/* Pagination */}
                {totalCount > PAGE_SIZE && (
                  <PaginationControls
                    currentPage={currentPage}
                    totalPages={Math.ceil(totalCount / PAGE_SIZE)}
                    onPageChange={setCurrentPage}
                    pageSize={PAGE_SIZE}
                    totalItems={totalCount}
                    label="chats"
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "var(--shadow-hard)",
            color: "var(--ink)",
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "-0.4px",
                color: "var(--neg-text)",
              }}
            >
              Delete Chat
            </DialogTitle>
            <DialogDescription
              className="ser"
              style={{ fontSize: 16, color: "var(--ink-2)", lineHeight: 1.4 }}
            >
              Are you sure you want to delete this chat? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-end">
            <button
              type="button"
              onClick={() => {
                setDeleteDialogOpen(false);
                setSelectedChat(null);
              }}
              className="pf-bf sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="pf-bf sm danger"
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Confirmation Dialog */}
      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "var(--shadow-hard)",
            color: "var(--ink)",
          }}
        >
          <DialogHeader className="text-left">
            <DialogTitle
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: "-0.4px",
                color: "var(--ink)",
              }}
            >
              Archive Chat
            </DialogTitle>
            <DialogDescription
              className="ser"
              style={{ fontSize: 16, color: "var(--ink-2)", lineHeight: 1.4 }}
            >
              This chat will be archived and hidden from your active chats. You
              can unarchive it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-end">
            <button
              type="button"
              onClick={() => {
                setArchiveDialogOpen(false);
                setSelectedChat(null);
              }}
              className="pf-bf sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => selectedChat && handleArchive(selectedChat)}
              className="pf-bs sm"
            >
              Archive
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View Archived Chat Dialog */}
      <Dialog open={viewChatDialogOpen} onOpenChange={setViewChatDialogOpen}>
        <DialogContent
          className="max-w-3xl max-h-[80vh] flex flex-col"
          style={{
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "var(--shadow-hard)",
            color: "var(--ink)",
          }}
        >
          <DialogHeader className="text-left">
            <div className="flex items-center gap-3">
              {viewingChat && (
                <>
                  <div
                    className="grid place-items-center shrink-0"
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 9,
                      background: "var(--pop-3)",
                      border: "1.5px solid var(--ink)",
                      color: "#f7f3e6",
                      transform: "rotate(-3deg)",
                    }}
                  >
                    {(() => {
                      const PageIcon = getPageIcon(viewingChat.pageIcon);
                      return <PageIcon className="h-4 w-4" />;
                    })()}
                  </div>
                  <div className="flex-1">
                    <DialogTitle
                      className="flex items-center gap-2"
                      style={{
                        fontSize: 16,
                        fontWeight: 800,
                        letterSpacing: "-0.3px",
                        color: "var(--ink)",
                      }}
                    >
                      {/* Show actual page name if pageName is default "StockSage", otherwise show pageName (which includes scenario name for FIRE) */}
                      {viewingChat.pageName &&
                      viewingChat.pageName !== "StockSage"
                        ? viewingChat.pageName
                        : PAGE_DISPLAY_NAMES[viewingChat.pagePath] ||
                          viewingChat.pagePath}
                      {viewingChat.isArchived && (
                        <Badge
                          variant="secondary"
                          className="bg-muted text-foreground/80"
                        >
                          <Archive className="h-3 w-3 mr-1" />
                          Archived
                        </Badge>
                      )}
                    </DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                      {formatDate(viewingChat.lastMessageAt)} •{" "}
                      {Array.isArray(viewingChat.messages)
                        ? viewingChat.messages.length
                        : 0}{" "}
                      messages
                    </DialogDescription>
                  </div>
                </>
              )}
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto mt-4 space-y-4 pr-2">
            {viewingChat &&
              Array.isArray(viewingChat.messages) &&
              viewingChat.messages.map((message: any, index: number) => (
                <div
                  key={index}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg p-4 ${
                      message.role === "user"
                        ? "bg-blue-600 text-foreground"
                        : "bg-muted text-foreground/80 prose prose-sm dark:prose-invert prose-headings:text-current prose-p:text-foreground/80"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {message.role === "assistant" && (
                        <MessageSquare className="h-4 w-4 mt-1 flex-shrink-0 text-blue-400" />
                      )}
                      <div className="flex-1">
                        {message.role === "assistant" ? (
                          <ReactMarkdown
                            components={{
                              p: ({ children }) => (
                                <p className="mb-2 last:mb-0 text-sm">
                                  {children}
                                </p>
                              ),
                              ul: ({ children }) => (
                                <ul className="list-disc list-inside mb-2 space-y-1 text-sm">
                                  {children}
                                </ul>
                              ),
                              ol: ({ children }) => (
                                <ol className="list-decimal list-inside mb-2 space-y-1 text-sm">
                                  {children}
                                </ol>
                              ),
                              li: ({ children }) => (
                                <li className="text-foreground/80">
                                  {children}
                                </li>
                              ),
                              strong: ({ children }) => (
                                <strong className="font-semibold text-foreground">
                                  {children}
                                </strong>
                              ),
                              code: ({ children }) => (
                                <code className="bg-muted px-1 py-0.5 rounded text-xs text-emerald-400">
                                  {children}
                                </code>
                              ),
                              a: ({ href, children }) => (
                                <Link
                                  href={href || "#"}
                                  className="text-blue-400 underline hover:text-blue-300"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {children}
                                </Link>
                              ),
                            }}
                          >
                            {message.content}
                          </ReactMarkdown>
                        ) : (
                          <p className="text-sm whitespace-pre-wrap break-words">
                            {message.content}
                          </p>
                        )}
                        {message.timestamp && (
                          <p
                            className={`text-xs mt-2 ${
                              message.role === "user"
                                ? "text-blue-200"
                                : "text-muted-foreground"
                            }`}
                          >
                            {new Date(message.timestamp).toLocaleString()}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            {viewingChat &&
              (!Array.isArray(viewingChat.messages) ||
                viewingChat.messages.length === 0) && (
                <div className="text-center py-8 text-muted-foreground">
                  No messages in this chat
                </div>
              )}
          </div>
          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              onClick={() => {
                setViewChatDialogOpen(false);
                setViewingChat(null);
              }}
              className="border-border text-foreground/80 hover:bg-muted"
            >
              Close
            </Button>
            {viewingChat && viewingChat.isArchived && (
              <Button
                onClick={() => {
                  if (viewingChat) {
                    handleUnarchive(viewingChat);
                    setViewChatDialogOpen(false);
                    setViewingChat(null);
                  }
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <ArchiveRestore className="h-4 w-4 mr-2" />
                Unarchive
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
