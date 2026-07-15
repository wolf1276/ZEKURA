"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { PageShell, Card } from "@/components/layout/page-shell";
import { useWallet } from "@/wallet/walletHooks";
import { truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV = [
  "Wallet",
  "Network",
  "Appearance",
  "Notifications",
  "Privacy",
  "Developer",
  "About",
];

const EXPLORER_URL: Record<string, string> = {
  preview: "https://preview.midnightexplorer.com/",
  preprod: "https://preprod.midnightexplorer.com/",
  mainnet: "https://midnightexplorer.com/",
};

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-10 scroll-mt-20">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mb-4 mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
      <Card className="divide-y divide-border/60">{children}</Card>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0">
        <p className="text-sm text-foreground/90">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

function Toggle({ id }: { id: string }) {
  const [on, setOn] = useState(true);
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={id}
      onClick={() => setOn((v) => !v)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        on ? "bg-primary" : "bg-border",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
          on ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function Btn({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:border-border-hover",
        destructive ? "text-destructive hover:border-destructive/50" : "text-foreground/90",
      )}
    >
      {children}
    </button>
  );
}

function ReadOnly({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-xs text-muted-foreground">{children}</span>
  );
}

export function SettingsPage() {
  const { status, wallet, openModal, disconnect } = useWallet();
  const { theme, setTheme } = useTheme();
  const explorer = EXPLORER_URL[wallet?.networkId ?? "preprod"] ?? EXPLORER_URL.preprod;
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

  function copyDebug() {
    void navigator.clipboard.writeText(
      JSON.stringify(
        { wallet: wallet?.walletName, network: wallet?.networkId, status },
        null,
        2,
      ),
    );
    toast.success("Debug info copied");
  }

  return (
    <PageShell
      title="Settings"
      description="Manage your wallet connection, network, and preferences."
    >
      <div className="flex gap-8">
        <nav className="sticky top-20 hidden h-fit w-44 flex-none flex-col gap-0.5 md:flex">
          <p className="mb-2 px-3 text-xs font-semibold tracking-wide text-muted-foreground">
            SETTINGS
          </p>
          {NAV.map((n) => (
            <a
              key={n}
              href={`#${n.toLowerCase()}`}
              className="rounded-md border-l-2 border-transparent px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary hover:bg-white/[0.03] hover:text-foreground"
            >
              {n}
            </a>
          ))}
        </nav>

        <div className="min-w-0 max-w-2xl flex-1">
          <Section id="wallet" title="Wallet" subtitle="Manage your connected wallet">
            <Row
              label="Connected Wallet"
              hint={wallet?.walletName ?? "No wallet connected"}
            >
              {wallet ? (
                <Btn onClick={disconnect} destructive>
                  Disconnect
                </Btn>
              ) : (
                <Btn onClick={openModal}>Connect</Btn>
              )}
            </Row>
            <Row label="Wallet Address">
              <ReadOnly>
                {wallet ? truncateAddress(wallet.unshieldedAddress, 10, 6) : "—"}
              </ReadOnly>
            </Row>
            <Row label="Reconnect">
              <Btn onClick={openModal}>Reconnect</Btn>
            </Row>
            <Row
              label="Auto Connect"
              hint="Automatically reconnect on launch"
            >
              <Toggle id="auto-connect" />
            </Row>
          </Section>

          <Section
            id="network"
            title="Network"
            subtitle="View network and infrastructure status"
          >
            <Row label="Current Network">
              <ReadOnly>{wallet?.networkId ?? "—"}</ReadOnly>
            </Row>
            <Row label="Network Status">
              <ReadOnly>{status === "connected" ? "Operational" : "—"}</ReadOnly>
            </Row>
            <Row label="Explorer Link">
              <Btn onClick={() => open(explorer)}>Open</Btn>
            </Row>
            <Row label="Proof Server Status">
              <ReadOnly>{status === "connected" ? "Online" : "—"}</ReadOnly>
            </Row>
          </Section>

          <Section id="appearance" title="Appearance" subtitle="Display preferences">
            <Row label="Theme">
              <select
                value={theme ?? "system"}
                onChange={(e) => setTheme(e.target.value)}
                className="rounded-md border border-border bg-transparent px-3 py-1.5 text-xs text-foreground/90 outline-none"
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </Row>
            <Row label="Compact Mode">
              <Toggle id="compact" />
            </Row>
            <Row label="Reduce Motion">
              <Toggle id="reduce-motion" />
            </Row>
          </Section>

          <Section
            id="notifications"
            title="Notifications"
            subtitle="Choose what you get notified about"
          >
            <Row label="Order Filled">
              <Toggle id="notify-filled" />
            </Row>
            <Row label="Settlement Complete">
              <Toggle id="notify-settled" />
            </Row>
            <Row label="Errors">
              <Toggle id="notify-errors" />
            </Row>
            <Row label="Browser Notifications">
              <Toggle id="notify-browser" />
            </Row>
          </Section>

          <Section
            id="privacy"
            title="Privacy"
            subtitle="Control what is visible on screen"
          >
            <Row label="Hide Portfolio">
              <Toggle id="hide-portfolio" />
            </Row>
            <Row label="Hide Balances">
              <Toggle id="hide-balances" />
            </Row>
            <Row label="Privacy Mode">
              <Toggle id="privacy-mode" />
            </Row>
          </Section>

          <Section
            id="developer"
            title="Developer"
            subtitle="Version and diagnostic information"
          >
            <Row label="SDK Version">
              <ReadOnly>@midnight-ntwrk 4.0.4</ReadOnly>
            </Row>
            <Row label="Network Manager Status">
              <ReadOnly>{status === "connected" ? "Running" : "Idle"}</ReadOnly>
            </Row>
            <Row label="Copy Debug Information">
              <Btn onClick={copyDebug}>Copy</Btn>
            </Row>
          </Section>

          <Section
            id="about"
            title="About"
            subtitle="Application information and support"
          >
            <Row label="Application Version">
              <ReadOnly>v0.1.0</ReadOnly>
            </Row>
            <Row label="Documentation">
              <Btn onClick={() => open("https://docs.midnight.network/")}>Open</Btn>
            </Row>
            <Row label="Support">
              <Btn onClick={() => open("https://docs.midnight.network/")}>Open</Btn>
            </Row>
          </Section>
        </div>
      </div>
    </PageShell>
  );
}
