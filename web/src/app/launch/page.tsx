"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, useScroll, useTransform } from "framer-motion";
import {
  ArrowUpRight,
  ChevronDown,
  Lock,
  Radio,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Scroll-reveal wrapper — the "framer-motion scroll animate" used across every section. */
function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
      {children}
    </p>
  );
}

function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "border-b border-border px-6 py-24 md:px-16 lg:py-28",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-[1200px]">{children}</div>
    </section>
  );
}

const NAV = [
  { label: "Product", href: "#showcase" },
  { label: "Protocol", href: "#security" },
  { label: "Documentation", href: "https://docs.midnight.network/" },
  { label: "Whitepaper", href: "#" },
  { label: "GitHub", href: "#" },
  { label: "X", href: "#" },
];

const FEATURES = [
  {
    title: "Confidential Trading",
    body: "Order amounts and balances stay hidden on-chain — trade without leaking your position to the mempool.",
  },
  {
    title: "Proactive Matching Engine",
    body: "An off-chain matcher pairs orders continuously and streams lifecycle events over live WebSocket feeds.",
  },
  {
    title: "Zero-Knowledge Settlement",
    body: "Settlement is proven, not revealed. Commitments verify a fill happened without exposing its contents.",
  },
  {
    title: "Wallet Integration",
    body: "Connect any Midnight DApp-connector wallet. The app adopts your wallet's network automatically.",
  },
  {
    title: "Live Orderbook",
    body: "A real-time view of open interest and last-traded prices, derived straight from the order flow.",
  },
  {
    title: "Open Source",
    body: "Contracts, matcher, and frontend are open for review. Verify the guarantees yourself.",
  },
];

const MODULES = ["Trade", "Portfolio", "Orders", "Activity", "Settings"];

const HIGHLIGHTS = [
  { n: "01", label: "Protocol Modules", sub: "Matcher, settlement, exchange.", value: "3" },
  { n: "02", label: "Network", sub: "Deployed on Midnight.", value: "Midnight" },
  { n: "03", label: "Supported Wallets", sub: "Connect options at launch.", value: "DApp Connector v4" },
  { n: "04", label: "Confidential by default", sub: "Every order, every settlement.", value: "100%" },
  { n: "05", label: "Live Feeds", sub: "Order & activity streams.", value: "WebSocket" },
  { n: "06", label: "Source", sub: "Open for review.", value: "Open Source" },
];

const SECURITY = [
  { title: "Replay Protection", icon: ShieldCheck },
  { title: "Commitment Verification", icon: Lock },
  { title: "Witness Validation", icon: ShieldCheck },
  { title: "Authorization", icon: Lock },
  { title: "Privacy Guarantees", icon: ShieldCheck },
  { title: "Audit Status", icon: Radio },
];

const DEV_RESOURCES = ["SDK", "API", "Documentation", "Whitepaper", "Architecture", "GitHub"];

const FAQS = [
  {
    q: "What is Zekura?",
    a: "Zekura is a confidential decentralized exchange built on Midnight — it lets you trade without revealing order amounts or balances on-chain.",
  },
  {
    q: "How does confidential settlement work?",
    a: "Orders settle through zero-knowledge commitments. A proof verifies a valid fill occurred without disclosing its contents to observers.",
  },
  {
    q: "Which wallets are supported?",
    a: "Any wallet implementing the Midnight DApp Connector API v4. The app adopts whatever network your wallet reports.",
  },
  {
    q: "Is the protocol audited?",
    a: "Zekura is open source and built for independent review. Formal audit status is published alongside each release.",
  },
  {
    q: "How do I get started?",
    a: "Connect a Midnight wallet, open the Trade screen, and place your first confidential order. Balances stay private throughout.",
  },
];

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 w-full max-w-[1200px] items-center justify-between px-6 md:px-16">
        <div className="flex items-center gap-9">
          <Link href="/launch" className="flex items-center gap-2 font-semibold tracking-tight">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/zekura-mark.ico" alt="" width={22} height={22} className="size-[22px] rounded-md" />
            <span className="text-[15px]">Zekura</span>
          </Link>
          <nav className="hidden items-center gap-6 lg:flex">
            {NAV.map((n) => (
              <a
                key={n.label}
                href={n.href}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {n.label}
              </a>
            ))}
          </nav>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          Launch App <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  const { scrollY } = useScroll();
  const y = useTransform(scrollY, [0, 600], [0, 120]);
  const opacity = useTransform(scrollY, [0, 500], [1, 0.25]);

  return (
    <section className="relative overflow-hidden border-b border-border">
      {/* Animated aurora background (Aceternity-style, built inline) */}
      <motion.div style={{ y, opacity }} className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(109,94,245,0.28),transparent_70%)]" />
        <motion.div
          className="absolute -top-40 left-1/4 size-[520px] rounded-full bg-primary/20 blur-[120px]"
          animate={{ x: [0, 80, 0], y: [0, 40, 0] }}
          transition={{ duration: 16, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute top-20 right-1/4 size-[420px] rounded-full bg-primary/10 blur-[110px]"
          animate={{ x: [0, -70, 0], y: [0, 60, 0] }}
          transition={{ duration: 20, repeat: Infinity, ease: "easeInOut" }}
        />
        <div
          className="absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(70% 60% at 50% 30%, #000 40%, transparent 100%)",
          }}
        />
      </motion.div>

      <div className="relative mx-auto w-full max-w-[1200px] px-6 pb-24 pt-28 md:px-16 lg:pt-36">
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-white/[0.03] px-3 py-1 text-xs text-muted-foreground"
        >
          <span className="size-1.5 rounded-full bg-primary" /> Now live on Midnight
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="max-w-3xl text-5xl font-semibold leading-[1.03] tracking-tight md:text-7xl"
        >
          Zekura is Live
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg"
        >
          The Zekura Protocol is now live — a confidential exchange for private,
          verifiable trading. Order amounts stay hidden, settlement stays proven,
          and your position never leaks to the mempool.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.25 }}
          className="mt-9 flex flex-wrap gap-3"
        >
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Launch App <ArrowUpRight className="size-4" />
          </Link>
          <a
            href="#"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-5 py-3 text-sm font-medium text-foreground/90 transition-colors hover:border-border-hover"
          >
            Read Whitepaper
          </a>
        </motion.div>

        <div className="mt-16 flex items-center gap-8 text-xs text-muted-foreground">
          <span className="uppercase tracking-widest">Ecosystem &amp; Stack</span>
          <div className="flex flex-wrap items-center gap-6 opacity-70">
            {["Midnight", "Compact", "ZK Proofs"].map((s) => (
              <span key={s} className="text-sm text-foreground/70">{s}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="max-w-3xl">
      {FAQS.map((f, i) => {
        const isOpen = open === i;
        return (
          <div key={f.q} className="border-b border-border">
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              className="flex w-full items-center justify-between gap-4 py-5 text-left"
            >
              <span className="flex items-baseline gap-4">
                <span className="font-mono text-xs text-muted-foreground">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-base text-foreground md:text-lg">{f.q}</span>
              </span>
              <ChevronDown
                className={cn(
                  "size-4 flex-none text-muted-foreground transition-transform",
                  isOpen && "rotate-180 text-foreground",
                )}
              />
            </button>
            <motion.div
              initial={false}
              animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <p className="max-w-2xl pb-5 pl-10 text-sm leading-relaxed text-muted-foreground">
                {f.a}
              </p>
            </motion.div>
          </div>
        );
      })}
    </div>
  );
}

export default function LaunchPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <Hero />

      {/* What's New */}
      <Section id="whats-new">
        <Reveal>
          <Kicker>02 — What&apos;s New</Kicker>
          <h2 className="mb-12 text-3xl font-semibold tracking-tight md:text-4xl">What launched</h2>
        </Reveal>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.08}>
              <div className="group flex h-full min-h-[180px] flex-col justify-between rounded-lg border border-border bg-card p-6 transition-colors hover:border-border-hover">
                <div>
                  <Zap className="mb-4 size-5 text-primary" />
                  <p className="mb-2 text-base font-medium">{f.title}</p>
                  <p className="text-sm leading-relaxed text-muted-foreground">{f.body}</p>
                </div>
                <span className="mt-6 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                  Learn more <ArrowUpRight className="size-3" />
                </span>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Product Showcase */}
      <Section id="showcase">
        <Reveal>
          <Kicker>03 — Product Showcase</Kicker>
          <h2 className="mb-10 text-3xl font-semibold tracking-tight md:text-4xl">See it in action</h2>
        </Reveal>
        <Reveal>
          <div className="relative mb-5 flex h-[380px] items-center justify-center overflow-hidden rounded-xl border border-border bg-card md:h-[480px]">
            <div className="absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_0%,rgba(109,94,245,0.18),transparent_70%)]" />
            <span className="relative text-sm text-muted-foreground">Application Preview</span>
          </div>
        </Reveal>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {MODULES.map((m, i) => (
            <Reveal key={m} delay={i * 0.06}>
              <div className="flex h-32 items-center justify-center rounded-lg border border-border bg-card text-sm text-foreground/80 transition-colors hover:border-border-hover">
                {m}
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Launch Highlights */}
      <Section id="highlights">
        <Reveal>
          <Kicker>04 — Launch Highlights</Kicker>
          <h2 className="mb-10 text-3xl font-semibold tracking-tight md:text-4xl">By the numbers</h2>
        </Reveal>
        <div className="border-t border-border">
          {HIGHLIGHTS.map((h, i) => (
            <Reveal key={h.n} delay={i * 0.04}>
              <div className="grid grid-cols-12 items-baseline gap-4 border-b border-border py-6">
                <span className="col-span-1 font-mono text-xs text-muted-foreground">{h.n}</span>
                <div className="col-span-11 md:col-span-5">
                  <p className="text-sm text-foreground">{h.label}</p>
                  <p className="text-xs text-muted-foreground">{h.sub}</p>
                </div>
                <div className="col-span-12 font-serif text-2xl md:col-span-6 md:text-right md:text-3xl">
                  {h.value}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-6 max-w-xl text-xs leading-relaxed text-muted-foreground">
          Figures reflect the current mainnet deployment and are updated with each release.
        </p>
      </Section>

      {/* Security */}
      <Section id="security">
        <Reveal>
          <Kicker>06 — Security</Kicker>
          <h2 className="mb-12 text-3xl font-semibold tracking-tight md:text-4xl">Security guarantees</h2>
        </Reveal>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {SECURITY.map((s, i) => (
            <Reveal key={s.title} delay={(i % 3) * 0.08}>
              <div className="flex min-h-[110px] items-center gap-4 rounded-lg border border-border bg-card p-6 transition-colors hover:border-border-hover">
                <s.icon className="size-5 flex-none text-primary" />
                <p className="text-sm font-medium">{s.title}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Developer Resources */}
      <Section id="developers">
        <Reveal>
          <Kicker>08 — Developer Resources</Kicker>
          <h2 className="mb-12 text-3xl font-semibold tracking-tight md:text-4xl">Build with Zekura</h2>
        </Reveal>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {DEV_RESOURCES.map((r, i) => (
            <Reveal key={r} delay={i * 0.05}>
              <a
                href="#"
                className="flex h-28 items-center justify-center rounded-lg border border-border bg-card text-sm text-foreground/80 transition-colors hover:border-border-hover hover:text-foreground"
              >
                {r}
              </a>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Community */}
      <Section id="community">
        <Reveal>
          <Kicker>09 — Community</Kicker>
          <div className="mb-10 flex items-end justify-between">
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Latest updates</h2>
            <a href="#" className="text-sm text-muted-foreground hover:text-foreground">View all →</a>
          </div>
        </Reveal>
        <div className="mb-10 grid gap-8 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Reveal key={i} delay={i * 0.1}>
              <div className="border-t border-border pt-5">
                <p className="mb-2 text-xs text-muted-foreground">By: Zekura Protocol</p>
                <p className="mb-2 font-serif text-lg">Zekura Protocol ships to mainnet</p>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  A short summary of the release — what changed, and why it matters for confidential trading.
                </p>
              </div>
            </Reveal>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {["GitHub Activity", "Discord", "Roadmap", "Developer Updates"].map((c, i) => (
            <Reveal key={c} delay={i * 0.06}>
              <div className="flex h-40 items-center justify-center rounded-lg border border-border bg-card text-sm text-muted-foreground transition-colors hover:border-border-hover">
                {c}
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq">
        <Reveal>
          <Kicker>10 — FAQ</Kicker>
          <h2 className="mb-10 text-3xl font-semibold tracking-tight md:text-4xl">Frequently asked</h2>
        </Reveal>
        <Reveal>
          <Faq />
        </Reveal>
      </Section>

      {/* Final CTA */}
      <Section className="relative overflow-hidden text-center">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_80%_at_50%_50%,rgba(109,94,245,0.16),transparent_70%)]" />
        <Reveal className="relative">
          <h2 className="mx-auto mb-8 max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">
            Ready to experience confidential trading?
          </h2>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Launch App <ArrowUpRight className="size-4" />
            </Link>
            <a href="#" className="rounded-md border border-border px-5 py-3 text-sm font-medium text-foreground/90 transition-colors hover:border-border-hover">
              Read Whitepaper
            </a>
            <a href="#" className="rounded-md border border-border px-5 py-3 text-sm font-medium text-foreground/90 transition-colors hover:border-border-hover">
              GitHub
            </a>
          </div>
        </Reveal>
      </Section>

      {/* Footer */}
      <footer className="px-6 py-16 md:px-16">
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-2 gap-8 md:grid-cols-6">
          {[
            { h: "Product", links: ["Overview", "Launch App"] },
            { h: "Protocol", links: ["Documentation", "Whitepaper", "Architecture"] },
            { h: "Security", links: ["Security", "Audits"] },
            { h: "Developers", links: ["GitHub", "SDK", "API"] },
            { h: "Community", links: ["X", "Discord"] },
            { h: "Legal", links: ["Privacy Policy", "Terms"] },
          ].map((col) => (
            <div key={col.h} className="flex flex-col gap-2.5">
              <p className="mb-1 text-[11px] uppercase tracking-widest text-muted-foreground">{col.h}</p>
              {col.links.map((l) => (
                <a key={l} href="#" className="text-xs text-foreground/70 transition-colors hover:text-foreground">
                  {l}
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="mx-auto mt-12 w-full max-w-[1200px] border-t border-border pt-6 text-xs text-muted-foreground">
          © {new Date().getFullYear()} Zekura Protocol · Confidential exchange on Midnight
        </div>
      </footer>
    </div>
  );
}
