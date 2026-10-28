"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { PieChart, X, Save, Loader2 } from "lucide-react";
import {
  InstrumentSearch,
  type InstrumentSearchItem,
} from "@/components/InstrumentSearch";

export interface MutualFundFormData {
  schemeName: string;
  schemeCode: string;
  amcName: string;
  folioNumber: string;
  category: string;
  units: string;
  averageNav: string;
  currentNav: string;
  sipActive: boolean;
  sipAmount: string;
  sipDate: string;
  brokerName: string;
}

interface BrokerConnection {
  id: string;
  brokerId: string;
  customName: string;
  brokerName: string;
  logo: string;
}

interface AddMutualFundDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: MutualFundFormData) => Promise<void>;
  title?: string;
}

const initialFormData: MutualFundFormData = {
  schemeName: "",
  schemeCode: "",
  amcName: "",
  folioNumber: "",
  category: "Equity",
  units: "",
  averageNav: "",
  currentNav: "",
  sipActive: false,
  sipAmount: "",
  sipDate: "",
  brokerName: "manual",
};

const MF_CATEGORIES = [
  "Equity",
  "Debt",
  "Hybrid",
  "ELSS",
  "Large Cap",
  "Mid Cap",
  "Small Cap",
  "Flexi Cap",
  "Multi Cap",
  "Index",
  "Sectoral",
  "Thematic",
];

export default function AddMutualFundDialog({
  open,
  onOpenChange,
  onSave,
  title = "Add Mutual Fund",
}: AddMutualFundDialogProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState<MutualFundFormData>(initialFormData);
  const [connections, setConnections] = useState<BrokerConnection[]>([]);
  const [isManualBroker, setIsManualBroker] = useState(false);
  const [manualBrokerName, setManualBrokerName] = useState("");
  const [isManualScheme, setIsManualScheme] = useState(false);
  const [selectedMF, setSelectedMF] = useState<InstrumentSearchItem | null>(
    null
  );
  const [isFetchingNAV, setIsFetchingNAV] = useState(false);

  // Handle MF selection from search
  const handleMFSelect = useCallback(async (item: InstrumentSearchItem) => {
    setSelectedMF(item);
    setIsManualScheme(false);
    setForm((p) => ({
      ...p,
      schemeName: item.name,
      schemeCode: item.symbol, // symbol = schemeCode for MFs
      amcName: item.exchange, // exchange = amcName for MFs
      category: item.sector || p.category, // sector = category for MFs
    }));

    // Fetch current NAV from scheme code
    if (item.symbol) {
      setIsFetchingNAV(true);
      try {
        const res = await fetch(
          `/api/market/search?q=${encodeURIComponent(item.symbol)}&types=MF&limit=1`
        );
        if (res.ok) {
          const data = await res.json();
          const result = data?.results?.[0];
          // NAV might be in cached search data - we already have it from the search
          // For now, just mark as fetched; NAV isn't returned in search results
        }
      } catch {
        // NAV fetch failed - user can enter manually
      } finally {
        setIsFetchingNAV(false);
      }
    }
  }, []);

  // Load broker connections from localStorage
  useEffect(() => {
    const saved = localStorage.getItem("tradebook_broker_connections");
    if (saved) {
      try {
        setConnections(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse saved connections");
      }
    }
  }, [open]);

  const handleBrokerChange = (value: string) => {
    if (value === "MANUAL") {
      setIsManualBroker(true);
      setForm((p) => ({ ...p, brokerName: "manual" }));
    } else {
      setIsManualBroker(false);
      const connection = connections.find((c) => c.id === value);
      if (connection) {
        setForm((p) => ({
          ...p,
          brokerName: connection.brokerName.toLowerCase(),
        }));
      }
    }
  };

  const handleManualBrokerChange = (name: string) => {
    setManualBrokerName(name);
    setForm((p) => ({ ...p, brokerName: "manual" }));
  };

  const handleSave = async () => {
    if (!form.schemeName || !form.units || !form.averageNav) {
      toast.error(
        "Please fill required fields (Scheme Name, Units, Average NAV)"
      );
      return;
    }

    setIsSaving(true);
    try {
      await onSave(form);
      setForm(initialFormData);
      setIsManualBroker(false);
      setManualBrokerName("");
      setIsManualScheme(false);
      setSelectedMF(null);
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to save mutual fund");
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    setForm(initialFormData);
    setIsManualBroker(false);
    setManualBrokerName("");
    setIsManualScheme(false);
    setSelectedMF(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[90vh] overflow-y-auto p-0 gap-0"
        style={{
          background: "var(--paper)",
          border: "2px solid var(--ink)",
          borderRadius: 16,
          boxShadow: "var(--shadow-hard)",
          color: "var(--ink)",
        }}
      >
        <DialogHeader
          className="space-y-0 text-left"
          style={{
            padding: "16px 22px",
            borderBottom: "2px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          <DialogTitle className="flex items-center gap-2.5">
            <span
              className="grid place-items-center shrink-0"
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "var(--ink)",
                color: "var(--pop-3)",
                transform: "rotate(-3deg)",
              }}
            >
              <PieChart className="h-4 w-4" />
            </span>
            <span
              style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.3px" }}
            >
              {title}
            </span>
          </DialogTitle>
          <DialogDescription
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              letterSpacing: "0.5px",
              marginTop: 4,
            }}
          >
            Add a mutual fund to your portfolio
          </DialogDescription>
        </DialogHeader>

        <div className="px-[22px] pt-[18px]">
          <div className="grid grid-cols-2 gap-4 pb-2">
            {/* Row 1: Scheme Name (searchable) */}
            <div className="space-y-2 col-span-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Scheme Name <span className="text-red-500">*</span>
              </Label>
              {isManualScheme || selectedMF ? (
                <div className="flex gap-2">
                  <Input
                    className="pf-input flex-1"
                    placeholder="e.g., HDFC Flexi Cap Fund - Direct Growth"
                    value={form.schemeName}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, schemeName: e.target.value }))
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs shrink-0 hover:underline"
                    style={{ color: "var(--emerald-text)" }}
                    onClick={() => {
                      setIsManualScheme(false);
                      setSelectedMF(null);
                      setForm((p) => ({
                        ...p,
                        schemeName: "",
                        schemeCode: "",
                        amcName: "",
                        category: "Equity",
                      }));
                    }}
                  >
                    Search
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <InstrumentSearch
                    onSelect={handleMFSelect}
                    placeholder="Search by fund name, AMC, or category..."
                    filterTypes={["MF"]}
                    limit={10}
                    className="w-full"
                  />
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground/80 underline"
                    onClick={() => setIsManualScheme(true)}
                  >
                    Or type scheme name manually
                  </button>
                </div>
              )}
              {selectedMF && (
                <p
                  className="text-[11px]"
                  style={{ color: "var(--emerald-text)" }}
                >
                  {selectedMF.exchange} · {selectedMF.sector || "Mutual Fund"}
                  {selectedMF.symbol && ` · Code: ${selectedMF.symbol}`}
                </p>
              )}
            </div>

            {/* Row 1b: Category, AMC Name (auto-filled when MF selected) */}
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Category
                {selectedMF && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    (auto-filled)
                  </span>
                )}
              </Label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((p) => ({ ...p, category: v }))}
                disabled={!!selectedMF}
              >
                <SelectTrigger
                  className={`pf-input ${selectedMF ? "opacity-70 cursor-not-allowed" : ""}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  style={{
                    background: "var(--paper)",
                    border: "2px solid var(--ink)",
                    color: "var(--ink)",
                  }}
                >
                  {MF_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                AMC Name
                {selectedMF && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    (auto-filled)
                  </span>
                )}
              </Label>
              <Input
                className={`pf-input ${selectedMF ? "opacity-70" : ""}`}
                placeholder="e.g., HDFC AMC"
                value={form.amcName}
                onChange={(e) =>
                  setForm((p) => ({ ...p, amcName: e.target.value }))
                }
                readOnly={!!selectedMF}
              />
            </div>

            {/* Row 2: Scheme Code (auto-filled), Folio Number */}
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Scheme Code
                {selectedMF && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    (auto-filled)
                  </span>
                )}
              </Label>
              <Input
                className={`pf-input ${selectedMF ? "opacity-70" : ""}`}
                placeholder="Optional"
                value={form.schemeCode}
                onChange={(e) =>
                  setForm((p) => ({ ...p, schemeCode: e.target.value }))
                }
                readOnly={!!selectedMF}
              />
            </div>
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Folio Number
              </Label>
              <Input
                className="pf-input"
                placeholder="Optional"
                value={form.folioNumber}
                onChange={(e) =>
                  setForm((p) => ({ ...p, folioNumber: e.target.value }))
                }
              />
            </div>

            {/* Row 3: Units, Average NAV */}
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Units <span className="text-red-500">*</span>
              </Label>
              <Input
                type="number"
                step="0.01"
                className="pf-input"
                placeholder="1250.45"
                value={form.units}
                onChange={(e) =>
                  setForm((p) => ({ ...p, units: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Average NAV <span className="text-red-500">*</span>
              </Label>
              <Input
                type="number"
                step="0.01"
                className="pf-input"
                placeholder="85.50"
                value={form.averageNav}
                onChange={(e) =>
                  setForm((p) => ({ ...p, averageNav: e.target.value }))
                }
              />
            </div>

            {/* Row 4: Current NAV, Broker */}
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Current NAV
              </Label>
              <Input
                type="number"
                step="0.01"
                className="pf-input"
                placeholder="Leave empty to use Average NAV"
                value={form.currentNav}
                onChange={(e) =>
                  setForm((p) => ({ ...p, currentNav: e.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Broker Account
              </Label>
              <Select
                value={
                  form.brokerName === "manual" ? "MANUAL" : form.brokerName
                }
                onValueChange={handleBrokerChange}
              >
                <SelectTrigger
                  className="pf-input"
                  style={{ display: "flex", alignItems: "center" }}
                >
                  <SelectValue placeholder="Select broker account" />
                </SelectTrigger>
                <SelectContent
                  style={{
                    background: "var(--paper)",
                    border: "2px solid var(--ink)",
                    color: "var(--ink)",
                  }}
                >
                  {connections.map((conn) => (
                    <SelectItem key={conn.id} value={conn.id}>
                      <div className="flex items-center gap-2">
                        <span>{conn.logo}</span>
                        <span>{conn.customName}</span>
                      </div>
                    </SelectItem>
                  ))}
                  <SelectItem value="MANUAL">
                    <div className="flex items-center gap-2">
                      <span>📝</span>
                      <span>Manual Entry</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              {isManualBroker && (
                <Input
                  className="pf-input mt-2"
                  placeholder="Enter broker name (optional)"
                  value={manualBrokerName}
                  onChange={(e) => handleManualBrokerChange(e.target.value)}
                />
              )}
            </div>

            {/* Row 5: SIP Active */}
            <div className="col-span-2 space-y-2">
              <div className="flex items-center justify-between">
                <Label
                  className="mono"
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--ink-2)",
                    letterSpacing: "0.3px",
                  }}
                >
                  SIP Active
                </Label>
                <Switch
                  checked={form.sipActive}
                  onCheckedChange={(checked) =>
                    setForm((p) => ({ ...p, sipActive: checked }))
                  }
                />
              </div>
            </div>

            {/* Row 6: SIP Amount, SIP Date (if SIP Active) */}
            {form.sipActive && (
              <>
                <div className="space-y-2">
                  <Label
                    className="mono"
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "var(--ink-2)",
                      letterSpacing: "0.3px",
                    }}
                  >
                    SIP Amount (₹)
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    className="pf-input"
                    placeholder="5000"
                    value={form.sipAmount}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, sipAmount: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label
                    className="mono"
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "var(--ink-2)",
                      letterSpacing: "0.3px",
                    }}
                  >
                    SIP Date (Day of month)
                  </Label>
                  <Input
                    type="number"
                    min="1"
                    max="28"
                    className="pf-input"
                    placeholder="5"
                    value={form.sipDate}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, sipDate: e.target.value }))
                    }
                  />
                </div>
              </>
            )}
          </div>
        </div>

        <DialogFooter
          className="gap-2 sm:justify-end"
          style={{
            padding: "14px 22px",
            borderTop: "1.5px dashed var(--rule-soft)",
            background: "var(--paper-2)",
          }}
        >
          <button type="button" className="pf-bf sm" onClick={handleClose}>
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
          <button
            type="button"
            className="pf-bs sm"
            onClick={handleSave}
            disabled={isSaving}
            style={
              isSaving ? { opacity: 0.6, cursor: "not-allowed" } : undefined
            }
          >
            <Save className="h-3.5 w-3.5" />{" "}
            {isSaving ? "Saving..." : "Save Mutual Fund →"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
