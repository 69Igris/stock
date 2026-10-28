"use client";

import { useState } from "react";
import { Button } from "@usemoney/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Badge } from "@usemoney/ui/badge";
import { Input } from "@usemoney/ui/input";
import { Label } from "@usemoney/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { toast } from "sonner";
import {
  Wand2,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Copy,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import {
  generateContentAction,
  verifyContentAction,
} from "@/lib/actions/content-generation";

type Step = "topic" | "generate" | "verify" | "result";

export default function ContentCreatePage() {
  const [step, setStep] = useState<Step>("topic");
  const [topic, setTopic] = useState("");
  const [contentType, setContentType] = useState<
    "article" | "video" | "audio" | "infographic"
  >("article");
  const [language, setLanguage] = useState("English");
  const [rawMaterials, setRawMaterials] = useState("");
  const [generatedContent, setGeneratedContent] = useState("");
  const [verification, setVerification] = useState<{
    score: number;
    checks: Array<{ label: string; status: string; detail: string }>;
    suggestions: string[];
  } | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const handleGenerate = async () => {
    if (!topic.trim()) {
      toast.error("Enter a topic");
      return;
    }
    setIsGenerating(true);
    try {
      const result = await generateContentAction({
        topic,
        contentType,
        language,
        rawMaterials: rawMaterials || undefined,
      });
      if (result.success) {
        setGeneratedContent(result.data);
        setStep("verify");
        toast.success("Content generated");
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error("Generation failed");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    try {
      const result = await verifyContentAction({
        content: generatedContent,
        topic,
        contentType,
        language,
      });
      if (result.success) {
        setVerification(result.data);
        setStep("result");
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error("Verification failed");
    } finally {
      setIsVerifying(false);
    }
  };

  const statusIcon = (status: string) => {
    if (status === "pass")
      return <CheckCircle className="h-4 w-4 text-emerald-400" />;
    if (status === "warn")
      return <AlertTriangle className="h-4 w-4 text-amber-400" />;
    return <XCircle className="h-4 w-4 text-red-400" />;
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Wand2 className="h-6 w-6 text-blue-400" />
          AI Content Creator
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Generate, verify, and publish educational content
        </p>
      </div>

      {/* Progress */}
      <div className="flex items-center gap-2">
        {(["topic", "generate", "verify", "result"] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`h-2 w-2 rounded-full ${step === s ? "bg-blue-500" : i < ["topic", "generate", "verify", "result"].indexOf(step) ? "bg-emerald-500" : "bg-slate-600"}`}
            />
            <span
              className={`text-xs ${step === s ? "text-white" : "text-slate-400"}`}
            >
              {s === "topic"
                ? "Topic"
                : s === "generate"
                  ? "Generate"
                  : s === "verify"
                    ? "Verify"
                    : "Result"}
            </span>
            {i < 3 && <div className="w-8 h-px bg-slate-700" />}
          </div>
        ))}
      </div>

      {/* Step: Topic */}
      {step === "topic" && (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardContent className="p-6 space-y-4">
            <div>
              <Label className="text-slate-300">Topic *</Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g., How to read candlestick patterns"
                className="bg-slate-800 border-slate-700 text-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-slate-300">Content Type</Label>
                <Select
                  value={contentType}
                  onValueChange={(v) => setContentType(v as typeof contentType)}
                >
                  <SelectTrigger className="bg-slate-800 border-slate-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem value="article">Article</SelectItem>
                    <SelectItem value="video">Video Script</SelectItem>
                    <SelectItem value="audio">Audio Script</SelectItem>
                    <SelectItem value="infographic">Infographic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-slate-300">Language</Label>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger className="bg-slate-800 border-slate-700">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    <SelectItem value="English">English</SelectItem>
                    <SelectItem value="Hindi">Hindi</SelectItem>
                    <SelectItem value="Tamil">Tamil</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-slate-300">
                Reference Materials (optional)
              </Label>
              <textarea
                value={rawMaterials}
                onChange={(e) => setRawMaterials(e.target.value)}
                placeholder="Paste any reference content, data, or notes..."
                className="w-full h-24 px-3 py-2 rounded-md bg-slate-800 border border-slate-700 text-white resize-none text-sm"
              />
            </div>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || !topic.trim()}
              className="w-full bg-blue-600 hover:bg-blue-700"
            >
              {isGenerating ? "Generating..." : "Generate Content"}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Step: Verify (shows generated content) */}
      {step === "verify" && (
        <Card className="bg-slate-900/50 border-slate-800">
          <CardHeader>
            <CardTitle className="text-white">Generated Content</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-slate-800 rounded-lg p-4 max-h-96 overflow-y-auto">
              <pre className="text-sm text-slate-300 whitespace-pre-wrap">
                {generatedContent}
              </pre>
            </div>
            <div className="flex gap-3">
              <Button
                variant="outline"
                onClick={() => setStep("topic")}
                className="border-slate-700 text-slate-300"
              >
                <ArrowLeft className="h-4 w-4 mr-2" /> Back
              </Button>
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(generatedContent);
                  toast.success("Copied");
                }}
                variant="outline"
                className="border-slate-700 text-slate-300"
              >
                <Copy className="h-4 w-4 mr-2" /> Copy
              </Button>
              <Button
                onClick={handleVerify}
                disabled={isVerifying}
                className="flex-1 bg-blue-600 hover:bg-blue-700"
              >
                {isVerifying ? "Verifying..." : "Verify Quality"}
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Result */}
      {step === "result" && verification && (
        <div className="space-y-4">
          <Card className="bg-slate-900/50 border-slate-800">
            <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-white">
                  Quality Score
                </h3>
                <Badge
                  className={
                    verification.score >= 7
                      ? "bg-emerald-600"
                      : verification.score >= 5
                        ? "bg-amber-600"
                        : "bg-red-600"
                  }
                >
                  {verification.score}/10
                </Badge>
              </div>
              <div className="space-y-3">
                {verification.checks.map((check, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 p-2 rounded bg-slate-800/50"
                  >
                    {statusIcon(check.status)}
                    <div>
                      <p className="text-sm text-white font-medium">
                        {check.label}
                      </p>
                      <p className="text-xs text-slate-400">{check.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
              {verification.suggestions.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm text-slate-300 font-medium mb-2">
                    Suggestions:
                  </p>
                  <ul className="list-disc list-inside space-y-1">
                    {verification.suggestions.map((s, i) => (
                      <li key={i} className="text-xs text-slate-400">
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => setStep("verify")}
              className="border-slate-700 text-slate-300"
            >
              <ArrowLeft className="h-4 w-4 mr-2" /> Back to Content
            </Button>
            <Button
              onClick={() => {
                setStep("topic");
                setGeneratedContent("");
                setVerification(null);
                setTopic("");
              }}
              className="flex-1 bg-blue-600"
            >
              Create Another
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
