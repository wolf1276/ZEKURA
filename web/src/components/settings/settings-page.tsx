"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { PageShell, Card } from "@/components/layout/page-shell";
import { useWallet } from "@/wallet/walletHooks";
import { truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSettings, applyDataAttributes } from "@/hooks/use-settings";

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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function Btn({
  children,
  onClick,
  destructive,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors",
        disabled
          ? "cursor-not-allowed border-destructive/30 text-destructive/60"
          : "hover:border-border-hover",
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
  const {
    autoConnect, setAutoConnect,
    compactMode, setCompactMode,
    reduceMotion, setReduceMotion,
    notifyFilled, setNotifyFilled,
    notifySettled, setNotifySettled,
    notifyErrors, setNotifyErrors,
    notifyBrowser, setNotifyBrowser,
    hidePortfolio, setHidePortfolio,
    hideBalances, setHideBalances,
    privacyMode, setPrivacyMode,
  } = useSettings();

  const unsupportedNetwork = status === "unsupported-network";
  const explorer = EXPLORER_URL[wallet?.networkId ?? "preprod"] ?? EXPLORER_URL.preprod;
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

  useEffect(() => {
    applyDataAttributes();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.compact = compactMode ? "" : undefined;
  }, [compactMode]);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduceMotion ? "" : undefined;
  }, [reduceMotion]);

  useEffect(() => {
    document.documentElement.dataset.hideBalances = hideBalances ? "" : undefined;
    document.documentElement.dataset.hidePortfolio = hidePortfolio ? "" : undefined;
  }, [hideBalances, hidePortfolio]);

  useEffect(() => {
    if (!notifyBrowser) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") return;
    if (Notification.permission === "denied") {
      toast.error("Browser notifications are blocked. Update your browser settings to enable them.");
      return;
    }
    Notification.requestPermission().then((permission) => {
      if (permission !== "granted") {
        setNotifyBrowser(false);
        toast.error("Notification permission denied. Update your browser settings to allow notifications.");
      }
    });
  }, [notifyBrowser, setNotifyBrowser]);

  function handlePrivacyMode(v: boolean) {
    setPrivacyMode(v);
    if (v) {
      setHidePortfolio(true);
      setHideBalances(true);
    }
  }

  function handleHidePortfolio(v: boolean) {
    setHidePortfolio(v);
    if (!v && !hideBalances) setPrivacyMode(false);
  }

  function handleHideBalances(v: boolean) {
    setHideBalances(v);
    if (!v && !hidePortfolio) setPrivacyMode(false);
  }

  async function copyAddress() {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.unshieldedAddress);
      toast.success("Address copied");
    } catch {
      toast.error("Failed to copy address. Clipboard access denied.");
    }
  }

  async function copyPublicKey() {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.shieldedCoinPublicKey);
      toast.success("Public key copied");
    } catch {
      toast.error("Failed to copy public key. Clipboard access denied.");
    }
  }

  async function copyDebug() {
    const payload = {
      app: { name: "Zekura", version: "v0.1.0" },
      wallet: wallet
        ? {
            name: wallet.walletName,
            networkId: wallet.networkId,
            unshieldedAddress: wallet.unshieldedAddress,
            shieldedAddress: wallet.shieldedAddress,
            configuration: wallet.configuration,
          }
        : null,
      network: wallet?.networkId ?? "none",
      status,
      settings: {
        autoConnect,
        compactMode,
        reduceMotion,
        notifyFilled,
        notifySettled,
        notifyErrors,
        notifyBrowser,
        hidePortfolio,
        hideBalances,
        privacyMode,
      },
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      toast.success("Debug info copied");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = JSON.stringify(payload, null, 2);
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast.success("Debug info copied");
      } catch {
        toast.error("Failed to copy debug info. Copy manually from console.");
        console.log("Debug info:", payload);
      }
      document.body.removeChild(ta);
    }
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
            <Row label="Wallet Address" hint={wallet ? "Click to copy" : undefined}>
              <button
                onClick={copyAddress}
                disabled={!wallet}
                className={cn(
                  "font-mono text-xs transition-colors",
                  wallet
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {wallet ? truncateAddress(wallet.unshieldedAddress, 10, 6) : "—"}
              </button>
            </Row>
            <Row label="Public Key" hint={wallet ? "Click to copy" : undefined}>
              <button
                onClick={copyPublicKey}
                disabled={!wallet}
                className={cn(
                  "font-mono text-xs transition-colors",
                  wallet
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {wallet ? truncateAddress(wallet.shieldedCoinPublicKey, 8, 6) : "—"}
              </button>
            </Row>
            <Row label="Reconnect">
              <Btn onClick={openModal}>Reconnect</Btn>
            </Row>
            <Row
              label="Auto Connect"
              hint="Automatically reconnect on launch"
            >
              <Toggle checked={autoConnect} onChange={setAutoConnect} />
            </Row>
          </Section>

          <Section
            id="network"
            title="Network"
            subtitle="View network and infrastructure status"
          >
            <Row
              label="Current Network"
              hint={
                unsupportedNetwork
                  ? `Unsupported: ${wallet?.networkId ?? "unknown"}`
                  : undefined
              }
            >
              <ReadOnly>{wallet?.networkId ?? "—"}</ReadOnly>
            </Row>
            <Row label="Network Status">
              <ReadOnly>{status === "connected" ? "Operational" : status === "connecting" ? "Connecting..." : status === "unsupported-network" ? "Unsupported" : "—"}</ReadOnly>
            </Row>
            <Row
              label="Explorer Link"
              hint={
                unsupportedNetwork
                  ? "Cannot open explorer — wallet is on an unsupported network"
                  : undefined
              }
            >
              <Btn
                onClick={() => {
                  if (!unsupportedNetwork) open(explorer);
                }}
                disabled={unsupportedNetwork}
                title={unsupportedNetwork ? "Current network has no explorer" : undefined}
              >
                Open
              </Btn>
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
            <Row
              label="Compact Mode"
              hint="Reduce spacing throughout the app"
            >
              <Toggle checked={compactMode} onChange={setCompactMode} />
            </Row>
            <Row
              label="Reduce Motion"
              hint="Disable animations and transitions"
            >
              <Toggle checked={reduceMotion} onChange={setReduceMotion} />
            </Row>
          </Section>

          <Section
            id="notifications"
            title="Notifications"
            subtitle="Choose what you get notified about"
          >
            <Row label="Order Filled">
              <Toggle checked={notifyFilled} onChange={setNotifyFilled} />
            </Row>
            <Row label="Settlement Complete">
              <Toggle checked={notifySettled} onChange={setNotifySettled} />
            </Row>
            <Row label="Errors">
              <Toggle checked={notifyErrors} onChange={setNotifyErrors} />
            </Row>
            <Row
              label="Browser Notifications"
              hint={
                typeof Notification !== "undefined" && Notification.permission === "denied"
                  ? "Blocked by browser — update site settings to enable"
                  : "Send push notifications for order events"
              }
            >
              {typeof Notification === "undefined" ? (
                <ReadOnly>Unsupported</ReadOnly>
              ) : (
                <Toggle checked={notifyBrowser} onChange={setNotifyBrowser} />
              )}
            </Row>
          </Section>

          <Section
            id="privacy"
            title="Privacy"
            subtitle="Control what is visible on screen"
          >
            <Row
              label="Hide Portfolio"
              hint="Hide portfolio values on dashboard"
            >
              <Toggle checked={hidePortfolio} onChange={handleHidePortfolio} />
            </Row>
            <Row
              label="Hide Balances"
              hint="Hide balance values across the app"
            >
              <Toggle checked={hideBalances} onChange={handleHideBalances} />
            </Row>
            <Row
              label="Privacy Mode"
              hint="Toggle all privacy settings at once"
            >
              <Toggle checked={privacyMode} onChange={handlePrivacyMode} />
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
            <Row label="Contract Address">
              <ReadOnly>{wallet?.configuration?.networkId === "preview" ? "N/A — Preview TBD" : wallet?.configuration?.networkId === "preprod" ? "N/A — Preprod TBD" : "—"}</ReadOnly>
            </Row>
            <Row label="Matcher Status">
              <ReadOnly>{status === "connected" ? "Available" : "—"}</ReadOnly>
            </Row>
            <Row label="API Status">
              <ReadOnly>{status === "connected" ? "Operational" : "—"}</ReadOnly>
            </Row>
            <Row label="Network Status">
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
            <Row label="GitHub">
              <Btn onClick={() => open("https://github.com/anomalyco/zekura")}>Open</Btn>
            </Row>
            <Row label="Documentation">
              <Btn onClick={() => open("https://docs.midnight.network/")}>Open</Btn>
            </Row>
            <Row label="Whitepaper">
              <Btn onClick={() => open("https://docs.midnight.network/learn/tokenomics/whitepaper")}>Open</Btn>
            </Row>
            <Row label="X">
              <Btn onClick={() => open("https://x.com/MidnightNtwrk")}>Open</Btn>
            </Row>
            <Row label="License">
              <Btn onClick={() => open("https://github.com/anomalyco/zekura/blob/main/LICENSE")}>Open</Btn>
            </Row>
          </Section>
        </div>
      </div>
    </PageShell>
  );
}
