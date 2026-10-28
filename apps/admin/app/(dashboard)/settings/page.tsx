"use client";

import {
  Settings,
  Database,
  Bell,
  Shield,
  Globe,
  CreditCard,
  ExternalLink,
} from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Configure admin panel settings
        </p>
      </div>

      <div className="grid gap-6">
        {/* Subscription Settings */}
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-purple-500/10">
              <CreditCard className="h-5 w-5 text-purple-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Subscription Settings</h2>
              <p className="text-sm text-muted-foreground">
                Plan billing modes are managed via PostHog feature flags
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium">Billing Variant Flags</p>
                <p className="text-sm text-muted-foreground">
                  PRO annual, PRO monthly, Premium annual, and Ultimate plan
                  availability are controlled by PostHog feature flags.
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  Flags: <code>pro_annual</code>, <code>pro_monthly</code>,{" "}
                  <code>premium_annual</code>, <code>ultimate_plan</code>
                </p>
              </div>
              <a
                href="https://us.posthog.com/feature_flags"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Manage in PostHog <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>

        {/* General Settings */}
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-primary/10">
              <Settings className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">General Settings</h2>
              <p className="text-sm text-muted-foreground">
                Basic configuration options
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b">
              <div>
                <p className="font-medium">Site Name</p>
                <p className="text-sm text-muted-foreground">
                  The name displayed in the admin panel
                </p>
              </div>
              <input
                type="text"
                defaultValue="UseMoney"
                className="px-3 py-1.5 rounded-lg border bg-background text-sm w-48"
              />
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium">Default Theme</p>
                <p className="text-sm text-muted-foreground">
                  Choose the default color theme
                </p>
              </div>
              <select className="px-3 py-1.5 rounded-lg border bg-background text-sm w-48">
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </select>
            </div>
          </div>
        </div>

        {/* Database Settings */}
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-green-500/10">
              <Database className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Database</h2>
              <p className="text-sm text-muted-foreground">
                Database connection status
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b">
              <div>
                <p className="font-medium">Connection Status</p>
                <p className="text-sm text-muted-foreground">
                  Current database connection state
                </p>
              </div>
              <span className="flex items-center gap-2 text-sm">
                <span className="h-2 w-2 rounded-full bg-green-500" />
                Connected
              </span>
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium">Database Type</p>
                <p className="text-sm text-muted-foreground">
                  The database provider being used
                </p>
              </div>
              <span className="text-sm text-muted-foreground">MongoDB</span>
            </div>
          </div>
        </div>

        {/* Notification Settings */}
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Bell className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Notifications</h2>
              <p className="text-sm text-muted-foreground">
                Configure notification preferences
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b">
              <div>
                <p className="font-medium">Email Notifications</p>
                <p className="text-sm text-muted-foreground">
                  Receive email updates for important events
                </p>
              </div>
              <button className="relative h-6 w-11 rounded-full bg-primary transition-colors">
                <span className="absolute right-1 top-1 h-4 w-4 rounded-full bg-white transition-transform" />
              </button>
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium">Content Alerts</p>
                <p className="text-sm text-muted-foreground">
                  Get notified when new content is uploaded
                </p>
              </div>
              <button className="relative h-6 w-11 rounded-full bg-muted transition-colors">
                <span className="absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform" />
              </button>
            </div>
          </div>
        </div>

        {/* Security Settings */}
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2 rounded-lg bg-red-500/10">
              <Shield className="h-5 w-5 text-red-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Security</h2>
              <p className="text-sm text-muted-foreground">
                Security and access control settings
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between py-3 border-b">
              <div>
                <p className="font-medium">Two-Factor Authentication</p>
                <p className="text-sm text-muted-foreground">
                  Managed through Clerk authentication
                </p>
              </div>
              <a
                href="https://dashboard.clerk.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
              >
                Manage in Clerk
              </a>
            </div>

            <div className="flex items-center justify-between py-3">
              <div>
                <p className="font-medium">Session Timeout</p>
                <p className="text-sm text-muted-foreground">
                  Auto-logout after inactivity period
                </p>
              </div>
              <select className="px-3 py-1.5 rounded-lg border bg-background text-sm w-48">
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
                <option value="240">4 hours</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
