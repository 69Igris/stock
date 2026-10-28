"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@usemoney/ui/button";
import { toast } from "sonner";
import { Play, Lock, Loader2, CheckCircle } from "lucide-react";
import { enrollInCourseAction } from "@/lib/actions/learning";

interface EnrollButtonProps {
  courseId: string;
  courseSlug: string;
  level: string;
  isEnrolled: boolean;
  firstLessonId?: string;
}

export function EnrollButton({
  courseId,
  courseSlug,
  level,
  isEnrolled,
  firstLessonId,
}: EnrollButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleEnroll = async () => {
    setIsLoading(true);
    try {
      const result = await enrollInCourseAction(courseId);
      if (result?.success) {
        toast.success("Enrolled successfully!");
        if (firstLessonId) {
          router.push(`/learning/${courseSlug}/lesson/${firstLessonId}`);
        } else {
          router.refresh();
        }
      } else {
        if (result?.error?.includes("Premium")) {
          toast.error(result?.error);
        } else {
          toast.error(result?.error || "Failed to enroll");
        }
      }
    } catch {
      toast.error("Failed to enroll");
    } finally {
      setIsLoading(false);
    }
  };

  if (isEnrolled) {
    return (
      <Button
        onClick={() => {
          if (firstLessonId)
            router.push(`/learning/${courseSlug}/lesson/${firstLessonId}`);
        }}
        className="w-full bg-emerald-600 hover:bg-emerald-700"
      >
        <Play className="h-4 w-4 mr-2" />
        Continue Learning
      </Button>
    );
  }

  return (
    <Button
      onClick={handleEnroll}
      disabled={isLoading}
      className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
    >
      {isLoading ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : level === "ADVANCED" ? (
        <Lock className="h-4 w-4 mr-2" />
      ) : (
        <Play className="h-4 w-4 mr-2" />
      )}
      {isLoading
        ? "Enrolling..."
        : level === "ADVANCED"
          ? "Enroll (Premium)"
          : "Enroll Free"}
    </Button>
  );
}
