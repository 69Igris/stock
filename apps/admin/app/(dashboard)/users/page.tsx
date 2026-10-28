import { getAdminUsers } from "@/lib/actions/admins";
import { AdminUsersClient } from "@/components/admin-users-client";

// Server component: resolves the admin allowlist server-side (MONEY-703) so the
// list never ships in the client bundle, then renders the client UI.
export default async function AdminUsersPage() {
  const admins = await getAdminUsers();
  return <AdminUsersClient admins={admins} />;
}
