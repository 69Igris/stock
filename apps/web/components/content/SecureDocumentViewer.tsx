"use client";

/**
 * Secure Document Viewer Component
 *
 * Renders PDFs and image-based slides with security features:
 * - Canvas-based rendering (not embeddable)
 * - No download/print options
 * - Right-click disabled
 * - Watermark overlay
 * - Text selection disabled
 * - Zoom and navigation controls
 */

import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import Image from "next/image";
import { Document, Page, pdfjs } from "react-pdf";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  RotateCw,
  Loader2,
} from "lucide-react";
import { cn } from "@usemoney/ui";

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// ============== TYPES ==============

export interface SecureDocumentViewerProps {
  /** Document URL (PDF or image) */
  src: string;
  /** Document type */
  type?: "pdf" | "image" | "slides";
  /** Array of image URLs for slides mode */
  slides?: string[];
  /** Initial page number (1-indexed) */
  initialPage?: number;
  /** Callback when page changes */
  onPageChange?: (page: number, totalPages: number) => void;
  /** Callback when document is fully viewed */
  onComplete?: () => void;
  /** Watermark text to display */
  watermarkText?: string;
  /** Additional CSS class */
  className?: string;
  /** Enable fullscreen mode */
  allowFullscreen?: boolean;
  /** Minimum zoom level */
  minZoom?: number;
  /** Maximum zoom level */
  maxZoom?: number;
}

export interface SecureDocumentViewerRef {
  goToPage: (page: number) => void;
  nextPage: () => void;
  prevPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  getCurrentPage: () => number;
  getTotalPages: () => number;
}

// ============== COMPONENT ==============

export const SecureDocumentViewer = forwardRef<
  SecureDocumentViewerRef,
  SecureDocumentViewerProps
>(
  (
    {
      src,
      type = "pdf",
      slides = [],
      initialPage = 1,
      onPageChange,
      onComplete,
      watermarkText,
      className,
      allowFullscreen = true,
      minZoom = 0.5,
      maxZoom = 3,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [numPages, setNumPages] = useState<number>(0);
    const [currentPage, setCurrentPage] = useState(initialPage);
    const [zoom, setZoom] = useState(1);
    const [rotation, setRotation] = useState(0);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [viewedPages, setViewedPages] = useState<Set<number>>(
      new Set([initialPage])
    );

    // Determine total pages based on type
    const totalPages = type === "slides" ? slides.length : numPages;

    // ============== NAVIGATION ==============

    const goToPage = useCallback(
      (page: number) => {
        const validPage = Math.max(1, Math.min(page, totalPages));
        setCurrentPage(validPage);
        setViewedPages((prev) => new Set([...Array.from(prev), validPage]));
        onPageChange?.(validPage, totalPages);
      },
      [totalPages, onPageChange]
    );

    const nextPage = useCallback(() => {
      if (currentPage < totalPages) {
        goToPage(currentPage + 1);
      }
    }, [currentPage, totalPages, goToPage]);

    const prevPage = useCallback(() => {
      if (currentPage > 1) {
        goToPage(currentPage - 1);
      }
    }, [currentPage, goToPage]);

    // ============== ZOOM ==============

    const zoomIn = useCallback(() => {
      setZoom((prev) => Math.min(prev + 0.25, maxZoom));
    }, [maxZoom]);

    const zoomOut = useCallback(() => {
      setZoom((prev) => Math.max(prev - 0.25, minZoom));
    }, [minZoom]);

    const resetZoom = useCallback(() => {
      setZoom(1);
    }, []);

    // ============== ROTATION ==============

    const rotate = useCallback(() => {
      setRotation((prev) => (prev + 90) % 360);
    }, []);

    // ============== FULLSCREEN ==============

    const toggleFullscreen = useCallback(async () => {
      if (!containerRef.current || !allowFullscreen) return;

      try {
        if (!document.fullscreenElement) {
          await containerRef.current.requestFullscreen();
          setIsFullscreen(true);
        } else {
          await document.exitFullscreen();
          setIsFullscreen(false);
        }
      } catch (err) {
        console.error("Fullscreen error:", err);
      }
    }, [allowFullscreen]);

    // ============== KEYBOARD NAVIGATION ==============

    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "ArrowRight" || e.key === "PageDown") {
          e.preventDefault();
          nextPage();
        } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
          e.preventDefault();
          prevPage();
        } else if (e.key === "Home") {
          e.preventDefault();
          goToPage(1);
        } else if (e.key === "End") {
          e.preventDefault();
          goToPage(totalPages);
        } else if (e.key === "+" || e.key === "=") {
          e.preventDefault();
          zoomIn();
        } else if (e.key === "-") {
          e.preventDefault();
          zoomOut();
        } else if (e.key === "0") {
          e.preventDefault();
          resetZoom();
        } else if (e.key === "Escape" && isFullscreen) {
          e.preventDefault();
          toggleFullscreen();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [
      nextPage,
      prevPage,
      goToPage,
      totalPages,
      zoomIn,
      zoomOut,
      resetZoom,
      isFullscreen,
      toggleFullscreen,
    ]);

    // ============== COMPLETION DETECTION ==============

    useEffect(() => {
      if (totalPages > 0 && viewedPages.size === totalPages) {
        onComplete?.();
      }
    }, [viewedPages, totalPages, onComplete]);

    // ============== PDF HANDLERS ==============

    const onDocumentLoadSuccess = useCallback(
      ({ numPages: pages }: { numPages: number }) => {
        setNumPages(pages);
        setIsLoading(false);
        setError(null);
      },
      []
    );

    const onDocumentLoadError = useCallback((err: Error) => {
      console.error("PDF load error:", err);
      setError("Failed to load document");
      setIsLoading(false);
    }, []);

    // ============== EXPOSE METHODS ==============

    useImperativeHandle(ref, () => ({
      goToPage,
      nextPage,
      prevPage,
      zoomIn,
      zoomOut,
      resetZoom,
      getCurrentPage: () => currentPage,
      getTotalPages: () => totalPages,
    }));

    // ============== RENDER ==============

    return (
      <div
        ref={containerRef}
        className={cn(
          "secure-document-viewer relative flex flex-col bg-gray-900",
          isFullscreen ? "fixed inset-0 z-50" : "rounded-lg overflow-hidden",
          className
        )}
        style={{
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
        onCopy={(e) => e.preventDefault()}
      >
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700">
          {/* Navigation */}
          <div className="flex items-center gap-2">
            <button
              onClick={prevPage}
              disabled={currentPage <= 1}
              className="p-2 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Previous page"
            >
              <ChevronLeft className="w-5 h-5 text-foreground" />
            </button>

            <span className="text-foreground text-sm min-w-[80px] text-center">
              {currentPage} / {totalPages || "..."}
            </span>

            <button
              onClick={nextPage}
              disabled={currentPage >= totalPages}
              className="p-2 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Next page"
            >
              <ChevronRight className="w-5 h-5 text-foreground" />
            </button>
          </div>

          {/* Zoom & Tools */}
          <div className="flex items-center gap-2">
            <button
              onClick={zoomOut}
              disabled={zoom <= minZoom}
              className="p-2 rounded hover:bg-gray-700 disabled:opacity-50"
              title="Zoom out"
            >
              <ZoomOut className="w-5 h-5 text-foreground" />
            </button>

            <span className="text-foreground text-sm min-w-[50px] text-center">
              {Math.round(zoom * 100)}%
            </span>

            <button
              onClick={zoomIn}
              disabled={zoom >= maxZoom}
              className="p-2 rounded hover:bg-gray-700 disabled:opacity-50"
              title="Zoom in"
            >
              <ZoomIn className="w-5 h-5 text-foreground" />
            </button>

            <div className="w-px h-6 bg-gray-600 mx-2" />

            <button
              onClick={rotate}
              className="p-2 rounded hover:bg-gray-700"
              title="Rotate"
            >
              <RotateCw className="w-5 h-5 text-foreground" />
            </button>

            {allowFullscreen && (
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded hover:bg-gray-700"
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? (
                  <Minimize2 className="w-5 h-5 text-foreground" />
                ) : (
                  <Maximize2 className="w-5 h-5 text-foreground" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Document Content */}
        <div className="flex-1 overflow-auto relative bg-gray-800">
          {/* Loading State */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 z-10">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-8 h-8 text-white animate-spin" />
                <span className="text-foreground text-sm">
                  Loading document...
                </span>
              </div>
            </div>
          )}

          {/* Error State */}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
              <div className="text-center text-foreground">
                <p className="text-lg font-medium mb-2">
                  Unable to load document
                </p>
                <p className="text-sm text-gray-400">{error}</p>
              </div>
            </div>
          )}

          {/* Document Renderer */}
          <div
            className="flex items-center justify-center min-h-full p-4"
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
              transformOrigin: "center center",
              transition: "transform 0.2s ease",
            }}
          >
            {type === "pdf" && (
              <Document
                file={src}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={onDocumentLoadError}
                loading={null}
                className="pdf-document"
              >
                <Page
                  pageNumber={currentPage}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="pdf-page shadow-2xl"
                  loading={null}
                />
              </Document>
            )}

            {type === "image" && (
              <div className="relative w-full h-full flex items-center justify-center">
                <Image
                  src={src}
                  alt="Document"
                  fill
                  className="object-contain shadow-2xl"
                  style={{ pointerEvents: "none" }}
                  onLoad={() => {
                    setIsLoading(false);
                    setNumPages(1);
                  }}
                  onError={() => {
                    setError("Failed to load image");
                    setIsLoading(false);
                  }}
                  draggable={false}
                  unoptimized
                />
              </div>
            )}

            {type === "slides" && slides.length > 0 && (
              <div className="relative w-full h-full flex items-center justify-center">
                <Image
                  src={slides[currentPage - 1]}
                  alt={`Slide ${currentPage}`}
                  fill
                  className="object-contain shadow-2xl"
                  style={{ pointerEvents: "none" }}
                  onLoad={() => setIsLoading(false)}
                  onError={() => setError("Failed to load slide")}
                  draggable={false}
                  unoptimized
                />
              </div>
            )}
          </div>

          {/* Watermark Overlay */}
          {watermarkText && <DocumentWatermark text={watermarkText} />}
        </div>

        {/* Page Thumbnails (for multi-page documents) */}
        {totalPages > 1 && (
          <div className="flex items-center gap-2 px-4 py-2 bg-gray-800 border-t border-gray-700 overflow-x-auto">
            {Array.from({ length: Math.min(totalPages, 10) }).map((_, i) => {
              const pageNum = i + 1;
              const isActive = pageNum === currentPage;
              const isViewed = viewedPages.has(pageNum);

              return (
                <button
                  key={pageNum}
                  onClick={() => goToPage(pageNum)}
                  className={cn(
                    "w-8 h-8 rounded text-sm font-medium transition-colors",
                    isActive
                      ? "bg-blue-600 text-foreground"
                      : isViewed
                        ? "bg-gray-600 text-gray-200 hover:bg-gray-500"
                        : "bg-gray-700 text-gray-400 hover:bg-gray-600"
                  )}
                  title={`Go to page ${pageNum}`}
                >
                  {pageNum}
                </button>
              );
            })}
            {totalPages > 10 && (
              <span className="text-gray-400 text-sm px-2">
                +{totalPages - 10} more
              </span>
            )}
          </div>
        )}

        {/* Security Styles */}
        <style jsx global>{`
          .secure-document-viewer {
            -webkit-touch-callout: none;
          }

          .pdf-document {
            display: flex;
            justify-content: center;
          }

          .pdf-page {
            background: white;
          }

          .pdf-page canvas {
            display: block;
            max-width: 100%;
            height: auto !important;
          }

          @media print {
            .secure-document-viewer {
              display: none !important;
            }
          }
        `}</style>
      </div>
    );
  }
);

SecureDocumentViewer.displayName = "SecureDocumentViewer";

// ============== WATERMARK COMPONENT ==============

interface DocumentWatermarkProps {
  text: string;
}

function DocumentWatermark({ text }: DocumentWatermarkProps) {
  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden"
      aria-hidden="true"
    >
      {/* Diagonal watermarks */}
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="absolute whitespace-nowrap"
          style={{
            top: `${(i * 20) % 100}%`,
            left: `${(i * 25) % 100}%`,
            transform: "rotate(-30deg)",
            opacity: 0.05,
            fontSize: "12px",
            fontFamily: "monospace",
            color: "#fff",
            userSelect: "none",
          }}
        >
          {text}
        </div>
      ))}
    </div>
  );
}

export default SecureDocumentViewer;
