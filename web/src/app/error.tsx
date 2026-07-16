"use client";

import { useEffect } from "react";
import { TriangleAlertIcon } from "lucide-react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <TriangleAlertIcon className="size-10 text-destructive" aria-hidden="true" />
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Something went wrong
        </h1>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          Zekura hit an unexpected error rendering this page. Your wallet
          connection and any submitted orders are unaffected — only the chain
          and Matcher ever hold order state.
        </p>
      </div>
      <button
        onClick={reset}
        className="rounded-md border border-border bg-white/[0.02] px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-hover hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Try again
      </button>
    </div>
  );
}
