import React from "react";
import { Clock } from "lucide-react";

interface ReadingTimeProps {
  /** The content to calculate reading time for */
  content: string;
  /** Average words per minute (default: 225 - average adult reading speed) */
  wordsPerMinute?: number;
  /** Whether to show the clock icon */
  showIcon?: boolean;
  /** Custom class name */
  className?: string;
}

/**
 * Calculate reading time from content
 * @param content - The text content
 * @param wordsPerMinute - Reading speed (default: 225 wpm)
 * @returns Reading time in minutes
 */
export function calculateReadingTime(
  content: string,
  wordsPerMinute: number = 225
): number {
  // Strip HTML tags if present
  const textContent = content.replace(/<[^>]*>/g, "");

  // Count words (split by whitespace and filter empty strings)
  const words = textContent
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  const wordCount = words.length;

  // Calculate reading time, minimum 1 minute
  const minutes = Math.ceil(wordCount / wordsPerMinute);

  return Math.max(1, minutes);
}

/**
 * ReadingTime - Display component for estimated reading time
 *
 * Calculates reading time based on word count using an average reading speed.
 * The default of 225 words per minute is the average adult reading speed.
 *
 * Usage:
 * ```tsx
 * <ReadingTime content={postContent} />
 * // Renders: "5 min read"
 * ```
 */
export function ReadingTime({
  content,
  wordsPerMinute = 225,
  showIcon = true,
  className = "",
}: ReadingTimeProps) {
  const minutes = calculateReadingTime(content, wordsPerMinute);

  return (
    <span
      className={`inline-flex items-center text-sm text-muted-foreground ${className}`}
    >
      {showIcon && <Clock className="h-4 w-4 mr-1" />}
      <span>{minutes} min read</span>
    </span>
  );
}

export default ReadingTime;
