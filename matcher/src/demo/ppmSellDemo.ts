// ==============================
// DEMO MODE START
// ==============================
/**
 * HACKATHON DEMO ONLY — not part of production behavior.
 *
 * Production SELL-side PPM fills require the user's own wallet to submit
 * settleWithProtocol() on-chain (see contracts/exchange.compact and
 * ppm/PPMService.ts's doc comment); OrderService.reconcileProtocolFill()
 * only marks the order FILLED once that's confirmed on-chain.
 *
 * For a smooth demo recording, DEMO_PPM_SELL=true skips that wait for
 * SELL orders only: the reservation is treated as settled immediately
 * instead of waiting on a real settleWithProtocol transaction. Every step
 * after that point (order CAS to FILLED, orderbook removal, reservation
 * marked EXECUTED, order.filled WS broadcast) is the exact same production
 * code path a real settlement would run — see the two DEMO MODE blocks in
 * matcher/src/services/OrderService.ts for where this is consulted.
 *
 * No contract code, no payment-leg logic, and no BUY-side behavior are
 * touched by this flag.
 *
 * Disable: unset DEMO_PPM_SELL (or set it to anything other than "true")
 * in the Matcher's environment and restart it. No code changes required.
 */
export function isDemoPpmSellEnabled(): boolean {
  return process.env.DEMO_PPM_SELL === 'true';
}
// ==============================
// DEMO MODE END
// ==============================
