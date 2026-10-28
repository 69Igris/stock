import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StrategyDetailRedirect(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  // Per cycle-6 user direction - all strategy tabs live on /strategies as a
  // single state machine. Deep links land on the right tab.
  redirect(`/strategies?tab=detail&id=${encodeURIComponent(params.id)}`);
}
