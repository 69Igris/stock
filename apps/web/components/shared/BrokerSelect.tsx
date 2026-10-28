"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

interface BrokerConnection {
  id: string;
  brokerId: string;
  customName: string;
  brokerName: string;
  logo: string;
}

const BROKER_LOGOS: Record<string, string> = {
  ZERODHA: "/brokers/zerodha.png",
  UPSTOX: "/brokers/upstox.png",
  FYERS: "/brokers/fyers.png",
  DHAN: "/brokers/dhan.png",
  ANGEL_ONE: "/brokers/angel.png",
  GROWW: "/brokers/groww.png",
  ICICI: "/brokers/icici.png",
  HDFC: "/brokers/hdfc.png",
  MANUAL: "",
};

export function BrokerLogo({
  broker,
  size = 16,
}: {
  broker: string;
  size?: number;
}) {
  const logoPath = BROKER_LOGOS[broker.toUpperCase()];
  if (!logoPath) {
    return <span>📝</span>;
  }
  return (
    <Image
      src={logoPath}
      alt={broker}
      width={size}
      height={size}
      className="rounded-sm object-contain"
    />
  );
}

interface BrokerSelectProps {
  value: string;
  onChange: (value: string, customName?: string) => void;
  label?: string;
  showManualOption?: boolean;
  className?: string;
}

export function BrokerSelect({
  value,
  onChange,
  label = "Broker",
  showManualOption = true,
  className,
}: BrokerSelectProps) {
  const [connections, setConnections] = useState<BrokerConnection[]>([]);
  const [isManual, setIsManual] = useState(false);
  const [manualName, setManualName] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("tradebook_broker_connections");
    if (saved) {
      try {
        setConnections(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse saved connections");
      }
    }
  }, []);

  const handleChange = (selectedValue: string) => {
    if (selectedValue === "MANUAL") {
      setIsManual(true);
      onChange("MANUAL", "");
    } else {
      setIsManual(false);
      const connection = connections.find((c) => c.id === selectedValue);
      onChange(selectedValue, connection?.customName);
    }
  };

  const handleManualChange = (name: string) => {
    setManualName(name);
    onChange("MANUAL", name);
  };

  return (
    <div className={className}>
      {label && (
        <Label className="text-foreground/80 mb-2 block">{label}</Label>
      )}
      <Select value={value} onValueChange={handleChange}>
        <SelectTrigger className="bg-muted border-border text-foreground">
          <SelectValue placeholder="Select broker account" />
        </SelectTrigger>
        <SelectContent className="bg-muted border-border">
          {connections.map((conn) => (
            <SelectItem key={conn.id} value={conn.id}>
              <div className="flex items-center gap-2">
                <BrokerLogo broker={conn.brokerName} size={16} />
                <span>{conn.customName}</span>
                <span className="text-xs text-muted-foreground">
                  ({conn.brokerName})
                </span>
              </div>
            </SelectItem>
          ))}
          {showManualOption && (
            <SelectItem value="MANUAL">
              <div className="flex items-center gap-2">
                <span>📝</span>
                <span>Manual Entry</span>
              </div>
            </SelectItem>
          )}
        </SelectContent>
      </Select>

      {isManual && (
        <Input
          className="mt-2 bg-muted border-border text-foreground"
          placeholder="Enter broker name (e.g., Zerodha, Angel One)"
          value={manualName}
          onChange={(e) => handleManualChange(e.target.value)}
        />
      )}
    </div>
  );
}

interface BrokerBadgeProps {
  brokerId?: string;
  customName?: string;
  brokerName?: string;
  className?: string;
}

export function BrokerBadge({
  brokerId,
  customName,
  brokerName,
  className,
}: BrokerBadgeProps) {
  const [connections, setConnections] = useState<BrokerConnection[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem("tradebook_broker_connections");
    if (saved) {
      try {
        setConnections(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse saved connections");
      }
    }
  }, []);

  // Find connection by ID
  const connection = brokerId
    ? connections.find((c) => c.id === brokerId)
    : null;

  // Determine display values
  const displayName =
    customName || connection?.customName || brokerName || "Manual";
  const brokerKey = connection?.brokerName || brokerName || "";

  return (
    <Badge
      variant="outline"
      className={`border-border text-foreground/80 ${className}`}
    >
      <span className="mr-1 flex items-center">
        <BrokerLogo broker={brokerKey} size={14} />
      </span>
      {displayName}
    </Badge>
  );
}

// Get all connected brokers for dropdowns
export function useConnectedBrokers() {
  const [connections, setConnections] = useState<BrokerConnection[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem("tradebook_broker_connections");
    if (saved) {
      try {
        setConnections(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse saved connections");
      }
    }
  }, []);

  return connections;
}
