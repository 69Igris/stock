import Link from "next/link";
import { Plus, Tags as TagsIcon } from "lucide-react";
import { listTags } from "@/lib/actions/tags";
import { TagCard } from "@/components/tags";
import { Button } from "@usemoney/ui/button";

export const dynamic = "force-dynamic";

export default async function TagsPage() {
  const result = await listTags();

  if (!result.success) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="p-8 rounded-xl bg-red-500/10 border border-red-500/20 text-center">
          <p className="text-red-400">Failed to load tags: {result.error}</p>
        </div>
      </div>
    );
  }

  const tags = result.data || [];

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Tags</h1>
          <p className="text-slate-400 mt-1">
            Organize your content with tags. {tags.length}{" "}
            {tags.length === 1 ? "tag" : "tags"} total.
          </p>
        </div>
        <Link href="/tags/new-tag">
          <Button className="bg-blue-600 hover:bg-blue-700 text-white">
            <Plus className="h-4 w-4 mr-2" />
            New Tag
          </Button>
        </Link>
      </div>

      {/* Quick Stats - at the top */}
      {tags.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/30">
            <p className="text-2xl font-bold text-white">{tags.length}</p>
            <p className="text-sm text-slate-400">Total Tags</p>
          </div>
          <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/30">
            <p className="text-2xl font-bold text-white">
              {tags.reduce((sum, tag) => sum + tag._count.posts, 0)}
            </p>
            <p className="text-sm text-slate-400">Tagged Posts</p>
          </div>
          <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/30">
            <p className="text-2xl font-bold text-white">
              {tags.filter((tag) => tag._count.posts > 0).length}
            </p>
            <p className="text-sm text-slate-400">Tags in Use</p>
          </div>
          <div className="p-4 rounded-xl border border-slate-800 bg-slate-900/30">
            <p className="text-2xl font-bold text-white">
              {tags.filter((tag) => tag._count.posts === 0).length}
            </p>
            <p className="text-sm text-slate-400">Unused Tags</p>
          </div>
        </div>
      )}

      {/* Tags Grid */}
      {tags.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 rounded-xl border border-slate-800 bg-slate-900/30">
          <div className="p-4 rounded-full bg-slate-800/50 mb-4">
            <TagsIcon className="h-8 w-8 text-slate-500" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No tags yet</h3>
          <p className="text-slate-400 text-center max-w-md mb-6">
            Tags help you organize your content. Create your first tag to get
            started.
          </p>
          <Link href="/tags/new-tag">
            <Button className="bg-blue-600 hover:bg-blue-700 text-white">
              <Plus className="h-4 w-4 mr-2" />
              Create your first tag
            </Button>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {tags.map((tag) => (
            <TagCard key={tag.id} tag={tag} />
          ))}
        </div>
      )}
    </div>
  );
}
