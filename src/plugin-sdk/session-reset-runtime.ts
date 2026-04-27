// Plugin-callable session reset. Plugins (e.g. Clawsy's soft-reset
// tool) run in the same process as the gateway and need a stable,
// exports-map-blessed path to invoke this. Deep-importing dist
// internals breaks the moment the bundler restructures hash-suffixed
// chunks — which is what shipped before this seam existed.
//
// Lazy-side runtime subpath rather than re-exporting through
// `gateway-runtime` so hot channel entrypoints don't pull the reset
// service into their startup graph.

export { performGatewaySessionReset } from "../gateway/session-reset-service.js";
