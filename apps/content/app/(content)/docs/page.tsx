import { PostsListComponent } from "../_components/posts/posts-list-component";

export const metadata = {
  title: "Documentation | UseMoney Content",
  description: "View and manage documentation pages",
};

export default function DocsPage() {
  return (
    <PostsListComponent
      defaultContentTypeFilter="DOCS"
      pageTitle="Documentation"
    />
  );
}
