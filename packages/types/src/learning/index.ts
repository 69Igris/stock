// Course types
export interface Course {
  id: string;
  slug: string;
  title: string;
  description: string;
  image?: string;
  level: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  duration: string;
  topics: string[];
  published: boolean;
  order: number;
  chapters?: Chapter[];
  enrollments?: Enrollment[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Chapter {
  id: string;
  courseId: string;
  title: string;
  order: number;
  lessons?: CourseLesson[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CourseLesson {
  id: string;
  chapterId: string;
  title: string;
  content: string;
  type: "TEXT" | "VIDEO" | "INTERACTIVE";
  videoUrl?: string;
  duration?: string;
  order: number;
  quizzes?: Quiz[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Quiz {
  id: string;
  lessonId: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation?: string;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Enrollment {
  id: string;
  userId: string;
  courseId: string;
  progress: number;
  completedAt?: Date;
  lessonProgress?: CourseLessonProgress[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CourseLessonProgress {
  id: string;
  enrollmentId: string;
  userId: string;
  lessonId: string;
  completed: boolean;
  quizScore?: number;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GlossaryTerm {
  id: string;
  term: string;
  definition: string;
  category?: string;
  related: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Input types
export interface CreateCourseInput {
  slug: string;
  title: string;
  description: string;
  image?: string;
  level: "BEGINNER" | "INTERMEDIATE" | "ADVANCED";
  duration: string;
  topics: string[];
  published?: boolean;
  order?: number;
}

export interface CreateChapterInput {
  courseId: string;
  title: string;
  order?: number;
}

export interface CreateCourseLessonInput {
  chapterId: string;
  title: string;
  content: string;
  type?: "TEXT" | "VIDEO" | "INTERACTIVE";
  videoUrl?: string;
  duration?: string;
  order?: number;
}

export interface CreateQuizInput {
  lessonId: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation?: string;
  order?: number;
}

export interface CreateGlossaryTermInput {
  term: string;
  definition: string;
  category?: string;
  related?: string[];
}

// List types
export interface CourseListItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  image?: string;
  level: string;
  duration: string;
  topics: string[];
  published: boolean;
  order: number;
  _count?: {
    chapters: number;
    enrollments: number;
  };
  chapterCount?: number;
  lessonCount?: number;
  enrollmentCount?: number;
}

export interface EnrollmentWithProgress {
  id: string;
  userId: string;
  courseId: string;
  progress: number;
  completedAt?: Date;
  course: CourseListItem;
  lessonProgress: CourseLessonProgress[];
}

// Content engine types
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
