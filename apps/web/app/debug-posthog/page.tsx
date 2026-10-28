import { redirect } from "next/navigation";
import { isAdmin, isDebugEnabled } from "@usemoney/auth";
import PostHogDebugClient from "./client";

export default async function PostHogDebugPage() {
  // Check if debug features are enabled
  if (!isDebugEnabled()) {
    redirect("/dashboard");
  }

  // Check if user is admin
  const admin = await isAdmin();

  if (!admin) {
    redirect("/dashboard");
  }

  return <PostHogDebugClient />;
}
