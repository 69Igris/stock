import type { Metadata } from "next";
import IntegrationsClient from "./client";

export const metadata: Metadata = {
  title: "Integrations — Brokers, exchanges, and mutual funds | UseMoney AI",
  description:
    "8 broker integrations, NSE + BSE market data, 14,000+ mutual funds. All read-only OAuth. The foundation that makes StockSage AI know your real portfolio.",
};

export default function IntegrationsPage() {
  return <IntegrationsClient />;
}
