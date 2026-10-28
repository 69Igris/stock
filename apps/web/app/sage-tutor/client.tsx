"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { toast } from "sonner";
import { Send, Sparkles, Loader2, Zap } from "lucide-react";
import Link from "next/link";
import { consumeAIQuery } from "@/lib/actions/subscription";
import { PageGuard } from "@/components/PageGuard";
import { TutorSkeleton } from "@/components/skeletons";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/* Render an assistant/user message, linkifying [text](url) markdown links. */
function MessageBody({ content }: { content: string }) {
  if (content.includes("[") && content.includes("](")) {
    return (
      <>
        {content.split(/(\[.*?\]\(.*?\))/g).map((part, idx) => {
          const linkMatch = part.match(/\[(.*?)\]\((.*?)\)/);
          if (linkMatch) {
            const [, linkText, linkUrl] = linkMatch;
            return (
              <Link
                key={idx}
                href={linkUrl}
                style={{ color: "var(--emerald)", textDecoration: "underline" }}
              >
                {linkText}
              </Link>
            );
          }
          return <span key={idx}>{part}</span>;
        })}
      </>
    );
  }
  return <>{content}</>;
}

export default function TutorPage() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isMobile = useIsMobile();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "assistant",
      content:
        "Welcome to StockSage Tutor! I'm here to help you learn about stock markets, trading strategies, technical analysis, and more. What would you like to learn today?",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [queryType, setQueryType] = useState<"fast" | "advanced">("fast");
  const [subscriptionAccess, setSubscriptionAccess] = useState<{
    fastQueriesUsed: number;
    fastQueriesLimit: number;
    advancedQueriesUsed: number;
    advancedQueriesLimit: number;
    canAccessAIQueries: boolean;
    // Deprecated but still supported
    slowQueriesUsed?: number;
    slowQueriesLimit?: number;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isDemoMode = useIsDemoMode({ user });
  const demoModeReady = useIsDemoModeReady();

  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) {
      router.push("/home");
    }
  }, [isLoaded, demoModeReady, user, router, isDemoMode]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (user && isLoaded) {
      fetch("/api/subscription/access")
        .then((res) => res.json())
        .then((access) => {
          setSubscriptionAccess({
            fastQueriesUsed: access.fastQueriesUsed || 0,
            fastQueriesLimit: access.fastQueriesLimit || 0,
            advancedQueriesUsed:
              access.advancedQueriesUsed || access.slowQueriesUsed || 0,
            advancedQueriesLimit:
              access.advancedQueriesLimit || access.slowQueriesLimit || 0,
            canAccessAIQueries: access.canAccessAIQueries || false,
            slowQueriesUsed: access.slowQueriesUsed,
            slowQueriesLimit: access.slowQueriesLimit,
          });
        })
        .catch((error) => {
          console.error("Failed to load subscription access:", error);
          setSubscriptionAccess({
            fastQueriesUsed: 0,
            fastQueriesLimit: 0,
            advancedQueriesUsed: 0,
            advancedQueriesLimit: 0,
            canAccessAIQueries: false,
            slowQueriesUsed: 0,
            slowQueriesLimit: 0,
          });
        });
    }
  }, [user, isLoaded]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    // MONEY-295: removed binary `canAccessAIQueries` gate. Server enforces:
    //   - Flash chat costs 0 credits → free for FREE plan
    //   - Out-of-credits returns 403 with credit-specific copy below
    // The previous check blocked FREE users (and during the
    // subscription-load race) despite Flash being free server-side.

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };
    setMessages((prev) => [...prev, userMessage]);
    const messageContent = input.trim();
    setInput("");
    setIsLoading(true);

    try {
      // Check query limit
      const queryResult = await consumeAIQuery(queryType);

      if (!queryResult.success) {
        const exhaustedMessage = `Your ${queryType} queries have been exhausted. Please add more queries or upgrade your plan to continue. Visit [pricing page](/pricing) to upgrade.`;
        const errorMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: exhaustedMessage,
        };
        setMessages((prev) => [...prev, errorMessage]);
        setIsLoading(false);
        toast.error(queryResult.error || "Query limit reached");
        return;
      }

      // Refresh subscription access
      fetch("/api/subscription/access")
        .then((res) => res.json())
        .then((access) => {
          setSubscriptionAccess({
            fastQueriesUsed: access.fastQueriesUsed || 0,
            fastQueriesLimit: access.fastQueriesLimit || 0,
            advancedQueriesUsed:
              access.advancedQueriesUsed || access.slowQueriesUsed || 0,
            advancedQueriesLimit:
              access.advancedQueriesLimit || access.slowQueriesLimit || 0,
            canAccessAIQueries: access.canAccessAIQueries || false,
            slowQueriesUsed: access.slowQueriesUsed,
            slowQueriesLimit: access.slowQueriesLimit,
          });
        })
        .catch((error) => {
          console.error("Failed to refresh subscription access:", error);
        });

      // Make API call
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: messageContent,
          queryType: queryType,
          pagePath: "/sage-tutor",
        }),
      });

      const data = await res.json();

      // Check for API errors
      if (data.error) {
        const errorMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: data.error,
        };
        setMessages((prev) => [...prev, errorMessage]);
        setIsLoading(false);
        return;
      }

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content:
          data.response ||
          "I apologize, I couldn't process that request. Please try again.",
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      toast.error("Failed to get response");
    } finally {
      setIsLoading(false);

      // Refresh subscription access after API call
      fetch("/api/subscription/access")
        .then((res) => res.json())
        .then((access) => {
          setSubscriptionAccess({
            fastQueriesUsed: access.fastQueriesUsed || 0,
            fastQueriesLimit: access.fastQueriesLimit || 0,
            advancedQueriesUsed: access.advancedQueriesUsed || 0,
            advancedQueriesLimit: access.advancedQueriesLimit || 0,
            canAccessAIQueries: access.canAccessAIQueries || false,
          });
        })
        .catch((error) => {
          console.error("Failed to refresh subscription access:", error);
        });
    }
  };

  const remaining = (used: number, limit: number) =>
    limit === -1
      ? "∞ remaining"
      : limit === 0
        ? "0 remaining"
        : `${Math.max(0, limit - used)} remaining`;

  return (
    <PageGuard
      route="/sage-tutor"
      fallback={<TutorSkeleton />}
      containerClassName="p-6 max-w-5xl mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div
            className={`pf-page${isMobile ? " is-mobile" : ""}`}
            style={{ maxWidth: 960, margin: "0 auto" }}
          >
            {isDemoMode && <DemoBanner />}

            {/* ── Page heading ── */}
            <div className={`pf-ph${isMobile ? " is-mobile" : ""}`}>
              <div className="l">
                <div className="eyebrow">
                  <span className="d" aria-hidden />
                  LEARN · SAGE TUTOR
                </div>
                <h1>
                  Ask anything, <span className="ser">learn everything.</span>
                </h1>
                <div className="sub">
                  AI-powered trading education and tutoring.
                </div>
              </div>
              {/* Learning hidden per request — re-enable to restore the
                  "Courses" link back to /learning. */}
              {/* <div className="r">
                <Link href="/learning" className="pf-bf">
                  <Sparkles size={13} /> Courses
                </Link>
              </div> */}
            </div>

            {/* ── Chat panel ── */}
            <div
              className="pf-card"
              style={{
                padding: 0,
                display: "flex",
                flexDirection: "column",
                height: isMobile ? "calc(100vh - 280px)" : 600,
                minHeight: 420,
                overflow: "hidden",
              }}
            >
              {/* Header + query type selector */}
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: "2px solid var(--ink)",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  background: "var(--paper-2)",
                }}
              >
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: "var(--emerald)",
                    color: "var(--paper)",
                    display: "grid",
                    placeItems: "center",
                    border: "1.5px solid var(--ink)",
                    transform: "rotate(-3deg)",
                    flexShrink: 0,
                  }}
                >
                  <Sparkles size={15} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 800,
                      letterSpacing: -0.3,
                      color: "var(--ink)",
                    }}
                  >
                    Financial Education AI
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                  >
                    Ask about trading, markets, or investing
                  </div>
                </div>
                {subscriptionAccess && (
                  <Select
                    value={queryType}
                    onValueChange={(v) =>
                      setQueryType(v as "fast" | "advanced")
                    }
                  >
                    <SelectTrigger className="h-8 text-xs w-[200px]">
                      <SelectValue>
                        <div className="flex items-center w-full gap-2">
                          <div className="flex items-center gap-2">
                            {queryType === "fast" ? (
                              <Zap className="h-3 w-3" />
                            ) : (
                              <Sparkles className="h-3 w-3" />
                            )}
                            <span>
                              {queryType === "fast" ? "Fast" : "Advanced"}
                            </span>
                          </div>
                          <span className="text-muted-foreground text-xs ml-auto">
                            {queryType === "fast"
                              ? remaining(
                                  subscriptionAccess.fastQueriesUsed,
                                  subscriptionAccess.fastQueriesLimit
                                )
                              : remaining(
                                  subscriptionAccess.advancedQueriesUsed,
                                  subscriptionAccess.advancedQueriesLimit
                                )}
                          </span>
                        </div>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fast">
                        <div className="flex items-center w-full gap-2">
                          <Zap className="h-3 w-3" />
                          <span>Fast</span>
                          <span className="text-muted-foreground text-xs whitespace-nowrap ml-auto pr-4">
                            {remaining(
                              subscriptionAccess.fastQueriesUsed,
                              subscriptionAccess.fastQueriesLimit
                            )}
                          </span>
                        </div>
                      </SelectItem>
                      <SelectItem value="advanced">
                        <div className="flex items-center w-full gap-2">
                          <Sparkles className="h-3 w-3" />
                          <span>Advanced</span>
                          <span className="text-muted-foreground text-xs whitespace-nowrap ml-auto pr-4">
                            {remaining(
                              subscriptionAccess.advancedQueriesUsed,
                              subscriptionAccess.advancedQueriesLimit
                            )}
                          </span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Messages */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: 18,
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                {messages.map((msg) =>
                  msg.role === "user" ? (
                    <div
                      key={msg.id}
                      style={{
                        alignSelf: "flex-end",
                        maxWidth: "85%",
                        padding: "10px 14px",
                        borderRadius: 12,
                        background: "var(--ink)",
                        color: "var(--paper)",
                        fontSize: 13,
                        lineHeight: 1.5,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      <MessageBody content={msg.content} />
                    </div>
                  ) : (
                    <div
                      key={msg.id}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                        maxWidth: "92%",
                      }}
                    >
                      <span
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 6,
                          background: "var(--emerald)",
                          color: "var(--paper)",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          border: "1.5px solid var(--ink)",
                        }}
                      >
                        <Sparkles size={12} />
                      </span>
                      <div
                        style={{
                          flex: 1,
                          fontSize: 13,
                          lineHeight: 1.55,
                          color: "var(--ink-2)",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        <MessageBody content={msg.content} />
                      </div>
                    </div>
                  )
                )}
                {isLoading && (
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        background: "var(--emerald)",
                        color: "var(--paper)",
                        display: "grid",
                        placeItems: "center",
                        border: "1.5px solid var(--ink)",
                      }}
                    >
                      <Loader2 size={12} className="animate-spin" />
                    </span>
                    <span
                      className="ser"
                      style={{ fontSize: 13, color: "var(--ink-3)" }}
                    >
                      Thinking…
                    </span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div
                style={{
                  borderTop: "2px solid var(--ink)",
                  padding: 14,
                  background: "var(--paper-2)",
                }}
              >
                <DemoGate
                  isDemoMode={isDemoMode}
                  message="Sign up to chat with the AI tutor"
                >
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleSend();
                    }}
                    style={{ display: "flex", gap: 8, width: "100%" }}
                  >
                    <div
                      className="pf-input"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flex: 1,
                        padding: "9px 12px",
                      }}
                    >
                      <Sparkles
                        size={14}
                        style={{ color: "var(--emerald)", flexShrink: 0 }}
                      />
                      <input
                        placeholder="Ask anything…"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        disabled={isLoading}
                        style={{
                          border: 0,
                          padding: 0,
                          background: "transparent",
                          color: "var(--ink)",
                          fontSize: 13.5,
                          flex: 1,
                          outline: "none",
                          fontFamily: "inherit",
                        }}
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={isLoading || !input.trim()}
                      className="pf-bs"
                      style={{
                        cursor:
                          isLoading || !input.trim() ? "default" : "pointer",
                        opacity: isLoading || !input.trim() ? 0.6 : 1,
                      }}
                    >
                      <Send size={14} />
                    </button>
                  </form>
                </DemoGate>
              </div>
            </div>
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
