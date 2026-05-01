// Plugin-routed cron jobs let an in-process plugin own the dispatch path
// for cron jobs whose `sessionTarget` is `plugin:<pluginId>`. The plugin
// registers a handler at boot via `registerCronJobHandler(pluginId, fn)`
// (re-exported from `openclaw/plugin-sdk/cron-runtime`); CronService's
// timer invokes that handler when a matching job fires, instead of going
// through the built-in main-session or isolated-agent lanes.
//
// This seam is generic on purpose: the plugin id is opaque to core, the
// handler decides what to do with the job (route through a synthetic
// inbound, bridge to an external system, fan out to channels, etc.).
//
// Registration is process-scoped. A single plugin id may have at most
// one registered handler; re-registering replaces the previous one.

import { assertSafeCronSessionTargetPluginId } from "./session-target.js";
import type { CronDeliveryTrace, CronJob, CronRunOutcome, CronRunTelemetry } from "./types.js";

export type CronJobHandlerParams = {
  /** Plugin id parsed from `sessionTarget: "plugin:<pluginId>"`. */
  pluginId: string;
  /** The full job snapshot at fire time. */
  job: CronJob;
  /** AbortSignal from CronService's timeout policy; honor it on long work. */
  abortSignal?: AbortSignal;
};

export type CronJobHandlerResult = CronRunOutcome &
  CronRunTelemetry & {
    /** The plugin already delivered output to its destination. */
    delivered?: boolean;
    /** Delivery was attempted (even if final ack uncertain). */
    deliveryAttempted?: boolean;
    /** Optional delivery telemetry shaped like the isolated lane's. */
    delivery?: CronDeliveryTrace;
  };

export type CronJobHandler = (params: CronJobHandlerParams) => Promise<CronJobHandlerResult>;

const handlers = new Map<string, CronJobHandler>();

/**
 * Register a handler for cron jobs whose sessionTarget is `plugin:<pluginId>`.
 * Returns an unregister fn that removes the handler if it is still the one
 * registered (idempotent if the slot was reassigned).
 */
export function registerCronJobHandler(pluginId: string, handler: CronJobHandler): () => void {
  const id = assertSafeCronSessionTargetPluginId(pluginId);
  handlers.set(id, handler);
  return () => {
    if (handlers.get(id) === handler) {
      handlers.delete(id);
    }
  };
}

export function getCronJobHandler(pluginId: string): CronJobHandler | undefined {
  return handlers.get(pluginId);
}

/** Test-only: clear every registered handler. */
export function __clearCronJobHandlersForTests() {
  handlers.clear();
}
