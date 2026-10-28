import { PostsListComponent } from "../_components/posts/posts-list-component";

export const metadata = {
  title: "Scheduled Posts | UseMoney Content",
  description: "View and manage your scheduled posts",
};

export default function ScheduledPostsPage() {
  return (
    <PostsListComponent
      defaultStatusFilter="SCHEDULED"
      pageTitle="Scheduled Posts"
    />
  );
}
