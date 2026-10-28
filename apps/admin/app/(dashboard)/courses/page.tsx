"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Input } from "@usemoney/ui/input";
import { toast } from "sonner";
import {
  Plus,
  Search,
  BookOpen,
  Users,
  Eye,
  EyeOff,
  Trash2,
} from "lucide-react";
import { getCourses, deleteCourse, publishCourse } from "@/lib/actions/courses";

export default function CoursesPage() {
  const [courses, setCourses] = useState<
    Array<{
      id: string;
      slug: string;
      title: string;
      description: string;
      level: string;
      duration: string;
      published: boolean;
      topics: string[];
      _count: { chapters: number; enrollments: number };
    }>
  >([]);
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await getCourses();
        setCourses(data as typeof courses);
      } catch {
        toast.error("Failed to load courses");
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, []);

  const handlePublish = async (courseId: string, published: boolean) => {
    try {
      await publishCourse(courseId, published);
      setCourses((prev) =>
        prev.map((c) => (c.id === courseId ? { ...c, published } : c)),
      );
      toast.success(published ? "Course published" : "Course unpublished");
    } catch {
      toast.error("Failed to update course");
    }
  };

  const handleDelete = async (courseId: string) => {
    if (!confirm("Delete this course and all its content?")) return;
    try {
      await deleteCourse(courseId);
      setCourses((prev) => prev.filter((c) => c.id !== courseId));
      toast.success("Course deleted");
    } catch {
      toast.error("Failed to delete course");
    }
  };

  const filteredCourses = courses.filter(
    (c) =>
      c.title.toLowerCase().includes(search.toLowerCase()) ||
      c.description.toLowerCase().includes(search.toLowerCase()),
  );

  const levelColors: Record<string, string> = {
    BEGINNER: "bg-emerald-600",
    INTERMEDIATE: "bg-amber-600",
    ADVANCED: "bg-red-600",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Courses</h1>
          <p className="text-sm text-slate-400">
            Manage learning courses and content
          </p>
        </div>
        <Link href="/courses/create">
          <Button className="bg-blue-600 hover:bg-blue-700">
            <Plus className="h-4 w-4 mr-2" />
            New Course
          </Button>
        </Link>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
        <Input
          placeholder="Search courses..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 bg-slate-800 border-slate-700 text-white"
        />
      </div>

      {isLoading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 bg-slate-800 rounded-lg animate-pulse"
            />
          ))}
        </div>
      ) : filteredCourses.length === 0 ? (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="p-8 text-center">
            <BookOpen className="h-8 w-8 text-slate-500 mx-auto mb-3" />
            <h3 className="text-lg font-semibold text-white mb-2">
              No Courses
            </h3>
            <p className="text-sm text-slate-400">
              Create your first course to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredCourses.map((course) => (
            <Card
              key={course.id}
              className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-colors"
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <Link href={`/courses/${course.id}`} className="flex-1">
                    <div className="flex items-center gap-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-white font-medium">
                            {course.title}
                          </h3>
                          <Badge
                            className={
                              levelColors[course.level] || "bg-slate-600"
                            }
                          >
                            {course.level}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={
                              course.published
                                ? "text-emerald-400 border-emerald-600"
                                : "text-slate-400 border-slate-600"
                            }
                          >
                            {course.published ? "Published" : "Draft"}
                          </Badge>
                        </div>
                        <p className="text-sm text-slate-400 line-clamp-1">
                          {course.description}
                        </p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                          <span>{course._count.chapters} chapters</span>
                          <span>{course.duration}</span>
                          <span className="flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            {course._count.enrollments} enrolled
                          </span>
                        </div>
                      </div>
                    </div>
                  </Link>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        handlePublish(course.id, !course.published)
                      }
                      className="text-slate-400 hover:text-white"
                    >
                      {course.published ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(course.id)}
                      className="text-slate-400 hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
