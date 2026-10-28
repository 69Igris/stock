"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { Menu, Plus } from "lucide-react";

interface HeaderProps {
  onMenuClick?: () => void;
}

const pageTitles: Record<string, string> = {
  "/": "Dashboard",
  "/posts": "All Posts",
  "/drafts": "Drafts",
  "/published": "Published",
  "/usemoney/blog": "Blog Posts",
  "/usemoney/glossary": "Glossary",
  "/usemoney/newsletter": "Newsletter",
  "/tags": "Tags",
  "/tags/new-tag": "New Tag",
  "/calendar": "Calendar",
  "/new-post": "New Post",
};

function getPageTitle(pathname: string): string {
  // Check for exact match first
  if (pageTitles[pathname]) {
    return pageTitles[pathname];
  }

  // Check for dynamic tag edit route
  if (pathname.startsWith("/tags/") && pathname !== "/tags/new-tag") {
    return "Edit Tag";
  }

  // Check for partial matches (for nested routes)
  for (const [path, title] of Object.entries(pageTitles)) {
    if (path !== "/" && pathname.startsWith(path)) {
      return title;
    }
  }

  return "Content CMS";
}

export function Header({ onMenuClick }: HeaderProps) {
  const pathname = usePathname();
  const pageTitle = getPageTitle(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-800 bg-slate-900/95 backdrop-blur supports-[backdrop-filter]:bg-slate-900/60 px-4 lg:px-6">
      <div className="flex items-center gap-3">
        {/* Mobile menu button */}
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h2 className="text-lg font-semibold text-white">{pageTitle}</h2>
      </div>

      <div className="flex items-center gap-3">
        <Link
          href="/new-post"
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New Post</span>
        </Link>

        {/* Clerk v7 removed `afterSignOutUrl` from <UserButton>; the
            destination is now configured on <ClerkProvider> (app/layout.tsx). */}
        <UserButton
          appearance={{
            elements: {
              avatarBox: "h-9 w-9",
            },
          }}
        />
      </div>
    </header>
  );
}
