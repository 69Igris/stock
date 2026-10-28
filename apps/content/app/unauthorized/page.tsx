"use client";

import { useClerk } from "@clerk/nextjs";

export default function UnauthorizedPage() {
  const { signOut } = useClerk();

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="text-center space-y-6 p-8">
        <div className="space-y-2">
          <h1 className="text-4xl font-bold text-white">Access Denied</h1>
          <p className="text-slate-400 text-lg">
            You do not have permission to access the Content Management System.
          </p>
        </div>
        <p className="text-slate-500 text-sm max-w-md mx-auto">
          If you believe this is an error, please contact the administrator to
          request access.
        </p>
        <button
          type="button"
          onClick={() => signOut({ redirectUrl: "/sign-in" })}
          className="inline-flex items-center justify-center px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
        >
          Sign in with a different account
        </button>
      </div>
    </div>
  );
}
