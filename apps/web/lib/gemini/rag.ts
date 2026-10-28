/**
 * RAG (Retrieval-Augmented Generation) Pipeline
 *
 * Retrieves relevant user context from vector store and formats
 * it for injection into Gemini prompts.
 */

import { geminiLogger as logger } from "@usemoney/logger";
import { type DocumentType, type SearchResult } from "./vector-store";
import { getUserRetriever, getStockRetriever } from "./retriever";

// ============== TYPES ==============

export interface RAGContext {
  documents: RetrievedDocument[];
  formattedContext: string;
  tokenEstimate: number;
}

export interface RetrievedDocument {
  content: string;
  docType: DocumentType;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface RAGOptions {
  maxDocuments?: number; // Max documents to retrieve (default: 5)
  maxTokens?: number; // Max tokens for context (default: 2000)
  minScore?: number; // Minimum similarity score (default: 0.5)
  docTypes?: DocumentType[]; // Filter by document types
  includeScores?: boolean; // Include relevance scores in output
}

// ============== CONFIGURATION ==============

const DEFAULT_OPTIONS: Required<RAGOptions> = {
  maxDocuments: 5,
  maxTokens: 2000,
  minScore: 0.5,
  docTypes: [],
  includeScores: false,
};

const CHARS_PER_TOKEN = 4;

// Document type labels for context formatting
const DOC_TYPE_LABELS: Record<string, string> = {
  holdings: "Portfolio Holdings",
  trades: "Trading Activity",
  fire_scenario: "FIRE Scenario",
  analysis: "Stock Analysis",
  user_preferences: "User Preferences",
  document: "Uploaded Document",
  filing: "Corporate Filing",
  news: "Stock News",
  financial_statement: "Financial Statements",
  corporate_filing: "Corporate Filing (NSE)",
  annual_report: "Annual Report",
  quarterly_result: "Quarterly Results",
  concall_transcript: "Concall Transcript",
  concall_ppt: "Concall Presentation",
  // MONEY-779: now part of the chat-RAG default stock-doc search.
  concall_ai_summary: "Concall AI Summary",
  screener_financials: "Screener Financials",
};

// ============== CORE FUNCTIONS ==============

/**
 * Retrieve relevant context for a user query
 *
 * @param userId - User ID
 * @param query - User's query text
 * @param options - RAG options
 * @returns Retrieved documents and formatted context
 */
export async function retrieveContext(
  userId: string,
  query: string,
  options: RAGOptions = {}
): Promise<RAGContext> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  try {
    // 1. Search for similar documents (via the retriever seam, MONEY-781).
    //    Identical args → identical behaviour (atlas unless Vertex RAG is on).
    const searchResults = await getUserRetriever().retrieve({
      query,
      topK: mergedOptions.maxDocuments * 2, // Get extra to filter by tokens
      filter: {
        userId,
        docTypes:
          mergedOptions.docTypes.length > 0
            ? mergedOptions.docTypes
            : undefined,
        minScore: mergedOptions.minScore,
      },
    });

    if (searchResults.length === 0) {
      logger.debug(
        { userId, query: query.slice(0, 50) },
        "No relevant documents found for RAG"
      );
      return {
        documents: [],
        formattedContext: "",
        tokenEstimate: 0,
      };
    }

    // 2. Filter to fit within token budget
    const { documents, tokenEstimate } = fitToTokenBudget(
      searchResults,
      mergedOptions.maxTokens,
      mergedOptions.maxDocuments
    );

    // 3. Format context for prompt injection
    const formattedContext = formatContextForPrompt(
      documents,
      mergedOptions.includeScores
    );

    logger.info(
      {
        userId,
        query: query.slice(0, 50),
        documentsRetrieved: documents.length,
        tokenEstimate,
        topScore: documents[0]?.score,
      },
      "RAG context retrieved"
    );

    return {
      documents,
      formattedContext,
      tokenEstimate,
    };
  } catch (error) {
    logger.error(
      { error, userId, query: query.slice(0, 50) },
      "Failed to retrieve RAG context"
    );

    // Return empty context on error (don't fail the entire request)
    return {
      documents: [],
      formattedContext: "",
      tokenEstimate: 0,
    };
  }
}

/**
 * Retrieve context optimized for specific page types
 */
export async function retrievePageContext(
  userId: string,
  query: string,
  pagePath: string,
  options: RAGOptions = {}
): Promise<RAGContext> {
  // Determine relevant document types based on page
  const pageDocTypes = getDocTypesForPage(pagePath);

  return retrieveContext(userId, query, {
    ...options,
    docTypes: pageDocTypes,
  });
}

/**
 * Retrieve context from stock-specific financial documents.
 * Searches system-level embeddings for a specific stock symbol.
 */
export async function retrieveStockContext(
  symbol: string,
  query: string,
  options: RAGOptions = {}
): Promise<RAGContext> {
  const mergedOptions = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Via the retriever seam (MONEY-781) — identical args → identical behaviour.
    const searchResults = await getStockRetriever().retrieve({
      query,
      topK: mergedOptions.maxDocuments * 2,
      filter: {
        symbol,
        docTypes:
          mergedOptions.docTypes.length > 0
            ? mergedOptions.docTypes
            : undefined,
        minScore: mergedOptions.minScore,
      },
    });

    if (searchResults.length === 0) {
      return { documents: [], formattedContext: "", tokenEstimate: 0 };
    }

    const { documents, tokenEstimate } = fitToTokenBudget(
      searchResults,
      mergedOptions.maxTokens,
      mergedOptions.maxDocuments
    );

    const formattedContext = formatContextForPrompt(
      documents,
      mergedOptions.includeScores
    );

    logger.info(
      {
        symbol,
        query: query.slice(0, 50),
        documentsRetrieved: documents.length,
        tokenEstimate,
      },
      "Stock document RAG context retrieved"
    );

    return { documents, formattedContext, tokenEstimate };
  } catch (error) {
    logger.error(
      { error, symbol, query: query.slice(0, 50) },
      "Failed to retrieve stock document context"
    );
    return { documents: [], formattedContext: "", tokenEstimate: 0 };
  }
}

// ============== HELPER FUNCTIONS ==============

/**
 * Get relevant document types for a page path.
 * Exported (used by retrievePageContext) so unit tests assert the real mapping.
 */
export function getDocTypesForPage(pagePath: string): DocumentType[] {
  const page = pagePath.toLowerCase();

  if (page.includes("fire") || page.includes("retirement")) {
    return ["fire_scenario", "holdings", "user_preferences"];
  }

  if (page.includes("holdings") || page.includes("portfolio")) {
    return ["holdings", "trades", "analysis"];
  }

  if (page.includes("trade") || page.includes("journal")) {
    return ["trades", "holdings"];
  }

  if (
    page.includes("analysis") ||
    page.includes("stock") ||
    page.includes("research")
  ) {
    return [
      "analysis",
      "holdings",
      "financial_statement",
      "corporate_filing",
      "annual_report",
      "quarterly_result",
    ];
  }

  if (page.includes("dashboard")) {
    return ["holdings", "trades", "fire_scenario"];
  }

  if (page.includes("document")) {
    return ["document", "holdings", "trades"];
  }

  // Default: search all types
  return [];
}

/**
 * Simple content fingerprint for near-duplicate detection.
 * Normalizes whitespace and takes first 200 chars as the fingerprint.
 * Exported (used by fitToTokenBudget) for unit testing the dedup key.
 */
export function contentFingerprint(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 200).toLowerCase();
}

/**
 * Fit documents within token budget, skipping near-duplicates.
 *
 * When multiple chunks from the same source document are retrieved,
 * only the highest-scoring one is kept (earlier in the results array
 * since results are already sorted by score descending).
 */
export function fitToTokenBudget(
  results: SearchResult[],
  maxTokens: number,
  maxDocuments: number
): { documents: RetrievedDocument[]; tokenEstimate: number } {
  const documents: RetrievedDocument[] = [];
  let totalTokens = 0;
  const seenFingerprints = new Set<string>();

  for (const result of results) {
    if (documents.length >= maxDocuments) break;

    // Deduplicate: skip if content is a near-duplicate of an already-selected doc
    const fp = contentFingerprint(result.content);
    if (seenFingerprints.has(fp)) continue;

    const contentTokens = Math.ceil(result.content.length / CHARS_PER_TOKEN);

    // Include overhead for formatting
    const overhead = 50; // Label, separators, etc.
    const docTokens = contentTokens + overhead;

    if (totalTokens + docTokens > maxTokens) {
      // Try to fit a truncated version if this is the first doc
      if (documents.length === 0) {
        const availableChars = (maxTokens - overhead) * CHARS_PER_TOKEN;
        const truncatedContent = result.content.slice(0, availableChars);

        documents.push({
          content: truncatedContent + "...",
          docType: result.docType,
          score: result.score,
          metadata: result.metadata,
        });
        seenFingerprints.add(fp);
        totalTokens = maxTokens;
      }
      break;
    }

    documents.push({
      content: result.content,
      docType: result.docType,
      score: result.score,
      metadata: result.metadata,
    });
    seenFingerprints.add(fp);

    totalTokens += docTokens;
  }

  return { documents, tokenEstimate: totalTokens };
}

/**
 * Format retrieved documents for prompt injection.
 * Exported (used by retrieveContext / retrieveStockContext) for unit testing.
 */
export function formatContextForPrompt(
  documents: RetrievedDocument[],
  includeScores: boolean
): string {
  if (documents.length === 0) return "";

  const sections: string[] = [];

  // Group by document type
  const byType: Record<string, RetrievedDocument[]> = {};
  for (const doc of documents) {
    if (!byType[doc.docType]) byType[doc.docType] = [];
    byType[doc.docType].push(doc);
  }

  for (const [docType, docs] of Object.entries(byType)) {
    const label = DOC_TYPE_LABELS[docType as DocumentType] || docType;
    const sectionLines = [`### ${label}`];

    for (const doc of docs) {
      if (includeScores) {
        sectionLines.push(`[Relevance: ${(doc.score * 100).toFixed(0)}%]`);
      }
      sectionLines.push(doc.content);
      sectionLines.push(""); // Empty line between docs
    }

    sections.push(sectionLines.join("\n"));
  }

  return sections.join("\n\n");
}

/**
 * Check if RAG context should be retrieved for a query
 *
 * Skip RAG for simple queries that don't need context
 */
export function shouldUseRAG(query: string, pagePath: string): boolean {
  const lowercaseQuery = query.toLowerCase();

  // Skip RAG for generic greetings
  if (
    lowercaseQuery.match(/^(hi|hello|hey|good\s+(morning|afternoon|evening))/)
  ) {
    return false;
  }

  // Skip RAG for meta questions about the AI
  if (
    lowercaseQuery.includes("what can you do") ||
    lowercaseQuery.includes("who are you") ||
    lowercaseQuery.includes("how do you work")
  ) {
    return false;
  }

  // Enable RAG for queries about user's data (even short ones like "Is TCS good?")
  const personalKeywords = [
    "my",
    "i have",
    "i own",
    "portfolio",
    "holdings",
    "trades",
    "stocks",
    "retirement",
    "fire",
    "scenario",
    "analysis",
    "bought",
    "sold",
    "invested",
    "returns",
    "profit",
    "loss",
    "pnl",
    "document",
    "uploaded",
    "report",
    "statement",
    "contract note",
  ];

  for (const keyword of personalKeywords) {
    if (lowercaseQuery.includes(keyword)) {
      return true;
    }
  }

  // Enable RAG for stock analysis queries (filings + news context)
  const stockAnalysisKeywords = [
    "annual report",
    "quarterly result",
    "filing",
    "management said",
    "management commentary",
    "latest news",
    "recent news",
    "what happened",
    "earnings",
    "results",
    "guidance",
    "outlook",
    "concall",
    "conference call",
    "analyze",
    "analyse",
    "research",
    "evaluate",
    "balance sheet",
    "income statement",
    "cash flow",
    "revenue growth",
    "debt to equity",
    "profit margin",
    "financial statement",
    "corporate filing",
    "dividend",
    "promoter holding",
    "shareholding",
  ];
  for (const keyword of stockAnalysisKeywords) {
    if (lowercaseQuery.includes(keyword)) {
      return true;
    }
  }

  // Enable RAG for certain page types that always benefit from context
  const contextPages = [
    "/fire",
    "/holdings",
    "/analysis",
    "/tradebook",
    "/documents",
  ];
  if (contextPages.some((p) => pagePath.startsWith(p))) {
    return true;
  }

  // Skip RAG for very short generic queries without personal keywords
  if (query.length < 15) return false;

  // Default: enable RAG for substantive queries
  return query.length > 50;
}

/**
 * Merge RAG context with existing user context
 */
export function mergeContexts(
  ragContext: string,
  existingContext?: string
): string {
  const parts: string[] = [];

  if (existingContext) {
    parts.push("## Current Page Data");
    parts.push(existingContext);
  }

  if (ragContext) {
    parts.push("## Relevant Historical Data");
    parts.push(ragContext);
  }

  return parts.join("\n\n");
}

/**
 * Create a summary of what context was retrieved (for debugging/logging)
 */
export function summarizeRetrievedContext(
  context: RAGContext
): Record<string, number> {
  const summary: Record<string, number> = {};

  for (const doc of context.documents) {
    summary[doc.docType] = (summary[doc.docType] || 0) + 1;
  }

  return summary;
}
