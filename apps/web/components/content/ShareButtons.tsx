"use client";

import React, { useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@usemoney/ui/button";
import { Twitter, Linkedin, Link2, Check } from "lucide-react";

interface ShareButtonsProps {
  /** Title to share (used in tweet/LinkedIn post) */
  title?: string;
  /** Optional custom URL (defaults to current page URL) */
  url?: string;
  /** Custom class name for the container */
  className?: string;
  /** Button size variant */
  size?: "default" | "sm" | "lg" | "icon";
  /** Button variant */
  variant?: "default" | "outline" | "ghost" | "secondary";
}

/**
 * ShareButtons - Social share buttons component
 *
 * Provides share functionality for Twitter, LinkedIn, and copy link.
 * Uses the current page URL by default, with toast notification on link copy.
 */
export function ShareButtons({
  title = "",
  url,
  className = "",
  size = "sm",
  variant = "outline",
}: ShareButtonsProps) {
  const [copied, setCopied] = React.useState(false);

  const getShareUrl = useCallback(() => {
    if (url) return url;
    if (typeof window !== "undefined") {
      return window.location.href;
    }
    return "";
  }, [url]);

  const shareOnTwitter = useCallback(() => {
    const shareUrl = getShareUrl();
    const tweetText = title ? `${title}` : "";
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}&url=${encodeURIComponent(shareUrl)}`;
    window.open(
      twitterUrl,
      "_blank",
      "noopener,noreferrer,width=550,height=420"
    );
  }, [title, getShareUrl]);

  const shareOnLinkedIn = useCallback(() => {
    const shareUrl = getShareUrl();
    const linkedInUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
    window.open(
      linkedInUrl,
      "_blank",
      "noopener,noreferrer,width=550,height=420"
    );
  }, [getShareUrl]);

  const copyLink = useCallback(async () => {
    const shareUrl = getShareUrl();

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("Link copied to clipboard");

      // Reset copied state after 2 seconds
      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      console.error("Failed to copy link:", error);
      toast.error("Failed to copy link");
    }
  }, [getShareUrl]);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Button
        variant={variant}
        size={size}
        onClick={shareOnTwitter}
        className="border-border hover:bg-muted hover:border-border"
        title="Share on Twitter"
      >
        <Twitter className="h-4 w-4" />
        {size !== "icon" && <span className="ml-2">Twitter</span>}
      </Button>

      <Button
        variant={variant}
        size={size}
        onClick={shareOnLinkedIn}
        className="border-border hover:bg-muted hover:border-border"
        title="Share on LinkedIn"
      >
        <Linkedin className="h-4 w-4" />
        {size !== "icon" && <span className="ml-2">LinkedIn</span>}
      </Button>

      <Button
        variant={variant}
        size={size}
        onClick={copyLink}
        className="border-border hover:bg-muted hover:border-border"
        title="Copy link"
      >
        {copied ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Link2 className="h-4 w-4" />
        )}
        {size !== "icon" && (
          <span className="ml-2">{copied ? "Copied" : "Copy Link"}</span>
        )}
      </Button>
    </div>
  );
}

export default ShareButtons;
