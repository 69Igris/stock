import {
  PageLoadingWrapper,
  ChatHistorySkeleton,
} from "@/components/skeletons";

export default function ChatHistoryLoading() {
  return (
    <PageLoadingWrapper title="Chat History">
      <ChatHistorySkeleton />
    </PageLoadingWrapper>
  );
}
