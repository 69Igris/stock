"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Input } from "@usemoney/ui/input";
import { toast } from "sonner";
import {
  ArrowLeft,
  Plus,
  ChevronDown,
  ChevronRight,
  FileText,
  Trash2,
} from "lucide-react";
import { getCourseById } from "@/lib/actions/courses";
import { createChapter, deleteChapter } from "@/lib/actions/chapters";
import { createLesson, deleteLesson } from "@/lib/actions/lessons";

export default function CourseEditorPage() {
  const params = useParams();
  const courseId = params.courseId as string;
  const [course, setCourse] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(
    new Set(),
  );
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [newLessonChapterId, setNewLessonChapterId] = useState<string | null>(
    null,
  );
  const [newLessonTitle, setNewLessonTitle] = useState("");

  const loadCourse = useCallback(async () => {
    try {
      const data = await getCourseById(courseId);
      setCourse(data as unknown as Record<string, unknown>);
      if (data?.chapters) {
        setExpandedChapters(
          new Set(data.chapters.map((c: { id: string }) => c.id)),
        );
      }
    } catch {
      toast.error("Failed to load course");
    } finally {
      setIsLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    loadCourse();
  }, [loadCourse]);

  const handleAddChapter = async () => {
    if (!newChapterTitle.trim()) return;
    try {
      await createChapter({ courseId, title: newChapterTitle });
      setNewChapterTitle("");
      loadCourse();
      toast.success("Chapter added");
    } catch {
      toast.error("Failed to add chapter");
    }
  };

  const handleDeleteChapter = async (chapterId: string) => {
    if (!confirm("Delete this chapter and all lessons?")) return;
    try {
      await deleteChapter(chapterId);
      loadCourse();
      toast.success("Chapter deleted");
    } catch {
      toast.error("Failed to delete chapter");
    }
  };

  const handleAddLesson = async (chapterId: string) => {
    if (!newLessonTitle.trim()) return;
    try {
      await createLesson({
        chapterId,
        title: newLessonTitle,
        content:
          "# " +
          newLessonTitle +
          "\n\nStart writing your lesson content here...",
      });
      setNewLessonTitle("");
      setNewLessonChapterId(null);
      loadCourse();
      toast.success("Lesson added");
    } catch {
      toast.error("Failed to add lesson");
    }
  };

  const handleDeleteLesson = async (lessonId: string) => {
    if (!confirm("Delete this lesson?")) return;
    try {
      await deleteLesson(lessonId);
      loadCourse();
      toast.success("Lesson deleted");
    } catch {
      toast.error("Failed to delete lesson");
    }
  };

  const toggleChapter = (id: string) => {
    setExpandedChapters((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (isLoading) {
    return <div className="h-64 bg-slate-800 rounded-lg animate-pulse" />;
  }

  if (!course) {
    return <p className="text-white">Course not found</p>;
  }

  const chapters = (course.chapters || []) as Array<{
    id: string;
    title: string;
    order: number;
    lessons: Array<{ id: string; title: string; type: string; order: number }>;
  }>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/courses">
          <Button variant="ghost" size="sm" className="text-slate-400">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">
            {course.title as string}
          </h1>
          <p className="text-sm text-slate-400">
            {course.description as string}
          </p>
        </div>
      </div>

      {/* Chapters & Lessons Tree */}
      <div className="space-y-3">
        {chapters.map((chapter) => (
          <Card key={chapter.id} className="bg-slate-900/50 border-slate-800">
            <CardContent className="p-0">
              <button
                onClick={() => toggleChapter(chapter.id)}
                className="w-full flex items-center justify-between p-4 hover:bg-slate-800/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  {expandedChapters.has(chapter.id) ? (
                    <ChevronDown className="h-4 w-4 text-slate-400" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                  )}
                  <span className="text-white font-medium">
                    {chapter.title}
                  </span>
                  <Badge
                    variant="outline"
                    className="text-slate-400 border-slate-600"
                  >
                    {chapter.lessons.length} lessons
                  </Badge>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteChapter(chapter.id);
                  }}
                  className="text-slate-400 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </button>

              {expandedChapters.has(chapter.id) && (
                <div className="px-4 pb-4 space-y-2">
                  {chapter.lessons.map((lesson) => (
                    <div
                      key={lesson.id}
                      className="flex items-center justify-between pl-6 py-2 border-l-2 border-slate-700 ml-2"
                    >
                      <Link
                        href={`/courses/${courseId}/lessons/${lesson.id}`}
                        className="flex items-center gap-2 text-sm text-slate-300 hover:text-white"
                      >
                        <FileText className="h-3.5 w-3.5" />
                        {lesson.title}
                        <Badge
                          variant="outline"
                          className="text-xs text-slate-500 border-slate-600"
                        >
                          {lesson.type}
                        </Badge>
                      </Link>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDeleteLesson(lesson.id)}
                        className="text-slate-400 hover:text-red-400 h-6 w-6 p-0"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}

                  {/* Add Lesson */}
                  {newLessonChapterId === chapter.id ? (
                    <div className="flex items-center gap-2 pl-6 ml-2">
                      <Input
                        value={newLessonTitle}
                        onChange={(e) => setNewLessonTitle(e.target.value)}
                        placeholder="Lesson title..."
                        className="bg-slate-800 border-slate-700 text-white text-sm h-8"
                        onKeyDown={(e) =>
                          e.key === "Enter" && handleAddLesson(chapter.id)
                        }
                        autoFocus
                      />
                      <Button
                        size="sm"
                        onClick={() => handleAddLesson(chapter.id)}
                        className="h-8 bg-blue-600"
                      >
                        Add
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setNewLessonChapterId(null)}
                        className="h-8"
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setNewLessonChapterId(chapter.id)}
                      className="flex items-center gap-2 pl-6 ml-2 text-xs text-blue-400 hover:text-blue-300"
                    >
                      <Plus className="h-3 w-3" /> Add Lesson
                    </button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {/* Add Chapter */}
        <Card className="bg-slate-900/50 border-slate-800 border-dashed">
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Input
                value={newChapterTitle}
                onChange={(e) => setNewChapterTitle(e.target.value)}
                placeholder="New chapter title..."
                className="bg-slate-800 border-slate-700 text-white"
                onKeyDown={(e) => e.key === "Enter" && handleAddChapter()}
              />
              <Button
                onClick={handleAddChapter}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Plus className="h-4 w-4 mr-1" /> Add Chapter
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
