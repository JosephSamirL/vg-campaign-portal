import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { reasonMessage } from "./reason-copy";

type SearchParams = Promise<{ reason?: string | string[] }>;

// Only the `?reason=…` alert depends on the request; it streams in so the form itself
// stays part of the static shell (Cache Components).
async function ReasonAlert({ searchParams }: { searchParams: SearchParams }) {
  const message = reasonMessage((await searchParams).reason);
  if (!message) return null;
  return (
    <Alert variant="destructive" data-testid="login-reason">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <Suspense fallback={null}>
          <ReasonAlert searchParams={searchParams} />
        </Suspense>
        <LoginForm />
      </div>
    </div>
  );
}
