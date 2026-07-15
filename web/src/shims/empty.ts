/**
 * Stub for Node-only modules (e.g. `fs`) that some Midnight SDK packages
 * statically import for code paths this browser client never exercises
 * (this app supplies its own zkConfigProvider/providers instead of letting
 * those packages touch the filesystem). Aliased in next.config.ts for
 * browser bundles only.
 */
export {};
