"use client";

import { useState } from "react";
import { Users, UserPlus, Shield, Mail, Trash2 } from "lucide-react";
import type { AdminUser } from "@/lib/actions/admins-types";

/**
 * Admin-users UI. The list of administrators is passed in from the server
 * component (`getAdminUsers`) — it is NOT hardcoded in the client bundle
 * (MONEY-703).
 */
export function AdminUsersClient({ admins }: { admins: AdminUser[] }) {
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleInviteAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!email || !email.includes("@")) {
      setError("Please enter a valid email address");
      return;
    }

    setInviting(true);

    try {
      const response = await fetch("/api/admin/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to invite admin");
      }

      setSuccess(`Invitation sent to ${email}`);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite admin");
    } finally {
      setInviting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Admin Users</h1>
        <p className="text-muted-foreground mt-1">
          Manage administrators who can access this panel
        </p>
      </div>

      {/* Invite Admin Form */}
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 rounded-lg bg-primary/10">
            <UserPlus className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Invite Admin</h2>
            <p className="text-sm text-muted-foreground">
              Add a new administrator by email
            </p>
          </div>
        </div>

        <form onSubmit={handleInviteAdmin} className="flex gap-4">
          <div className="flex-1">
            <input
              type="email"
              placeholder="Enter email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 rounded-lg border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <button
            type="submit"
            disabled={inviting}
            className="px-6 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {inviting ? "Inviting..." : "Send Invite"}
          </button>
        </form>

        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
        {success && <p className="mt-3 text-sm text-green-500">{success}</p>}
      </div>

      {/* Current Admins */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center gap-3 p-6 border-b">
          <div className="p-2 rounded-lg bg-purple-500/10">
            <Users className="h-5 w-5 text-purple-500" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Current Administrators</h2>
            <p className="text-sm text-muted-foreground">
              {admins.length} admin{admins.length !== 1 ? "s" : ""} with access
            </p>
          </div>
        </div>

        <div className="divide-y">
          {admins.map((admin) => (
            <div
              key={admin.email}
              className="flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-sm font-medium text-primary">
                    {admin.email.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{admin.email}</p>
                    {admin.isOwner && (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                        Owner
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <Shield className="h-3 w-3" />
                    <span>Full admin access</span>
                  </div>
                </div>
              </div>

              {!admin.isOwner && (
                <button className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Info Card */}
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-4">
        <div className="flex gap-3">
          <Mail className="h-5 w-5 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-blue-500">How admin invites work</p>
            <p className="text-muted-foreground mt-1">
              When you invite someone, they&apos;ll receive an email with
              instructions to access the admin panel. They must sign in with the
              exact email address you invited, or have the &quot;admin&quot;
              role set in their Clerk metadata.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
