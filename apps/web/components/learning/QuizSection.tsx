"use client";

import { useState } from "react";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Progress } from "@usemoney/ui/progress";
import {
  CheckCircle,
  XCircle,
  ChevronRight,
  Trophy,
  Target,
  Play,
} from "lucide-react";
import { cn } from "@usemoney/utils";

interface QuizItem {
  id: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string | null;
}

interface QuizSectionProps {
  quizzes: QuizItem[];
  onComplete?: (score: number, total: number) => void;
}

export function QuizSection({ quizzes, onComplete }: QuizSectionProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [isFinished, setIsFinished] = useState(false);

  if (quizzes.length === 0) return null;

  const currentQuiz = quizzes[currentIndex];

  const handleSubmit = () => {
    if (selectedAnswer === null) return;
    const isCorrect = selectedAnswer === currentQuiz.correctAnswer;
    const newScore = {
      correct: score.correct + (isCorrect ? 1 : 0),
      total: score.total + 1,
    };
    setScore(newScore);
    setShowResult(true);
  };

  const handleNext = () => {
    if (currentIndex + 1 >= quizzes.length) {
      setIsFinished(true);
      onComplete?.(score.correct, score.total);
      return;
    }
    setCurrentIndex((prev) => prev + 1);
    setSelectedAnswer(null);
    setShowResult(false);
  };

  const handleRestart = () => {
    setCurrentIndex(0);
    setSelectedAnswer(null);
    setShowResult(false);
    setScore({ correct: 0, total: 0 });
    setIsFinished(false);
  };

  if (isFinished) {
    const pct =
      score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
    return (
      <Card className="bg-card/50 border-border">
        <CardContent className="p-8 text-center">
          <Trophy
            className={cn(
              "h-12 w-12 mx-auto mb-4",
              pct >= 70 ? "text-amber-400" : "text-muted-foreground"
            )}
          />
          <h3 className="text-xl font-bold text-foreground mb-2">
            Quiz Complete!
          </h3>
          <p className="text-3xl font-bold text-foreground mb-1">{pct}%</p>
          <p className="text-sm text-muted-foreground mb-6">
            {score.correct} of {score.total} correct
          </p>
          <Progress value={pct} className="h-2 mb-6" />
          <Button
            onClick={handleRestart}
            variant="outline"
            className="border-border"
          >
            Try Again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/50 border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-foreground flex items-center gap-2">
            <Trophy className="h-5 w-5 text-amber-400" />
            Quiz
          </CardTitle>
          <span className="text-xs text-muted-foreground">
            {currentIndex + 1} / {quizzes.length}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <h3 className="text-sm font-medium text-foreground">
          {currentQuiz.question}
        </h3>

        <div className="space-y-2">
          {currentQuiz.options.map((option, i) => (
            <button
              key={i}
              onClick={() => !showResult && setSelectedAnswer(i)}
              disabled={showResult}
              className={cn(
                "w-full text-left p-3 rounded-lg border transition-colors text-sm",
                selectedAnswer === i &&
                  !showResult &&
                  "border-blue-500 bg-blue-500/10",
                showResult &&
                  i === currentQuiz.correctAnswer &&
                  "border-emerald-500 bg-emerald-500/10",
                showResult &&
                  selectedAnswer === i &&
                  i !== currentQuiz.correctAnswer &&
                  "border-red-500 bg-red-500/10",
                !showResult &&
                  selectedAnswer !== i &&
                  "border-border hover:border-border",
                showResult &&
                  i !== currentQuiz.correctAnswer &&
                  selectedAnswer !== i &&
                  "border-border opacity-50"
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-foreground/80">{option}</span>
                {showResult && i === currentQuiz.correctAnswer && (
                  <CheckCircle className="h-4 w-4 text-emerald-400" />
                )}
                {showResult &&
                  selectedAnswer === i &&
                  i !== currentQuiz.correctAnswer && (
                    <XCircle className="h-4 w-4 text-red-400" />
                  )}
              </div>
            </button>
          ))}
        </div>

        {showResult && currentQuiz.explanation && (
          <p className="text-xs text-muted-foreground italic bg-muted/50 p-3 rounded-lg">
            {currentQuiz.explanation}
          </p>
        )}

        <div className="flex gap-3">
          {!showResult ? (
            <Button
              onClick={handleSubmit}
              disabled={selectedAnswer === null}
              className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Submit Answer
            </Button>
          ) : (
            <Button
              onClick={handleNext}
              className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {currentIndex + 1 >= quizzes.length
                ? "See Results"
                : "Next Question"}
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
