// Module-level registry of the active CronService instance, used to
// expose programmatic cron CRUD to plugins via
// `openclaw/plugin-sdk/cron-runtime`. The gateway boot path
// (`server-cron.ts:buildGatewayCronService`) registers the constructed
// CronService here; plugin code reads it via `getCronServiceForRuntime`.
//
// Why a singleton instead of threading the service through
// OpenClawPluginApi.runtime: plugins load on a wide range of paths
// (boot-time `register`, hot-reload re-imports, deferred runtime
// imports), and not all of them have access to the gateway live state.
// A module-level registry sidesteps that without growing the runtime
// API surface. Callers MUST guard for null — the registry can be unset
// during early boot, in test harnesses, or in non-gateway runtimes
// (CLI commands like `openclaw doctor`).
//
// Lifecycle:
//   - Gateway boot: setCronServiceForRuntime(cron) after CronService
//     construction.
//   - Gateway shutdown / reload: setCronServiceForRuntime(null) to
//     prevent stale references on hot-reload (the next boot path will
//     register the fresh instance).

import type { CronService } from "./service.js";

let registered: CronService | null = null;

export function setCronServiceForRuntime(svc: CronService | null): void {
  registered = svc;
}

export function getCronServiceForRuntime(): CronService | null {
  return registered;
}
