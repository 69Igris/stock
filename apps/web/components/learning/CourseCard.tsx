"use client";

import Link from "next/link";
import { Card, CardContent, CardFooter } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Progress } from "@usemoney/ui/progress";
import { BookOpen, Clock, Users, Lock } from "lucide-react";

interface CourseCardProps {
  slug: string;
  title: string;
  description: string;
  level: string;
  duration: string;
  topics: string[];
  lessonCount: number;
  enrollmentCount: number;
  enrollment?: {
    progress: number;
    completedAt: string | null;
  } | null;
  image?: string | null;
}

const levelColors: Record<string, string> = {
  BEGINNER: "bg-emerald-600/20 text-emerald-400 border-emerald-600/30",
  INTERMEDIATE: "bg-amber-600/20 text-amber-400 border-amber-600/30",
  ADVANCED: "bg-red-600/20 text-red-400 border-red-600/30",
};

export function CourseCard({
  slug,
  title,
  description,
  level,
  duration,
  topics,
  lessonCount,
  enrollmentCount,
  enrollment,
}: CourseCardProps) {
  const isEnrolled = !!enrollment;
  const progress = enrollment?.progress ?? 0;
  const isCompleted = !!enrollment?.completedAt;

  return (
    <Link href={`/learning/${slug}`}>
      <Card className="bg-card/50 border-border hover:border-border transition-all cursor-pointer h-full flex flex-col">
        <CardContent className="p-5 flex-1">
          <div className="flex items-start justify-between mb-3">
            <Badge
              variant="outline"
              className={
                levelColors[level] || "text-muted-foreground border-border"
              }
            >
              {level}
            </Badge>
            {level === "ADVANCED" && !isEnrolled && (
              <Lock className="h-4 w-4 text-amber-400" />
            )}
          </div>

          <h3 className="text-lg font-semibold text-foreground mb-2 line-clamp-2">
            {title}
          </h3>
          <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
            {description}
          </p>

          <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3">
            <span className="flex items-center gap-1">
              <BookOpen className="h-3.5 w-3.5" />
              {lessonCount} lessons
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              {duration}
            </span>
            <span className="flex items-center gap-1">
              <Users className="h-3.5 w-3.5" />
              {enrollmentCount}
            </span>
          </div>

          <div className="flex flex-wrap gap-1">
            {topics.slice(0, 3).map((topic) => (
              <Badge
                key={topic}
                variant="outline"
                className="text-xs text-muted-foreground border-border"
              >
                {topic}
              </Badge>
            ))}
            {topics.length > 3 && (
              <Badge
                variant="outline"
                className="text-xs text-muted-foreground border-border"
              >
                +{topics.length - 3}
              </Badge>
            )}
          </div>
        </CardContent>

        {isEnrolled && (
          <CardFooter className="px-5 pb-5 pt-0">
            <div className="w-full">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span
                  className={
                    isCompleted ? "text-emerald-400" : "text-muted-foreground"
                  }
                >
                  {isCompleted
                    ? "Completed"
                    : `${Math.round(progress)}% complete`}
                </span>
              </div>
              <Progress value={progress} className="h-1.5" />
            </div>
          </CardFooter>
        )}
      </Card>
    </Link>
  );
}
