export const dynamic = "force-dynamic";

import { isDemoSession } from "@/lib/demo/session";
import StockSagePageClient from "./client";

// StockSage (the AI chat surface) has its own route + client so the sidebar
// marks it active, it gets a chat-shaped loading skeleton, and chat navigation
// (new chat, open past chat, delete) no longer falls back to the dashboard
// overview. The portfolio overview lives at /dashboard.
export default async function StockSagePage() {
  const isDemo = await isDemoSession();

  return <StockSagePageClient isDemo={isDemo} />;
}
