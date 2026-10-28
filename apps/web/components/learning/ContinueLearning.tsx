"use client";

import Link from "next/link";
import { Card, CardContent } from "@usemoney/ui/card";
import { Progress } from "@usemoney/ui/progress";
import { ArrowRight, BookOpen } from "lucide-react";

interface EnrollmentItem {
  id: string;
  progress: number;
  course: {
    slug: string;
    title: string;
    level: string;
    duration: string;
  };
}

interface ContinueLearningProps {
  enrollments: EnrollmentItem[];
}

export function ContinueLearning({ enrollments }: ContinueLearningProps) {
  const inProgress = enrollments.filter(
    (e) => e.progress > 0 && e.progress < 100
  );

  if (inProgress.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-blue-400" />
        Continue Learning
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {inProgress.slice(0, 3).map((enrollment) => (
          <Link
            key={enrollment.id}
            href={`/learning/${enrollment.course.slug}`}
          >
            <Card className="bg-card/50 border-border hover:border-border transition-colors cursor-pointer">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-foreground truncate flex-1 mr-2">
                    {enrollment.course.title}
                  </h3>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
                  <span>{enrollment.course.level}</span>
                  <span>{Math.round(enrollment.progress)}%</span>
                </div>
                <Progress value={enrollment.progress} className="h-1.5" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
