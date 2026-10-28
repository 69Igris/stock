import Image from "next/image";
import { listStudioGenerations } from "@/lib/actions/studio";

export const dynamic = "force-dynamic";

export default async function StudioLibraryPage() {
  const items = await listStudioGenerations();

  return (
    <div className="mx-auto max-w-6xl p-8">
      <h1 className="text-2xl font-bold text-neutral-900">🗂️ Studio Library</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Your generated images and reels, newest first. Generated from Image
        Studio and Reel Studio.
      </p>

      {items.length === 0 ? (
        <p className="mt-10 text-sm text-neutral-500">
          Nothing yet — generate an image in Image Studio or render a reel in
          Reel Studio and it&apos;ll show up here.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((g) => (
            <a
              key={g.id}
              href={g.url}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl border-2 border-neutral-900 bg-white p-2 shadow-[2px_2px_0_0_#1d1d1b] transition-transform hover:-translate-y-0.5"
            >
              <div className="relative aspect-square overflow-hidden rounded-lg bg-neutral-100">
                {g.kind === "reel" ? (
                  <video
                    src={g.url}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <Image
                    src={g.url}
                    alt={g.prompt ?? "Generated image"}
                    fill
                    sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                    className="object-cover"
                  />
                )}
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-500">
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium uppercase">
                  {g.kind}
                </span>
                <time dateTime={g.createdAt}>
                  {new Date(g.createdAt).toLocaleDateString()}
                </time>
              </div>
              {g.prompt && (
                <p className="mt-1 line-clamp-2 text-xs text-neutral-700">
                  {g.prompt}
                </p>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
