"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { toast } from "sonner";
import { BookOpen, X, Save, Loader2 } from "lucide-react";
import {
  InstrumentSearch,
  type InstrumentSearchItem,
} from "@/components/InstrumentSearch";

export interface TradeFormData {
  tradeDate: string;
  symbol: string;
  broker: string;
  brokerDisplayName: string;
  exchange: string;
  segment: string;
  positionType: string;
  tradeType: string;
  orderType: string;
  quantity: string;
  price: string;
  exitPrice: string;
  brokerage: string;
  realizedPnL: string;
  productType: string;
  tags: string;
  notes: string;
}

interface BrokerConnection {
  id: string;
  brokerId: string;
  customName: string;
  brokerName: string;
  logo: string;
}

interface AddTradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (data: TradeFormData) => Promise<void>;
  title?: string;
  isPosition?: boolean;
}

const BROKER_LOGOS: Record<string, string> = {
  ZERODHA: "🟢",
  UPSTOX: "🟣",
  FYERS: "🟢",
  DHAN: "🔵",
  ANGEL_ONE: "🔴",
  GROWW: "🟡",
  ICICI: "🟠",
  HDFC: "🔵",
  MANUAL: "📝",
};

const initialFormData: TradeFormData = {
  tradeDate: new Date().toISOString().split("T")[0],
  symbol: "",
  broker: "",
  brokerDisplayName: "",
  exchange: "NSE",
  segment: "EQUITY",
  positionType: "LONG",
  tradeType: "BUY",
  orderType: "MARKET",
  quantity: "",
  price: "",
  exitPrice: "",
  brokerage: "20",
  realizedPnL: "",
  productType: "CNC",
  tags: "",
  notes: "",
};

export default function AddTradeDialog({
  open,
  onOpenChange,
  onSave,
  title = "Add Trade to Logbook",
  isPosition = false,
}: AddTradeDialogProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [form, setForm] = useState<TradeFormData>(initialFormData);
  const [connections, setConnections] = useState<BrokerConnection[]>([]);
  const [isManualBroker, setIsManualBroker] = useState(false);
  const [manualBrokerName, setManualBrokerName] = useState("");
  const [isManualSymbol, setIsManualSymbol] = useState(false);
  const [isFetchingCMP, setIsFetchingCMP] = useState(false);
  const [selectedInstrument, setSelectedInstrument] =
    useState<InstrumentSearchItem | null>(null);

  // Handle instrument selection from search
  const handleInstrumentSelect = useCallback(
    async (item: InstrumentSearchItem) => {
      setSelectedInstrument(item);
      setIsManualSymbol(false);
      setForm((p) => ({
        ...p,
        symbol: item.symbol,
        exchange: item.exchange || p.exchange,
      }));

      // Fetch CMP if yahoo symbol is available
      if (item.yahooSymbol) {
        setIsFetchingCMP(true);
        try {
          const res = await fetch(
            `/api/market/autocomplete?q=${encodeURIComponent(item.yahooSymbol)}&limit=1`
          );
          if (res.ok) {
            const data = await res.json();
            const quote = data?.results?.[0];
            if (quote?.price) {
              setForm((p) => ({ ...p, price: String(quote.price) }));
            }
          }
        } catch {
          // CMP fetch failed - user can enter manually
        } finally {
          setIsFetchingCMP(false);
        }
      }
    },
    []
  );

  const handleManualSymbolToggle = useCallback(() => {
    setIsManualSymbol(true);
    setSelectedInstrument(null);
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
      setForm((p) => ({ ...p, broker: "MANUAL", brokerDisplayName: "" }));
    } else {
      setIsManualBroker(false);
      const connection = connections.find((c) => c.id === value);
      if (connection) {
        setForm((p) => ({
          ...p,
          broker: connection.id,
          brokerDisplayName: `${connection.logo} ${connection.customName}`,
        }));
      }
    }
  };

  const handleManualBrokerChange = (name: string) => {
    setManualBrokerName(name);
    setForm((p) => ({ ...p, brokerDisplayName: name }));
  };

  const handleSave = async () => {
    if (!form.symbol || !form.quantity || !form.price) {
      toast.error("Please fill required fields (Symbol, Quantity, Price)");
      return;
    }

    setIsSaving(true);
    try {
      await onSave(form);
      setForm(initialFormData);
      setIsManualBroker(false);
      setManualBrokerName("");
      setIsManualSymbol(false);
      setSelectedInstrument(null);
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to save trade");
    } finally {
      setIsSaving(false);
    }
  };

  const handleClose = () => {
    setForm(initialFormData);
    setIsManualBroker(false);
    setManualBrokerName("");
    setIsManualSymbol(false);
    setSelectedInstrument(null);
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
                color: "var(--pop-2)",
                transform: "rotate(-3deg)",
              }}
            >
              <BookOpen className="h-4 w-4" />
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
            Manually log a trade for your personal records
          </DialogDescription>
        </DialogHeader>

        <div className="px-[22px] pt-[18px]">
          <div className="grid grid-cols-2 gap-4 pb-2">
            {/* Row 1: Trade Date, Symbol */}
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
                Trade Date <span className="text-red-500">*</span>
              </Label>
              <Input
                type="date"
                className="pf-input"
                value={form.tradeDate}
                onChange={(e) =>
                  setForm((p) => ({ ...p, tradeDate: e.target.value }))
                }
                max={new Date().toISOString().split("T")[0]}
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
                Symbol <span className="text-red-500">*</span>
              </Label>
              {isManualSymbol || selectedInstrument ? (
                <div className="flex gap-2">
                  <Input
                    className="pf-input flex-1"
                    placeholder="e.g., RELIANCE"
                    value={form.symbol}
                    onChange={(e) =>
                      setForm((p) => ({
                        ...p,
                        symbol: e.target.value.toUpperCase(),
                      }))
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs shrink-0 hover:underline"
                    style={{ color: "var(--emerald-text)" }}
                    onClick={() => {
                      setIsManualSymbol(false);
                      setSelectedInstrument(null);
                      setForm((p) => ({ ...p, symbol: "", price: "" }));
                    }}
                  >
                    Search
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <InstrumentSearch
                    onSelect={handleInstrumentSelect}
                    placeholder="Search stocks, MFs..."
                    filterTypes={["EQUITY", "MF", "ETF"]}
                    limit={8}
                    className="w-full"
                  />
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground/80 underline"
                    onClick={handleManualSymbolToggle}
                  >
                    Or type symbol manually
                  </button>
                </div>
              )}
              {isFetchingCMP && (
                <p
                  className="text-[11px] flex items-center gap-1"
                  style={{ color: "var(--pop-3-text)" }}
                >
                  <Loader2 className="h-3 w-3 animate-spin" /> Fetching current
                  price...
                </p>
              )}
              {selectedInstrument && (
                <p
                  className="text-[11px]"
                  style={{ color: "var(--emerald-text)" }}
                >
                  {selectedInstrument.name} ({selectedInstrument.exchange})
                  {form.price && !isFetchingCMP && ` · CMP: ₹${form.price}`}
                </p>
              )}
            </div>

            {/* Row 2: Broker Account, Exchange */}
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
              <Select value={form.broker} onValueChange={handleBrokerChange}>
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
                        <span className="text-xs text-muted-foreground">
                          ({conn.brokerName})
                        </span>
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
                  placeholder="Enter broker name (e.g., Zerodha, Angel One)"
                  value={manualBrokerName}
                  onChange={(e) => handleManualBrokerChange(e.target.value)}
                />
              )}
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
                Exchange
                {selectedInstrument && (
                  <span className="text-[10px] text-muted-foreground ml-1">
                    (auto-filled)
                  </span>
                )}
              </Label>
              <Select
                value={form.exchange}
                onValueChange={(v) => setForm((p) => ({ ...p, exchange: v }))}
                disabled={!!selectedInstrument}
              >
                <SelectTrigger
                  className={`pf-input ${selectedInstrument ? "opacity-70 cursor-not-allowed" : ""}`}
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
                  <SelectItem value="NSE">NSE</SelectItem>
                  <SelectItem value="BSE">BSE</SelectItem>
                  <SelectItem value="NFO">NFO</SelectItem>
                  <SelectItem value="MCX">MCX</SelectItem>
                  <SelectItem value="NCDEX">NCDEX</SelectItem>
                  <SelectItem value="CDS">CDS (Currency)</SelectItem>
                  <SelectItem value="CRYPTO">Crypto</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Row 3: Segment, Position Type */}
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
                Segment
              </Label>
              <Select
                value={form.segment}
                onValueChange={(v) => setForm((p) => ({ ...p, segment: v }))}
              >
                <SelectTrigger
                  className="pf-input"
                  style={{ display: "flex", alignItems: "center" }}
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
                  <SelectItem value="EQUITY">Equity (Cash)</SelectItem>
                  <SelectItem value="FUTURES">Futures</SelectItem>
                  <SelectItem value="OPTIONS">Options</SelectItem>
                  <SelectItem value="COMMODITY">Commodity</SelectItem>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="CRYPTO">Crypto</SelectItem>
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
                Position Type <span className="text-red-500">*</span>
              </Label>
              <Select
                value={form.positionType}
                onValueChange={(v) =>
                  setForm((p) => ({ ...p, positionType: v }))
                }
              >
                <SelectTrigger
                  className="pf-input"
                  style={{ display: "flex", alignItems: "center" }}
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
                  <SelectItem value="LONG">Long (Bullish)</SelectItem>
                  <SelectItem value="SHORT">Short (Bearish)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Row 4: Trade Type, Order Type */}
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
                Trade Type <span className="text-red-500">*</span>
              </Label>
              <Select
                value={form.tradeType}
                onValueChange={(v) => setForm((p) => ({ ...p, tradeType: v }))}
              >
                <SelectTrigger
                  className="pf-input"
                  style={{ display: "flex", alignItems: "center" }}
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
                  <SelectItem value="BUY">Buy</SelectItem>
                  <SelectItem value="SELL">Sell</SelectItem>
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
                Order Type
              </Label>
              <Select
                value={form.orderType}
                onValueChange={(v) => setForm((p) => ({ ...p, orderType: v }))}
              >
                <SelectTrigger
                  className="pf-input"
                  style={{ display: "flex", alignItems: "center" }}
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
                  <SelectItem value="MARKET">Market</SelectItem>
                  <SelectItem value="LIMIT">Limit</SelectItem>
                  <SelectItem value="SL">Stop Loss</SelectItem>
                  <SelectItem value="SL-M">Stop Loss Market</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Row 5: Quantity, Price */}
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
                Quantity <span className="text-red-500">*</span>
              </Label>
              <Input
                type="number"
                className="pf-input"
                placeholder="100"
                value={form.quantity}
                onChange={(e) =>
                  setForm((p) => ({ ...p, quantity: e.target.value }))
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
                Price <span className="text-red-500">*</span>
              </Label>
              <Input
                type="number"
                step="0.01"
                className="pf-input"
                placeholder="1500.50"
                value={form.price}
                onChange={(e) =>
                  setForm((p) => ({ ...p, price: e.target.value }))
                }
              />
            </div>

            {/* Row 6: Exit Price, Brokerage */}
            {!isPosition && (
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
                    Exit Price (₹){" "}
                    <span className="text-xs text-muted-foreground">
                      Leave empty for open position
                    </span>
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    className="pf-input"
                    placeholder="Leave empty if position is open"
                    value={form.exitPrice}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, exitPrice: e.target.value }))
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
                    Brokerage (₹)
                  </Label>
                  <Input
                    type="number"
                    className="pf-input"
                    placeholder="20"
                    value={form.brokerage}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, brokerage: e.target.value }))
                    }
                  />
                </div>
              </>
            )}

            {/* Row 7: Realized P&L (only for tradebook) */}
            {!isPosition && (
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
                  Realized P&L (₹)
                </Label>
                <Input
                  type="text"
                  className="pf-input"
                  placeholder="1500 or -500"
                  value={form.realizedPnL}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, realizedPnL: e.target.value }))
                  }
                />
              </div>
            )}

            {/* Product Type (shown for both tradebook and positions) */}
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
                Product Type
              </Label>
              <Select
                value={form.productType}
                onValueChange={(v) =>
                  setForm((p) => ({ ...p, productType: v }))
                }
              >
                <SelectTrigger
                  className="pf-input"
                  style={{ display: "flex", alignItems: "center" }}
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
                  <SelectItem value="CNC">CNC (Delivery)</SelectItem>
                  <SelectItem value="MIS">MIS (Intraday)</SelectItem>
                  <SelectItem value="NRML">NRML (F&O)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Tags */}
            <div className="col-span-2 space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Tags (comma separated)
              </Label>
              <Input
                className="pf-input"
                placeholder="breakout, momentum"
                value={form.tags}
                onChange={(e) =>
                  setForm((p) => ({ ...p, tags: e.target.value }))
                }
              />
            </div>

            {/* Notes */}
            <div className="col-span-2 space-y-2">
              <Label
                className="mono"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--ink-2)",
                  letterSpacing: "0.3px",
                }}
              >
                Notes / Trade Rationale
              </Label>
              <Textarea
                className="pf-input min-h-[80px]"
                placeholder="Why did you take this trade? What was your strategy?"
                value={form.notes}
                onChange={(e) =>
                  setForm((p) => ({ ...p, notes: e.target.value }))
                }
              />
            </div>
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
            {isSaving ? "Saving..." : "Save Trade →"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
