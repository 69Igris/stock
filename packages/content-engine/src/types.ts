export interface ContentVerificationResult {
  score: number;
  checks: ContentCheck[];
  suggestions: string[];
}

export interface ContentCheck {
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
}

export interface GenerateContentOptions {
  topic: string;
  contentType: "article" | "video" | "audio" | "infographic";
  language?: string;
  rawMaterials?: string;
}

export interface VerifyContentOptions {
  content: string;
  topic: string;
  contentType: string;
  language?: string;
}

export interface GenerateQuizOptions {
  topic: string;
  difficulty: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  count?: number;
}
