import {
  Upload,
  FolderOpen,
  Users,
  BookOpen,
  TrendingUp,
  FileText,
} from "lucide-react";

export default function AdminDashboardPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">
          Welcome to UseMoney Admin Panel
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-blue-500/10">
              <FileText className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Content</p>
              <p className="text-2xl font-bold">0</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-green-500/10">
              <BookOpen className="h-6 w-6 text-green-500" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Learning Paths</p>
              <p className="text-2xl font-bold">0</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-purple-500/10">
              <Users className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Admin Users</p>
              <p className="text-2xl font-bold">1</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-lg bg-orange-500/10">
              <TrendingUp className="h-6 w-6 text-orange-500" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Active Users</p>
              <p className="text-2xl font-bold">0</p>
            </div>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <a
            href="/content"
            className="rounded-lg border bg-card p-6 hover:border-primary transition-colors"
          >
            <Upload className="h-8 w-8 text-primary mb-4" />
            <h3 className="text-lg font-semibold mb-2">Upload Content</h3>
            <p className="text-sm text-muted-foreground">
              Upload videos, PDFs, and infographics for learning modules
            </p>
          </a>

          <a
            href="/content/library"
            className="rounded-lg border bg-card p-6 hover:border-primary transition-colors"
          >
            <FolderOpen className="h-8 w-8 text-primary mb-4" />
            <h3 className="text-lg font-semibold mb-2">Content Library</h3>
            <p className="text-sm text-muted-foreground">
              Browse and manage your uploaded content
            </p>
          </a>

          <a
            href="/users"
            className="rounded-lg border bg-card p-6 hover:border-primary transition-colors"
          >
            <Users className="h-8 w-8 text-primary mb-4" />
            <h3 className="text-lg font-semibold mb-2">Manage Admins</h3>
            <p className="text-sm text-muted-foreground">
              Invite and manage admin users
            </p>
          </a>
        </div>
      </div>
    </div>
  );
}
