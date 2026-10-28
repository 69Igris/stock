/**
 * Fetch User Documents Tool (Phase 7E - RAG Integration)
 *
 * Keyword-scores the user's uploaded UserDocument.textContent for chunks
 * relevant to the query/symbol and returns them as RAG context for research
 * synthesis. MONEY-613: wired into the stock-analysis skill so it actually
 * fires — it was registered but referenced by no skill, i.e. RAG was dead in
 * research.
 *
 * NOTE: this is the KEYWORD path, not vector search. The system-level
 * financial-document corpus (concall / annual-report / filing chunks in
 * DocumentEmbedding via Atlas $vectorSearch) is consumed only by chat today.
 * Bringing true vector RAG into research needs a SHARED query-embedding
 * function in @usemoney/core (which lacks the google-auth-library / Vertex dep
 * today) — tracked on MONEY-613 / 277.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export const fetchUserDocumentsTool: ResearchToolDef = {
  name: "fetch_user_documents",
  description:
    "Fetch user-uploaded documents and their extracted text relevant to a stock symbol. Returns document chunks for RAG context in research synthesis.",
  category: "data",
  parameters: {
    userId: {
      type: "string",
      description: "User ID to fetch documents for",
      required: true,
    },
    symbol: {
      type: "string",
      description:
        "Stock symbol to search for in documents (e.g., RELIANCE, TCS)",
    },
    query: {
      type: "string",
      description: "Search query to find relevant document chunks",
    },
    documentIds: {
      type: "string[]",
      description: "Specific document IDs to fetch (if user selected them)",
    },
    categories: {
      type: "string[]",
      description:
        "Document categories to filter: ANNUAL_REPORT, RESEARCH_REPORT, BROKER_STATEMENT, etc.",
    },
    maxChunks: {
      type: "number",
      description: "Maximum number of text chunks to return",
      default: 10,
    },
  },
  cacheTTL: 300, // 5 min cache
  execute: async (params): Promise<ToolOutput> => {
    const userId = params.userId as string;
    const symbol = params.symbol as string | undefined;
    const query = params.query as string | undefined;
    const documentIds = params.documentIds as string[] | undefined;
    const categories = params.categories as string[] | undefined;
    const maxChunks = (params.maxChunks as number) || 10;

    if (!userId) {
      return { success: false, error: "userId is required" };
    }

    try {
      // Dynamic import to avoid bundling Prisma in non-web contexts
      const { default: prisma } = await import("@usemoney/database");

      // Build query for UserDocument
      const whereClause: Record<string, unknown> = {
        userId,
        isDeleted: false,
        processingStatus: "READY",
      };

      if (documentIds && documentIds.length > 0) {
        whereClause.id = { in: documentIds };
      }

      if (categories && categories.length > 0) {
        whereClause.category = { in: categories };
      }

      // Fetch documents
      const documents = await prisma.userDocument.findMany({
        where: whereClause,
        select: {
          id: true,
          title: true,
          customName: true,
          category: true,
          labels: true,
          textContent: true,
          sourceType: true,
          fileName: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      if (documents.length === 0) {
        return {
          success: true,
          data: {
            documentCount: 0,
            chunks: [],
            note: "No documents found matching criteria. Analysis will use public data sources only.",
          },
        };
      }

      // Extract relevant chunks from documents
      const chunks: Array<{
        documentId: string;
        documentTitle: string;
        category: string;
        source: string;
        text: string;
        relevanceScore: number;
      }> = [];

      const searchTerms = [symbol?.toUpperCase(), query?.toLowerCase()].filter(
        Boolean,
      ) as string[];

      for (const doc of documents) {
        const text = doc.textContent || "";
        if (!text) continue;

        const title = doc.customName || doc.title || doc.fileName || "Untitled";

        // If no search terms, include first chunk of each document
        if (searchTerms.length === 0) {
          chunks.push({
            documentId: doc.id,
            documentTitle: title,
            category: doc.category,
            source: `${doc.sourceType}: ${title}`,
            text: text.slice(0, 2000),
            relevanceScore: 50,
          });
          continue;
        }

        // Split text into paragraphs and score relevance
        const paragraphs = text
          .split(/\n\n+/)
          .filter((p) => p.trim().length > 50);

        for (const para of paragraphs) {
          let score = 0;
          const paraLower = para.toLowerCase();

          for (const term of searchTerms) {
            if (paraLower.includes(term.toLowerCase())) {
              score += 30;
              // Bonus for exact symbol match
              if (
                term === symbol?.toUpperCase() &&
                para.toUpperCase().includes(term)
              ) {
                score += 20;
              }
            }
          }

          if (score > 0) {
            chunks.push({
              documentId: doc.id,
              documentTitle: title,
              category: doc.category,
              source: `Source: ${title} (${doc.category})`,
              text: para.slice(0, 1500),
              relevanceScore: Math.min(score, 100),
            });
          }
        }
      }

      // Sort by relevance, take top chunks
      chunks.sort((a, b) => b.relevanceScore - a.relevanceScore);
      const topChunks = chunks.slice(0, maxChunks);

      return {
        success: true,
        data: {
          documentCount: documents.length,
          chunkCount: topChunks.length,
          chunks: topChunks,
          documents: documents.map((d) => ({
            id: d.id,
            title: d.customName || d.title || d.fileName,
            category: d.category,
            labels: d.labels,
          })),
        },
        metadata: {
          searchTerms,
          totalParagraphsScanned: chunks.length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to fetch documents: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
