"use client";

// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { CourseDetailSkeleton } from "@/components/skeletons";
import {
  ArrowLeft,
  BookOpen,
  Clock,
  Users,
  GraduationCap,
  CheckCircle,
} from "lucide-react";
import { getCourseBySlugAction } from "@/lib/actions/learning";
import { ChapterAccordion } from "@/components/learning/ChapterAccordion";
import { EnrollButton } from "@/components/learning/EnrollButton";
import { useIsMobile } from "@/hooks/use-mobile";

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

interface CourseData {
  id: string;
  slug: string;
  title: string;
  description: string;
  level: string;
  duration: string;
  topics: string[];
  chapters: Chapter[];
  _count: { enrollments: number };
  enrollment: {
    id: string;
    progress: number;
    completedAt: string | null;
    lessonProgress: Array<{ lessonId: string; completed: boolean }>;
  } | null;
}

/* Level → accent colour, matching the design's course-thumb palette. */
const LEVEL_COLOR: Record<string, string> = {
  BEGINNER: "var(--emerald)",
  INTERMEDIATE: "var(--pop-3)",
  ADVANCED: "var(--pop-1)",
};

export default function CourseDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isMobile = useIsMobile();
  const slug = params.courseSlug as string;

  const [course, setCourse] = useState<CourseData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const demoMode =
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode");
    if (!isLoaded) return;
    if (!user && !demoMode) {
      router.push("/home");
    }
  }, [isLoaded, user, router]);

  useEffect(() => {
    async function load() {
      try {
        const result = await getCourseBySlugAction(slug);
        if (result?.success) {
          setCourse(result?.data as unknown as CourseData);
        }
      } catch {
        // handled
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [slug]);

  const totalLessons =
    course?.chapters.reduce((sum, ch) => sum + ch.lessons.length, 0) ?? 0;
  const completedLessonIds = new Set(
    course?.enrollment?.lessonProgress
      ?.filter((lp) => lp.completed)
      .map((lp) => lp.lessonId) ?? []
  );

  // Find first lesson for "Start Learning" button
  const firstLesson = course?.chapters?.[0]?.lessons?.[0];
  const accentColor = course
    ? LEVEL_COLOR[course.level] || "var(--pop-3)"
    : "var(--pop-3)";

  return (
    <PageGuard
      route="/learning"
      fallback={<CourseDetailSkeleton />}
      containerClassName="p-6"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className={`pf-page${isMobile ? " is-mobile" : ""}`}>
            {/* Back Link */}
            <Link
              href="/learning"
              className="pf-bf sm"
              style={{ marginBottom: 16, textDecoration: "none" }}
            >
              <ArrowLeft size={13} /> Back to courses
            </Link>

            {isLoading ? (
              <div
                className="pf-card flat"
                style={{ padding: 32, opacity: 0.5 }}
              >
                <div
                  style={{
                    height: 28,
                    width: "60%",
                    background: "var(--rule-softer)",
                    borderRadius: 6,
                    marginBottom: 12,
                  }}
                />
                <div
                  style={{
                    height: 14,
                    width: "90%",
                    background: "var(--rule-softer)",
                    borderRadius: 4,
                  }}
                />
              </div>
            ) : !course ? (
              <div
                className="pf-card flat"
                style={{ textAlign: "center", padding: 48 }}
              >
                <BookOpen
                  size={40}
                  style={{ color: "var(--ink-3)", margin: "0 auto 12px" }}
                />
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    marginBottom: 6,
                    color: "var(--ink)",
                  }}
                >
                  Course not found
                </h3>
                <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
                  This course may not exist or isn&apos;t published yet.
                </p>
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "2fr 1fr",
                  gap: 18,
                  alignItems: "start",
                }}
              >
                {/* ── Main column ── */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 18,
                  }}
                >
                  {/* Course header (design: pf-ph style block) */}
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        className="pf-pill"
                        style={{
                          background: accentColor,
                          color: "var(--paper)",
                          borderColor: "var(--ink)",
                        }}
                      >
                        {course.level}
                      </span>
                      {course.enrollment?.completedAt && (
                        <span className="pf-pill emerald">
                          <CheckCircle size={11} /> COMPLETED
                        </span>
                      )}
                    </div>
                    <h1
                      style={{
                        fontSize: isMobile ? 28 : 34,
                        fontWeight: 800,
                        letterSpacing: -1.2,
                        lineHeight: 1.05,
                        color: "var(--ink)",
                      }}
                    >
                      {course.title}
                    </h1>
                    <p
                      className="ser"
                      style={{
                        marginTop: 10,
                        fontSize: 16,
                        color: "var(--ink-3)",
                        lineHeight: 1.4,
                      }}
                    >
                      {course.description}
                    </p>
                  </div>

                  {/* Stats row */}
                  <div
                    className="mono"
                    style={{
                      display: "flex",
                      gap: 18,
                      flexWrap: "wrap",
                      fontSize: 12,
                      color: "var(--ink-3)",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <BookOpen size={14} /> {totalLessons} lessons
                    </span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <Clock size={14} /> {course.duration}
                    </span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <Users size={14} /> {course._count.enrollments} enrolled
                    </span>
                  </div>

                  {/* Progress */}
                  {course.enrollment && (
                    <div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          marginBottom: 6,
                        }}
                      >
                        <span
                          className="mono"
                          style={{ fontSize: 11, color: "var(--ink-3)" }}
                        >
                          PROGRESS
                        </span>
                        <span
                          className="mono"
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: "var(--emerald-text)",
                          }}
                        >
                          {Math.round(course.enrollment.progress)}%
                        </span>
                      </div>
                      <div
                        style={{
                          height: 8,
                          background: "var(--rule-softer)",
                          border: "1.5px solid var(--ink)",
                          borderRadius: 999,
                        }}
                      >
                        <div
                          style={{
                            width: `${course.enrollment.progress}%`,
                            height: "100%",
                            background: "var(--emerald)",
                            borderRadius: 999,
                          }}
                        />
                      </div>
                    </div>
                  )}

                  {/* Topics */}
                  {course.topics.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {course.topics.map((topic) => (
                        <span key={topic} className="pf-pill outline">
                          {topic}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Chapters (ChapterAccordion preserved, wired to data) */}
                  <div>
                    <div className="pf-sec-h" style={{ marginTop: 4 }}>
                      <span className="n">CONTENT</span>
                      <h3>
                        Course <span className="ser">content.</span>
                      </h3>
                      <span className="rule" />
                    </div>
                    <ChapterAccordion
                      chapters={course.chapters}
                      courseSlug={course.slug}
                      completedLessonIds={completedLessonIds}
                    />
                  </div>
                </div>

                {/* ── Sidebar column ── */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 14,
                  }}
                >
                  <div className="pf-card tilt-r" style={{ padding: 22 }}>
                    <div style={{ textAlign: "center" }}>
                      <div
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 10,
                          background: accentColor,
                          color: "var(--paper)",
                          display: "grid",
                          placeItems: "center",
                          border: "1.5px solid var(--ink)",
                          transform: "rotate(-3deg)",
                          margin: "0 auto 12px",
                        }}
                      >
                        <GraduationCap size={24} />
                      </div>
                      <div
                        style={{
                          fontSize: 17,
                          fontWeight: 800,
                          letterSpacing: -0.4,
                          color: "var(--ink)",
                        }}
                      >
                        {course.enrollment
                          ? "Continue learning"
                          : "Get started"}
                      </div>
                      <div
                        className="ser"
                        style={{
                          marginTop: 4,
                          fontSize: 13.5,
                          color: "var(--ink-3)",
                        }}
                      >
                        {course.enrollment
                          ? `${completedLessonIds.size} of ${totalLessons} lessons completed`
                          : `${totalLessons} lessons · ${course.duration}`}
                      </div>
                    </div>
                    <div style={{ marginTop: 16 }}>
                      <EnrollButton
                        courseId={course.id}
                        courseSlug={course.slug}
                        level={course.level}
                        isEnrolled={!!course.enrollment}
                        firstLessonId={firstLesson?.id}
                      />
                    </div>
                  </div>

                  {course.topics.length > 0 && (
                    <div className="pf-card" style={{ padding: 18 }}>
                      <div className="ttl">WHAT YOU&apos;LL LEARN</div>
                      <ul
                        style={{
                          marginTop: 12,
                          display: "flex",
                          flexDirection: "column",
                          gap: 8,
                          listStyle: "none",
                          padding: 0,
                        }}
                      >
                        {course.topics.map((topic) => (
                          <li
                            key={topic}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 8,
                              fontSize: 13,
                              color: "var(--ink-2)",
                            }}
                          >
                            <CheckCircle
                              size={15}
                              style={{
                                color: "var(--emerald-text)",
                                marginTop: 1,
                                flexShrink: 0,
                              }}
                            />
                            {topic}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
