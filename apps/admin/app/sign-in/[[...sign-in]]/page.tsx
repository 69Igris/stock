import { SignIn } from "@clerk/nextjs";
import Image from "next/image";

export default function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <Image
              src="/icon.svg"
              alt="UseMoney"
              width={48}
              height={48}
              className="h-12 w-12 rounded-lg"
            />
          </div>
          <h1 className="text-2xl font-bold">UseMoney Admin</h1>
          <p className="text-muted-foreground mt-2">
            Sign in to access the admin panel
          </p>
        </div>
        <SignIn
          appearance={{
            elements: {
              rootBox: "mx-auto",
              card: "bg-card border shadow-lg",
            },
          }}
          // Clerk Core 2+ renamed the deprecated `redirectUrl` prop to
          // `fallbackRedirectUrl` (used when no redirect_url is present).
          fallbackRedirectUrl="/"
        />
      </div>
    </div>
  );
}
