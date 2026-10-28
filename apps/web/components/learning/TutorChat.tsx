"use client";

import { useState, useEffect, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import { Button } from "@usemoney/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@usemoney/ui/card";
import { Input } from "@usemoney/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { toast } from "sonner";
import { Brain, Send, Sparkles, Loader2, Zap } from "lucide-react";
import { cn } from "@usemoney/utils";
import Link from "next/link";
import { consumeAIQuery } from "@/lib/actions/subscription";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface TutorChatProps {
  /** Optional context to prepend to messages (e.g. lesson topic) */
  context?: string;
  /** Page path for the API call */
  pagePath?: string;
  /** Custom height class */
  heightClass?: string;
}

export function TutorChat({
  context,
  pagePath = "/learning",
  heightClass = "h-[600px]",
}: TutorChatProps) {
  const { user, isLoaded } = useUser();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "1",
      role: "assistant",
      content: context
        ? `I'm ready to help you learn about **${context}**. Ask me anything!`
        : "Welcome to AI Trading Tutor! I'm here to help you learn about stock markets, trading strategies, technical analysis, and more. What would you like to learn today?",
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
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
          });
        })
        .catch(() => {
          setSubscriptionAccess({
            fastQueriesUsed: 0,
            fastQueriesLimit: 0,
            advancedQueriesUsed: 0,
            advancedQueriesLimit: 0,
            canAccessAIQueries: false,
          });
        });
    }
  }, [user, isLoaded]);

  const refreshAccess = () => {
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
        });
      })
      .catch(() => {});
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    // MONEY-295: removed binary `canAccessAIQueries` gate. Server enforces:
    //   - Flash chat costs 0 credits → free for FREE plan
    //   - Out-of-credits returns 403 below
    // Previous gate blocked FREE users + the subscription-load race window.

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
      const queryResult = await consumeAIQuery(queryType);
      if (!queryResult.success) {
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: `Your ${queryType} queries have been exhausted. Visit [pricing page](/pricing) to upgrade.`,
          },
        ]);
        toast.error(queryResult.error || "Query limit reached");
        return;
      }

      refreshAccess();

      const contextPrefix = context
        ? `[Context: The user is learning about "${context}"] `
        : "";
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: contextPrefix + messageContent,
          queryType,
          pagePath,
        }),
      });

      const data = await res.json();
      if (data.error) {
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: data.error,
          },
        ]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content:
            data.response ||
            "I couldn't process that request. Please try again.",
        },
      ]);
    } catch {
      toast.error("Failed to get response");
    } finally {
      setIsLoading(false);
      refreshAccess();
    }
  };

  const renderQueryRemaining = (type: "fast" | "advanced") => {
    if (!subscriptionAccess) return "";
    const used =
      type === "fast"
        ? subscriptionAccess.fastQueriesUsed
        : subscriptionAccess.advancedQueriesUsed;
    const limit =
      type === "fast"
        ? subscriptionAccess.fastQueriesLimit
        : subscriptionAccess.advancedQueriesLimit;
    if (limit === -1) return "unlimited";
    return `${Math.max(0, limit - used)} remaining`;
  };

  return (
    <Card className={cn("flex flex-col", heightClass)}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-primary" />
          {context
            ? `Ask about: ${context}`
            : "Chat with Financial Education AI"}
        </CardTitle>
        <CardDescription>
          Ask anything about trading, markets, or investing
        </CardDescription>
        {subscriptionAccess && (
          <div className="mt-3">
            <Select
              value={queryType}
              onValueChange={(v) => setQueryType(v as "fast" | "advanced")}
            >
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue>
                  <div className="flex items-center w-full gap-2">
                    <div className="flex items-center gap-2">
                      {queryType === "fast" ? (
                        <Zap className="h-3 w-3" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      <span>{queryType === "fast" ? "Fast" : "Advanced"}</span>
                    </div>
                    <span className="text-muted-foreground text-xs ml-auto">
                      {renderQueryRemaining(queryType)}
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
                      {renderQueryRemaining("fast")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="advanced">
                  <div className="flex items-center w-full gap-2">
                    <Sparkles className="h-3 w-3" />
                    <span>Advanced</span>
                    <span className="text-muted-foreground text-xs whitespace-nowrap ml-auto pr-4">
                      {renderQueryRemaining("advanced")}
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex",
              msg.role === "user" ? "justify-end" : "justify-start"
            )}
          >
            <div
              className={cn(
                "max-w-[80%] rounded-lg px-4 py-2",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              )}
            >
              <div className="whitespace-pre-wrap text-sm">
                {msg.content.includes("[") && msg.content.includes("](") ? (
                  <>
                    {msg.content.split(/(\[.*?\]\(.*?\))/g).map((part, idx) => {
                      const linkMatch = part.match(/\[(.*?)\]\((.*?)\)/);
                      if (linkMatch) {
                        const [, linkText, linkUrl] = linkMatch;
                        return (
                          <Link
                            key={idx}
                            href={linkUrl}
                            className="text-primary underline hover:no-underline"
                          >
                            {linkText}
                          </Link>
                        );
                      }
                      return <span key={idx}>{part}</span>;
                    })}
                  </>
                ) : (
                  msg.content
                )}
              </div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </CardContent>
      <CardFooter className="border-t p-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex gap-2 w-full"
        >
          <Input
            placeholder="Ask about trading concepts, strategies, analysis..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isLoading}
            className="flex-1"
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </CardFooter>
    </Card>
  );
}
