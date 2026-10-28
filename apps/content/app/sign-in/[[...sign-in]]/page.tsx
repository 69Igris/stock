"use client";

import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <SignIn
        appearance={{
          elements: {
            rootBox: "w-full max-w-md",
            card: "bg-slate-900 border-slate-800 shadow-xl rounded-xl",
            headerTitle: "text-white",
            headerSubtitle: "text-slate-400",
            socialButtonsBlockButton:
              "bg-slate-800 hover:bg-slate-700 border-slate-700",
            socialButtonsBlockButtonText: "text-white",
            dividerLine: "bg-slate-700",
            dividerText: "text-slate-400",
            formFieldLabel: "text-slate-300",
            formFieldInput: "bg-slate-800 border-slate-700 text-white",
            formButtonPrimary: "bg-blue-600 hover:bg-blue-700",
            footerActionLink: "text-blue-500 hover:text-blue-400",
            identityPreviewEditButton: "text-blue-500",
          },
        }}
        routing="path"
        path="/sign-in"
      />
    </div>
  );
}
