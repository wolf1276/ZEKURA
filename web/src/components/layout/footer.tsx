import { ShieldCheck } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-border px-4 py-4 md:px-6">
      <div className="flex flex-col items-center justify-between gap-2 text-xs text-muted-foreground sm:flex-row">
        <p>© {new Date().getFullYear()} Zekura. Built on Midnight.</p>
        <p className="flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 text-primary" />
          Confidential by default — no public order book, ever.
        </p>
      </div>
    </footer>
  );
}
