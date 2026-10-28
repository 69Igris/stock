import { PostsListComponent } from "../../_components/posts/posts-list-component";

export const metadata = {
  title: "Glossary Terms | UseMoney Content",
  description: "View and manage glossary terms",
};

export default function GlossaryPage() {
  return (
    <PostsListComponent
      defaultContentTypeFilter="GLOSSARY"
      pageTitle="Glossary Terms"
    />
  );
}
