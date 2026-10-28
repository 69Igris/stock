"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { Flame, Loader2, Lock, AlertTriangle } from "lucide-react";
import {
  startRoastAction,
  type RoastParams,
  type RoastErrorType,
} from "@/lib/actions/roast";

interface RoastSectionProps {
  brokers: string[];
  hasAccess: boolean;
}

export default function RoastSection({
  brokers,
  hasAccess,
}: RoastSectionProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"overall" | "broker">("overall");
  const [selectedBroker, setSelectedBroker] = useState<string>(
    brokers[0] || ""
  );
  const [assetType, setAssetType] = useState<"stocks" | "mf" | "all">("all");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<RoastErrorType | null>(null);

  const handleRoast = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setErrorType(null);

    const params: RoastParams = {
      mode,
      assetType,
      ...(mode === "broker" && selectedBroker
        ? { broker: selectedBroker }
        : {}),
    };

    const result = await startRoastAction(params);

    if (result?.success && result.sessionId) {
      router.push(`/roast/${result.sessionId}`);
      return;
    } else {
      setError(result?.error || "Something went wrong");
      setErrorType(result?.errorType || null);
    }

    setIsLoading(false);
  }, [mode, assetType, selectedBroker, router]);

  if (!hasAccess) {
    return (
      <Card className="mt-6 border-border bg-card/30">
        <CardContent className="py-8 text-center">
          <Lock className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground mb-2">
            Portfolio Roast is a Pro feature
          </p>
          <p className="text-xs text-muted-foreground">
            Upgrade to Pro to get your portfolio brutally (and hilariously)
            analyzed by AI
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mt-8">
      <Card className="border-orange-900/30 bg-gradient-to-br from-orange-950/20 to-card/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Flame className="h-5 w-5 text-orange-500" />
            Roast My Portfolio
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Get a brutally honest (and funny) AI analysis of your portfolio
          </p>
        </CardHeader>
        <CardContent>
          {/* Options */}
          <div className="flex flex-wrap items-end gap-4 mb-4">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Mode</label>
              <Select
                value={mode}
                onValueChange={(v) => setMode(v as "overall" | "broker")}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="overall">Overall</SelectItem>
                  <SelectItem value="broker">By Broker</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === "broker" && brokers.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Broker</label>
                <Select
                  value={selectedBroker}
                  onValueChange={setSelectedBroker}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {brokers.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Asset Type
              </label>
              <Select
                value={assetType}
                onValueChange={(v) =>
                  setAssetType(v as "stocks" | "mf" | "all")
                }
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="stocks">Stocks Only</SelectItem>
                  <SelectItem value="mf">Mutual Funds Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleRoast}
              disabled={isLoading}
              className="bg-orange-600 hover:bg-orange-700 text-foreground"
            >
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Starting...
                </>
              ) : (
                <>
                  <Flame className="h-4 w-4 mr-2" />
                  Roast It!
                </>
              )}
            </Button>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 p-3 rounded-lg bg-red-950/30 border border-red-900/30">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-300">
                    {errorType === "NEEDS_REAUTH"
                      ? "Broker Session Expired"
                      : errorType === "NOT_CONNECTED"
                        ? "Broker Not Connected"
                        : "Error"}
                  </p>
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
