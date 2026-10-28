import { PostsListComponent } from "../../_components/posts/posts-list-component";

export const metadata = {
  title: "Blog Posts | UseMoney Content",
  description: "View and manage blog posts",
};

export default function BlogPage() {
  return (
    <PostsListComponent
      defaultContentTypeFilter="BLOG"
      pageTitle="Blog Posts"
    />
  );
}
