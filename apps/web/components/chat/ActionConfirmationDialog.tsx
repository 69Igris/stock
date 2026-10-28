"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import type { DetectedAction } from "@usemoney/types";
import { Loader2, Sparkles, Check } from "lucide-react";

interface ActionConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: DetectedAction | null;
  onConfirm: (action: DetectedAction) => Promise<void>;
  onCancel?: () => void;
}

/**
 * ActionConfirmationDialog — playful re-skin (MONEY-484).
 *
 * All logic (handleConfirm, handleCancel, toast, formatters) is preserved
 * verbatim. Visual chrome restyled with pf-* tokens to match the design
 * reference in screens-qa-system.jsx (ActionConfirmationDialog):
 *   - Emerald rotated Sparkles badge header
 *   - "STOCKSAGE SUGGESTS · CONFIRM TO RUN" mono sub-label
 *   - Dashed-border parameter block titled "WHAT'LL HAPPEN"
 *   - pf-bf / pf-bs buttons
 */
export function ActionConfirmationDialog({
  open,
  onOpenChange,
  action,
  onConfirm,
  onCancel,
}: ActionConfirmationDialogProps) {
  const [isExecuting, setIsExecuting] = useState(false);

  const handleConfirm = async () => {
    if (!action) return;
    setIsExecuting(true);
    try {
      await onConfirm(action);
      toast.success("Action completed successfully", {
        description: getSuccessMessage(action.type),
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Action execution failed:", error);
      toast.error("Action failed", {
        description: "An unexpected error occurred. Please try again.",
      });
    } finally {
      setIsExecuting(false);
    }
  };

  const handleCancel = () => {
    if (isExecuting) return;
    onOpenChange(false);
    onCancel?.();
  };

  if (!action) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "var(--shadow-hard)",
          color: "var(--ink)",
          padding: 0,
          overflow: "hidden",
          maxWidth: 500,
        }}
      >
        {/* Header band */}
        <div
          style={{
            padding: "16px 22px",
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 9,
              background: "var(--emerald)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              flexShrink: 0,
            }}
          >
            <Sparkles style={{ width: 18, height: 18 }} />
          </div>
          <div>
            <div
              className="mono"
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: "var(--emerald-text)",
                letterSpacing: "1.5px",
                textTransform: "uppercase",
                marginBottom: 3,
              }}
            >
              STOCKSAGE SUGGESTS · CONFIRM TO RUN
            </div>
            <AlertDialogTitle
              style={{
                fontSize: 17,
                fontWeight: 800,
                letterSpacing: "-0.3px",
                color: "var(--ink)",
                lineHeight: 1.2,
              }}
            >
              {getActionTitle(action.type)}
            </AlertDialogTitle>
          </div>
        </div>

        <div style={{ padding: 22 }}>
          <AlertDialogHeader>
            <AlertDialogDescription
              className="ser"
              style={{
                fontSize: 15,
                color: "var(--ink-2)",
                lineHeight: 1.4,
                marginBottom: 16,
              }}
            >
              {action.confirmationMessage}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* Parameter block */}
          <div
            style={{
              padding: 14,
              background: "var(--rule-softer)",
              borderRadius: 10,
              border: "1px dashed var(--ink)",
            }}
          >
            <div
              className="mono"
              style={{
                marginBottom: 10,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "1px",
                color: "var(--ink-3)",
                textTransform: "uppercase",
              }}
            >
              WHAT&apos;LL HAPPEN
            </div>
            <dl
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 12,
                color: "var(--ink-2)",
                lineHeight: 1.7,
                margin: 0,
                padding: 0,
              }}
            >
              {Object.entries(action.parameters).map(([key, value]) => (
                <div
                  key={key}
                  style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
                >
                  <dt style={{ fontWeight: 700, color: "var(--ink-3)" }}>
                    {formatParameterName(key)}:
                  </dt>
                  <dd
                    style={{
                      color: "var(--emerald-text)",
                      margin: 0,
                      fontWeight: 700,
                    }}
                  >
                    {formatParameterValue(value)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>

        <AlertDialogFooter
          style={{
            padding: "14px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            margin: 0,
          }}
        >
          <AlertDialogCancel
            onClick={handleCancel}
            disabled={isExecuting}
            className="pf-bf sm mt-0 disabled:opacity-50"
          >
            No, just chat
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isExecuting}
            className="pf-bs sm disabled:opacity-50"
            style={{ minWidth: 120 }}
          >
            {isExecuting ? (
              <>
                <Loader2
                  style={{
                    width: 13,
                    height: 13,
                    animation: "spin 1s linear infinite",
                  }}
                />
                Executing…
              </>
            ) : (
              <>
                <Check style={{ width: 13, height: 13 }} />
                Yes, do it
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function getActionTitle(actionType: string): string {
  const titles: Record<string, string> = {
    create_scenario: "Create FIRE Scenario",
    modify_scenario: "Modify FIRE Scenario",
    delete_scenario: "Delete FIRE Scenario",
    add_stock: "Add Stock to Portfolio",
    add_mutual_fund: "Add Mutual Fund to Portfolio",
    remove_holding: "Remove Holding",
    save_analysis: "Save Stock Analysis",
  };
  return titles[actionType] || "Confirm Action";
}

function getSuccessMessage(actionType: string): string {
  const messages: Record<string, string> = {
    create_scenario: "FIRE scenario created successfully",
    modify_scenario: "FIRE scenario updated successfully",
    delete_scenario: "FIRE scenario deleted",
    add_stock: "Stock added to your portfolio",
    add_mutual_fund: "Mutual fund added to your portfolio",
    remove_holding: "Holding removed from portfolio",
    save_analysis: "Analysis saved successfully",
  };
  return messages[actionType] || "Action completed";
}

function formatParameterName(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .replace(/_/g, " ");
}

function formatParameterValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (value >= 1000) return `₹${value.toLocaleString("en-IN")}`;
    return value.toString();
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
