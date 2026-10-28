import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function StrategyBacktestRedirect(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  redirect(`/strategies?tab=backtest&id=${encodeURIComponent(params.id)}`);
}
