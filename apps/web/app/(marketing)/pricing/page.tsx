import type { Metadata } from "next";
import PricingClient from "./client";

export const metadata: Metadata = {
  title: "Pricing — UseMoney AI",
  description:
    "Free forever. PRO ₹249/month or ₹1,999/year. Premium ₹1,499/month or ₹14,990/year. Credit packs that never expire. Built for Indian retail investors.",
};

export default function PricingPage() {
  return <PricingClient />;
}
