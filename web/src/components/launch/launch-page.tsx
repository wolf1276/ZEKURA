"use client";

import { useState } from "react";
import Link from "next/link";
import { Manrope } from "next/font/google";
import { motion } from "framer-motion";
import { ArrowUpRight, ChevronDown, Lock, Radio, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-manrope",
});

/* Kimia tokenized class recipes — semantic tokens only, no one-off values. */
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-full bg-[var(--k-text-primary)] px-6 py-3 text-[14px] font-semibold text-[var(--k-text-inverse)] transition-opacity duration-150 hover:opacity-90";
const BTN_SECONDARY =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--k-border)] px-6 py-3 text-[14px] font-semibold text-[var(--k-text-primary)] transition-colors duration-150 hover:bg-[var(--k-surface-muted)]";
const CARD =
  "rounded-[22px] border border-[var(--k-border)] bg-[var(--k-surface-muted)] p-6 transition-colors duration-300 hover:border-[var(--k-border-muted)]";
const MUTED = "text-[var(--k-text-tertiary)]";

/** Scroll-reveal — motion.duration.normal (500ms), respects reduced motion via viewport once. */
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
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className={cn("mb-5 text-[11px] font-semibold uppercase tracking-[0.14em]", MUTED)}>
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
      className={cn("border-b border-[var(--k-border)] px-6 py-20 md:px-10 lg:py-24", className)}
    >
      <div className="mx-auto w-full max-w-[1080px]">{children}</div>
    </section>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[20px] font-bold tracking-tight md:text-[20px]">{children}</h2>;
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
  { title: "Confidential Trading", body: "Order amounts and balances stay hidden on-chain — trade without leaking your position to the mempool." },
  { title: "Proactive Matching Engine", body: "An off-chain matcher pairs orders continuously and streams lifecycle events over live WebSocket feeds." },
  { title: "Zero-Knowledge Settlement", body: "Settlement is proven, not revealed. Commitments verify a fill happened without exposing its contents." },
  { title: "Wallet Integration", body: "Connect any Midnight DApp-connector wallet. The app adopts your wallet's network automatically." },
  { title: "Live Orderbook", body: "A real-time view of open interest and last-traded prices, derived straight from the order flow." },
  { title: "Open Source", body: "Contracts, matcher, and frontend are open for review. Verify the guarantees yourself." },
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
  { q: "What is Zekura?", a: "Zekura is a confidential decentralized exchange built on Midnight — it lets you trade without revealing order amounts or balances on-chain." },
  { q: "How does confidential settlement work?", a: "Orders settle through zero-knowledge commitments. A proof verifies a valid fill occurred without disclosing its contents to observers." },
  { q: "Which wallets are supported?", a: "Any wallet implementing the Midnight DApp Connector API v4. The app adopts whatever network your wallet reports." },
  { q: "Is the protocol audited?", a: "Zekura is open source and built for independent review. Formal audit status is published alongside each release." },
  { q: "How do I get started?", a: "Connect a Midnight wallet, open the Trade screen, and place your first confidential order. Balances stay private throughout." },
];

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--k-border)] bg-[var(--k-surface-base)]/85 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[1080px] items-center justify-between px-6 md:px-10">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/zekura-mark.ico" alt="" width={22} height={22} className="size-[22px] rounded-md" />
            <span>Zekura</span>
          </Link>
          <nav className="hidden items-center gap-6 lg:flex">
            {NAV.map((n) => (
              <a key={n.label} href={n.href} className={cn("text-[14px] transition-colors duration-150 hover:text-[var(--k-text-primary)]", MUTED)}>
                {n.label}
              </a>
            ))}
          </nav>
        </div>
        <Link href="/dashboard" className={BTN_PRIMARY}>
          Launch App <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="border-b border-[var(--k-border)]">
      <div className="mx-auto w-full max-w-[1080px] px-6 py-24 md:px-10 lg:py-28">
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-[var(--k-border)] bg-[var(--k-surface-strong)] px-3 py-1 text-[12px] font-medium text-[var(--k-text-secondary)]"
        >
          <span className="size-1.5 rounded-full bg-[var(--k-text-primary)]" /> Now live on Midnight
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05 }}
          className="max-w-2xl text-[36px] font-extrabold leading-[1.05] tracking-tight"
        >
          Zekura is live — confidential trading, verifiably private.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className={cn("mt-6 max-w-xl text-[17px] leading-[1.6]", "text-[var(--k-text-secondary)]")}
        >
          The Zekura Protocol is a confidential exchange for private, verifiable
          trading. Order amounts stay hidden, settlement stays proven, and your
          position never leaks to the mempool.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="mt-8 flex flex-wrap gap-3"
        >
          <Link href="/dashboard" className={BTN_PRIMARY}>
            Launch App <ArrowUpRight className="size-4" />
          </Link>
          <a href="#" className={BTN_SECONDARY}>Read Whitepaper</a>
        </motion.div>

        <div className="mt-14 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-[var(--k-border)] pt-6">
          <span className={cn("text-[11px] uppercase tracking-[0.14em]", MUTED)}>Ecosystem &amp; Stack</span>
          <div className="flex flex-wrap items-center gap-6">
            {["Midnight", "Compact", "ZK Proofs"].map((s) => (
              <span key={s} className="text-[14px] text-[var(--k-text-secondary)]">{s}</span>
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
          <div key={f.q} className="border-b border-[var(--k-border)]">
            <button
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 py-5 text-left"
            >
              <span className="flex items-baseline gap-4">
                <span className={cn("text-[12px] tabular-nums", MUTED)}>{String(i + 1).padStart(2, "0")}</span>
                <span className="text-[16px] font-medium">{f.q}</span>
              </span>
              <ChevronDown className={cn("size-4 flex-none transition-transform duration-300", MUTED, isOpen && "rotate-180")} />
            </button>
            <motion.div
              initial={false}
              animate={{ height: isOpen ? "auto" : 0, opacity: isOpen ? 1 : 0 }}
              transition={{ duration: 0.3, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <p className={cn("max-w-2xl pb-5 pl-9 text-[14px] leading-[1.6]", "text-[var(--k-text-secondary)]")}>{f.a}</p>
            </motion.div>
          </div>
        );
      })}
    </div>
  );
}

export function LaunchPage() {
  return (
    <div className={cn(manrope.variable, "kimia min-h-screen text-[16px] leading-[24px]")}>
      <Nav />
      <Hero />

      {/* What's New */}
      <Section id="whats-new">
        <Reveal>
          <Kicker>02 — What&apos;s New</Kicker>
          <H2>What launched</H2>
        </Reveal>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 3) * 0.06}>
              <div className={cn(CARD, "flex h-full min-h-[172px] flex-col justify-between")}>
                <div>
                  <p className="mb-2 text-[15px] font-semibold">{f.title}</p>
                  <p className={cn("text-[14px] leading-[1.55]", MUTED)}>{f.body}</p>
                </div>
                <span className={cn("mt-6 inline-flex items-center gap-1 text-[12px] font-medium", MUTED)}>
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
          <H2>See it in action</H2>
        </Reveal>
        <Reveal>
          <div className="mt-10 flex h-[340px] items-center justify-center rounded-[22px] border border-[var(--k-border)] bg-[var(--k-surface-strong)] md:h-[440px]">
            <span className={cn("text-[14px]", MUTED)}>Application Preview</span>
          </div>
        </Reveal>
        <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
          {MODULES.map((m, i) => (
            <Reveal key={m} delay={i * 0.05}>
              <div className={cn(CARD, "flex h-28 items-center justify-center text-[14px] font-medium")}>{m}</div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Launch Highlights */}
      <Section id="highlights">
        <Reveal>
          <Kicker>04 — Launch Highlights</Kicker>
          <H2>By the numbers</H2>
        </Reveal>
        <div className="mt-10 border-t border-[var(--k-border)]">
          {HIGHLIGHTS.map((h, i) => (
            <Reveal key={h.n} delay={i * 0.04}>
              <div className="grid grid-cols-12 items-baseline gap-4 border-b border-[var(--k-border)] py-6">
                <span className={cn("col-span-1 text-[12px] tabular-nums", MUTED)}>{h.n}</span>
                <div className="col-span-11 md:col-span-5">
                  <p className="text-[15px] font-medium">{h.label}</p>
                  <p className={cn("text-[12px]", MUTED)}>{h.sub}</p>
                </div>
                <div className="col-span-12 text-[20px] font-bold md:col-span-6 md:text-right">{h.value}</div>
              </div>
            </Reveal>
          ))}
        </div>
        <p className={cn("mt-6 max-w-xl text-[12px] leading-[1.6]", MUTED)}>
          Figures reflect the current mainnet deployment and are updated with each release.
        </p>
      </Section>

      {/* Security */}
      <Section id="security">
        <Reveal>
          <Kicker>06 — Security</Kicker>
          <H2>Security guarantees</H2>
        </Reveal>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {SECURITY.map((s, i) => (
            <Reveal key={s.title} delay={(i % 3) * 0.06}>
              <div className={cn(CARD, "flex min-h-[96px] items-center gap-4")}>
                <s.icon className="size-5 flex-none text-[var(--k-text-primary)]" />
                <p className="text-[15px] font-semibold">{s.title}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Developer Resources */}
      <Section id="developers">
        <Reveal>
          <Kicker>08 — Developer Resources</Kicker>
          <H2>Build with Zekura</H2>
        </Reveal>
        <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {DEV_RESOURCES.map((r, i) => (
            <Reveal key={r} delay={i * 0.05}>
              <a href="#" className={cn(CARD, "flex h-24 items-center justify-center text-[14px] font-medium hover:bg-[var(--k-surface-strong)]")}>{r}</a>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* Community */}
      <Section id="community">
        <Reveal>
          <Kicker>09 — Community</Kicker>
          <div className="flex items-end justify-between">
            <H2>Latest updates</H2>
            <a href="#" className={cn("text-[14px]", MUTED)}>View all →</a>
          </div>
        </Reveal>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          {[0, 1].map((i) => (
            <Reveal key={i} delay={i * 0.08}>
              <div className="border-t border-[var(--k-border)] pt-5">
                <p className={cn("mb-2 text-[12px]", MUTED)}>By: Zekura Protocol</p>
                <p className="mb-2 text-[17px] font-bold">Zekura Protocol ships to mainnet</p>
                <p className={cn("text-[14px] leading-[1.55]", MUTED)}>A short summary of the release — what changed, and why it matters for confidential trading.</p>
              </div>
            </Reveal>
          ))}
        </div>
        <div className="mt-9 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {["GitHub Activity", "Discord", "Roadmap", "Developer Updates"].map((c, i) => (
            <Reveal key={c} delay={i * 0.05}>
              <div className={cn(CARD, "flex h-36 items-center justify-center text-[14px] font-medium", MUTED)}>{c}</div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq">
        <Reveal>
          <Kicker>10 — FAQ</Kicker>
          <H2>Frequently asked</H2>
        </Reveal>
        <Reveal className="mt-10">
          <Faq />
        </Reveal>
      </Section>

      {/* Final CTA */}
      <Section className="text-center">
        <Reveal>
          <h2 className="mx-auto mb-8 max-w-2xl text-[36px] font-extrabold leading-[1.1] tracking-tight">
            Ready to experience confidential trading?
          </h2>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/dashboard" className={BTN_PRIMARY}>
              Launch App <ArrowUpRight className="size-4" />
            </Link>
            <a href="#" className={BTN_SECONDARY}>Read Whitepaper</a>
            <a href="#" className={BTN_SECONDARY}>GitHub</a>
          </div>
        </Reveal>
      </Section>

      {/* Footer */}
      <footer className="px-6 py-16 md:px-10">
        <div className="mx-auto grid w-full max-w-[1080px] grid-cols-2 gap-8 md:grid-cols-6">
          {[
            { h: "Product", links: ["Overview", "Launch App"] },
            { h: "Protocol", links: ["Documentation", "Whitepaper", "Architecture"] },
            { h: "Security", links: ["Security", "Audits"] },
            { h: "Developers", links: ["GitHub", "SDK", "API"] },
            { h: "Community", links: ["X", "Discord"] },
            { h: "Legal", links: ["Privacy Policy", "Terms"] },
          ].map((col) => (
            <div key={col.h} className="flex flex-col gap-2.5">
              <p className={cn("mb-1 text-[11px] uppercase tracking-[0.14em]", MUTED)}>{col.h}</p>
              {col.links.map((l) => (
                <a key={l} href={l === "X" ? "https://x.com/zekuraprotcol" : "#"} className={cn("text-[13px] transition-colors duration-150 hover:text-[var(--k-text-primary)]", "text-[var(--k-text-secondary)]")}>{l}</a>
              ))}
            </div>
          ))}
        </div>
        <div className={cn("mx-auto mt-12 w-full max-w-[1080px] border-t border-[var(--k-border)] pt-6 text-[12px]", MUTED)}>
          © {new Date().getFullYear()} Zekura Protocol · Confidential exchange on Midnight
        </div>
      </footer>
    </div>
  );
}
