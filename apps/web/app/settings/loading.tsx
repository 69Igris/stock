import { PageLoadingWrapper, SettingsSkeleton } from "@/components/skeletons";

export default function SettingsLoading() {
  return (
    <PageLoadingWrapper title="Settings" breadcrumb="Configuration">
      <SettingsSkeleton />
    </PageLoadingWrapper>
  );
}
