"use client";

import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { motion } from "framer-motion";
import {
  Maximize2,
  Minimize2,
  MousePointer2,
  Pencil,
  Ruler,
  TrendingUp,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { generateCandles, nextTick } from "@/lib/mock/candles";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Candle, Timeframe } from "@/lib/types";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1H", "4H", "1D"];
type ChartStyle = "candles" | "line" | "area";

const CHART_STYLES: { key: ChartStyle; label: string }[] = [
  { key: "candles", label: "Candles" },
  { key: "line", label: "Line" },
  { key: "area", label: "Area" },
];

/** Drawing-tool affordances from TradingView Advanced Charts. lightweight-charts
 *  has no built-in drawing/indicator toolbox — these are stubbed here so the
 *  rail matches the wireframe and slots into Advanced Charts later with no
 *  layout change once that licensed package is available. */
const DRAWING_TOOLS = [
  { icon: MousePointer2, label: "Cursor" },
  { icon: TrendingUp, label: "Trend Line" },
  { icon: Pencil, label: "Brush" },
  { icon: Ruler, label: "Measure" },
];

interface TradingChartProps {
  pairLabel: string;
  basePrice: number;
}

export function TradingChart({ pairLabel, basePrice }: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick" | "Line" | "Area"> | null>(
    null,
  );
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const candlesRef = useRef<Candle[]>([]);

  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const [chartStyle, setChartStyle] = useState<ChartStyle>("candles");
  const [fullscreen, setFullscreen] = useState(false);
  const [ohlc, setOhlc] = useState<Candle | null>(null);

  // Chart lifecycle: create once, tear down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { color: "transparent" },
        textColor: "rgba(255,255,255,0.65)",
        fontFamily: "var(--font-geist-sans)",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(109,94,245,0.5)",
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: "#6d5ef5",
        },
        horzLine: {
          color: "rgba(109,94,245,0.5)",
          width: 1,
          style: LineStyle.Solid,
          labelBackgroundColor: "#6d5ef5",
        },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
    });

    chartRef.current = chart;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Rebuild series when timeframe or chart style changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (seriesRef.current) chart.removeSeries(seriesRef.current);
    if (volumeSeriesRef.current) chart.removeSeries(volumeSeriesRef.current);

    const candles = generateCandles(timeframe, 140, basePrice);
    candlesRef.current = candles;

    let series: ISeriesApi<"Candlestick" | "Line" | "Area">;

    if (chartStyle === "candles") {
      series = chart.addSeries(CandlestickSeries, {
        upColor: "#ffffff",
        downColor: "rgba(255,255,255,0.25)",
        borderUpColor: "#ffffff",
        borderDownColor: "rgba(255,255,255,0.35)",
        wickUpColor: "rgba(255,255,255,0.8)",
        wickDownColor: "rgba(255,255,255,0.3)",
      });
      series.setData(
        candles.map((c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
    } else if (chartStyle === "line") {
      series = chart.addSeries(LineSeries, {
        color: "#6d5ef5",
        lineWidth: 2,
      });
      series.setData(
        candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })),
      );
    } else {
      series = chart.addSeries(AreaSeries, {
        lineColor: "#6d5ef5",
        topColor: "rgba(109,94,245,0.32)",
        bottomColor: "rgba(109,94,245,0.02)",
        lineWidth: 2,
      });
      series.setData(
        candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })),
      );
    }

    seriesRef.current = series;

    const priceLine = candles[candles.length - 1];
    series.createPriceLine({
      price: priceLine.close,
      color: "#6d5ef5",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "oracle ref",
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      color: "rgba(255,255,255,0.16)",
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });
    volumeSeries.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.volume,
        color:
          c.close >= c.open
            ? "rgba(255,255,255,0.22)"
            : "rgba(109,94,245,0.3)",
      })),
    );
    volumeSeriesRef.current = volumeSeries;

    chart.timeScale().fitContent();
    setOhlc(priceLine);
  }, [timeframe, chartStyle, basePrice]);

  // Simulated live tick stream — swap for the Matcher/oracle WS feed later.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const series = seriesRef.current;
      const candles = candlesRef.current;
      if (!series || candles.length === 0) return;

      const last = candles[candles.length - 1];
      const updated = nextTick(last, Date.now());
      candles[candles.length - 1] = updated;

      if (chartStyle === "candles") {
        series.update({
          time: updated.time as UTCTimestamp,
          open: updated.open,
          high: updated.high,
          low: updated.low,
          close: updated.close,
        });
      } else {
        series.update({
          time: updated.time as UTCTimestamp,
          value: updated.close,
        });
      }
      setOhlc(updated);
    }, 2500);

    return () => window.clearInterval(interval);
  }, [chartStyle]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.99 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className={cn(
        "flex flex-1 flex-col overflow-hidden",
        fullscreen &&
          "fixed inset-0 z-50 bg-background p-4 md:p-6",
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 shrink items-center gap-1 overflow-x-auto scrollbar-none">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tf === timeframe
                  ? "bg-primary text-white"
                  : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
              )}
            >
              {tf}
            </button>
          ))}
          <div className="mx-2 h-4 w-px bg-border" />
          {CHART_STYLES.map((s) => (
            <button
              key={s.key}
              onClick={() => setChartStyle(s.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                s.key === chartStyle
                  ? "text-foreground bg-white/[0.06]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden text-xs italic text-muted-foreground lg:inline">
            Reference price line — oracle feed, not an order book
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setFullscreen((v) => !v)}
                aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {fullscreen ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {ohlc && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
          <span>{pairLabel}</span>
          <span>O <span className="text-foreground/80">{formatPrice(ohlc.open)}</span></span>
          <span>H <span className="text-foreground/80">{formatPrice(ohlc.high)}</span></span>
          <span>L <span className="text-foreground/80">{formatPrice(ohlc.low)}</span></span>
          <span>C <span className="text-foreground">{formatPrice(ohlc.close)}</span></span>
          <span>Vol <span className="text-foreground/80">{Math.round(ohlc.volume).toLocaleString()}</span></span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="hidden w-11 flex-col items-center gap-1 border-r border-border py-2 sm:flex">
          {DRAWING_TOOLS.map((tool) => (
            <Tooltip key={tool.label}>
              <TooltipTrigger asChild>
                <button
                  aria-label={tool.label}
                  className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <tool.icon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{tool.label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div
          ref={containerRef}
          className="relative min-h-[320px] flex-1 overflow-hidden"
        />
      </div>
    </motion.div>
  );
}
