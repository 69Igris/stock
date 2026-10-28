"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@usemoney/ui/card";
import { Progress } from "@usemoney/ui/progress";
import { Badge } from "@usemoney/ui/badge";
import { Button } from "@usemoney/ui/button";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  RefreshCw,
  FileText,
} from "lucide-react";
import Link from "next/link";
import {
  getImportJobStatusAction,
  type ImportJobStatus,
} from "@/lib/actions/import-job";

interface ImportProgressProps {
  jobId: string;
  onComplete?: (result: ImportJobStatus) => void;
  onError?: (error: string) => void;
}

export default function ImportProgress({
  jobId,
  onComplete,
  onError,
}: ImportProgressProps) {
  const [job, setJob] = useState<ImportJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await getImportJobStatusAction(jobId);
      if (result?.success && result.job) {
        setJob(result.job);

        // Check if job is complete
        if (result.job.status === "COMPLETED") {
          setIsPolling(false);
          onComplete?.(result.job);
        } else if (result.job.status === "FAILED") {
          setIsPolling(false);
          setError(result.job.errorMessage || "Import failed");
          onError?.(result.job.errorMessage || "Import failed");
        } else if (result.job.status === "CANCELLED") {
          setIsPolling(false);
        }
      } else {
        setError(result?.error || "Failed to get job status");
        setIsPolling(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get job status");
      setIsPolling(false);
    }
  }, [jobId, onComplete, onError]);

  useEffect(() => {
    // Initial fetch
    fetchStatus();

    // Poll every 2 seconds while job is active
    if (isPolling) {
      const interval = setInterval(fetchStatus, 2000);
      return () => clearInterval(interval);
    }
  }, [fetchStatus, isPolling]);

  const getStatusIcon = () => {
    if (!job) return <Loader2 className="h-5 w-5 animate-spin text-blue-500" />;

    switch (job.status) {
      case "PENDING":
        return (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        );
      case "PROCESSING":
        return <Loader2 className="h-5 w-5 animate-spin text-blue-500" />;
      case "COMPLETED":
        return <CheckCircle2 className="h-5 w-5 text-green-500" />;
      case "FAILED":
        return <XCircle className="h-5 w-5 text-red-500" />;
      case "CANCELLED":
        return <AlertCircle className="h-5 w-5 text-amber-500" />;
      default:
        return <Loader2 className="h-5 w-5 animate-spin" />;
    }
  };

  const getStatusText = () => {
    if (!job) return "Loading...";

    switch (job.status) {
      case "PENDING":
        return "Waiting to start...";
      case "PROCESSING":
        if (job.stage === "parsing_complete") {
          return `Parsed ${job.totalRows} rows (${job.validRows} valid)`;
        }
        if (job.stage === "duplicate_check_complete") {
          return "Checking for duplicates...";
        }
        if (job.processedCount !== undefined) {
          return `Processing trades... (${job.processedCount}/${job.validRows || "?"})`;
        }
        return "Processing...";
      case "COMPLETED":
        return "Import complete!";
      case "FAILED":
        return "Import failed";
      case "CANCELLED":
        return "Import cancelled";
      default:
        return "Unknown status";
    }
  };

  const getStatusBadge = () => {
    if (!job) return null;

    switch (job.status) {
      case "PENDING":
        return <Badge className="bg-muted">Pending</Badge>;
      case "PROCESSING":
        return <Badge className="bg-blue-600">Processing</Badge>;
      case "COMPLETED":
        return <Badge className="bg-green-600">Completed</Badge>;
      case "FAILED":
        return <Badge className="bg-red-600">Failed</Badge>;
      case "CANCELLED":
        return <Badge className="bg-amber-600">Cancelled</Badge>;
      default:
        return null;
    }
  };

  if (error && !job) {
    return (
      <Card className="bg-red-900/20 border-red-800">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-red-500" />
            <div>
              <p className="text-red-400 font-medium">Error</p>
              <p className="text-sm text-red-300">{error}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card/50 border-border">
      <CardContent className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {getStatusIcon()}
            <div>
              <p className="text-foreground font-medium">{getStatusText()}</p>
              {job?.status === "PROCESSING" && job.imported !== undefined && (
                <p className="text-sm text-muted-foreground">
                  {job.imported} imported, {job.skipped} skipped
                </p>
              )}
            </div>
          </div>
          {getStatusBadge()}
        </div>

        {/* Progress Bar */}
        {job && (job.status === "PENDING" || job.status === "PROCESSING") && (
          <div className="space-y-2">
            <Progress value={job.progress} className="h-2" />
            <p className="text-xs text-muted-foreground text-right">
              {job.progress}%
            </p>
          </div>
        )}

        {/* Completed Result */}
        {job?.status === "COMPLETED" && job.result && (
          <div className="space-y-3 pt-2 border-t border-border">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="text-center">
                <p className="text-2xl font-bold text-green-400">
                  {job.result.imported}
                </p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-amber-400">
                  {job.result.skipped}
                </p>
                <p className="text-xs text-muted-foreground">Skipped</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-blue-400">
                  {job.result.duplicates?.synced || 0}
                </p>
                <p className="text-xs text-muted-foreground">Synced Dups</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-muted-foreground">
                  {job.result?.errors?.length || 0}
                </p>
                <p className="text-xs text-muted-foreground">Errors</p>
              </div>
            </div>

            {/* View Log Link */}
            {job.result.batchId && (
              <div className="flex justify-center pt-2">
                <Link href={`/tradebook/import/log/${job.result.batchId}`}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-muted-foreground"
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    View Import Log
                  </Button>
                </Link>
              </div>
            )}
          </div>
        )}

        {/* Failed State */}
        {job?.status === "FAILED" && (
          <div className="pt-2 border-t border-border">
            <p className="text-sm text-red-400">
              {job.errorMessage || "An error occurred during import"}
            </p>
            {job.imported !== undefined && job.imported > 0 && (
              <p className="text-sm text-muted-foreground mt-2">
                Partial import: {job.imported} trades were imported before the
                error
              </p>
            )}
          </div>
        )}

        {/* Retry Button for Failed */}
        {!isPolling && job?.status !== "COMPLETED" && (
          <div className="flex justify-end pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsPolling(true);
                setError(null);
                fetchStatus();
              }}
              className="text-muted-foreground"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh Status
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
