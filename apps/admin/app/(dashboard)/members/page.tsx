import { MembersClient } from "./client";

// User / member management (MONEY-412). Auth via middleware + each server
// action's requireAdmin().
export default function MembersPage() {
  return <MembersClient />;
}
