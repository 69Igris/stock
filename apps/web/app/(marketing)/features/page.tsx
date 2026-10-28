import type { Metadata } from "next";
import FeaturesClient from "./client";

export const metadata: Metadata = {
  title: "Features — UseMoney AI",
  description:
    "Three layers: AI research on your real holdings, multi-broker portfolio foundation, and an institutional screener with walk-forward backtesting. Built for Indian retail investors.",
};

export default function FeaturesPage() {
  return <FeaturesClient />;
}
