"use client";

import { useState } from "react";
import Image from "next/image";
import { User } from "lucide-react";
import { cn } from "@/lib/utils";

interface AuthorAvatarProps {
  src?: string | null;
  name?: string | null;
  /** Rendered width/height in px (square). */
  size?: number;
  className?: string;
}

/**
 * Author avatar with a resilient fallback (MONEY-1050).
 *
 * Content authors store a SNAPSHOT of their Clerk avatar URL (an
 * `img.clerk.com` proxy). When the author later changes their Clerk photo the
 * old proxy URL 404s, and the render sites — which only null-checked the URL —
 * showed a broken image. This client component swaps to an initials/icon
 * fallback on load error, so a stale or dead URL can never render broken again.
 */
export function AuthorAvatar({
  src,
  name,
  size = 36,
  className,
}: AuthorAvatarProps) {
  const [failed, setFailed] = useState(false);
  const initial = name?.trim().charAt(0).toUpperCase();

  if (src && !failed) {
    return (
      <Image
        src={src}
        alt={name || "Author"}
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className={cn("rounded-full object-cover shrink-0", className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <div
      aria-label={name || "Author"}
      className={cn(
        "rounded-full bg-muted flex items-center justify-center text-muted-foreground shrink-0",
        className
      )}
      style={{ width: size, height: size }}
    >
      {initial ? (
        <span
          className="font-medium leading-none"
          style={{ fontSize: Math.round(size * 0.45) }}
        >
          {initial}
        </span>
      ) : (
        <User style={{ width: size * 0.5, height: size * 0.5 }} />
      )}
    </div>
  );
}
