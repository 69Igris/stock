"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@usemoney/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle,
  FileText,
  Video,
  Gamepad2,
} from "lucide-react";
import { cn } from "@usemoney/utils";

interface Lesson {
  id: string;
  title: string;
  type: string;
  duration: string | null;
  order: number;
}

interface Chapter {
  id: string;
  title: string;
  order: number;
  lessons: Lesson[];
}

interface ChapterAccordionProps {
  chapters: Chapter[];
  courseSlug: string;
  completedLessonIds?: Set<string>;
  currentLessonId?: string;
}

const lessonTypeIcon: Record<
  string,
  React.ComponentType<{ className?: string }>
> = {
  TEXT: FileText,
  VIDEO: Video,
  INTERACTIVE: Gamepad2,
};

export function ChapterAccordion({
  chapters,
  courseSlug,
  completedLessonIds = new Set(),
  currentLessonId,
}: ChapterAccordionProps) {
  const [openChapters, setOpenChapters] = useState<Set<string>>(() => {
    // Auto-open chapter containing current lesson
    if (currentLessonId) {
      const ch = chapters.find((c) =>
        c.lessons.some((l) => l.id === currentLessonId)
      );
      if (ch) return new Set([ch.id]);
    }
    // Default: open first chapter
    return new Set(chapters.length > 0 ? [chapters[0].id] : []);
  });

  const toggleChapter = (chapterId: string) => {
    setOpenChapters((prev) => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {chapters.map((chapter) => {
        const isOpen = openChapters.has(chapter.id);
        const completedCount = chapter.lessons.filter((l) =>
          completedLessonIds.has(l.id)
        ).length;
        const totalCount = chapter.lessons.length;

        return (
          <div
            key={chapter.id}
            className="border border-border rounded-lg overflow-hidden"
          >
            <button
              onClick={() => toggleChapter(chapter.id)}
              className="w-full flex items-center justify-between p-4 bg-card/50 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-sm font-medium text-foreground">
                  {chapter.title}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {completedCount}/{totalCount} lessons
              </span>
            </button>

            {isOpen && (
              <div className="bg-background/30">
                {chapter.lessons.map((lesson) => {
                  const Icon = lessonTypeIcon[lesson.type] || FileText;
                  const isCompleted = completedLessonIds.has(lesson.id);
                  const isCurrent = lesson.id === currentLessonId;

                  return (
                    <Link
                      key={lesson.id}
                      href={`/learning/${courseSlug}/lesson/${lesson.id}`}
                      className={cn(
                        "flex items-center gap-3 px-6 py-3 text-sm transition-colors border-t border-border/50",
                        isCurrent
                          ? "bg-blue-600/10 text-blue-400"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
                      )}
                    >
                      {isCompleted ? (
                        <CheckCircle className="h-4 w-4 text-emerald-400 shrink-0" />
                      ) : (
                        <Icon className="h-4 w-4 shrink-0" />
                      )}
                      <span className="flex-1 truncate">{lesson.title}</span>
                      {lesson.duration && (
                        <span className="text-xs text-muted-foreground/50">
                          {lesson.duration}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
