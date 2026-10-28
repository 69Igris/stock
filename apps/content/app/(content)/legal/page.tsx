import { PostsListComponent } from "../_components/posts/posts-list-component";

export const metadata = {
  title: "Legal | UseMoney Content",
  description: "View and manage legal pages",
};

export default function LegalPage() {
  return (
    <PostsListComponent
      defaultContentTypeFilter="LEGAL"
      pageTitle="Legal Pages"
    />
  );
}
