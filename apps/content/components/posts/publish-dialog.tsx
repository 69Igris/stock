"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  CalendarIcon,
  Loader2,
  Send,
  Clock,
  Users,
  Mail,
  Search,
  X,
} from "lucide-react";
import { Button } from "@usemoney/ui/button";
import { Calendar } from "@usemoney/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@usemoney/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { Input } from "@usemoney/ui/input";
import { Badge } from "@usemoney/ui/badge";
import { cn } from "@usemoney/utils";
import type { PostStatus, ContentType } from "@usemoney/types";
import { searchUsersForIndividualSend } from "@/lib/actions/subscribers";

export type NewsletterSegment =
  | "newsletter"
  | "marketing"
  | "usemoney-free"
  | "usemoney-paid"
  | "usemoney-downgrade"
  | "usemoney-security";

interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPublish: (
    segments?: NewsletterSegment[],
    individualEmails?: string[],
  ) => Promise<void>;
  onSchedule: (
    date: Date,
    segments?: NewsletterSegment[],
    individualEmails?: string[],
  ) => Promise<void>;
  isPublishing: boolean;
  currentStatus: PostStatus;
  contentType?: ContentType;
  /** When "resend", only shows segment selector + resend button (no publish/schedule) */
  mode?: "publish" | "resend";
}

type SendMode = "audiences" | "individual";

type PublishOption = "now" | "schedule";

/**
 * Resend audience-based options — mirror of EMAIL_SEGMENTS in @usemoney/email.
 * Inlined here to avoid importing the email package into the client bundle
 * (newsletter.ts transitively pulls @usemoney/database / Prisma).
 *
 * "marketing" is shown as a disabled preview until RESEND_AUDIENCE_MARKETING_ID
 * is provisioned in the Resend dashboard.
 */
const RESEND_AUDIENCE_OPTIONS: {
  value: NewsletterSegment;
  label: string;
  description: string;
  disabled?: boolean;
  hint?: string;
}[] = [
  {
    value: "newsletter",
    label: "UseMoney Newsletter",
    description:
      "Opt-in newsletter audience — users who subscribed via the newsletter form or settings",
  },
  {
    value: "marketing",
    label: "UseMoney Marketing",
    description:
      "Users who opted into marketing emails (default-checked at signup, toggleable in settings)",
  },
];

const SEGMENT_OPTIONS: {
  value: NewsletterSegment;
  label: string;
  description: string;
}[] = [
  {
    value: "usemoney-free",
    label: "Free Users",
    description: "All free-tier app users",
  },
  {
    value: "usemoney-paid",
    label: "Paid Users",
    description: "PRO, Premium & AI Unlimited users",
  },
  {
    value: "usemoney-downgrade",
    label: "Downgraded Users",
    description: "Previously paid, now on free plan (great for win-back)",
  },
  {
    value: "usemoney-security",
    label: "Security",
    description: "All users (no unsubscribe)",
  },
];

export function PublishDialog({
  open,
  onOpenChange,
  onPublish,
  onSchedule,
  isPublishing,
  currentStatus,
  contentType,
  mode = "publish",
}: PublishDialogProps) {
  const isResendMode = mode === "resend";
  const [publishOption, setPublishOption] = useState<PublishOption>("now");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(
    new Date(),
  );
  const [selectedHour, setSelectedHour] = useState("09");
  const [selectedMinute, setSelectedMinute] = useState("00");
  const [selectedSegments, setSelectedSegments] = useState<NewsletterSegment[]>(
    ["newsletter"],
  );

  // Individual email state
  const [sendMode, setSendMode] = useState<SendMode>("audiences");
  const [emailSearch, setEmailSearch] = useState("");
  const [searchResults, setSearchResults] = useState<
    { email: string; name: string | null }[]
  >([]);
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchTimerRef = useRef<NodeJS.Timeout | null>(null);

  const isNewsletter = contentType === "NEWSLETTER";

  // Debounced search
  const handleEmailSearch = useCallback((query: string) => {
    setEmailSearch(query);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const result = await searchUsersForIndividualSend(query);
        if (result.success && result.data) {
          setSearchResults(result.data);
        }
      } catch {
        // ignore
      } finally {
        setIsSearching(false);
      }
    }, 300);
  }, []);

  // Reset individual state when dialog closes
  useEffect(() => {
    if (!open) {
      setEmailSearch("");
      setSearchResults([]);
      setSelectedEmails([]);
      setSendMode("audiences");
    }
  }, [open]);

  const toggleEmail = (email: string) => {
    setSelectedEmails((prev) =>
      prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email],
    );
  };

  const toggleSegment = (segment: NewsletterSegment) => {
    setSelectedSegments((prev) =>
      prev.includes(segment)
        ? prev.filter((s) => s !== segment)
        : [...prev, segment],
    );
  };

  const handleConfirm = async () => {
    const segments =
      isNewsletter || isResendMode ? selectedSegments : undefined;
    const individuals =
      sendMode === "individual" && selectedEmails.length > 0
        ? selectedEmails
        : undefined;

    if (isResendMode) {
      await onPublish(segments, individuals);
      return;
    }
    if (publishOption === "now") {
      await onPublish(segments, individuals);
    } else if (selectedDate) {
      const publishDate = new Date(selectedDate);
      publishDate.setHours(parseInt(selectedHour), parseInt(selectedMinute), 0);
      await onSchedule(publishDate, segments, individuals);
    }
  };

  const hours = Array.from({ length: 24 }, (_, i) =>
    i.toString().padStart(2, "0"),
  );
  const minutes = Array.from({ length: 12 }, (_, i) =>
    (i * 5).toString().padStart(2, "0"),
  );

  const isScheduleValid =
    publishOption === "now" ||
    (selectedDate && new Date(selectedDate) > new Date());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-800 text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isResendMode
              ? "Resend Newsletter"
              : currentStatus === "PUBLISHED"
                ? "Update Post"
                : "Publish Post"}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {isResendMode
              ? "Select audiences to resend this newsletter to."
              : currentStatus === "PUBLISHED"
                ? "Update your published post settings."
                : "Choose when to publish your post."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Publish Options (hidden in resend mode) */}
          {!isResendMode && (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPublishOption("now")}
                className={cn(
                  "flex flex-col items-center gap-2 p-4 rounded-lg border transition-all",
                  publishOption === "now"
                    ? "border-blue-500 bg-blue-500/10 text-white"
                    : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-300",
                )}
              >
                <Send
                  className={cn(
                    "h-6 w-6",
                    publishOption === "now"
                      ? "text-blue-500"
                      : "text-slate-500",
                  )}
                />
                <span className="font-medium">Publish Now</span>
                <span className="text-xs opacity-70">Post immediately</span>
              </button>

              <button
                type="button"
                onClick={() => setPublishOption("schedule")}
                className={cn(
                  "flex flex-col items-center gap-2 p-4 rounded-lg border transition-all",
                  publishOption === "schedule"
                    ? "border-blue-500 bg-blue-500/10 text-white"
                    : "border-slate-700 bg-slate-800/50 text-slate-400 hover:border-slate-600 hover:text-slate-300",
                )}
              >
                <Clock
                  className={cn(
                    "h-6 w-6",
                    publishOption === "schedule"
                      ? "text-blue-500"
                      : "text-slate-500",
                  )}
                />
                <span className="font-medium">Schedule</span>
                <span className="text-xs opacity-70">Pick date & time</span>
              </button>
            </div>
          )}

          {/* Schedule Options */}
          {!isResendMode && publishOption === "schedule" && (
            <div className="space-y-4">
              {/* Calendar */}
              <div className="flex justify-center">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={setSelectedDate}
                  disabled={(date) => date < new Date()}
                  className="rounded-lg border border-slate-700 bg-slate-800"
                />
              </div>

              {/* Time Picker */}
              <div className="flex items-center justify-center gap-2">
                <Select value={selectedHour} onValueChange={setSelectedHour}>
                  <SelectTrigger className="w-20 bg-slate-800 border-slate-700 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700 max-h-60">
                    {hours.map((hour) => (
                      <SelectItem
                        key={hour}
                        value={hour}
                        className="text-slate-300 focus:bg-slate-700 focus:text-white"
                      >
                        {hour}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-slate-400">:</span>
                <Select
                  value={selectedMinute}
                  onValueChange={setSelectedMinute}
                >
                  <SelectTrigger className="w-20 bg-slate-800 border-slate-700 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700 max-h-60">
                    {minutes.map((minute) => (
                      <SelectItem
                        key={minute}
                        value={minute}
                        className="text-slate-300 focus:bg-slate-700 focus:text-white"
                      >
                        {minute}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Selected DateTime Display */}
              {selectedDate && (
                <p className="text-center text-sm text-slate-400">
                  Scheduled for:{" "}
                  <span className="text-white">
                    {selectedDate.toLocaleDateString("en-US", {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}{" "}
                    at {selectedHour}:{selectedMinute}
                  </span>
                </p>
              )}
            </div>
          )}

          {/* Newsletter Send Options */}
          {(isNewsletter || isResendMode) && (
            <div className="space-y-3">
              {/* Send Mode Toggle */}
              <div className="flex items-center gap-1 p-1 bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setSendMode("audiences")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-sm font-medium transition-colors",
                    sendMode === "audiences"
                      ? "bg-slate-700 text-white"
                      : "text-slate-400 hover:text-slate-300",
                  )}
                >
                  <Users className="h-3.5 w-3.5" />
                  Audiences
                </button>
                <button
                  type="button"
                  onClick={() => setSendMode("individual")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-sm font-medium transition-colors",
                    sendMode === "individual"
                      ? "bg-slate-700 text-white"
                      : "text-slate-400 hover:text-slate-300",
                  )}
                >
                  <Mail className="h-3.5 w-3.5" />
                  Individual Emails
                </button>
              </div>

              {/* Audience Segments */}
              {sendMode === "audiences" && (
                <div className="space-y-4">
                  {/* Resend newsletter / marketing audiences */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      Newsletter Audiences
                    </p>
                    {RESEND_AUDIENCE_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-lg border transition-all",
                          option.disabled
                            ? "cursor-not-allowed border-slate-800 bg-slate-900/50 opacity-50"
                            : cn(
                                "cursor-pointer",
                                selectedSegments.includes(option.value)
                                  ? "border-blue-500 bg-blue-500/10"
                                  : "border-slate-700 bg-slate-800/50 hover:border-slate-600",
                              ),
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSegments.includes(option.value)}
                          onChange={() =>
                            !option.disabled && toggleSegment(option.value)
                          }
                          disabled={option.disabled}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0 disabled:cursor-not-allowed"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">
                              {option.label}
                            </span>
                            {option.hint && (
                              <span className="text-xs text-slate-500 italic">
                                {option.hint}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {option.description}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Legacy per-user-tier audiences */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                      App User Segments
                    </p>
                    {SEGMENT_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all",
                          selectedSegments.includes(option.value)
                            ? "border-blue-500 bg-blue-500/10"
                            : "border-slate-700 bg-slate-800/50 hover:border-slate-600",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSegments.includes(option.value)}
                          onChange={() => toggleSegment(option.value)}
                          className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                        />
                        <div>
                          <div className="text-sm font-medium text-white">
                            {option.label}
                          </div>
                          <div className="text-xs text-slate-400">
                            {option.description}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>

                  {selectedSegments.length === 0 && (
                    <p className="text-xs text-amber-400">
                      Select at least one audience to send the newsletter to.
                    </p>
                  )}
                </div>
              )}

              {/* Individual Email Selection */}
              {sendMode === "individual" && (
                <div className="space-y-3">
                  {/* Selected Emails */}
                  {selectedEmails.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedEmails.map((email) => (
                        <Badge
                          key={email}
                          variant="secondary"
                          className="bg-blue-500/20 text-blue-300 border-blue-500/30 text-xs gap-1"
                        >
                          {email}
                          <button
                            type="button"
                            onClick={() => toggleEmail(email)}
                            className="hover:text-white"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Search Input */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <Input
                      placeholder="Search users by email or name..."
                      value={emailSearch}
                      onChange={(e) => handleEmailSearch(e.target.value)}
                      className="pl-9 bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
                    />
                    {isSearching && (
                      <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-slate-400" />
                    )}
                  </div>

                  {/* Search Results */}
                  {searchResults.length > 0 && (
                    <div className="max-h-48 overflow-y-auto space-y-1 border border-slate-700 rounded-lg p-1">
                      {searchResults.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            const newEmails = searchResults
                              .map((r) => r.email)
                              .filter((e) => !selectedEmails.includes(e));
                            setSelectedEmails((prev) => [
                              ...prev,
                              ...newEmails,
                            ]);
                          }}
                          className="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-slate-800 rounded"
                        >
                          Select all results ({searchResults.length})
                        </button>
                      )}
                      {searchResults.map((sub) => (
                        <label
                          key={sub.email}
                          className={cn(
                            "flex items-center gap-2 px-3 py-2 rounded cursor-pointer transition-colors",
                            selectedEmails.includes(sub.email)
                              ? "bg-blue-500/10"
                              : "hover:bg-slate-800",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selectedEmails.includes(sub.email)}
                            onChange={() => toggleEmail(sub.email)}
                            className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                          />
                          <div className="min-w-0">
                            <div className="text-sm text-white truncate">
                              {sub.email}
                            </div>
                            {sub.name && (
                              <div className="text-xs text-slate-400 truncate">
                                {sub.name}
                              </div>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}

                  {emailSearch.length >= 2 &&
                    !isSearching &&
                    searchResults.length === 0 && (
                      <p className="text-xs text-slate-400 text-center py-2">
                        No users found.
                      </p>
                    )}

                  {selectedEmails.length === 0 && (
                    <p className="text-xs text-amber-400">
                      Search and select at least one user.
                    </p>
                  )}

                  {selectedEmails.length > 0 && (
                    <p className="text-xs text-slate-400">
                      {selectedEmails.length} email
                      {selectedEmails.length !== 1 ? "s" : ""} selected
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isPublishing}
            className="text-slate-400 hover:text-white"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={
              isPublishing ||
              (!isResendMode && !isScheduleValid) ||
              ((isNewsletter || isResendMode) &&
                sendMode === "audiences" &&
                selectedSegments.length === 0) ||
              ((isNewsletter || isResendMode) &&
                sendMode === "individual" &&
                selectedEmails.length === 0)
            }
            className="bg-blue-600 hover:bg-blue-700 text-white min-w-[120px]"
          >
            {isPublishing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {isResendMode
                  ? "Sending..."
                  : publishOption === "now"
                    ? "Publishing..."
                    : "Scheduling..."}
              </>
            ) : isResendMode ? (
              <>
                <Send className="h-4 w-4 mr-2" />
                Resend
              </>
            ) : (
              <>
                {publishOption === "now" ? (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Publish
                  </>
                ) : (
                  <>
                    <CalendarIcon className="h-4 w-4 mr-2" />
                    Schedule
                  </>
                )}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
