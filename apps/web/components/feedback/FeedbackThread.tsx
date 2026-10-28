"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Image from "next/image";
import { Skeleton } from "@usemoney/ui/skeleton";
import {
  ArrowLeft,
  Send,
  Loader2,
  Bug,
  Lightbulb,
  Wrench,
  HelpCircle,
  MoreHorizontal,
  Paperclip,
  Clock,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@usemoney/ui/dialog";
import { toast } from "sonner";
import {
  getFeedbackThreadAction,
  addFeedbackReplyAction,
  type FeedbackThread as FeedbackThreadType,
} from "@/lib/actions/feedback";
import { ImageDropZone, type UploadedImage } from "./ImageDropZone";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  BUG: Bug,
  FEATURE_REQUEST: Lightbulb,
  IMPROVEMENT: Wrench,
  QUESTION: HelpCircle,
  OTHER: MoreHorizontal,
};

const TYPE_LABEL: Record<string, string> = {
  BUG: "Bug Report",
  FEATURE_REQUEST: "Feature Request",
  IMPROVEMENT: "Improvement",
  QUESTION: "Question",
  OTHER: "Other",
};

const STATUS_UI: Record<
  string,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
  }
> = {
  OPEN: {
    label: "Open",
    icon: Clock,
    color: "text-amber-500 bg-amber-500/10 border-amber-500/30",
  },
  IN_PROGRESS: {
    label: "In Progress",
    icon: Loader2,
    color: "text-blue-500 bg-blue-500/10 border-blue-500/30",
  },
  PLANNED: {
    label: "Planned",
    icon: CheckCircle2,
    color: "text-violet-500 bg-violet-500/10 border-violet-500/30",
  },
  COMPLETED: {
    label: "Completed",
    icon: CheckCircle2,
    color: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
  },
  DECLINED: {
    label: "Declined",
    icon: AlertCircle,
    color: "text-red-500 bg-red-500/10 border-red-500/30",
  },
  DUPLICATE: {
    label: "Duplicate",
    icon: AlertCircle,
    color: "text-muted-foreground bg-muted/40 border-border/30",
  },
};

function formatDate(date: Date): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({
  sender,
  isUser,
  message,
  imageUrls,
  time,
  onImageClick,
}: {
  sender: string;
  isUser: boolean;
  message: string;
  imageUrls: string[];
  time: Date;
  onImageClick: (url: string) => void;
}) {
  const align = isUser ? "justify-end" : "justify-start";

  return (
    <>
      {/* Text bubble */}
      {message && (
        <div className={cn("flex", align)}>
          <div
            style={{
              maxWidth: "78%",
              borderRadius: 14,
              padding: "10px 14px",
              ...(isUser
                ? {
                    background: "var(--emerald-bg)",
                    border: "1.5px solid var(--emerald)",
                    color: "var(--ink)",
                    borderBottomRightRadius: 4,
                  }
                : {
                    background: "var(--paper-2)",
                    border: "1.5px solid var(--rule-soft)",
                    color: "var(--ink)",
                    borderBottomLeftRadius: 4,
                  }),
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 4,
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  color: isUser ? "var(--emerald-text)" : "var(--ink-3)",
                }}
              >
                {sender}
              </span>
              <span
                className="mono"
                style={{ fontSize: 9.5, color: "var(--ink-4)" }}
              >
                {formatDate(time)}
              </span>
            </div>
            <p
              style={{
                fontSize: 13,
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
                color: "var(--ink)",
              }}
            >
              {message}
            </p>
          </div>
        </div>
      )}

      {/* Each image as its own bubble */}
      {imageUrls.map((url, i) => (
        <div key={i} className={cn("flex", align)}>
          <div
            style={{
              maxWidth: "60%",
              borderRadius: 14,
              overflow: "hidden",
              border: "1.5px solid var(--rule-soft)",
              ...(isUser
                ? { borderColor: "var(--emerald)", borderBottomRightRadius: 4 }
                : { borderBottomLeftRadius: 4 }),
            }}
          >
            <button
              type="button"
              onClick={() => onImageClick(url)}
              className="relative w-full hover:opacity-90 transition-opacity block"
            >
              <Image
                src={url}
                alt={`Attachment ${i + 1}`}
                width={480}
                height={320}
                className="w-full h-auto object-contain"
                unoptimized
              />
            </button>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                padding: "4px 10px",
                background: isUser ? "var(--emerald-bg)" : "var(--paper-2)",
              }}
            >
              <span
                className="mono"
                style={{ fontSize: 9.5, color: "var(--ink-4)" }}
              >
                {formatDate(time)}
              </span>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// FeedbackThread
// ---------------------------------------------------------------------------

interface FeedbackThreadProps {
  feedbackId: string;
  onBack: () => void;
}

export function FeedbackThread({ feedbackId, onBack }: FeedbackThreadProps) {
  const [thread, setThread] = useState<FeedbackThreadType | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [replyText, setReplyText] = useState("");
  const [replyImages, setReplyImages] = useState<UploadedImage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [showAttachments, setShowAttachments] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadThread = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await getFeedbackThreadAction(feedbackId);
      if (result?.success && result?.data) {
        setThread(result.data);
      } else {
        toast.error(result?.error || "Failed to load thread");
      }
    } catch {
      toast.error("Failed to load thread");
    } finally {
      setIsLoading(false);
    }
  }, [feedbackId]);

  useEffect(() => {
    loadThread();
  }, [loadThread]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.replies.length]);

  const handleSendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyText.trim() || isSending) return;

    setIsSending(true);
    try {
      const imagePaths = replyImages
        .filter((img) => img.status === "uploaded" && img.path)
        .map((img) => img.path!);

      const result = await addFeedbackReplyAction({
        feedbackId,
        message: replyText.trim(),
        images: imagePaths.length > 0 ? imagePaths : undefined,
      });

      if (result?.success) {
        setReplyText("");
        setReplyImages([]);
        setShowAttachments(false);
        loadThread();
      } else {
        toast.error(result?.error || "Failed to send reply");
      }
    } catch {
      toast.error("Failed to send reply");
    } finally {
      setIsSending(false);
    }
  };

  // Loading
  if (isLoading) {
    return (
      <div className="space-y-4">
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: "var(--ink-3)",
            background: "none",
            border: 0,
            cursor: "pointer",
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to submissions
        </button>
        <div className="space-y-4">
          <Skeleton
            className="h-24 w-full rounded-xl"
            style={{ background: "var(--rule-softer)" }}
          />
          <Skeleton
            className="h-16 w-3/4 ml-auto rounded-xl"
            style={{ background: "var(--rule-softer)" }}
          />
          <Skeleton
            className="h-16 w-3/4 rounded-xl"
            style={{ background: "var(--rule-softer)" }}
          />
        </div>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="space-y-4">
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: "var(--ink-3)",
            background: "none",
            border: 0,
            cursor: "pointer",
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to submissions
        </button>
        <div
          className="pf-card flat"
          style={{ padding: "32px 24px", textAlign: "center" }}
        >
          <AlertCircle
            className="h-10 w-10 mx-auto mb-3"
            style={{ color: "var(--ink-4)" }}
          />
          <p style={{ fontWeight: 600, color: "var(--ink)" }}>
            Feedback not found
          </p>
        </div>
      </div>
    );
  }

  const { feedback, replies } = thread;
  const TypeIcon = TYPE_ICON[feedback.type] || MoreHorizontal;
  const statusUi = STATUS_UI[feedback.status] || STATUS_UI.OPEN;
  const StatusIcon = statusUi.icon;
  const isClosed =
    feedback.status === "COMPLETED" || feedback.status === "DECLINED";

  return (
    <div className="flex flex-col h-[calc(100vh-var(--topbar-h)-2rem)] lg:h-[calc(100vh-var(--topbar-h)-3rem)]">
      {/* Top bar - back + title + badges */}
      <div
        className="shrink-0"
        style={{
          borderBottom: "1.5px dashed var(--rule-soft)",
          background: "var(--paper-2)",
          padding: "12px 16px",
        }}
      >
        <button
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12.5,
            color: "var(--ink-3)",
            background: "none",
            border: 0,
            cursor: "pointer",
            marginBottom: 10,
          }}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to submissions
        </button>
        <div className="flex items-center justify-between gap-4">
          <h2
            style={{
              fontSize: 15,
              fontWeight: 800,
              letterSpacing: -0.3,
              color: "var(--ink)",
              lineHeight: 1.2,
            }}
            className="truncate"
          >
            {feedback.title}
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            <span className="pf-pill outline" style={{ fontSize: 9.5 }}>
              <TypeIcon className="h-3 w-3" />
              {TYPE_LABEL[feedback.type] || "Other"}
            </span>
            <span className="pf-pill outline" style={{ fontSize: 9.5 }}>
              <StatusIcon className="h-3 w-3" />
              {statusUi.label}
            </span>
          </div>
        </div>
      </div>

      {/* Scrollable messages area */}
      <div className="flex-1 overflow-y-auto py-4 space-y-3 min-h-0">
        {/* Original message */}
        <MessageBubble
          sender="You"
          isUser
          message={feedback.description}
          imageUrls={feedback.imageUrls}
          time={feedback.createdAt}
          onImageClick={setLightboxUrl}
        />

        {/* Admin note (legacy) */}
        {feedback.adminNote && replies.length === 0 && (
          <MessageBubble
            sender="UseMoney Team"
            isUser={false}
            message={feedback.adminNote}
            imageUrls={[]}
            time={feedback.updatedAt}
            onImageClick={setLightboxUrl}
          />
        )}

        {/* Replies */}
        {replies.map((reply) => (
          <MessageBubble
            key={reply.id}
            sender={reply.isAdmin ? "UseMoney Team" : "You"}
            isUser={!reply.isAdmin}
            message={reply.message}
            imageUrls={reply.imageUrls}
            time={reply.createdAt}
            onImageClick={setLightboxUrl}
          />
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Sticky reply input at bottom */}
      <div
        className="shrink-0"
        style={{
          borderTop: "1.5px dashed var(--rule-soft)",
          padding: "12px 16px",
          background: "var(--paper-2)",
        }}
      >
        {!isClosed ? (
          <form onSubmit={handleSendReply} className="space-y-2">
            {showAttachments && (
              <ImageDropZone
                images={replyImages}
                onImagesChange={setReplyImages}
                disabled={isSending}
              />
            )}

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => setShowAttachments(!showAttachments)}
                style={{
                  padding: 8,
                  borderRadius: 8,
                  border: "1.5px solid var(--rule-soft)",
                  background: showAttachments
                    ? "var(--emerald-bg)"
                    : "transparent",
                  color: showAttachments
                    ? "var(--emerald-text)"
                    : "var(--ink-3)",
                  cursor: "pointer",
                  transition: "all 0.12s",
                  flexShrink: 0,
                }}
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (replyText.trim()) handleSendReply(e);
                  }
                }}
                placeholder="Write a reply… (Enter to send)"
                rows={1}
                className="pf-input resize-none"
                disabled={isSending}
                style={{
                  flex: 1,
                  minHeight: 72,
                  maxHeight: 200,
                  fontSize: 13,
                  lineHeight: 1.45,
                }}
                onInput={(e) => {
                  const el = e.target as HTMLTextAreaElement;
                  el.style.height = "72px";
                  el.style.height = Math.min(el.scrollHeight, 200) + "px";
                }}
              />
              <button
                type="submit"
                disabled={isSending || !replyText.trim()}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: "50%",
                  background: "var(--emerald)",
                  color: "var(--paper)",
                  display: "grid",
                  placeItems: "center",
                  border: "none",
                  cursor:
                    isSending || !replyText.trim() ? "not-allowed" : "pointer",
                  opacity: isSending || !replyText.trim() ? 0.4 : 1,
                  flexShrink: 0,
                  transition: "opacity 0.12s",
                }}
              >
                {isSending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          </form>
        ) : (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 9,
              border: "1.5px dashed var(--rule-soft)",
              background: "var(--paper-2)",
              textAlign: "center",
            }}
          >
            <p className="ser" style={{ fontSize: 13, color: "var(--ink-3)" }}>
              This thread is{" "}
              <span
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontStyle: "normal",
                  fontWeight: 700,
                  color: "var(--ink)",
                }}
              >
                {feedback.status.toLowerCase().replace("_", " ")}
              </span>{" "}
              and closed for replies.
            </p>
          </div>
        )}
      </div>

      {/* Image lightbox */}
      <Dialog open={!!lightboxUrl} onOpenChange={() => setLightboxUrl(null)}>
        <DialogContent
          className="p-1"
          style={{
            maxWidth: 800,
            background: "var(--paper)",
            border: "2px solid var(--ink)",
            borderRadius: 16,
            boxShadow: "6px 6px 0 var(--ink)",
          }}
        >
          <DialogTitle className="sr-only">Attachment preview</DialogTitle>
          {lightboxUrl && (
            <div className="relative w-full" style={{ aspectRatio: "16/10" }}>
              <Image
                src={lightboxUrl}
                alt="Full size"
                fill
                className="object-contain rounded"
                unoptimized
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
