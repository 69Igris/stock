"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import { useUser } from "@clerk/nextjs";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@usemoney/ui/button";
import { ChatProvider, useChatContext } from "@/lib/chat/ChatContext";
import ChatMessageList from "./ChatMessageList";
import ChatPromptArea from "./ChatPromptArea";
import ChatLauncherButton from "./ChatLauncherButton";
import {
  MessageSquare,
  X,
  Sparkles,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@usemoney/utils";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";
import type { ChatContextMode } from "@usemoney/types";
import { AI_ADVISORY_DISCLOSURE } from "@/lib/consent/ai-advisory";
import { useOwnedRoute } from "@/lib/hooks/useOwnedRoute";

interface EmbeddedChatPanelProps {
  pageName?: string;
  defaultContext?: ChatContextMode;
  userContext?: string;
  icon?: LucideIcon;
  buttonClassName?: string;
  /** Overrides on the launcher's inline geometry (notably `bottom`, which a
      class cannot override — see ChatLauncherButton). */
  buttonStyle?: CSSProperties;
  headerIconClassName?: string;
  hideContextSelector?: boolean;
}

export default function EmbeddedChatPanel({
  pageName = "StockSage",
  defaultContext,
  userContext,
  icon: Icon,
  buttonClassName,
  buttonStyle,
  headerIconClassName,
  hideContextSelector,
}: EmbeddedChatPanelProps) {
  const { user, isLoaded } = useUser();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ownedRoute = useOwnedRoute();
  const [isOpen, setIsOpen] = useState(false);
  const isClosingRef = useRef(false);

  const isDemoMode = useIsDemoMode({ user });
  const isRealUser = isLoaded && !!user;
  const userName = user?.fullName || user?.firstName || "Trader";

  const chatIdFromUrl = searchParams?.get("chatId") || undefined;

  // Auto-open panel when chatId is in URL
  useEffect(() => {
    if (isClosingRef.current) return;
    if (chatIdFromUrl && !isOpen) {
      setIsOpen(true);
    }
  }, [chatIdFromUrl, isOpen]);

  // Strip chatId from URL without closing
  const stripChatIdFromUrl = useCallback(() => {
    if (chatIdFromUrl && pathname) {
      const params = new URLSearchParams(searchParams?.toString() || "");
      params.delete("chatId");
      const newUrl = params.toString()
        ? `${pathname}?${params.toString()}`
        : pathname;
      // MONEY-1082: this panel is rendered on many routes and `pathname` is
      // captured at render, so an unguarded replace could drag the user back
      // to whichever page the panel was opened on. Stays a navigation because
      // `chatIdFromUrl` is read back out of useSearchParams.
      ownedRoute.replaceRoute(newUrl);
    }
  }, [chatIdFromUrl, pathname, searchParams, ownedRoute]);

  // Handle close - strip chatId from URL and close panel
  const handleClose = useCallback(() => {
    isClosingRef.current = true;
    stripChatIdFromUrl();
    setIsOpen(false);
    setTimeout(() => {
      isClosingRef.current = false;
    }, 100);
  }, [stripChatIdFromUrl]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, handleClose]);

  return (
    <>
      {/* Toggle button on right edge */}
      {!isOpen && (
        <ChatLauncherButton
          onClick={() => setIsOpen(true)}
          className={buttonClassName}
          /* `bottom` is an inline style on the launcher, which outranks every
             class — so a caller repositioning it via buttonClassName="bottom-32"
             would be silently ignored. buttonStyle is merged after the defaults
             and is the supported way to move it (MONEY-1151). */
          style={buttonStyle}
          title={`Open ${pageName}`}
        >
          {Icon ? (
            <Icon className="h-4 w-4" />
          ) : (
            <MessageSquare className="h-4 w-4" />
          )}
          <span className="hidden sm:inline">{pageName}</span>
        </ChatLauncherButton>
      )}

      {/* Side panel — sits BELOW the global topbar+ticker so it never
          overlaps the nav chrome. --topbar-h = 5.25rem (topbar row 56px +
          ticker 28px). The panel height shrinks accordingly, and also by
          --mobile-nav-h so the bottom bar can't cover the composer. */}
      <div
        className={cn(
          "fixed right-0 z-50 transition-transform duration-300 ease-in-out",
          "w-full sm:w-[380px] bg-[var(--paper)] border-l border-[var(--rule-soft)] shadow-2xl",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
        style={{
          top: "var(--topbar-h, 5.25rem)",
          height:
            "calc(100dvh - var(--topbar-h, 5.25rem) - var(--mobile-nav-h, 0px))",
        }}
      >
        <ChatProvider
          userName={userName}
          isRealUser={isRealUser}
          isDemoMode={isDemoMode}
          pagePath={pathname || "/"}
          initialChatId={isOpen ? chatIdFromUrl : undefined}
          defaultContext={defaultContext}
          userContext={userContext}
          hideContextSelector={hideContextSelector}
        >
          <div className="flex flex-col h-full pf-app">
            {/* Header */}
            <ChatPanelHeader
              pageName={pageName}
              onClose={handleClose}
              onStripChatId={stripChatIdFromUrl}
              icon={Icon}
              headerIconClassName={headerIconClassName}
            />

            {/* MONEY-501 (SEBI Reg 18(9)): always-on AI-advisory micro-
                disclosure at the chat entry point. */}
            <div
              className="px-4 py-1.5 shrink-0 text-[10px] leading-tight text-[var(--ink-3)]"
              style={{ borderBottom: "1px solid var(--rule-soft)" }}
            >
              {AI_ADVISORY_DISCLOSURE.short}
            </div>

            {/* Messages */}
            <ChatMessageList />

            {/* Input */}
            <div
              className="p-3 shrink-0"
              style={{ borderTop: "2px solid var(--ink)" }}
            >
              <ChatPromptArea />
            </div>
          </div>
        </ChatProvider>
      </div>

      {/* Backdrop on mobile */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 sm:hidden"
          onClick={handleClose}
        />
      )}
    </>
  );
}

/** Inner header rendered inside ChatProvider so it can access context */
function ChatPanelHeader({
  pageName,
  onClose,
  onStripChatId,
  icon: Icon,
  headerIconClassName,
}: {
  pageName: string;
  onClose: () => void;
  onStripChatId: () => void;
  icon?: LucideIcon;
  headerIconClassName?: string;
}) {
  const { messages, clearChat } = useChatContext();

  const handleNewChat = () => {
    clearChat();
    onStripChatId();
  };

  return (
    <div
      className="flex items-center justify-between px-4 py-3 shrink-0"
      style={{ borderBottom: "2px solid var(--ink)" }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className={cn(
            "grid place-items-center shrink-0",
            headerIconClassName
          )}
          style={{
            width: 28,
            height: 28,
            borderRadius: 7,
            background: "var(--emerald)",
            color: "var(--paper)",
            border: "1.5px solid var(--ink)",
            transform: "rotate(-3deg)",
          }}
        >
          {Icon ? (
            <Icon className="h-4 w-4" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
        </div>
        <div className="leading-tight">
          <div
            style={{
              fontSize: 14,
              fontWeight: 800,
              color: "var(--ink)",
              letterSpacing: "-0.3px",
            }}
          >
            {pageName}
          </div>
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              color: "var(--ink-3)",
              letterSpacing: "0.5px",
            }}
          >
            AI research assistant
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {messages.length > 0 && (
          <button
            type="button"
            onClick={handleNewChat}
            className="pf-bf sm"
            title="Start new chat"
            style={{ padding: "5px 10px" }}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="pf-bf sm"
          aria-label="Close"
          style={{ padding: "5px 8px" }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
