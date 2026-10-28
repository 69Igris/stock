"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useChatContext } from "@/lib/chat/ChatContext";
import { getBrokerConnectionsAction } from "@/lib/actions/broker-connection";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { Layers, Link2, Plus } from "lucide-react";

// ============== Component ==============

interface BrokerOption {
  value: string;
  label: string;
  brokerId: string;
  brokerName: string;
}

export default function ChatContextSelector() {
  const router = useRouter();
  const { selectedContext, setContext } = useChatContext();
  const [brokerOptions, setBrokerOptions] = useState<BrokerOption[]>([]);

  // Fetch connected brokers
  useEffect(() => {
    getBrokerConnectionsAction()
      .then((result) => {
        if (result?.success && result?.data) {
          const connected = result?.data
            .filter((b) => b.status === "CONNECTED")
            .map((b) => ({
              value: `broker:${b.id}`,
              label: b.accountName || b.broker,
              brokerId: b.id,
              brokerName: b.broker,
            }));
          setBrokerOptions(connected);
        }
      })
      .catch(() => {
        // Silently fail - just show "All Brokers"
      });
  }, []);

  // Broker value
  const brokerValue =
    typeof selectedContext === "object" && selectedContext.type === "broker"
      ? `broker:${selectedContext.brokerId}`
      : "all";

  const handleBrokerChange = (value: string) => {
    if (value === "__connect_new__") {
      router.push("/brokers");
      return;
    }
    if (value === "all") {
      setContext("all");
    } else {
      const broker = brokerOptions.find((o) => o.value === value);
      if (broker) {
        setContext({
          type: "broker",
          brokerId: broker.brokerId,
          brokerName: broker.brokerName,
        });
      }
    }
  };

  // Display label for selected broker
  const brokerLabel =
    brokerValue === "all"
      ? "All Brokers"
      : brokerOptions.find((o) => o.value === brokerValue)?.label || "Broker";

  return (
    <div className="flex items-center gap-2">
      {/* Broker Selector */}
      <Select value={brokerValue} onValueChange={handleBrokerChange}>
        <SelectTrigger
          className="h-7 w-auto min-w-[110px] text-xs rounded-full px-3 border-[1.5px] border-[var(--ink)]"
          style={{ background: "var(--paper)" }}
        >
          <SelectValue>
            <div className="flex items-center gap-1.5">
              <Layers className="h-3 w-3" />
              <span className="text-[var(--ink-2)]">{brokerLabel}</span>
            </div>
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          className="border-[1.5px] border-[var(--ink)]"
          style={{ background: "var(--paper)" }}
        >
          <SelectItem value="all">
            <div className="flex items-center gap-2">
              <Layers className="h-3 w-3" />
              <span>All Brokers</span>
            </div>
          </SelectItem>
          {brokerOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <div className="flex items-center gap-2">
                <Link2 className="h-3 w-3" />
                <span>{option.label}</span>
              </div>
            </SelectItem>
          ))}
          <SelectItem value="__connect_new__">
            <div className="flex items-center gap-2 text-[var(--accent-primary)]">
              <Plus className="h-3 w-3" />
              <span>Connect New Broker</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
