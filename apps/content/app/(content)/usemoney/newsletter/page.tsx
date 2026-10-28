import { PostsListComponent } from "../../_components/posts/posts-list-component";

export const metadata = {
  title: "Newsletters | UseMoney Content",
  description: "View and manage newsletters",
};

export default function NewsletterPage() {
  return (
    <PostsListComponent
      defaultContentTypeFilter="NEWSLETTER"
      pageTitle="Newsletters"
    />
  );
}
