/**
 * Shared shape for the admin-users list. Lives in its own (non-"use server")
 * module so both the server action and the client component can import the type
 * without a "use server" file exporting a non-async member (Next forbids that).
 */
export interface AdminUser {
  email: string;
  isOwner: boolean;
}
