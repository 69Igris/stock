"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { isPublicShellRoute } from "@/components/Sidebar";

interface SidebarContextValue {
  collapsed: boolean;
  toggleSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextValue>({
  collapsed: false,
  toggleSidebar: () => {},
});

export function useSidebar() {
  return useContext(SidebarContext);
}

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days = 365) {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const isPublic = isPublicShellRoute(pathname);

  useEffect(() => {
    const saved = getCookie("sidebar_collapsed");
    if (saved === "true") setCollapsed(true);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    setCookie("sidebar_collapsed", String(collapsed));
  }, [collapsed, mounted]);

  // Set CSS variables - zero on public pages, sidebar width on app pages
  useEffect(() => {
    if (isPublic) {
      document.documentElement.style.setProperty("--sidebar-w", "0px");
      document.documentElement.style.setProperty("--topbar-h", "0px");
    } else {
      document.documentElement.style.setProperty(
        "--sidebar-w",
        collapsed ? "4rem" : "16rem"
      );
      document.documentElement.style.setProperty("--topbar-h", "4.75rem");
    }
  }, [collapsed, isPublic]);

  const toggleSidebar = useCallback(() => setCollapsed((c) => !c), []);

  // Keyboard shortcut: Cmd+B / Ctrl+B
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <SidebarContext.Provider value={{ collapsed, toggleSidebar }}>
      {children}
    </SidebarContext.Provider>
  );
}
