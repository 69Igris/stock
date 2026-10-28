"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { LearningSkeleton } from "@/components/skeletons";
import {
  GraduationCap,
  BookOpen,
  Search,
  Trophy,
  Sparkles,
  ArrowRight,
} from "lucide-react";
import {
  getCoursesAction,
  getUserEnrollmentsAction,
} from "@/lib/actions/learning";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsDemoMode, useIsDemoModeReady } from "@/lib/hooks/useIsDemoMode";

interface CourseItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  level: string;
  duration: string;
  topics: string[];
  lessonCount: number;
  enrollmentCount: number;
  image: string | null;
}

interface EnrollmentItem {
  id: string;
  progress: number;
  courseId: string;
  course: {
    id: string;
    slug: string;
    title: string;
    level: string;
    duration: string;
  };
}

/* Level → accent colour, matching the design's course-thumb palette. */
const LEVEL_COLOR: Record<string, string> = {
  BEGINNER: "var(--emerald)",
  INTERMEDIATE: "var(--pop-3)",
  ADVANCED: "var(--pop-1)",
};

export default function LearningClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isMobile = useIsMobile();

  const [courses, setCourses] = useState<CourseItem[]>([]);
  const [enrollments, setEnrollments] = useState<EnrollmentItem[]>([]);
  const [search, setSearch] = useState("");
  const [levelFilter, setLevelFilter] = useState("ALL");
  const [isLoading, setIsLoading] = useState(true);

  const isDemoMode = useIsDemoMode({ user });
  const demoModeReady = useIsDemoModeReady();

  useEffect(() => {
    if (!isLoaded) return;
    if (!demoModeReady) return;
    if (!user && !isDemoMode) {
      router.push("/home");
    }
  }, [isLoaded, demoModeReady, user, router, isDemoMode]);

  useEffect(() => {
    async function load() {
      try {
        const [coursesResult, enrollmentsResult] = await Promise.all([
          getCoursesAction({
            level: levelFilter !== "ALL" ? levelFilter : undefined,
            search: search || undefined,
          }),
          getUserEnrollmentsAction(),
        ]);

        if (coursesResult.success) {
          setCourses(coursesResult.data as unknown as CourseItem[]);
        }
        if (enrollmentsResult.success) {
          setEnrollments(enrollmentsResult.data as unknown as EnrollmentItem[]);
        }
      } catch {
        // handled
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [search, levelFilter]);

  // Build enrollment lookup
  const enrollmentByCourseId = new Map(
    enrollments.map((e) => [e.courseId, { progress: e.progress }])
  );

  // First in-progress enrollment drives the "Continue learning" banner.
  const continueEnrollment = enrollments.find(
    (e) => e.progress > 0 && e.progress < 100
  );

  const levels = ["ALL", "BEGINNER", "INTERMEDIATE", "ADVANCED"];
  const levelLabel = (l: string) =>
    l === "ALL" ? "All" : l.charAt(0) + l.slice(1).toLowerCase();

  return (
    <PageGuard
      route="/learning"
      fallback={<LearningSkeleton />}
      containerClassName="p-6"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className={`pf-page${isMobile ? " is-mobile" : ""}`}>
            {isDemoMode && <DemoBanner />}

            {/* ── Page heading (design: LearningScreen pf-ph) ── */}
            <div className={`pf-ph${isMobile ? " is-mobile" : ""}`}>
              <div className="l">
                <div className="eyebrow">
                  <span className="d" aria-hidden />
                  {courses.length} {courses.length === 1 ? "COURSE" : "COURSES"}{" "}
                  · INDIAN MARKETS · BEGINNER → PRO
                </div>
                <h1>
                  Get smarter, <span className="ser">slowly.</span>
                </h1>
                <div className="sub">
                  Courses built for Indian retail investors. No abstract finance
                  — only NSE/BSE examples.
                </div>
              </div>
              <div className="r">
                <Link href="/quizzes" className="pf-bf">
                  <Trophy size={13} /> Quizzes
                </Link>
                <Link href="/sage-tutor" className="pf-bs">
                  <Sparkles size={13} /> Tutor session
                </Link>
              </div>
            </div>

            {/* ── Continue learning (design: gold-headed tilt card) ── */}
            <DemoGate
              isDemoMode={isDemoMode}
              message="Sign up to enroll in courses"
            >
              {continueEnrollment && (
                <div
                  className="pf-card tilt-l"
                  style={{
                    padding: 0,
                    marginBottom: 22,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      padding: "14px 22px",
                      background: "var(--ink)",
                      color: "var(--paper)",
                      borderBottom: "2px solid var(--ink)",
                    }}
                  >
                    <div className="ttl" style={{ color: "var(--pop-2-text)" }}>
                      CONTINUE LEARNING
                    </div>
                  </div>
                  <div
                    style={{
                      padding: 22,
                      display: "grid",
                      gridTemplateColumns: isMobile ? "1fr" : "auto 1fr auto",
                      gap: isMobile ? 14 : 24,
                      alignItems: "center",
                    }}
                  >
                    <div
                      style={{
                        width: isMobile ? "100%" : 150,
                        aspectRatio: "16/10",
                        borderRadius: 10,
                        background:
                          LEVEL_COLOR[continueEnrollment.course.level] ||
                          "var(--pop-3)",
                        border: "2px solid var(--ink)",
                        display: "grid",
                        placeItems: "center",
                        color: "var(--paper)",
                      }}
                    >
                      <GraduationCap size={44} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="ttl">
                        {continueEnrollment.course.level}
                      </div>
                      <div
                        style={{
                          marginTop: 4,
                          fontSize: 20,
                          fontWeight: 800,
                          letterSpacing: -0.5,
                        }}
                      >
                        {continueEnrollment.course.title}
                      </div>
                      <div
                        className="ser"
                        style={{
                          marginTop: 8,
                          fontSize: 14,
                          color: "var(--ink-3)",
                        }}
                      >
                        You&apos;re {Math.round(continueEnrollment.progress)}%
                        through.
                      </div>
                      <div
                        style={{
                          marginTop: 14,
                          height: 8,
                          background: "var(--rule-softer)",
                          border: "1.5px solid var(--ink)",
                          borderRadius: 999,
                        }}
                      >
                        <div
                          style={{
                            width: `${continueEnrollment.progress}%`,
                            height: "100%",
                            background: "var(--emerald)",
                            borderRadius: 999,
                          }}
                        />
                      </div>
                    </div>
                    <Link
                      href={`/learning/${continueEnrollment.course.slug}`}
                      className="pf-bs"
                      style={isMobile ? { justifyContent: "center" } : {}}
                    >
                      Resume <ArrowRight size={12} />
                    </Link>
                  </div>
                </div>
              )}
            </DemoGate>

            {/* ── Catalog section header + filter pills ── */}
            <div className="pf-sec-h">
              <span className="n">CATALOG</span>
              <h3>
                All{" "}
                <span className="ser">
                  {courses.length} {courses.length === 1 ? "course" : "courses"}
                  .
                </span>
              </h3>
              <span className="rule" />
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 16,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {/* Search */}
              <div
                className="pf-input"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flex: isMobile ? "1 1 100%" : "1 1 220px",
                  maxWidth: isMobile ? "none" : 320,
                  padding: "8px 12px",
                }}
              >
                <Search size={15} style={{ color: "var(--ink-3)" }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search courses…"
                  style={{
                    border: 0,
                    padding: 0,
                    background: "transparent",
                    color: "var(--ink)",
                    fontSize: 13.5,
                    flex: 1,
                    outline: "none",
                    fontFamily: "inherit",
                  }}
                />
              </div>
              {/* Level pills */}
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {levels.map((level) => {
                  const active = levelFilter === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setLevelFilter(level)}
                      className={`pf-pill ${active ? "" : "outline"}`}
                      style={{
                        cursor: "pointer",
                        ...(active
                          ? {
                              background: "var(--ink)",
                              color: "var(--paper)",
                            }
                          : {}),
                      }}
                    >
                      {levelLabel(level)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Course grid ── */}
            {isLoading ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile
                    ? "1fr"
                    : "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: 14,
                }}
              >
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div
                    key={i}
                    className="pf-card flat"
                    style={{ padding: 16, opacity: 0.5 }}
                  >
                    <div
                      style={{
                        height: 96,
                        borderRadius: 8,
                        background: "var(--rule-softer)",
                        border: "1.5px solid var(--rule-soft)",
                        marginBottom: 12,
                      }}
                    />
                    <div
                      style={{
                        height: 16,
                        width: "75%",
                        background: "var(--rule-softer)",
                        borderRadius: 4,
                        marginBottom: 8,
                      }}
                    />
                    <div
                      style={{
                        height: 11,
                        width: "50%",
                        background: "var(--rule-softer)",
                        borderRadius: 4,
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : courses.length === 0 ? (
              <div
                className="pf-card flat"
                style={{ textAlign: "center", padding: 48 }}
              >
                <BookOpen
                  size={40}
                  style={{
                    color: "var(--ink-3)",
                    margin: "0 auto 12px",
                  }}
                />
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 800,
                    marginBottom: 6,
                    color: "var(--ink)",
                  }}
                >
                  No courses found
                </h3>
                <p style={{ fontSize: 13, color: "var(--ink-3)" }}>
                  {search
                    ? "Try adjusting your search."
                    : "Courses are being prepared. Check back soon!"}
                </p>
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile
                    ? "1fr"
                    : "repeat(auto-fill, minmax(260px, 1fr))",
                  gap: 14,
                }}
              >
                {courses.map((course) => {
                  const enrollment = enrollmentByCourseId.get(course.id);
                  const progress = enrollment?.progress ?? 0;
                  const color = LEVEL_COLOR[course.level] || "var(--pop-3)";
                  return (
                    <Link
                      key={course.id}
                      href={`/learning/${course.slug}`}
                      className="pf-card"
                      style={{
                        padding: 16,
                        display: "block",
                        textDecoration: "none",
                        color: "var(--ink)",
                      }}
                    >
                      <div
                        style={{
                          height: 96,
                          borderRadius: 8,
                          background: color,
                          marginBottom: 12,
                          display: "grid",
                          placeItems: "center",
                          color: "var(--paper)",
                          border: "1.5px solid var(--ink)",
                          position: "relative",
                          overflow: "hidden",
                        }}
                      >
                        <GraduationCap size={28} />
                        <span
                          className="mono"
                          style={{
                            position: "absolute",
                            bottom: 8,
                            left: 8,
                            fontSize: 9.5,
                            padding: "2px 7px",
                            background: "rgba(0,0,0,0.4)",
                            color: "#fff",
                            borderRadius: 4,
                            letterSpacing: 1,
                          }}
                        >
                          {course.level}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 14.5,
                          fontWeight: 800,
                          letterSpacing: -0.3,
                          color: "var(--ink)",
                        }}
                      >
                        {course.title}
                      </div>
                      <div
                        className="mono"
                        style={{
                          marginTop: 4,
                          fontSize: 10.5,
                          color: "var(--ink-3)",
                        }}
                      >
                        {course.lessonCount}{" "}
                        {course.lessonCount === 1 ? "module" : "modules"} ·{" "}
                        {course.duration}
                      </div>
                      {progress > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <div
                            style={{
                              height: 5,
                              background: "var(--rule-softer)",
                              border: "1px solid var(--rule-soft)",
                              borderRadius: 999,
                            }}
                          >
                            <div
                              style={{
                                width: `${progress}%`,
                                height: "100%",
                                background: "var(--emerald)",
                                borderRadius: 999,
                              }}
                            />
                          </div>
                          <div
                            className="mono"
                            style={{
                              marginTop: 4,
                              fontSize: 10,
                              color: "var(--emerald-text)",
                            }}
                          >
                            {Math.round(progress)}% complete
                          </div>
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
