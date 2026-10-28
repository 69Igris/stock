// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import ImportHistoryClient from "./client";

export const metadata = {
  title: "Import History",
  description: "View your trade import history",
};

export default async function ImportHistoryPage() {
  return <ImportHistoryClient />;
}
