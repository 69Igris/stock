"use client";

import { createReactBlockSpec } from "@blocknote/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@usemoney/ui/alert-dialog";
import { Button } from "@usemoney/ui/button";
import { Input } from "@usemoney/ui/input";

/**
 * Convert a YouTube watch/short URL into an embed URL.
 * If already an embed URL or unrecognised, returns the input unchanged.
 */
function toEmbedUrl(raw: string): string {
  const url = raw.trim();
  // Already embed format
  if (url.includes("/embed/")) return url;

  // Standard watch URL: youtube.com/watch?v=VIDEO_ID
  const watchMatch = url.match(/(?:youtube\.com\/watch\?v=)([^&\n?#]+)/);
  if (watchMatch?.[1]) {
    return `https://www.youtube.com/embed/${watchMatch[1]}`;
  }

  // Short URL: youtu.be/VIDEO_ID
  const shortMatch = url.match(/youtu\.be\/([^&\n?#]+)/);
  if (shortMatch?.[1]) {
    return `https://www.youtube.com/embed/${shortMatch[1]}`;
  }

  // Shorts URL: youtube.com/shorts/VIDEO_ID
  const shortsMatch = url.match(/youtube\.com\/shorts\/([^&\n?#]+)/);
  if (shortsMatch?.[1]) {
    return `https://www.youtube.com/embed/${shortsMatch[1]}`;
  }

  return url;
}

export const Youtube = createReactBlockSpec(
  {
    type: "youtube" as const,
    propSchema: {
      url: {
        default: "" as const,
      },
    },
    content: "none" as const,
  },
  {
    render: (props) => {
      let url = "";
      return (
        <div
          className={
            !props.block.props.url
              ? "rounded-md w-full justify-center bg-neutral-200 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300"
              : "relative w-full aspect-video"
          }
        >
          {props.block.props.url ? (
            <iframe
              src={props.block.props.url}
              title="YouTube video player"
              className="absolute top-0 left-0 w-full h-full rounded-md shadow-md"
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope;"
              allowFullScreen
            />
          ) : (
            <AlertDialog>
              <AlertDialogTrigger className="w-full">
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full justify-start gap-x-2"
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5 fill-red-600">
                    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z" />
                    <path
                      d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z"
                      className="fill-white"
                    />
                  </svg>
                  Add YouTube Video
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Embed YouTube Video</AlertDialogTitle>
                  <AlertDialogDescription>
                    <Input
                      type="text"
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="mt-2"
                      onChange={(e) => {
                        url = e.currentTarget.value;
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (url.trim()) {
                            props.editor.updateBlock(props.block, {
                              type: "youtube",
                              props: { url: toEmbedUrl(url) },
                            });
                          }
                        }
                      }}
                      autoFocus
                    />
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      if (url.trim()) {
                        props.editor.updateBlock(props.block, {
                          type: "youtube",
                          props: { url: toEmbedUrl(url) },
                        });
                      }
                    }}
                  >
                    Embed
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      );
    },
  },
);
