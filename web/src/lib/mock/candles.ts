import type { Candle, Timeframe } from "@/lib/types";

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1H": 3600,
  "4H": 14400,
  "1D": 86400,
};

/** Deterministic PRNG so server/client and repeated renders agree without hydration drift. */
function mulberry32(seed: number) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * tNIGHT/tZKR is a synthetic oracle-referenced pair, not a real listed
 * instrument on any market data provider — candles are generated from a
 * seeded random walk so the chart has stable, realistic-looking history.
 */
export function generateCandles(
  timeframe: Timeframe,
  count = 120,
  basePrice = 0.84,
  seed = 42,
): Candle[] {
  const random = mulberry32(seed + TIMEFRAME_SECONDS[timeframe]);
  const stepSeconds = TIMEFRAME_SECONDS[timeframe];
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - stepSeconds * count;

  const candles: Candle[] = [];
  let price = basePrice * 0.94;
  const drift = 0.00035;
  const volatility = 0.012;

  for (let i = 0; i < count; i++) {
    const time = startTime + i * stepSeconds;
    const open = price;
    const change = (random() - 0.45) * volatility + drift;
    const close = Math.max(0.01, open * (1 + change));
    const wick = Math.abs(close - open) * (0.4 + random() * 0.8);
    const high = Math.max(open, close) + wick * random();
    const low = Math.min(open, close) - wick * random();
    const volume = 800 + random() * 2400;

    candles.push({
      time,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(volume),
    });

    price = close;
  }

  return candles;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function nextTick(last: Candle, seed: number): Candle {
  const random = mulberry32(seed ^ last.time);
  const change = (random() - 0.48) * 0.01;
  const close = Math.max(0.01, last.close * (1 + change));
  const high = Math.max(last.high, close);
  const low = Math.min(last.low, close);
  return {
    ...last,
    close: round(close),
    high: round(high),
    low: round(low),
    volume: last.volume + Math.round(random() * 60),
  };
}
