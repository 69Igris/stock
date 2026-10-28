// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import InvestorProfileEditor from "./client";

export const metadata = {
  title: "Investor Profile",
  description:
    "Edit your experience level, goals, risk tolerance and investor style.",
};

export default function InvestorProfilePage() {
  return <InvestorProfileEditor />;
}
