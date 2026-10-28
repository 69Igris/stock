import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import NotificationsClient from "./client";
import NotificationsBodySkeleton from "./NotificationsBodySkeleton";
import { getNotificationsAction } from "@/lib/actions/notifications";

export const metadata = {
  title: "Notifications",
  description:
    "All your portfolio alerts, broker updates, news catalysts, and system messages in one feed.",
};

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const result = await getNotificationsAction(50, 0);
  const items = result?.success ? (result.data ?? []) : [];

  return (
    <PageGuard
      route="/discover"
      title="Notifications"
      breadcrumb="Account"
      fallback={<NotificationsBodySkeleton />}
      containerClassName="px-4 sm:px-6 py-5 max-w-[1200px] mx-auto pb-24"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="px-4 sm:px-6 py-5 max-w-[1200px] mx-auto pb-24">
            <NotificationsClient initial={items} />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}
