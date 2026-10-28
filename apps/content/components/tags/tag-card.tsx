"use client";

import Link from "next/link";
import { FileText, Edit } from "lucide-react";
import { Badge } from "@usemoney/ui/badge";
import { Button } from "@usemoney/ui/button";
import { cn } from "@/lib/utils";

interface TagCardProps {
  tag: {
    id: string;
    slug: string;
    name: string;
    description?: string | null;
    color?: string | null;
    imageUrl?: string | null;
    _count: {
      posts: number;
    };
  };
}

export function TagCard({ tag }: TagCardProps) {
  const color = tag.color || "#3b82f6";
  const postCount = tag._count.posts;

  return (
    <div className="group relative rounded-xl border border-slate-800 bg-slate-900/50 overflow-hidden hover:border-slate-700 transition-all duration-200 hover:shadow-lg hover:shadow-slate-950/50">
      {/* Color indicator bar at top */}
      <div className="h-2 w-full" style={{ backgroundColor: color }} />

      {/* Card content */}
      <div className="p-5">
        {/* Header with name and edit button */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-white text-lg truncate group-hover:text-blue-400 transition-colors">
              {tag.name}
            </h3>
            <p className="text-sm text-slate-500 mt-0.5 font-mono">
              /{tag.slug}
            </p>
          </div>
          <Link href={`/tags/${tag.slug}`}>
            <Button
              size="sm"
              variant="ghost"
              className="opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8 p-0 text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <Edit className="h-4 w-4" />
            </Button>
          </Link>
        </div>

        {/* Description */}
        {tag.description && (
          <p className="mt-3 text-sm text-slate-400 line-clamp-2">
            {tag.description}
          </p>
        )}

        {/* Footer with post count */}
        <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-800">
          <Badge
            variant="secondary"
            className={cn(
              "bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors",
              postCount === 0 && "opacity-50",
            )}
          >
            <FileText className="h-3 w-3 mr-1.5" />
            {postCount} {postCount === 1 ? "post" : "posts"}
          </Badge>

          {/* Color preview */}
          <div className="flex items-center gap-2">
            <div
              className="h-5 w-5 rounded-md border border-slate-700"
              style={{ backgroundColor: color }}
            />
            <span className="text-xs text-slate-500 font-mono">{color}</span>
          </div>
        </div>
      </div>

      {/* Click overlay for the entire card */}
      <Link
        href={`/tags/${tag.slug}`}
        className="absolute inset-0 z-0"
        aria-label={`Edit ${tag.name}`}
      >
        <span className="sr-only">Edit {tag.name}</span>
      </Link>
    </div>
  );
}
