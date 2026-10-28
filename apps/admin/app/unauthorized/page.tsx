import { ShieldX } from "lucide-react";
import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center max-w-md px-4">
        <div className="flex justify-center mb-6">
          <div className="p-4 rounded-full bg-destructive/10">
            <ShieldX className="h-12 w-12 text-destructive" />
          </div>
        </div>
        <h1 className="text-3xl font-bold mb-2">Access Denied</h1>
        <p className="text-muted-foreground mb-6">
          You don&apos;t have permission to access the admin panel. Please contact an
          administrator if you believe this is an error.
        </p>
        <div className="flex flex-col gap-3">
          <Link
            href="/sign-in"
            className="px-6 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors"
          >
            Sign in with different account
          </Link>
          <a
            href="mailto:deepshaswat@gmail.com"
            className="px-6 py-2 rounded-lg border text-foreground font-medium hover:bg-accent transition-colors"
          >
            Request Access
          </a>
        </div>
      </div>
    </div>
  );
}
