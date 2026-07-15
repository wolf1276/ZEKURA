export function formatPrice(value: number | string, digits = 3): string {
  const n = typeof value === "string" ? Number(value) : value;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatAmount(value: number | string, digits = 2): string {
  const n = typeof value === "string" ? Number(value) : value;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function truncateAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail) return address;
  return `${address.slice(0, lead)}...${address.slice(-tail)}`;
}

export function formatOrderId(id: string): string {
  return `#${id.slice(0, 4).toUpperCase()}`;
}

export function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

export function formatExpiry(expiresAt: string): string {
  const seconds = Number(expiresAt);
  if (!Number.isFinite(seconds) || seconds >= 9_999_999_999) return "GTC";
  const diff = seconds * 1000 - Date.now();
  if (diff <= 0) return "expired";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}
