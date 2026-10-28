"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  Bug,
  Lightbulb,
  Wrench,
  HelpCircle,
  MoreHorizontal,
  Send,
  Plus,
  Loader2,
  ArrowLeft,
  CheckCheck,
  Check,
  X,
  Globe,
  MapPin,
  Paperclip,
} from "lucide-react";
import { toast } from "sonner";
import {
  getUserFeedbackAction,
  getFeedbackThreadAction,
  submitFeedbackAction,
  addFeedbackReplyAction,
  closeUserFeedbackAction,
  uploadFeedbackImageAction,
  type FeedbackItem,
  type FeedbackThread as FeedbackThreadData,
  type FeedbackReplyItem,
} from "@/lib/actions/feedback";
import {
  validateFeedbackImage,
  FEEDBACK_MAX_IMAGES,
} from "@/lib/feedback/attachments";
import { usePfConfirm } from "@/components/ui/use-confirm";

const TYPE_CONFIG: Record<
  string,
  {
    label: string;
    icon: React.ComponentType<{
      className?: string;
      style?: React.CSSProperties;
    }>;
    color: string; // tailwind classes for list avatars
    cssColor: string; // CSS var for chip border/tint (large-graphic accent)
    textColor: string; // AA-safe text/icon-label variant of cssColor
    initial: string;
  }
> = {
  BUG: {
    label: "Bug",
    icon: Bug,
    color: "bg-red-500/10 text-red-400 border-red-500/30",
    cssColor: "var(--pop-1)",
    textColor: "var(--pop-1-text)",
    initial: "B",
  },
  FEATURE_REQUEST: {
    label: "Feature",
    icon: Lightbulb,
    color: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    cssColor: "var(--pop-3)",
    textColor: "var(--pop-3-text)",
    initial: "F",
  },
  IMPROVEMENT: {
    label: "Improvement",
    icon: Wrench,
    color: "bg-violet-500/10 text-violet-400 border-violet-500/30",
    cssColor: "var(--pop-5)",
    textColor: "var(--pop-5-text)",
    initial: "I",
  },
  QUESTION: {
    label: "Question",
    icon: HelpCircle,
    color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
    cssColor: "var(--emerald)",
    textColor: "var(--emerald-text)",
    initial: "Q",
  },
  OTHER: {
    label: "Other",
    icon: MoreHorizontal,
    color: "bg-[var(--bg-segmented)] text-muted-foreground border-border",
    cssColor: "var(--pop-2)",
    textColor: "var(--pop-2-text)",
    initial: "O",
  },
};

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  OPEN: { label: "Open", color: "text-amber-400" },
  IN_PROGRESS: { label: "In progress", color: "text-blue-400" },
  PLANNED: { label: "Planned", color: "text-violet-400" },
  COMPLETED: { label: "Resolved", color: "text-emerald-400" },
  DECLINED: { label: "Declined", color: "text-red-400" },
  DUPLICATE: { label: "Duplicate", color: "text-muted-foreground" },
};

const FEEDBACK_TYPES = [
  { value: "BUG", label: "Bug" },
  { value: "FEATURE_REQUEST", label: "Feature" },
  { value: "IMPROVEMENT", label: "Improvement" },
  { value: "QUESTION", label: "Question" },
  { value: "OTHER", label: "Other" },
] as const;

function timeAgo(date: Date | string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(date).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
  });
}

function timeStamp(date: Date | string): string {
  return new Date(date).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getShortBrowser(): string {
  if (typeof navigator === "undefined") return "Unknown";
  const ua = navigator.userAgent;
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  return "Browser";
}

export default function FeedbackTab() {
  const pathname = usePathname();
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<FeedbackThreadData | null>(
    null
  );
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [isLoadingThread, setIsLoadingThread] = useState(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [reply, setReply] = useState("");
  const [isSendingReply, setIsSendingReply] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { confirm, confirmDialog } = usePfConfirm();
  const replyAtt = useTicketAttachments();

  // ── Loaders ─────────────────────────────────────────────────────
  // Stack-based nav: list (default) → thread (when activeId set) OR
  // new-form (when showNewForm set). No auto-open: clicking a ticket
  // navigates into the thread; back button returns to the list.
  const loadList = useCallback(async () => {
    setIsLoadingList(true);
    try {
      const result = await getUserFeedbackAction({ skip: 0, limit: 50 });
      if (result?.success && result?.data) {
        setItems(result.data.items);
      }
    } finally {
      setIsLoadingList(false);
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setIsLoadingThread(true);
    try {
      const result = await getFeedbackThreadAction(id);
      if (result?.success && result?.data) {
        setActiveThread(result.data);
      }
    } finally {
      setIsLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (activeId) loadThread(activeId);
  }, [activeId, loadThread]);

  // Auto-scroll to bottom on new replies
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeThread?.replies.length]);

  // ── Actions ─────────────────────────────────────────────────────
  const handleSendReply = async () => {
    if (!reply.trim() || !activeThread || isSendingReply) return;
    setIsSendingReply(true);
    try {
      const result = await addFeedbackReplyAction({
        feedbackId: activeThread.feedback.id,
        message: reply.trim(),
        images: replyAtt.attachments.map((a) => a.path),
      });
      if (result?.success && result?.data) {
        setReply("");
        replyAtt.reset();
        // Optimistically append; loadThread refresh would also work
        setActiveThread((prev) =>
          prev
            ? {
                ...prev,
                replies: [...prev.replies, result.data as FeedbackReplyItem],
              }
            : prev
        );
      } else {
        toast.error(result?.error || "Failed to send");
      }
    } finally {
      setIsSendingReply(false);
    }
  };

  const handleCloseTicket = async () => {
    if (!activeThread) return;
    const ok = await confirm({
      title: "Close this ticket?",
      description: "You can reopen it any time by replying to the thread.",
      confirmLabel: "Close ticket",
      cancelLabel: "Keep open",
    });
    if (!ok) return;
    const result = await closeUserFeedbackAction(activeThread.feedback.id);
    if (result?.success) {
      toast.success("Ticket closed");
      // Update list + thread state locally so UI reflects immediately
      setItems((prev) =>
        prev.map((it) =>
          it.id === activeThread.feedback.id
            ? { ...it, status: "COMPLETED" }
            : it
        )
      );
      setActiveThread((prev) =>
        prev
          ? { ...prev, feedback: { ...prev.feedback, status: "COMPLETED" } }
          : prev
      );
    } else {
      toast.error(result?.error || "Failed to close ticket");
    }
  };

  const handleCreate = async (
    type: string,
    title: string,
    description: string,
    images: string[]
  ) => {
    const result = await submitFeedbackAction({
      type: type as
        | "BUG"
        | "FEATURE_REQUEST"
        | "IMPROVEMENT"
        | "QUESTION"
        | "OTHER",
      title,
      description,
      images,
      page: pathname || undefined,
    });
    if (result?.success && result?.data) {
      toast.success("Feedback submitted");
      setShowNewForm(false);
      await loadList();
      setActiveId(result.data.id);
    } else {
      toast.error(result?.error || "Failed to submit");
    }
  };

  const activeFeedback = activeThread?.feedback;
  const activeTypeCfg = activeFeedback
    ? TYPE_CONFIG[activeFeedback.type] || TYPE_CONFIG.OTHER
    : null;
  const activeStatus = activeFeedback
    ? STATUS_LABELS[activeFeedback.status] || STATUS_LABELS.OPEN
    : null;

  // Stack-based view selection
  const view: "list" | "thread" | "new" = showNewForm
    ? "new"
    : activeId
      ? "thread"
      : "list";

  return (
    <div className="pf-card flat" style={{ padding: 0, overflow: "hidden" }}>
      {confirmDialog}
      {view === "list" ? (
        // ── List view - default. Conversations + new-ticket CTA. ──
        <div className="flex flex-col min-h-[480px]">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: "1.5px dashed var(--rule-soft)",
              background: "var(--paper-2)",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 1.5,
                color: "var(--ink-4)",
                fontWeight: 700,
              }}
            >
              Conversations
            </div>
            <button
              onClick={() => {
                setShowNewForm(true);
                setActiveId(null);
                setActiveThread(null);
              }}
              className="pf-bf sm"
            >
              <Plus className="h-3 w-3" />
              New ticket
            </button>
          </div>
          <div className="flex-1">
            {isLoadingList ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: "48px 16px", textAlign: "center" }}>
                <p
                  style={{ fontSize: 13, color: "var(--ink)", marginBottom: 4 }}
                >
                  No tickets yet
                </p>
                <p
                  style={{
                    fontSize: 11.5,
                    color: "var(--ink-3)",
                    marginBottom: 16,
                  }}
                >
                  Submit feedback, bug reports, or feature requests.
                </p>
                <button
                  onClick={() => setShowNewForm(true)}
                  className="pf-bs sm"
                  style={{ display: "inline-flex" }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create your first ticket
                </button>
              </div>
            ) : (
              items.map((it) => {
                const tCfg = TYPE_CONFIG[it.type] || TYPE_CONFIG.OTHER;
                const sCfg = STATUS_LABELS[it.status] || STATUS_LABELS.OPEN;
                return (
                  <button
                    key={it.id}
                    onClick={() => setActiveId(it.id)}
                    className="set-row"
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "12px 16px",
                      borderBottom: "1px dashed var(--rule-soft)",
                    }}
                  >
                    <div
                      className="flex items-center gap-2.5"
                      style={{ width: "100%" }}
                    >
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center font-mono font-bold text-[12px] flex-shrink-0 ${tCfg.color} border`}
                      >
                        {tCfg.initial}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="font-mono text-[10px] tracking-[0.4px] text-emerald-400/80 font-bold">
                            #{it.id.slice(-6).toUpperCase()}
                          </span>
                          <span className="text-foreground/40">·</span>
                          <span
                            className={`font-mono text-[9.5px] uppercase tracking-[0.6px] font-bold ${sCfg.color}`}
                          >
                            {sCfg.label}
                          </span>
                          <span className="text-muted-foreground/60">·</span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {timeAgo(it.updatedAt)}
                          </span>
                        </div>
                        <div className="text-[13px] font-semibold text-foreground truncate">
                          {it.title}
                        </div>
                      </div>
                      {it.replyCount > 0 && (
                        <span className="font-mono text-[11px] text-emerald-400 font-bold ml-2">
                          {it.replyCount}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : view === "new" ? (
        // ── New form view - back-button header + form ──
        <div className="flex flex-col min-h-[480px]">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 16px",
              borderBottom: "1.5px dashed var(--rule-soft)",
              background: "var(--paper-2)",
            }}
          >
            <button
              onClick={() => setShowNewForm(false)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12.5,
                color: "var(--ink-3)",
              }}
              title="Back to tickets"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </button>
            <div className="flex-1" />
            <span
              className="mono"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 1.5,
                color: "var(--ink-4)",
                fontWeight: 700,
              }}
            >
              New ticket
            </span>
          </div>
          <NewFeedbackForm
            onCancel={() => setShowNewForm(false)}
            onSubmit={handleCreate}
            pathname={pathname}
          />
        </div>
      ) : (
        // ── Thread view - back, ticket ID, close button, bubbles ──
        <div
          className="flex flex-col min-h-[480px]"
          style={{
            background:
              "linear-gradient(180deg,rgba(52,211,153,.012),transparent 30%)",
          }}
        >
          {isLoadingThread || !activeThread ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 16px",
                  borderBottom: "1.5px dashed var(--rule-soft)",
                  background: "var(--paper-2)",
                }}
              >
                <button
                  onClick={() => {
                    setActiveId(null);
                    setActiveThread(null);
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12.5,
                    color: "var(--ink-3)",
                  }}
                  title="Back to tickets"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <div
                  style={{
                    width: 1,
                    height: 16,
                    background: "var(--rule-soft)",
                    margin: "0 4px",
                  }}
                />
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center font-mono font-bold text-[12px] flex-shrink-0 ${activeTypeCfg?.color} border`}
                >
                  {activeTypeCfg?.initial}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10.5px] tracking-[0.4px] text-emerald-400 font-bold">
                      #{activeFeedback?.id.slice(-6).toUpperCase()}
                    </span>
                    <span className="text-foreground/40">·</span>
                    <span
                      className={`font-mono text-[10px] uppercase tracking-[0.6px] font-bold ${activeStatus?.color}`}
                    >
                      {activeStatus?.label}
                    </span>
                    <span className="text-muted-foreground/60">·</span>
                    <span className="font-mono text-[10.5px] text-muted-foreground">
                      {activeFeedback?.replyCount ?? 0} repl
                      {(activeFeedback?.replyCount ?? 0) === 1 ? "y" : "ies"}
                    </span>
                  </div>
                  <div className="text-[13.5px] font-bold text-foreground truncate mt-0.5">
                    {activeFeedback?.title}
                  </div>
                </div>
                {/* Close button - only when ticket is still open. */}
                {activeFeedback &&
                  activeFeedback.status !== "COMPLETED" &&
                  activeFeedback.status !== "DECLINED" &&
                  activeFeedback.status !== "DUPLICATE" && (
                    <button
                      onClick={handleCloseTicket}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 text-[11.5px] font-semibold transition-colors"
                      title="Close this ticket"
                    >
                      <X className="h-3 w-3" />
                      Close
                    </button>
                  )}
              </div>

              {/* Messages - WhatsApp bubbles */}
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
                {/* Initial submission as the user's first bubble */}
                {activeFeedback && (
                  <Bubble
                    isAdmin={false}
                    text={activeFeedback.description}
                    timestamp={activeFeedback.createdAt}
                    images={activeThread.feedback.imageUrls}
                    seen
                  />
                )}
                {activeThread.replies.map((r) => (
                  <Bubble
                    key={r.id}
                    isAdmin={r.isAdmin}
                    text={r.message}
                    timestamp={r.createdAt}
                    images={r.imageUrls}
                    seen
                  />
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Reply input */}
              {activeFeedback?.status === "COMPLETED" ||
              activeFeedback?.status === "DECLINED" ||
              activeFeedback?.status === "DUPLICATE" ? (
                <div className="border-t border-border px-4 py-3 text-center text-[12px] text-muted-foreground bg-black/15">
                  This conversation is closed.
                </div>
              ) : (
                <div className="border-t border-border px-3 py-2.5 bg-black/20 space-y-2">
                  <AttachmentChips
                    attachments={replyAtt.attachments}
                    onRemove={replyAtt.remove}
                  />
                  <div className="flex items-end gap-2">
                    {replyAtt.input}
                    <button
                      type="button"
                      onClick={replyAtt.pick}
                      disabled={replyAtt.uploading}
                      title="Attach a screenshot"
                      aria-label="Attach a screenshot"
                      className="w-9 h-9 rounded-full border border-border text-muted-foreground hover:text-foreground flex items-center justify-center flex-shrink-0 disabled:opacity-40"
                    >
                      {replyAtt.uploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Paperclip className="h-4 w-4" />
                      )}
                    </button>
                    <textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSendReply();
                        }
                      }}
                      placeholder="Type a message..."
                      rows={1}
                      className="flex-1 resize-none bg-[var(--bg-card)] border border-border rounded-[18px] px-3.5 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/40 focus:border-emerald-500/40 max-h-32"
                    />
                    <button
                      onClick={handleSendReply}
                      disabled={!reply.trim() || isSendingReply}
                      className="w-9 h-9 rounded-full bg-emerald-500 text-emerald-950 flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:bg-emerald-400 transition-colors flex-shrink-0"
                    >
                      {isSendingReply ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

interface PendingAttachment {
  path: string;
  previewUrl: string;
  name: string;
}

/**
 * Screenshot attachments for a composer (new ticket + thread reply) —
 * MONEY-764: the store workflow (schema `images: String[]` + signed-URL
 * thread reads) existed but no upload path/UI ever did. Uploads happen
 * eagerly on pick via `uploadFeedbackImageAction`; ANY failure (storage
 * unconfigured, GCS outage, bad file) toasts and the message still sends
 * text-only — attachments never block a submission.
 */
function useTicketAttachments(max = FEEDBACK_MAX_IMAGES) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = () => inputRef.current?.click();

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = max - attachments.length;
    if (room <= 0) {
      toast.error(`Up to ${max} images per message`);
      return;
    }
    if (files.length > room) {
      toast.error(`Only ${room} more image${room === 1 ? "" : "s"} fit`);
    }
    const selected = Array.from(files).slice(0, room);
    setUploading(true);
    try {
      for (const file of selected) {
        const check = validateFeedbackImage({
          type: file.type,
          size: file.size,
        });
        if (!check.ok) {
          toast.error(`${file.name}: ${check.error}`);
          continue;
        }
        const fd = new FormData();
        fd.set("file", file);
        const res = await uploadFeedbackImageAction(fd);
        if (res?.success && res.data) {
          const uploaded = res.data;
          setAttachments((prev) => [
            ...prev,
            {
              path: uploaded.path,
              previewUrl: uploaded.previewUrl,
              name: file.name,
            },
          ]);
        } else {
          toast.error(res?.error || "Upload failed — send without it");
        }
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  const reset = () => setAttachments([]);

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      hidden
      onChange={(e) => void onFiles(e.target.files)}
    />
  );

  return { attachments, uploading, pick, remove, reset, input };
}

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (path: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {attachments.map((a) => (
        <div
          key={a.path}
          style={{
            position: "relative",
            width: 44,
            height: 44,
            borderRadius: 8,
            border: "1.5px solid var(--rule-soft)",
            overflow: "hidden",
            background: "var(--paper-2)",
          }}
          title={a.name}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={a.previewUrl}
            alt={a.name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          <button
            type="button"
            onClick={() => onRemove(a.path)}
            aria-label={`Remove ${a.name}`}
            style={{
              position: "absolute",
              top: 1,
              right: 1,
              width: 15,
              height: 15,
              borderRadius: 999,
              background: "var(--ink)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              lineHeight: 0,
            }}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Bubble({
  isAdmin,
  text,
  timestamp,
  seen,
  images,
}: {
  isAdmin: boolean;
  text: string;
  timestamp: Date | string;
  seen?: boolean;
  /** Signed (short-lived) URLs for attached screenshots. */
  images?: string[];
}) {
  return (
    <div className={`flex ${isAdmin ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[78%] rounded-[14px] px-3 py-2 ${
          isAdmin
            ? "bg-[var(--bg-card)] border border-border text-foreground rounded-bl-sm"
            : "bg-emerald-500/15 border border-emerald-500/30 text-foreground rounded-br-sm"
        }`}
      >
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {images.map((url, i) => (
              <a
                key={`${i}-${url.slice(0, 40)}`}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open attachment"
                className="block w-24 h-24 rounded-lg overflow-hidden border border-border"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt={`Attachment ${i + 1}`}
                  className="w-full h-full object-cover"
                />
              </a>
            ))}
          </div>
        )}
        <p className="text-[13px] leading-[1.45] whitespace-pre-wrap break-words">
          {text}
        </p>
        <div
          className={`flex items-center gap-1 justify-end mt-1 font-mono text-[9.5px] ${
            isAdmin ? "text-muted-foreground/60" : "text-emerald-400/80"
          }`}
        >
          {timeStamp(timestamp)}
          {!isAdmin &&
            (seen ? (
              <CheckCheck className="h-3 w-3 text-emerald-400" />
            ) : (
              <Check className="h-3 w-3" />
            ))}
        </div>
      </div>
    </div>
  );
}

function NewFeedbackForm({
  onCancel,
  onSubmit,
  pathname,
}: {
  onCancel: () => void;
  onSubmit: (
    type: string,
    title: string,
    description: string,
    images: string[]
  ) => Promise<void>;
  pathname: string | null;
}) {
  const [type, setType] = useState("FEATURE_REQUEST");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const att = useTicketAttachments();

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(
        type,
        title.trim(),
        description.trim(),
        att.attachments.map((a) => a.path)
      );
    } finally {
      setSubmitting(false);
    }
  };

  const isValid = title.length >= 5 && description.length >= 10;

  return (
    <form
      onSubmit={handle}
      className="flex-1 overflow-y-auto"
      style={{
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      {/* Category grid */}
      <div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginBottom: 8,
          }}
        >
          Category
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(5, 1fr)",
            gap: 5,
          }}
        >
          {FEEDBACK_TYPES.map((t) => {
            const cfg = TYPE_CONFIG[t.value];
            const active = type === t.value;
            return (
              <button
                type="button"
                key={t.value}
                onClick={() => setType(t.value)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  padding: "8px 4px",
                  borderRadius: 8,
                  border: active
                    ? `1.5px solid ${cfg.cssColor}`
                    : "1.5px solid var(--rule-soft)",
                  background: active
                    ? `color-mix(in srgb, ${cfg.cssColor} 12%, transparent)`
                    : "transparent",
                  color: active ? cfg.textColor : "var(--ink-3)",
                  cursor: "pointer",
                  transition: "all 0.12s",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                }}
              >
                <cfg.icon
                  className="h-3 w-3"
                  style={{ color: active ? cfg.textColor : "var(--ink-3)" }}
                />
                <span style={{ textAlign: "center", lineHeight: 1.2 }}>
                  {t.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Title */}
      <div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginBottom: 6,
          }}
        >
          Title
        </div>
        <input
          required
          minLength={5}
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Short summary"
          className="pf-input"
          style={{ fontSize: 13 }}
        />
        <div
          className="mono"
          style={{
            fontSize: 10,
            color: title.length >= 5 ? "var(--emerald-text)" : "var(--ink-4)",
            marginTop: 3,
            textAlign: "right",
          }}
        >
          {title.length}/200
        </div>
      </div>

      {/* Description */}
      <div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginBottom: 6,
          }}
        >
          Description
        </div>
        <textarea
          required
          minLength={10}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the bug, feature or improvement. Include steps to reproduce if relevant."
          rows={5}
          className="pf-input resize-none"
          style={{ fontSize: 13, lineHeight: 1.45 }}
        />
        <div
          className="mono"
          style={{
            fontSize: 10,
            color:
              description.length >= 10 ? "var(--emerald-text)" : "var(--ink-4)",
            marginTop: 3,
            textAlign: "right",
          }}
        >
          {description.length}/2000
        </div>
      </div>

      {/* Attachments (optional screenshots) */}
      <div>
        <div
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 1.5,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            marginBottom: 6,
          }}
        >
          Attachments{" "}
          <span style={{ color: "var(--ink-4)", fontWeight: 600 }}>
            · optional · up to {FEEDBACK_MAX_IMAGES} images, 5 MB each
          </span>
        </div>
        {att.input}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <AttachmentChips
            attachments={att.attachments}
            onRemove={att.remove}
          />
          {att.attachments.length < FEEDBACK_MAX_IMAGES && (
            <button
              type="button"
              onClick={att.pick}
              disabled={att.uploading}
              className="pf-bf sm"
              style={{ opacity: att.uploading ? 0.6 : 1 }}
            >
              {att.uploading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Paperclip className="h-3 w-3" />
              )}
              {att.uploading ? "Uploading…" : "Attach screenshot"}
            </button>
          )}
        </div>
      </div>

      {/* Auto-attached context */}
      <div
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          border: "1.5px dashed var(--rule-soft)",
          background: "var(--paper-2)",
          display: "flex",
          flexWrap: "wrap",
          gap: 5,
          alignItems: "center",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: "uppercase",
            color: "var(--ink-4)",
            marginRight: 2,
          }}
        >
          Auto-attached:
        </span>
        {pathname && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              padding: "1px 6px",
              borderRadius: 999,
              border: "1.5px solid var(--rule-soft)",
              background: "var(--paper)",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "var(--ink-3)",
              fontWeight: 600,
            }}
          >
            <MapPin className="h-2 w-2" />
            {pathname.length > 28 ? `…${pathname.slice(-25)}` : pathname}
          </span>
        )}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "1px 6px",
            borderRadius: 999,
            border: "1.5px solid var(--rule-soft)",
            background: "var(--paper)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            color: "var(--ink-3)",
            fontWeight: 600,
          }}
        >
          <Globe className="h-2 w-2" />
          {getShortBrowser()}
        </span>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="submit"
          disabled={submitting || !isValid}
          className="pf-bs sm"
          style={{
            opacity: submitting || !isValid ? 0.4 : 1,
            cursor: submitting || !isValid ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          Send →
        </button>
        <button type="button" onClick={onCancel} className="pf-bf sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
