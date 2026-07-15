/**
 * Browser-only replacement for `isomorphic-ws` (aliased in next.config.ts).
 *
 * @midnight-ntwrk/midnight-js-indexer-public-data-provider does
 * `import * as ws from 'isomorphic-ws'` and reads `ws.WebSocket` off of it,
 * but isomorphic-ws's own browser build only has a default export, so
 * Turbopack's static ESM analysis correctly reports `ws.WebSocket` as
 * nonexistent and fails the build. This shim provides both the default
 * export (matching isomorphic-ws's own shape) and a named `WebSocket`
 * export, backed by the browser's native implementation.
 */
export const WebSocket = globalThis.WebSocket;
export default globalThis.WebSocket;
