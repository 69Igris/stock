"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderOpen,
  Users,
  Settings,
  BookOpen,
  Wand2,
  Tag,
  Link2,
  Receipt,
  ScrollText,
  CreditCard,
  UserCog,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@usemoney/utils";
import { navItems, isNavItemActive } from "./sidebar-nav";

// Icon per nav route, keyed by the shared metadata's `name`.
const navIcons: Record<string, LucideIcon> = {
  Dashboard: LayoutDashboard,
  Courses: BookOpen,
  "Content Creator": Wand2,
  "Content Library": FolderOpen,
  Coupons: Tag,
  "Invite Links": Link2,
  "GST Invoices": Receipt,
  "Audit Logs": ScrollText,
  Payments: CreditCard,
  Members: UserCog,
  "Admin Users": Users,
  Settings: Settings,
};

const navigation = navItems.map((item) => ({
  ...item,
  icon: navIcons[item.name],
}));

interface SidebarProps {
  isOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const pathname = usePathname();

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
              <p className="text-xs text-slate-400">Admin Panel</p>
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
        <nav className="flex flex-col gap-1 p-3">
          <p className="px-3 py-2 text-xs font-medium text-slate-500 uppercase tracking-wider">
            Menu
          </p>
          {navigation.map((item) => {
            const isActive = isNavItemActive(pathname, item.href);

            return (
              <Link
                key={item.name}
                href={item.href}
                onClick={onClose}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-blue-600 text-white shadow-lg shadow-blue-600/20"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white",
                )}
              >
                <item.icon
                  className={cn(
                    "h-5 w-5",
                    isActive ? "text-white" : "text-slate-400",
                  )}
                />
                {item.name}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-slate-800">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800/50">
            <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-slate-400">System Online</span>
          </div>
        </div>
      </aside>
    </>
  );
}
