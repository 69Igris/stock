"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";

import { PageGuard } from "@/components/PageGuard";
import { QuizzesSkeleton } from "@/components/skeletons";
import { DemoBanner, DemoGate } from "@/components/DemoBanner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { toast } from "sonner";
import {
  Trophy,
  Sparkles,
  Loader2,
  Play,
  CheckCircle,
  XCircle,
  ChevronRight,
  RotateCcw,
  BookOpen,
  Target,
  Brain,
  ArrowLeft,
} from "lucide-react";
import { generateQuizAction } from "@/lib/actions/quiz";
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
}

// Preset quizzes
const PRESET_QUIZZES = [
  {
    id: "market-basics",
    title: "Market Basics",
    description: "Test your knowledge of stock market fundamentals",
    icon: BookOpen,
    difficulty: "Beginner",
    questionCount: 5,
    questions: [
      {
        question: "What does P/E ratio measure?",
        options: [
          "Profit to Equity",
          "Price to Earnings",
          "Performance to Efficiency",
          "Profit to Expense",
        ],
        correctAnswer: 1,
        explanation:
          "P/E ratio stands for Price-to-Earnings ratio. It compares a company's stock price to its earnings per share.",
      },
      {
        question: "What is a stop-loss order?",
        options: [
          "An order to buy at a higher price",
          "An order to automatically sell at a set price to limit losses",
          "An order to hold indefinitely",
          "An order to increase position size",
        ],
        correctAnswer: 1,
        explanation:
          "A stop-loss order automatically sells your position when the price drops to a specified level, limiting potential losses.",
      },
      {
        question: "What is diversification?",
        options: [
          "Investing all in one stock",
          "Spreading investments across different assets",
          "A day trading strategy",
          "Selling stocks short",
        ],
        correctAnswer: 1,
        explanation:
          "Diversification means spreading your investments across different assets, sectors, or markets to reduce risk.",
      },
      {
        question: "What is a bull market?",
        options: [
          "A market that is declining",
          "A market that is rising",
          "A market with no change",
          "A market for agricultural commodities",
        ],
        correctAnswer: 1,
        explanation:
          "A bull market refers to a period when stock prices are rising or expected to rise, typically 20% or more from recent lows.",
      },
      {
        question: "What is market capitalization?",
        options: [
          "Total debt of a company",
          "Total value of a company's outstanding shares",
          "Annual revenue",
          "Net profit margin",
        ],
        correctAnswer: 1,
        explanation:
          "Market capitalization is calculated by multiplying the stock price by the total number of outstanding shares.",
      },
    ],
  },
  {
    id: "technical-analysis",
    title: "Technical Analysis",
    description: "Test your knowledge of chart patterns and indicators",
    icon: Target,
    difficulty: "Intermediate",
    questionCount: 4,
    questions: [
      {
        question: "What does RSI stand for?",
        options: [
          "Relative Stock Index",
          "Relative Strength Index",
          "Random Sample Index",
          "Risk-adjusted Stock Investment",
        ],
        correctAnswer: 1,
        explanation:
          "RSI (Relative Strength Index) is a momentum oscillator that measures the speed and magnitude of price changes on a scale of 0-100.",
      },
      {
        question: "What is a 'Golden Cross' in technical analysis?",
        options: [
          "When price hits an all-time high",
          "When 50-day MA crosses above 200-day MA",
          "When volume doubles",
          "When RSI hits 50",
        ],
        correctAnswer: 1,
        explanation:
          "A Golden Cross occurs when the 50-day moving average crosses above the 200-day moving average, signaling a potential bullish trend.",
      },
      {
        question: "MACD stands for?",
        options: [
          "Moving Average Convergence Divergence",
          "Market Analysis Correlation Data",
          "Multiple Average Cross Distribution",
          "Market Adjusted Capital Dividend",
        ],
        correctAnswer: 0,
        explanation:
          "MACD (Moving Average Convergence Divergence) is a trend-following momentum indicator showing the relationship between two moving averages.",
      },
      {
        question: "What does a 'Doji' candlestick pattern indicate?",
        options: [
          "Strong bullish trend",
          "Strong bearish trend",
          "Market indecision",
          "High volume",
        ],
        correctAnswer: 2,
        explanation:
          "A Doji candlestick has nearly equal open and close prices, indicating indecision between buyers and sellers.",
      },
    ],
  },
  {
    id: "options-basics",
    title: "Options Basics",
    description: "Test your knowledge of options trading fundamentals",
    icon: Brain,
    difficulty: "Advanced",
    questionCount: 4,
    questions: [
      {
        question: "In options, what is a Call option?",
        options: [
          "Right to sell at strike price",
          "Right to buy at strike price",
          "Obligation to buy",
          "Obligation to sell",
        ],
        correctAnswer: 1,
        explanation:
          "A Call option gives the holder the right (but not the obligation) to buy an asset at a specified strike price before expiration.",
      },
      {
        question: "What is 'theta' in options?",
        options: [
          "Sensitivity to price changes",
          "Sensitivity to volatility",
          "Time decay",
          "Interest rate sensitivity",
        ],
        correctAnswer: 2,
        explanation:
          "Theta measures the rate of decline in an option's value due to the passage of time (time decay).",
      },
      {
        question: "What is an 'Iron Condor' strategy?",
        options: [
          "Buying a call and a put",
          "Selling a call spread and a put spread simultaneously",
          "Buying two calls at different strikes",
          "Selling naked options",
        ],
        correctAnswer: 1,
        explanation:
          "An Iron Condor involves selling both a call spread and a put spread with the same expiration, profiting from low volatility.",
      },
      {
        question: "What happens to option premium as expiration approaches?",
        options: [
          "It always increases",
          "It stays constant",
          "It typically decreases (time decay)",
          "It depends on the stock price only",
        ],
        correctAnswer: 2,
        explanation:
          "As expiration approaches, option premiums decrease due to time decay (theta). This accelerates closer to expiration.",
      },
    ],
  },
];

/* Difficulty → accent colour for the quiz-type tiles (design palette). */
const DIFFICULTY_COLOR: Record<string, string> = {
  Beginner: "var(--emerald)",
  Intermediate: "var(--pop-3)",
  Advanced: "var(--pop-1)",
};

export default function QuizzesClient() {
  const router = useRouter();
  const { user, isLoaded } = useUser();
  const isMobile = useIsMobile();
  const [mounted, setMounted] = useState(false);

  // AI Quiz state
  const [topic, setTopic] = useState("");
  const [difficulty, setDifficulty] = useState<
    "Beginner" | "Intermediate" | "Advanced"
  >("Beginner");
  const [isGenerating, setIsGenerating] = useState(false);

  // Active quiz state
  const [activeQuiz, setActiveQuiz] = useState<{
    title: string;
    questions: QuizQuestion[];
  } | null>(null);
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [quizComplete, setQuizComplete] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDemoMode = useIsDemoMode({ user });

  useEffect(() => {
    if (!isLoaded || !mounted) return;
    if (!user && !isDemoMode) {
      router.push("/home");
    }
  }, [isLoaded, mounted, user, isDemoMode, router]);

  const currentQuestion = activeQuiz?.questions[currentQuestionIdx];

  const handleGenerateQuiz = async () => {
    if (!topic.trim()) {
      toast.error("Please enter a quiz topic");
      return;
    }

    setIsGenerating(true);
    try {
      const result = await generateQuizAction({
        topic: topic.trim(),
        difficulty,
        count: 5,
      });

      if (result?.success && result?.data) {
        setActiveQuiz({
          title: `AI Quiz: ${topic}`,
          questions: result?.data,
        });
        setCurrentQuestionIdx(0);
        setSelectedAnswer(null);
        setShowResult(false);
        setAnswers([]);
        setQuizComplete(false);
        toast.success("Quiz generated!");
      } else {
        toast.error(result?.error || "Failed to generate quiz");
      }
    } catch {
      toast.error("Failed to generate quiz");
    } finally {
      setIsGenerating(false);
    }
  };

  const startPresetQuiz = (quiz: (typeof PRESET_QUIZZES)[number]) => {
    setActiveQuiz({
      title: quiz.title,
      questions: quiz.questions,
    });
    setCurrentQuestionIdx(0);
    setSelectedAnswer(null);
    setShowResult(false);
    setAnswers([]);
    setQuizComplete(false);
  };

  const handleSubmitAnswer = () => {
    if (selectedAnswer === null) return;
    setShowResult(true);
    setAnswers((prev) => [...prev, selectedAnswer]);
  };

  const handleNextQuestion = () => {
    if (!activeQuiz) return;
    if (currentQuestionIdx + 1 >= activeQuiz.questions.length) {
      setQuizComplete(true);
    } else {
      setCurrentQuestionIdx((prev) => prev + 1);
      setSelectedAnswer(null);
      setShowResult(false);
    }
  };

  const handleRetry = () => {
    if (!activeQuiz) return;
    setCurrentQuestionIdx(0);
    setSelectedAnswer(null);
    setShowResult(false);
    setAnswers([]);
    setQuizComplete(false);
  };

  const handleBackToQuizzes = () => {
    setActiveQuiz(null);
    setCurrentQuestionIdx(0);
    setSelectedAnswer(null);
    setShowResult(false);
    setAnswers([]);
    setQuizComplete(false);
  };

  const score = activeQuiz
    ? answers.filter((a, i) => a === activeQuiz.questions[i]?.correctAnswer)
        .length
    : 0;

  return (
    <PageGuard
      route="/quizzes"
      fallback={<QuizzesSkeleton />}
      containerClassName="px-4 lg:px-6 pt-4 lg:pt-6 pb-24 space-y-6 max-w-6xl mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className={`pf-page${isMobile ? " is-mobile" : ""}`}>
            {isDemoMode && <DemoBanner />}

            {/* ── Page heading ── */}
            <div className={`pf-ph${isMobile ? " is-mobile" : ""}`}>
              <div className="l">
                <div className="eyebrow">
                  <span className="d" aria-hidden />
                  LEARN · QUIZZES · NSE/BSE FLAVOURED
                </div>
                <h1>
                  Test what you <span className="ser">actually know.</span>
                </h1>
                <div className="sub">
                  AI-generated and preset quizzes to sharpen your financial
                  knowledge.
                </div>
              </div>
              {/* Learning hidden per request — re-enable to restore the
                  Courses (/learning) + Tutor session (/sage-tutor) CTAs. */}
              {/* <div className="r">
                <Link href="/learning" className="pf-bf">
                  <BookOpen size={13} /> Courses
                </Link>
                <Link href="/sage-tutor" className="pf-bs">
                  <Sparkles size={13} /> Tutor session
                </Link>
              </div> */}
            </div>

            {activeQuiz ? (
              /* ─────────────── Active quiz view ─────────────── */
              quizComplete ? (
                /* Results */
                <div
                  className="pf-card tilt-l"
                  style={{
                    padding: 32,
                    textAlign: "center",
                    maxWidth: 560,
                    margin: "0 auto",
                  }}
                >
                  <div
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: 14,
                      background: "var(--pop-2)",
                      color: "#1d1d1b",
                      display: "grid",
                      placeItems: "center",
                      border: "2px solid var(--ink)",
                      transform: "rotate(-3deg)",
                      margin: "0 auto 16px",
                    }}
                  >
                    <Trophy size={30} />
                  </div>
                  <h2
                    style={{
                      fontSize: 24,
                      fontWeight: 800,
                      letterSpacing: -0.6,
                      color: "var(--ink)",
                    }}
                  >
                    Quiz complete!
                  </h2>
                  <div
                    className="ser"
                    style={{
                      marginTop: 4,
                      fontSize: 15,
                      color: "var(--ink-3)",
                    }}
                  >
                    {activeQuiz.title}
                  </div>
                  <div
                    className="mono"
                    style={{
                      marginTop: 20,
                      fontSize: 48,
                      fontWeight: 800,
                      letterSpacing: -1.5,
                      color: "var(--emerald)",
                    }}
                  >
                    {Math.round((score / activeQuiz.questions.length) * 100)}%
                  </div>
                  <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
                    You got {score} out of {activeQuiz.questions.length} correct
                  </div>
                  <div
                    style={{
                      margin: "18px auto 0",
                      height: 8,
                      maxWidth: 320,
                      background: "var(--rule-softer)",
                      border: "1.5px solid var(--ink)",
                      borderRadius: 999,
                    }}
                  >
                    <div
                      style={{
                        width: `${(score / activeQuiz.questions.length) * 100}%`,
                        height: "100%",
                        background: "var(--emerald)",
                        borderRadius: 999,
                      }}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 10,
                      justifyContent: "center",
                      marginTop: 24,
                    }}
                  >
                    <button
                      type="button"
                      onClick={handleRetry}
                      className="pf-bf"
                      style={{ cursor: "pointer" }}
                    >
                      <RotateCcw size={13} /> Retry
                    </button>
                    <button
                      type="button"
                      onClick={handleBackToQuizzes}
                      className="pf-bs"
                      style={{ cursor: "pointer" }}
                    >
                      Back to quizzes
                    </button>
                  </div>
                </div>
              ) : currentQuestion ? (
                /* Question view */
                <div style={{ maxWidth: 640, margin: "0 auto" }}>
                  {/* Progress row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 16,
                    }}
                  >
                    <button
                      type="button"
                      onClick={handleBackToQuizzes}
                      className="pf-bf sm"
                      style={{ cursor: "pointer" }}
                    >
                      <ArrowLeft size={13} /> Back
                    </button>
                    <div
                      style={{
                        flex: 1,
                        height: 8,
                        background: "var(--rule-softer)",
                        border: "1.5px solid var(--ink)",
                        borderRadius: 999,
                      }}
                    >
                      <div
                        style={{
                          width: `${((currentQuestionIdx + 1) / activeQuiz.questions.length) * 100}%`,
                          height: "100%",
                          background: "var(--emerald)",
                          borderRadius: 999,
                        }}
                      />
                    </div>
                    <span
                      className="mono"
                      style={{ fontSize: 12, color: "var(--ink-3)" }}
                    >
                      {currentQuestionIdx + 1} / {activeQuiz.questions.length}
                    </span>
                  </div>

                  <div className="pf-card" style={{ padding: 24 }}>
                    <h3
                      style={{
                        fontSize: 18,
                        fontWeight: 800,
                        letterSpacing: -0.3,
                        color: "var(--ink)",
                        lineHeight: 1.3,
                      }}
                    >
                      {currentQuestion.question}
                    </h3>
                    <div
                      style={{
                        marginTop: 16,
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                      }}
                    >
                      {currentQuestion.options.map((option, i) => {
                        const isCorrect = i === currentQuestion.correctAnswer;
                        const isSelected = selectedAnswer === i;
                        let bg = "var(--paper)";
                        let borderColor = "var(--ink)";
                        let textColor = "var(--ink)";
                        if (showResult && isCorrect) {
                          bg = "var(--emerald)";
                          borderColor = "var(--emerald)";
                          textColor = "var(--paper)";
                        } else if (showResult && isSelected && !isCorrect) {
                          bg = "var(--pop-1)";
                          borderColor = "var(--pop-1)";
                          textColor = "var(--paper)";
                        } else if (!showResult && isSelected) {
                          bg = "var(--emerald-bg)";
                          borderColor = "var(--emerald)";
                        } else if (showResult) {
                          borderColor = "var(--rule-soft)";
                          textColor = "var(--ink-3)";
                        }
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => !showResult && setSelectedAnswer(i)}
                            disabled={showResult}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: 10,
                              width: "100%",
                              textAlign: "left",
                              padding: "11px 14px",
                              borderRadius: 9,
                              border: `1.5px solid ${borderColor}`,
                              background: bg,
                              color: textColor,
                              fontSize: 13.5,
                              fontWeight: isSelected ? 700 : 500,
                              cursor: showResult ? "default" : "pointer",
                              transition: "all .12s",
                            }}
                          >
                            <span>{option}</span>
                            {showResult && isCorrect && (
                              <CheckCircle size={15} />
                            )}
                            {showResult && isSelected && !isCorrect && (
                              <XCircle size={15} />
                            )}
                          </button>
                        );
                      })}
                    </div>

                    {showResult && currentQuestion.explanation && (
                      <div
                        style={{
                          marginTop: 16,
                          padding: 14,
                          background: "var(--paper-2)",
                          border: "1.5px solid var(--ink)",
                          borderRadius: 10,
                        }}
                      >
                        <div className="ttl" style={{ color: "var(--pop-1)" }}>
                          EXPLANATION
                        </div>
                        <div
                          className="ser"
                          style={{
                            marginTop: 6,
                            fontSize: 14,
                            color: "var(--ink-2)",
                            lineHeight: 1.45,
                          }}
                        >
                          {currentQuestion.explanation}
                        </div>
                      </div>
                    )}

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        marginTop: 18,
                      }}
                    >
                      {!showResult ? (
                        <button
                          type="button"
                          onClick={handleSubmitAnswer}
                          disabled={selectedAnswer === null}
                          className="pf-bs"
                          style={{
                            cursor:
                              selectedAnswer === null ? "default" : "pointer",
                            opacity: selectedAnswer === null ? 0.6 : 1,
                          }}
                        >
                          Submit answer
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleNextQuestion}
                          className="pf-bs"
                          style={{ cursor: "pointer" }}
                        >
                          {currentQuestionIdx + 1 >= activeQuiz.questions.length
                            ? "See results"
                            : "Next question"}
                          <ChevronRight size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : null
            ) : (
              /* ─────────────── Quiz selection view ─────────────── */
              <div
                style={{ display: "flex", flexDirection: "column", gap: 22 }}
              >
                {/* AI quiz generator */}
                <DemoGate
                  isDemoMode={isDemoMode}
                  message="Sign up to generate AI quizzes"
                >
                  <div className="pf-card tilt-l" style={{ padding: 22 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          background: "var(--emerald)",
                          color: "var(--paper)",
                          display: "grid",
                          placeItems: "center",
                          border: "1.5px solid var(--ink)",
                          transform: "rotate(-3deg)",
                        }}
                      >
                        <Sparkles size={15} />
                      </span>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 800,
                          letterSpacing: -0.4,
                          color: "var(--ink)",
                        }}
                      >
                        Generate AI quiz
                      </div>
                    </div>
                    <div
                      className="ser"
                      style={{ fontSize: 14, color: "var(--ink-3)" }}
                    >
                      Enter any financial topic and AI will generate a quiz for
                      you.
                    </div>
                    <div
                      style={{
                        marginTop: 14,
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                        alignItems: "center",
                      }}
                    >
                      <input
                        className="pf-input"
                        placeholder="e.g., Options Greeks, Candlestick Patterns…"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        style={{ flex: isMobile ? "1 1 100%" : "1 1 240px" }}
                      />
                      <Select
                        value={difficulty}
                        onValueChange={(v) =>
                          setDifficulty(v as typeof difficulty)
                        }
                      >
                        <SelectTrigger className="w-[160px] h-[44px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Beginner">Beginner</SelectItem>
                          <SelectItem value="Intermediate">
                            Intermediate
                          </SelectItem>
                          <SelectItem value="Advanced">Advanced</SelectItem>
                        </SelectContent>
                      </Select>
                      <button
                        type="button"
                        onClick={handleGenerateQuiz}
                        disabled={isGenerating || !topic.trim()}
                        className="pf-bs lg"
                        style={{
                          cursor:
                            isGenerating || !topic.trim()
                              ? "default"
                              : "pointer",
                          opacity: isGenerating || !topic.trim() ? 0.6 : 1,
                        }}
                      >
                        {isGenerating ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />{" "}
                            Generating…
                          </>
                        ) : (
                          <>
                            <Sparkles size={14} /> Generate quiz
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </DemoGate>

                {/* Preset quizzes (design: quiz-type tiles) */}
                <div>
                  <div className="pf-sec-h">
                    <span className="n">QUIZ TYPES</span>
                    <h3>
                      Pick your <span className="ser">poison.</span>
                    </h3>
                    <span className="rule" />
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: isMobile
                        ? "1fr"
                        : "repeat(auto-fill, minmax(260px, 1fr))",
                      gap: 14,
                    }}
                  >
                    {PRESET_QUIZZES.map((quiz) => {
                      const Icon = quiz.icon;
                      const color =
                        DIFFICULTY_COLOR[quiz.difficulty] || "var(--pop-3)";
                      return (
                        <div
                          key={quiz.id}
                          className="pf-card"
                          style={{
                            padding: 18,
                            display: "flex",
                            flexDirection: "column",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              justifyContent: "space-between",
                              gap: 8,
                            }}
                          >
                            <span
                              style={{
                                width: 42,
                                height: 42,
                                borderRadius: 10,
                                background: color,
                                color: "var(--paper)",
                                display: "grid",
                                placeItems: "center",
                                border: "1.5px solid var(--ink)",
                                transform: "rotate(-3deg)",
                                boxShadow: "2px 2px 0 var(--ink)",
                              }}
                            >
                              <Icon size={19} />
                            </span>
                            <span className="pf-pill outline">
                              {quiz.difficulty}
                            </span>
                          </div>
                          <div
                            style={{
                              marginTop: 12,
                              fontSize: 18,
                              fontWeight: 800,
                              letterSpacing: -0.4,
                              color: "var(--ink)",
                            }}
                          >
                            {quiz.title}
                          </div>
                          <div
                            style={{
                              marginTop: 6,
                              fontSize: 13,
                              color: "var(--ink-3)",
                              lineHeight: 1.4,
                              flex: 1,
                            }}
                          >
                            {quiz.description}
                          </div>
                          <div
                            className="mono"
                            style={{
                              marginTop: 10,
                              fontSize: 10.5,
                              color: "var(--ink-3)",
                            }}
                          >
                            {quiz.questionCount} questions
                          </div>
                          <button
                            type="button"
                            onClick={() => startPresetQuiz(quiz)}
                            className="pf-bs sm"
                            style={{
                              marginTop: 12,
                              cursor: "pointer",
                              justifyContent: "center",
                            }}
                          >
                            <Play size={13} /> Start quiz
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
