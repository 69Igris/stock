import { AuditLogsClient } from "./client";

// Audit-trail viewers (MONEY-583): broker failures + consent records + sync
// logs. Auth is enforced by the admin middleware and each server action's
// requireAdmin(); data loads client-side per tab.
export default function AuditLogsPage() {
  return <AuditLogsClient />;
}
