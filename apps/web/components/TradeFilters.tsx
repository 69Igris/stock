"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarWithYearNav } from "@/components/ui/calendar";
import { Search, Calendar as CalendarIcon, X } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@usemoney/utils";
import { BrokerLogo } from "@/components/shared/BrokerSelect";
import { SEGMENT_FILTER_OPTIONS } from "@usemoney/core/brokers/clients/broker-mappings";

export interface FilterState {
  symbol: string;
  broker: string;
  segment: string;
  tradeType: string;
  status: string; // "all" | "OPEN" | "CLOSED" | "PARTIAL"
  dateRange: string;
  fromDate: string;
  toDate: string;
}

interface BrokerConnection {
  id: string;
  broker: string;
  brokerUserId: string | null;
  accountName: string | null;
}

// Manual entry icon component
function ManualEntryIcon({ size = 14 }: { size?: number }) {
  return (
    <span style={{ fontSize: size }} className="leading-none">
      📝
    </span>
  );
}

interface TradeFiltersProps {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  onClear: () => void;
  showType?: boolean;
  showStatus?: boolean; // Show open/closed status filter
  showDateRange?: boolean;
  className?: string;
  brokerConnections?: BrokerConnection[];
}

const dateRangeOptions = [
  { value: "allTime", label: "All Time" },
  { value: "today", label: "Today" },
  { value: "last7", label: "Last 7 Days" },
  { value: "last30", label: "Last 30 Days" },
  { value: "currentFY", label: "Current FY" },
  { value: "custom", label: "Custom" },
];

export default function TradeFilters({
  filters,
  onChange,
  onClear,
  showType = true,
  showStatus = false,
  showDateRange = true,
  className,
  brokerConnections = [],
}: TradeFiltersProps) {
  const [showCustomDates, setShowCustomDates] = useState(
    filters.dateRange === "custom"
  );
  const [fromDate, setFromDate] = useState<Date | undefined>(
    filters.fromDate ? new Date(filters.fromDate) : undefined
  );
  const [toDate, setToDate] = useState<Date | undefined>(
    filters.toDate ? new Date(filters.toDate) : undefined
  );

  const handleDateRangeChange = (value: string) => {
    const today = new Date();
    let newFromDate = "";
    let newToDate = today.toISOString().split("T")[0];

    if (value === "custom") {
      setShowCustomDates(true);
      onChange({ ...filters, dateRange: value });
      return;
    }

    setShowCustomDates(false);

    switch (value) {
      case "allTime":
        newFromDate = "";
        newToDate = "";
        break;
      case "today":
        newFromDate = newToDate;
        break;
      case "last7": {
        const weekAgo = new Date(today);
        weekAgo.setDate(today.getDate() - 7);
        newFromDate = weekAgo.toISOString().split("T")[0];
        break;
      }
      case "last30": {
        const monthAgo = new Date(today);
        monthAgo.setDate(today.getDate() - 30);
        newFromDate = monthAgo.toISOString().split("T")[0];
        break;
      }
      case "currentFY": {
        const fyStart =
          today.getMonth() >= 3
            ? new Date(today.getFullYear(), 3, 1)
            : new Date(today.getFullYear() - 1, 3, 1);
        newFromDate = fyStart.toISOString().split("T")[0];
        break;
      }
      default:
        newFromDate = "";
        newToDate = "";
    }

    onChange({
      ...filters,
      dateRange: value,
      fromDate: newFromDate,
      toDate: newToDate,
    });
  };

  const handleCustomDateChange = (
    type: "from" | "to",
    date: Date | undefined
  ) => {
    if (type === "from") {
      setFromDate(date);
      onChange({
        ...filters,
        fromDate: date ? date.toISOString().split("T")[0] : "",
      });
    } else {
      setToDate(date);
      onChange({
        ...filters,
        toDate: date ? date.toISOString().split("T")[0] : "",
      });
    }
  };

  return (
    <div className={cn("space-y-4", className)}>
      {/* Row 1: Search and Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search symbol..."
              className="pl-10 bg-white dark:bg-muted border-slate-300 dark:border-border"
              value={filters.symbol}
              onChange={(e) => onChange({ ...filters, symbol: e.target.value })}
            />
          </div>
        </div>

        <Select
          value={filters.broker}
          onValueChange={(v) => onChange({ ...filters, broker: v })}
        >
          <SelectTrigger className="w-[200px] bg-white dark:bg-muted border-slate-300 dark:border-border">
            <SelectValue placeholder="Broker Account" />
          </SelectTrigger>
          <SelectContent className="bg-white dark:bg-muted border-slate-300 dark:border-border">
            <SelectItem value="all">All Brokers</SelectItem>
            {brokerConnections.map((conn) => (
              <SelectItem
                key={conn.id}
                value={`${conn.broker}:${conn.brokerUserId || ""}`}
              >
                <div className="flex items-center gap-2">
                  <BrokerLogo broker={conn.broker} size={16} />
                  <span>{conn.accountName || conn.broker}</span>
                </div>
              </SelectItem>
            ))}
            <SelectItem value="manual">
              <div className="flex items-center gap-2">
                <ManualEntryIcon size={16} />
                <span>Manual Entry</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.segment}
          onValueChange={(v) => onChange({ ...filters, segment: v })}
        >
          <SelectTrigger className="w-[160px] bg-white dark:bg-muted border-slate-300 dark:border-border">
            <SelectValue placeholder="Segment" />
          </SelectTrigger>
          <SelectContent className="bg-white dark:bg-muted border-slate-300 dark:border-border">
            <SelectItem value="all">All Segments</SelectItem>
            {Object.entries(SEGMENT_FILTER_OPTIONS).map(([code, info]) => (
              <SelectItem key={code} value={code}>
                {info.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {showType && (
          <Select
            value={filters.tradeType}
            onValueChange={(v) => onChange({ ...filters, tradeType: v })}
          >
            <SelectTrigger className="w-[110px] bg-white dark:bg-muted border-slate-300 dark:border-border">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent className="bg-white dark:bg-muted border-slate-300 dark:border-border">
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="BUY">Buy</SelectItem>
              <SelectItem value="SELL">Sell</SelectItem>
            </SelectContent>
          </Select>
        )}

        {showStatus && (
          <Select
            value={filters.status}
            onValueChange={(v) => onChange({ ...filters, status: v })}
          >
            <SelectTrigger className="w-[120px] bg-white dark:bg-muted border-slate-300 dark:border-border">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent className="bg-white dark:bg-muted border-slate-300 dark:border-border">
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="OPEN">Open</SelectItem>
              <SelectItem value="CLOSED">Closed</SelectItem>
              <SelectItem value="PARTIAL">Partial</SelectItem>
            </SelectContent>
          </Select>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="text-muted-foreground hover:text-slate-700"
        >
          <X className="h-4 w-4 mr-1" /> Clear
        </Button>
      </div>

      {/* Row 2: Date Range */}
      {showDateRange && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground/50 dark:text-muted-foreground">
              Date Range:
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {dateRangeOptions.map((option) => (
              <Button
                key={option.value}
                variant={
                  filters.dateRange === option.value ? "default" : "outline"
                }
                size="sm"
                onClick={() => handleDateRangeChange(option.value)}
                className={cn(
                  "text-xs h-8",
                  filters.dateRange === option.value
                    ? "bg-blue-600 text-white hover:bg-blue-700"
                    : "bg-white dark:bg-muted border-slate-300 dark:border-border text-slate-700 dark:text-foreground/80"
                )}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Custom Date Pickers */}
      {showDateRange && showCustomDates && (
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground/50 dark:text-muted-foreground">
              From:
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "w-[140px] justify-start text-left font-normal bg-white dark:bg-muted border-slate-300 dark:border-border",
                    !fromDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {fromDate ? format(fromDate, "dd/MM/yyyy") : "Pick date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto p-0 bg-white dark:bg-muted"
                align="start"
              >
                <CalendarWithYearNav
                  mode="single"
                  selected={fromDate}
                  onSelect={(d: Date | undefined) =>
                    handleCustomDateChange("from", d)
                  }
                  disabled={{ after: new Date() }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground/50 dark:text-muted-foreground">
              To:
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "w-[140px] justify-start text-left font-normal bg-white dark:bg-muted border-slate-300 dark:border-border",
                    !toDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {toDate ? format(toDate, "dd/MM/yyyy") : "Pick date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto p-0 bg-white dark:bg-muted"
                align="start"
              >
                <CalendarWithYearNav
                  mode="single"
                  selected={toDate}
                  onSelect={(d: Date | undefined) =>
                    handleCustomDateChange("to", d)
                  }
                  disabled={{ after: new Date() }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}
    </div>
  );
}
