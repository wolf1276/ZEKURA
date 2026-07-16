import Link from "next/link";
import { CompassIcon } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
      <CompassIcon className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Page not found
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
        </p>
      </div>
      <Link
        href="/"
        className="rounded-md border border-border bg-white/[0.02] px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-border-hover hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Back to Zekura
      </Link>
    </div>
  );
}
