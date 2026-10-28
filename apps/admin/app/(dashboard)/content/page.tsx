"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent } from "@usemoney/ui/card";
import { Button } from "@usemoney/ui/button";
import { BookOpen, FileText, Users, Wand2, Plus } from "lucide-react";
import { getContentStats } from "@/lib/actions/stats";

export default function ContentDashboardPage() {
  const [stats, setStats] = useState({
    courses: 0,
    publishedCourses: 0,
    draftCourses: 0,
    chapters: 0,
    lessons: 0,
    enrollments: 0,
  });

  useEffect(() => {
    async function load() {
      try {
        const data = await getContentStats();
        setStats(data);
      } catch {
        // handled
      }
    }
    load();
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Content Dashboard</h1>
        <p className="text-sm text-slate-400 mt-1">
          Overview of all learning content
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="p-4">
            <BookOpen className="h-5 w-5 text-blue-400 mb-2" />
            <p className="text-2xl font-bold text-white">{stats.courses}</p>
            <p className="text-xs text-slate-400">
              Courses ({stats.publishedCourses} published)
            </p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="p-4">
            <FileText className="h-5 w-5 text-emerald-400 mb-2" />
            <p className="text-2xl font-bold text-white">{stats.lessons}</p>
            <p className="text-xs text-slate-400">Lessons</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="p-4">
            <Users className="h-5 w-5 text-amber-400 mb-2" />
            <p className="text-2xl font-bold text-white">{stats.enrollments}</p>
            <p className="text-xs text-slate-400">Enrollments</p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/courses/create">
          <Card className="bg-slate-900/50 border-slate-800 hover:border-blue-600 transition-colors cursor-pointer">
            <CardContent className="p-6 text-center">
              <Plus className="h-8 w-8 text-blue-400 mx-auto mb-3" />
              <h3 className="text-white font-medium">Create Course</h3>
              <p className="text-xs text-slate-400 mt-1">
                Build a structured learning course
              </p>
            </CardContent>
          </Card>
        </Link>
        <Link href="/content/create">
          <Card className="bg-slate-900/50 border-slate-800 hover:border-purple-600 transition-colors cursor-pointer">
            <CardContent className="p-6 text-center">
              <Wand2 className="h-8 w-8 text-purple-400 mx-auto mb-3" />
              <h3 className="text-white font-medium">AI Content Creator</h3>
              <p className="text-xs text-slate-400 mt-1">
                Generate content with AI
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
