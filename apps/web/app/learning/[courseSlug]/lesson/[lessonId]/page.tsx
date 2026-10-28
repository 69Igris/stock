"use client";

// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { LessonSkeleton } from "@/components/skeletons";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  BookOpen,
  MessageSquare,
  Lock,
} from "lucide-react";
import {
  getLessonByIdAction,
  updateLessonProgressAction,
  getCourseBySlugAction,
} from "@/lib/actions/learning";
import { ChapterAccordion } from "@/components/learning/ChapterAccordion";
import { QuizSection } from "@/components/learning/QuizSection";
import { TutorChat } from "@/components/learning/TutorChat";
import { useIsMobile } from "@/hooks/use-mobile";

interface QuizItem {
  id: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string | null;
}

interface LessonSibling {
  id: string;
  title: string;
  order: number;
}

interface LessonData {
  id: string;
  title: string;
  content: string;
  type: string;
  videoUrl: string | null;
  duration: string | null;
  quizzes: QuizItem[];
  chapter: {
    id: string;
    title: string;
    lessons: LessonSibling[];
    course: {
      id: string;
      slug: string;
      title: string;
      level: string;
    };
  };
}

interface CourseChapter {
  id: string;
  title: string;
  order: number;
  lessons: Array<{
    id: string;
    title: string;
    type: string;
    duration: string | null;
    order: number;
  }>;
}

interface CourseForSidebar {
  chapters: CourseChapter[];
  enrollment: {
    id: string;
    lessonProgress: Array<{ lessonId: string; completed: boolean }>;
  } | null;
}

export default function LessonViewerPage() {
  const params = useParams();
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isMobile = useIsMobile();
  const courseSlug = params.courseSlug as string;
  const lessonId = params.lessonId as string;

  const [lesson, setLesson] = useState<LessonData | null>(null);
  // MONEY-1062: when getLessonByIdAction FAILS the page must not silently render
  // an empty state. Capture the failure so we can show the premium/locked
  // treatment (code PREMIUM_REQUIRED) or a plain error instead of nothing.
  const [lessonError, setLessonError] = useState<{
    premium: boolean;
    message: string;
  } | null>(null);
  const [courseData, setCourseData] = useState<CourseForSidebar | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCompleting, setIsCompleting] = useState(false);
  const [showChat, setShowChat] = useState(false);

  useEffect(() => {
    const demoMode =
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode");
    if (!isLoaded) return;
    if (!user && !demoMode) router.push("/home");
  }, [isLoaded, user, router]);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      setLessonError(null);
      try {
        const [lessonResult, courseResult] = await Promise.all([
          getLessonByIdAction(lessonId),
          getCourseBySlugAction(courseSlug),
        ]);
        if (lessonResult.success) {
          setLesson(lessonResult.data as unknown as LessonData);
          setLessonError(null);
        } else {
          setLesson(null);
          // The action forwards the service ServiceResult verbatim, which carries
          // `code: "PREMIUM_REQUIRED"` for a gated ADVANCED lesson (not part of the
          // ActionResponse type — read it defensively, same as apps/api).
          const code = (lessonResult as { code?: string }).code;
          setLessonError({
            premium: code === "PREMIUM_REQUIRED",
            message:
              lessonResult.error ||
              "This lesson could not be loaded. Please try again.",
          });
        }
        if (courseResult.success) {
          setCourseData(courseResult.data as unknown as CourseForSidebar);
        }
      } catch {
        setLesson(null);
        setLessonError({
          premium: false,
          message: "This lesson could not be loaded. Please try again.",
        });
      } finally {
        setIsLoading(false);
      }
    }
    load();
  }, [lessonId, courseSlug]);

  const completedLessonIds = new Set(
    courseData?.enrollment?.lessonProgress
      ?.filter((lp) => lp.completed)
      .map((lp) => lp.lessonId) ?? []
  );

  const isLessonCompleted = completedLessonIds.has(lessonId);

  // Find prev/next lessons across all chapters
  const allLessons: Array<{ id: string; title: string }> = [];
  courseData?.chapters.forEach((ch) => {
    ch.lessons.forEach((l) => allLessons.push(l));
  });
  const currentIdx = allLessons.findIndex((l) => l.id === lessonId);
  const prevLesson = currentIdx > 0 ? allLessons[currentIdx - 1] : null;
  const nextLesson =
    currentIdx < allLessons.length - 1 ? allLessons[currentIdx + 1] : null;

  const handleMarkComplete = useCallback(async () => {
    if (!courseData?.enrollment || isCompleting) return;
    setIsCompleting(true);
    try {
      const result = await updateLessonProgressAction(
        courseData.enrollment.id,
        lessonId,
        true
      );
      if (result?.success) {
        toast.success("Lesson marked as complete!");
        // Refresh data
        const courseResult = await getCourseBySlugAction(courseSlug);
        if (courseResult.success) {
          setCourseData(courseResult.data as unknown as CourseForSidebar);
        }
      } else {
        toast.error(result?.error || "Failed to mark complete");
      }
    } catch {
      toast.error("Failed to update progress");
    } finally {
      setIsCompleting(false);
    }
  }, [courseData, lessonId, courseSlug, isCompleting]);

  const handleQuizComplete = useCallback(
    async (score: number, total: number) => {
      if (!courseData?.enrollment) return;
      try {
        await updateLessonProgressAction(
          courseData.enrollment.id,
          lessonId,
          true,
          Math.round((score / total) * 100)
        );
        const courseResult = await getCourseBySlugAction(courseSlug);
        if (courseResult.success) {
          setCourseData(courseResult.data as unknown as CourseForSidebar);
        }
      } catch {
        // handled
      }
    },
    [courseData, lessonId, courseSlug]
  );

  return (
    <PageGuard
      route="/learning"
      fallback={<LessonSkeleton />}
      containerClassName="p-6"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />

        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className={`pf-page${isMobile ? " is-mobile" : ""}`}>
            {isLoading ? (
              <div
                className="pf-card flat"
                style={{ padding: 32, opacity: 0.5 }}
              >
                <div
                  style={{
                    height: 28,
                    width: "55%",
                    background: "var(--rule-softer)",
                    borderRadius: 6,
                    marginBottom: 14,
                  }}
                />
                <div
                  style={{
                    aspectRatio: "16/9",
                    background: "var(--rule-softer)",
                    borderRadius: 10,
                  }}
                />
              </div>
            ) : !lesson ? (
              lessonError?.premium ? (
                // MONEY-1062: a fail-closed PREMIUM_REQUIRED lesson gets an explicit
                // upgrade/locked treatment (not a silent empty page). Reuses the
                // page's existing card + button classes — theme-aware, no new design.
                <div
                  className="pf-card flat"
                  style={{ textAlign: "center", padding: 48 }}
                >
                  <Lock
                    size={40}
                    style={{ color: "var(--ink-3)", margin: "0 auto 12px" }}
                  />
                  <h3
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      marginBottom: 8,
                      color: "var(--ink)",
                    }}
                  >
                    Premium lesson
                  </h3>
                  <p
                    style={{
                      fontSize: 14,
                      lineHeight: 1.5,
                      color: "var(--ink-2)",
                      maxWidth: 420,
                      margin: "0 auto 18px",
                    }}
                  >
                    {lessonError.message ||
                      "This lesson requires a premium subscription."}
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      flexWrap: "wrap",
                      justifyContent: "center",
                    }}
                  >
                    <Link
                      href="/pricing"
                      className="pf-bs"
                      style={{ textDecoration: "none" }}
                    >
                      Upgrade to unlock
                    </Link>
                    <Link
                      href={`/learning/${courseSlug}`}
                      className="pf-bf"
                      style={{ textDecoration: "none" }}
                    >
                      Back to course
                    </Link>
                  </div>
                </div>
              ) : (
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
                      marginBottom: 12,
                      color: "var(--ink)",
                    }}
                  >
                    {lessonError ? "Lesson unavailable" : "Lesson not found"}
                  </h3>
                  <Link
                    href={`/learning/${courseSlug}`}
                    className="pf-bf"
                    style={{ textDecoration: "none" }}
                  >
                    Back to course
                  </Link>
                </div>
              )
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "1fr 280px",
                  gap: 18,
                  alignItems: "start",
                }}
              >
                {/* ── Main lesson column ── */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 18,
                  }}
                >
                  {/* Breadcrumb */}
                  <div
                    className="mono"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 11,
                      color: "var(--ink-3)",
                      flexWrap: "wrap",
                    }}
                  >
                    <Link
                      href="/learning"
                      style={{
                        color: "var(--ink-3)",
                        textDecoration: "none",
                      }}
                    >
                      LEARNING
                    </Link>
                    <span>/</span>
                    <Link
                      href={`/learning/${courseSlug}`}
                      style={{
                        color: "var(--ink-3)",
                        textDecoration: "none",
                      }}
                    >
                      {lesson.chapter.course.title.toUpperCase()}
                    </Link>
                    <span>/</span>
                    <span style={{ color: "var(--ink)" }}>
                      {lesson.title.toUpperCase()}
                    </span>
                  </div>

                  {/* Lesson header */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        className="eyebrow"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 7,
                          fontFamily: "JetBrains Mono, monospace",
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--emerald-text)",
                          letterSpacing: 1,
                        }}
                      >
                        <span
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 99,
                            background: "var(--emerald)",
                          }}
                        />
                        {lesson.chapter.title.toUpperCase()}
                        {lesson.type !== "TEXT" && ` · ${lesson.type}`}
                        {lesson.duration && ` · ${lesson.duration}`}
                      </div>
                      <h1
                        style={{
                          marginTop: 8,
                          fontSize: isMobile ? 28 : 34,
                          fontWeight: 800,
                          letterSpacing: -1.2,
                          lineHeight: 1.05,
                          color: "var(--ink)",
                        }}
                      >
                        {lesson.title}
                      </h1>
                    </div>
                    {isLessonCompleted ? (
                      <span className="pf-pill emerald">
                        <CheckCircle size={11} /> COMPLETED
                      </span>
                    ) : courseData?.enrollment ? (
                      <button
                        type="button"
                        onClick={handleMarkComplete}
                        disabled={isCompleting}
                        className="pf-bs sm"
                        style={{
                          cursor: isCompleting ? "default" : "pointer",
                          opacity: isCompleting ? 0.7 : 1,
                        }}
                      >
                        <CheckCircle size={13} />
                        {isCompleting ? "Marking…" : "Mark complete"}
                      </button>
                    ) : null}
                  </div>

                  {/* Video player (secure iframe preserved) */}
                  {lesson.type === "VIDEO" && lesson.videoUrl && (
                    <div
                      style={{
                        aspectRatio: "16/9",
                        borderRadius: 12,
                        overflow: "hidden",
                        background: "#000",
                        border: "2px solid var(--ink)",
                      }}
                    >
                      <iframe
                        src={lesson.videoUrl}
                        style={{ width: "100%", height: "100%", border: 0 }}
                        allowFullScreen
                        title={lesson.title}
                      />
                    </div>
                  )}

                  {/* Lesson content (markdown) */}
                  <div
                    className="pf-card"
                    style={{ padding: isMobile ? 18 : 26 }}
                  >
                    <div
                      className="prose prose-invert prose-sm max-w-none"
                      style={{ color: "var(--ink-2)" }}
                    >
                      <ReactMarkdown>{lesson.content}</ReactMarkdown>
                    </div>
                  </div>

                  {/* Quiz section (QuizSection preserved, scoring intact) */}
                  {lesson.quizzes.length > 0 && (
                    <QuizSection
                      quizzes={lesson.quizzes}
                      onComplete={handleQuizComplete}
                    />
                  )}

                  {/* Prev / next navigation */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      borderTop: "1.5px solid var(--rule-soft)",
                      paddingTop: 18,
                    }}
                  >
                    {prevLesson ? (
                      <Link
                        href={`/learning/${courseSlug}/lesson/${prevLesson.id}`}
                        className="pf-bf sm"
                        style={{
                          textDecoration: "none",
                          maxWidth: "45%",
                          overflow: "hidden",
                        }}
                      >
                        <ArrowLeft size={13} />
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {prevLesson.title}
                        </span>
                      </Link>
                    ) : (
                      <div />
                    )}
                    {nextLesson ? (
                      <Link
                        href={`/learning/${courseSlug}/lesson/${nextLesson.id}`}
                        className="pf-bs sm"
                        style={{
                          textDecoration: "none",
                          maxWidth: "45%",
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {nextLesson.title}
                        </span>
                        <ArrowRight size={13} />
                      </Link>
                    ) : (
                      <Link
                        href={`/learning/${courseSlug}`}
                        className="pf-bf sm"
                        style={{ textDecoration: "none" }}
                      >
                        Back to course
                      </Link>
                    )}
                  </div>

                  {/* Contextual AI tutor (TutorChat preserved) */}
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowChat(!showChat)}
                      className="pf-bf"
                      style={{ marginBottom: 14, cursor: "pointer" }}
                    >
                      <MessageSquare size={13} />
                      {showChat ? "Hide AI tutor" : "Ask AI about this lesson"}
                    </button>
                    {showChat && (
                      <TutorChat
                        context={`${lesson.title} (${lesson.chapter.course.title})`}
                        pagePath={`/learning/${courseSlug}/lesson/${lessonId}`}
                        heightClass="h-[400px]"
                      />
                    )}
                  </div>
                </div>

                {/* ── Course outline sidebar (ChapterAccordion preserved) ── */}
                {!isMobile && (
                  <aside style={{ position: "sticky", top: 18 }}>
                    <div className="ttl" style={{ marginBottom: 12 }}>
                      LESSON PATH
                    </div>
                    {courseData && (
                      <ChapterAccordion
                        chapters={courseData.chapters}
                        courseSlug={courseSlug}
                        completedLessonIds={completedLessonIds}
                        currentLessonId={lessonId}
                      />
                    )}
                  </aside>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
