"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Input } from "@usemoney/ui/input";
import { Label } from "@usemoney/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { toast } from "sonner";
import { ArrowLeft, Save, Wand2, Trash2 } from "lucide-react";
import { getLessonById, updateLesson } from "@/lib/actions/lessons";
import { generateQuizzesForLesson, deleteQuiz } from "@/lib/actions/quizzes";

export default function LessonEditorPage() {
  const params = useParams();
  const router = useRouter();
  const courseId = params.courseId as string;
  const lessonId = params.lessonId as string;

  const [lesson, setLesson] = useState<Record<string, unknown> | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [type, setType] = useState("TEXT");
  const [videoUrl, setVideoUrl] = useState("");
  const [duration, setDuration] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await getLessonById(lessonId);
        if (data) {
          setLesson(data as unknown as Record<string, unknown>);
          setTitle(data.title);
          setContent(data.content);
          setType(data.type);
          setVideoUrl(data.videoUrl || "");
          setDuration(data.duration || "");
        }
      } catch {
        toast.error("Failed to load lesson");
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [lessonId]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await updateLesson(lessonId, {
        title,
        content,
        type,
        videoUrl: videoUrl || undefined,
        duration: duration || undefined,
      });
      toast.success("Lesson saved");
    } catch {
      toast.error("Failed to save lesson");
    } finally {
      setIsSaving(false);
    }
  };

  const handleGenerateQuiz = async () => {
    setIsGenerating(true);
    try {
      const chapter = lesson?.chapter as Record<string, unknown> | undefined;
      const course = chapter?.course as Record<string, unknown> | undefined;
      const level = (course?.level as string) || "BEGINNER";
      await generateQuizzesForLesson(
        lessonId,
        title,
        level as "BEGINNER" | "INTERMEDIATE" | "ADVANCED",
      );
      toast.success("Quizzes generated");
      // Reload
      const data = await getLessonById(lessonId);
      setLesson(data as unknown as Record<string, unknown>);
    } catch {
      toast.error("Failed to generate quizzes. Check if Gemini is enabled.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDeleteQuiz = async (quizId: string) => {
    try {
      await deleteQuiz(quizId);
      const data = await getLessonById(lessonId);
      setLesson(data as unknown as Record<string, unknown>);
      toast.success("Quiz deleted");
    } catch {
      toast.error("Failed to delete quiz");
    }
  };

  if (isLoading) {
    return <div className="h-64 bg-slate-800 rounded-lg animate-pulse" />;
  }

  const quizzes = (lesson?.quizzes || []) as Array<{
    id: string;
    question: string;
    options: string[];
    correctAnswer: number;
    explanation: string | null;
  }>;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href={`/courses/${courseId}`}>
            <Button variant="ghost" size="sm" className="text-slate-400">
              <ArrowLeft className="h-4 w-4 mr-1" /> Back
            </Button>
          </Link>
          <h1 className="text-xl font-bold text-white">Edit Lesson</h1>
        </div>
        <Button
          onClick={handleSave}
          disabled={isSaving}
          className="bg-blue-600 hover:bg-blue-700"
        >
          <Save className="h-4 w-4 mr-2" />
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>

      {/* Lesson Content */}
      <Card className="bg-slate-900/50 border-slate-800">
        <CardContent className="p-6 space-y-4">
          <div>
            <Label className="text-slate-300">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-slate-800 border-slate-700 text-white"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <Label className="text-slate-300">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="bg-slate-800 border-slate-700">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="TEXT">Text</SelectItem>
                  <SelectItem value="VIDEO">Video</SelectItem>
                  <SelectItem value="INTERACTIVE">Interactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type === "VIDEO" && (
              <div>
                <Label className="text-slate-300">Video URL</Label>
                <Input
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white"
                />
              </div>
            )}
            <div>
              <Label className="text-slate-300">Duration</Label>
              <Input
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="e.g., 10 min"
                className="bg-slate-800 border-slate-700 text-white"
              />
            </div>
          </div>

          <div>
            <Label className="text-slate-300">Content (Markdown)</Label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-96 px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-white font-mono text-sm resize-none"
            />
          </div>
        </CardContent>
      </Card>

      {/* Quizzes */}
      <Card className="bg-slate-900/50 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white">
              Quizzes ({quizzes.length})
            </CardTitle>
            <Button
              onClick={handleGenerateQuiz}
              disabled={isGenerating}
              variant="outline"
              className="border-blue-600 text-blue-400 hover:bg-blue-600/10"
            >
              <Wand2 className="h-4 w-4 mr-2" />
              {isGenerating ? "Generating..." : "AI Generate"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {quizzes.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">
              No quizzes yet. Click &quot;AI Generate&quot; to create quizzes.
            </p>
          ) : (
            quizzes.map((quiz, index) => (
              <div key={quiz.id} className="p-3 bg-slate-800/50 rounded-lg">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm text-white font-medium mb-2">
                      Q{index + 1}: {quiz.question}
                    </p>
                    <div className="space-y-1">
                      {quiz.options.map((opt, i) => (
                        <p
                          key={i}
                          className={`text-xs ${i === quiz.correctAnswer ? "text-emerald-400 font-medium" : "text-slate-400"}`}
                        >
                          {i === quiz.correctAnswer ? "✓" : "○"} {opt}
                        </p>
                      ))}
                    </div>
                    {quiz.explanation && (
                      <p className="text-xs text-slate-400 mt-2 italic">
                        {quiz.explanation}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDeleteQuiz(quiz.id)}
                    className="text-slate-400 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
