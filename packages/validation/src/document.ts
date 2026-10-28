import { z } from "zod";

// Mirrors Prisma enums for client-side validation
export const DocumentCategorySchema = z.enum([
  "BROKER_STATEMENT",
  "CONTRACT_NOTE",
  "ANNUAL_REPORT",
  "RESEARCH_REPORT",
  "TAX_REPORT",
  "RISK_REPORT",
  "PORTFOLIO_STATEMENT",
  "OTHER",
]);

export const DocumentSourceTypeSchema = z.enum([
  "UPLOAD",
  "URL",
  "NSE_FETCH",
  "GENERATED",
]);

export const DocumentFilterSchema = z.object({
  category: DocumentCategorySchema.optional(),
  sourceType: DocumentSourceTypeSchema.optional(),
  search: z.string().optional(),
  skip: z.number().int().min(0).default(0),
  limit: z.number().int().positive().max(100).default(20),
});

export const UploadDocumentSchema = z.object({
  title: z.string().min(1, "Title is required").max(200),
  description: z.string().max(1000).optional(),
  category: DocumentCategorySchema.default("OTHER"),
});

export const ImportUrlSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  title: z.string().min(1).max(200).optional(),
  category: DocumentCategorySchema.default("OTHER"),
});

export const FetchNseDocumentSchema = z.object({
  symbol: z.string().min(1, "Symbol is required"),
  docType: z.enum(["annual_report", "shareholding", "financial_results"]),
});

export const GenerateReportSchema = z.object({
  type: z.enum(["tax", "risk", "portfolio_statement"]),
  fy: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Financial year format: 2025-26")
    .optional(),
});

// Inferred types
export type DocumentCategoryInput = z.input<typeof DocumentCategorySchema>;
export type DocumentFilterInput = z.input<typeof DocumentFilterSchema>;
export type DocumentFilterData = z.output<typeof DocumentFilterSchema>;
export type UploadDocumentInput = z.input<typeof UploadDocumentSchema>;
export type UploadDocumentData = z.output<typeof UploadDocumentSchema>;
export type ImportUrlInput = z.input<typeof ImportUrlSchema>;
export type ImportUrlData = z.output<typeof ImportUrlSchema>;
export type FetchNseDocumentInput = z.input<typeof FetchNseDocumentSchema>;
export type GenerateReportInput = z.input<typeof GenerateReportSchema>;
export type GenerateReportData = z.output<typeof GenerateReportSchema>;
