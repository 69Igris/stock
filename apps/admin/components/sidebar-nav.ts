/**
 * Pure sidebar navigation metadata + active-route logic for the admin sidebar
 * (apps/admin/components/sidebar.tsx).
 *
 * The route list (name + href) and the `isActive` predicate are extracted here
 * so they can be unit tested without importing the "use client" component (and
 * its lucide-react icons / next/navigation hooks). The sidebar pairs this
 * metadata with an icon map and calls `isNavItemActive` for highlighting.
 *
 * @see apps/admin/__tests__/components/sidebar.test.ts
 */

export interface NavItem {
  name: string;
  href: string;
}

/**
 * Ordered admin sidebar routes. Single source of truth for the nav structure;
 * the sidebar component attaches an icon to each by `name`.
 */
export const navItems: readonly NavItem[] = [
  { name: "Dashboard", href: "/" },
  { name: "Courses", href: "/courses" },
  { name: "Content Creator", href: "/content/create" },
  { name: "Content Library", href: "/content" },
  { name: "Coupons", href: "/coupons" },
  { name: "Invite Links", href: "/invites" },
  { name: "GST Invoices", href: "/gst/invoices" },
  { name: "Audit Logs", href: "/audit-logs" },
  { name: "Payments", href: "/payments" },
  { name: "Members", href: "/members" },
  { name: "Admin Users", href: "/users" },
  { name: "Settings", href: "/settings" },
];

/**
 * Determines whether a nav item is active for the current pathname.
 * Mirrors the sidebar's highlight rule:
 *   pathname === href || (href !== "/" && pathname.startsWith(href))
 * The `href !== "/"` guard prevents the Dashboard root from matching every path.
 */
export function isNavItemActive(pathname: string, itemHref: string): boolean {
  return (
    pathname === itemHref || (itemHref !== "/" && pathname.startsWith(itemHref))
  );
}

/**
 * Returns the first nav item active for the given pathname, or undefined.
 */
export function findActiveNavItem(pathname: string): NavItem | undefined {
  return navItems.find((item) => isNavItemActive(pathname, item.href));
}
