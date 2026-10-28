import { IdeaFullPageEditor } from "@/components/ideas";

export default async function IdeaPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { id } = params;

  return (
    <div className="h-[calc(100vh-4rem)]">
      <IdeaFullPageEditor ideaId={id} />
    </div>
  );
}
