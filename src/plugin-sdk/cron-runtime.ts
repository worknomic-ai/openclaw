// Plugin-facing programmatic access to the gateway's CronService. The
// CronService is constructed in `gateway/server-cron.ts` at boot and
// registered via `setCronServiceForRuntime`. Plugins load it via the
// `getCronServiceForRuntime` re-export here and call its add/list/
// update/remove/run methods directly — bypassing the gateway-RPC layer
// (which requires URL+token threading and JSON-shape param validation
// that's awkward for in-process callers).
//
// Why this seam exists:
//   The OpenClaw cron tool surfaces `cron.add`/`cron.list`/etc. as
//   gateway RPC methods, designed for LLM-callable tools that may run
//   in subprocesses. Plugin code runs in-process and shouldn't pay the
//   RPC tax. This SDK gives plugin authors a typed Promise<CronJob>
//   surface that matches what the gateway uses internally.
//
// Usage:
//   import { getCronServiceForRuntime } from "openclaw/plugin-sdk/cron-runtime";
//   const cron = getCronServiceForRuntime();
//   if (!cron) throw new Error("cron service not initialized");
//   const job = await cron.add({
//     name: "morning brief",
//     schedule: { kind: "cron", expr: "0 8 * * *" },
//     payload: { kind: "agentTurn", message: "Send the morning brief." },
//     sessionTarget: "current",
//     // …
//   });
//
// Always check for null — the registry is unset during early boot, in
// CLI commands that don't construct a cron service (`openclaw doctor`),
// and in test harnesses that don't boot the full gateway.

export { getCronServiceForRuntime, setCronServiceForRuntime } from "../cron/runtime-registry.js";

export { CronService } from "../cron/service.js";
export type {
  CronListPageOptions,
  CronListPageResult,
  CronServiceContract,
  CronServiceDeps,
  CronServiceRunResult,
  CronWakeResult,
} from "../cron/service.js";
export type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronSchedule,
  CronSessionTarget,
} from "../cron/types.js";
