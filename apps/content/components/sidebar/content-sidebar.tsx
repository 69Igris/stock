"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FileText,
  FilePen,
  CheckCircle,
  Newspaper,
  BookOpen,
  Mail,
  Tags,
  Calendar,
  X,
  Lightbulb,
  FileQuestion,
  BarChart3,
  Users,
  Scale,
  UserCheck,
  Sparkles,
  Images,
  Clapperboard,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "All Posts", href: "/posts", icon: FileText },
  { name: "Drafts", href: "/drafts", icon: FilePen },
  { name: "Published", href: "/published", icon: CheckCircle },
];

const studioNavigation = [
  { name: "Studio", href: "/studio", icon: Sparkles },
  { name: "Image Studio", href: "/studio/image", icon: Images },
  { name: "Reel Studio", href: "/studio/reel", icon: Clapperboard },
  { name: "Library", href: "/studio/library", icon: FolderOpen },
];

const ideasNavigation = [
  { name: "All Ideas", href: "/ideas", icon: Lightbulb },
  { name: "New Ideas", href: "/ideas/new-status", icon: Lightbulb },
  { name: "In Progress", href: "/ideas/in-progress", icon: Lightbulb },
  { name: "Draft Created", href: "/ideas/draft-created", icon: Lightbulb },
  { name: "Archived", href: "/ideas/archived", icon: Lightbulb },
];

const usemoneyNavigation = [
  { name: "Blog Posts", href: "/usemoney/blog", icon: Newspaper },
  { name: "Glossary", href: "/usemoney/glossary", icon: BookOpen },
  { name: "Newsletter", href: "/usemoney/newsletter", icon: Mail },
  { name: "Docs", href: "/docs", icon: FileQuestion },
  { name: "Legal", href: "/legal", icon: Scale },
];

const otherNavigation = [
  { name: "Tags", href: "/tags", icon: Tags },
  { name: "Calendar", href: "/calendar", icon: Calendar },
  { name: "Analytics", href: "/analytics", icon: BarChart3 },
  { name: "Subscribers", href: "/subscribers", icon: UserCheck },
  { name: "Members", href: "/members", icon: Users },
];

interface ContentSidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function ContentSidebar({ isOpen, onClose }: ContentSidebarProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") {
      return pathname === "/";
    }
    return pathname.startsWith(href);
  };

  const NavItem = ({
    item,
  }: {
    item: { name: string; href: string; icon: React.ElementType };
  }) => {
    const active = isActive(item.href);

    return (
      <Link
        href={item.href}
        onClick={onClose}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
          active
            ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
            : "text-slate-300 hover:bg-slate-800 hover:text-white",
        )}
      >
        <item.icon
          className={cn("h-5 w-5", active ? "text-white" : "text-slate-400")}
        />
        {item.name}
      </Link>
    );
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 border-r border-slate-800 transform transition-transform duration-300 ease-in-out",
          "lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        {/* Logo Header */}
        <div className="flex h-16 items-center justify-between px-4 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <Image
              src="/icon.svg"
              alt="UseMoney"
              width={32}
              height={32}
              className="h-8 w-8 rounded-md"
            />
            <div>
              <h1 className="text-lg font-semibold text-white">UseMoney</h1>
              <p className="text-xs text-slate-400">Content CMS</p>
            </div>
          </div>

          {/* Close button for mobile */}
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex flex-col gap-1 p-3 overflow-y-auto h-[calc(100vh-8rem)]">
          {/* Main Navigation */}
          <p className="px-3 py-2 text-xs font-medium text-slate-500 uppercase tracking-wider">
            Content
          </p>
          {navigation.map((item) => (
            <NavItem key={item.name} item={item} />
          ))}

          {/* Studio Section */}
          <p className="px-3 py-2 mt-4 text-xs font-medium text-slate-500 uppercase tracking-wider">
            Studio
          </p>
          {studioNavigation.map((item) => (
            <NavItem key={item.name} item={item} />
          ))}

          {/* Ideas Section */}
          <p className="px-3 py-2 mt-4 text-xs font-medium text-slate-500 uppercase tracking-wider">
            Ideas
          </p>
          {ideasNavigation.map((item) => (
            <NavItem key={item.name} item={item} />
          ))}

          {/* UseMoney Section */}
          <p className="px-3 py-2 mt-4 text-xs font-medium text-slate-500 uppercase tracking-wider">
            UseMoney
          </p>
          {usemoneyNavigation.map((item) => (
            <NavItem key={item.name} item={item} />
          ))}

          {/* Other Navigation */}
          <p className="px-3 py-2 mt-4 text-xs font-medium text-slate-500 uppercase tracking-wider">
            Organize
          </p>
          {otherNavigation.map((item) => (
            <NavItem key={item.name} item={item} />
          ))}
        </nav>

        {/* Footer */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-slate-800">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800/50">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-slate-400">UseMoney Content</span>
          </div>
        </div>
      </aside>
    </>
  );
}
