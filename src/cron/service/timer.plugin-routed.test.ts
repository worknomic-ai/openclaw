import { describe, expect, it, vi } from "vitest";
import { __clearCronJobHandlersForTests, registerCronJobHandler } from "../plugin-handlers.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type CronServiceState } from "./state.js";
import { executeJobCore } from "./timer.js";

function buildState(): CronServiceState {
  return createCronServiceState({
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    storePath: "/tmp/plugin-routed/cron.json",
    cronEnabled: true,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function buildPluginRoutedJob(pluginId: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "test plugin-routed job",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "at", at: "2026-01-01T00:00:00.000Z" },
    sessionTarget: `plugin:${pluginId}`,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "irrelevant" },
    ...overrides,
  } as CronJob;
}

describe("executeJobCore: plugin-routed dispatch", () => {
  it("invokes the registered plugin handler with the job and returns its result", async () => {
    __clearCronJobHandlersForTests();
    const handler = vi.fn(async () => ({
      status: "ok" as const,
      summary: "delivered via plugin",
      delivered: true,
      sessionKey: "wa:peer:1234",
    }));
    const unregister = registerCronJobHandler("clawsy", handler);
    try {
      const job = buildPluginRoutedJob("clawsy");
      const result = await executeJobCore(buildState(), job);

      expect(handler).toHaveBeenCalledTimes(1);
      const params = handler.mock.calls[0][0];
      expect(params.pluginId).toBe("clawsy");
      expect(params.job).toBe(job);

      expect(result.status).toBe("ok");
      expect(result.summary).toBe("delivered via plugin");
      expect(result.delivered).toBe(true);
      expect(result.sessionKey).toBe("wa:peer:1234");
    } finally {
      unregister();
    }
  });

  it("does NOT call runIsolatedAgentJob for plugin-routed jobs", async () => {
    __clearCronJobHandlersForTests();
    const handler = vi.fn(async () => ({ status: "ok" as const }));
    const unregister = registerCronJobHandler("clawsy", handler);
    try {
      const state = buildState();
      const runIsolated = state.deps.runIsolatedAgentJob as ReturnType<typeof vi.fn>;
      await executeJobCore(state, buildPluginRoutedJob("clawsy"));
      expect(runIsolated).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("returns 'skipped' with a clear error when no handler is registered", async () => {
    __clearCronJobHandlersForTests();
    const result = await executeJobCore(buildState(), buildPluginRoutedJob("clawsy"));
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/no cron job handler registered for plugin "clawsy"/);
  });

  it("captures handler exceptions as 'error' status", async () => {
    __clearCronJobHandlersForTests();
    const unregister = registerCronJobHandler("clawsy", async () => {
      throw new Error("boom");
    });
    try {
      const result = await executeJobCore(buildState(), buildPluginRoutedJob("clawsy"));
      expect(result.status).toBe("error");
      expect(result.error).toContain("boom");
    } finally {
      unregister();
    }
  });

  it("returns abort error when the abort signal fires before dispatch", async () => {
    __clearCronJobHandlersForTests();
    const handler = vi.fn(async () => ({ status: "ok" as const }));
    const unregister = registerCronJobHandler("clawsy", handler);
    try {
      const ctrl = new AbortController();
      ctrl.abort();
      const result = await executeJobCore(
        buildState(),
        buildPluginRoutedJob("clawsy"),
        ctrl.signal,
      );
      expect(result.status).toBe("error");
      expect(handler).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("dispatches independently per plugin id", async () => {
    __clearCronJobHandlersForTests();
    const a = vi.fn(async () => ({ status: "ok" as const, summary: "a" }));
    const b = vi.fn(async () => ({ status: "ok" as const, summary: "b" }));
    const unA = registerCronJobHandler("alpha", a);
    const unB = registerCronJobHandler("beta", b);
    try {
      await executeJobCore(buildState(), buildPluginRoutedJob("alpha"));
      await executeJobCore(buildState(), buildPluginRoutedJob("beta"));
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(a.mock.calls[0][0].pluginId).toBe("alpha");
      expect(b.mock.calls[0][0].pluginId).toBe("beta");
    } finally {
      unA();
      unB();
    }
  });

  it("registerCronJobHandler returns an unregister fn that is idempotent", async () => {
    __clearCronJobHandlersForTests();
    const handler = vi.fn(async () => ({ status: "ok" as const }));
    const unregister = registerCronJobHandler("clawsy", handler);
    unregister();
    unregister(); // second call is a no-op
    const result = await executeJobCore(buildState(), buildPluginRoutedJob("clawsy"));
    expect(result.status).toBe("skipped");
  });

  it("re-registering replaces the previous handler", async () => {
    __clearCronJobHandlersForTests();
    const first = vi.fn(async () => ({ status: "ok" as const, summary: "first" }));
    const second = vi.fn(async () => ({ status: "ok" as const, summary: "second" }));
    registerCronJobHandler("clawsy", first);
    const unregisterSecond = registerCronJobHandler("clawsy", second);
    try {
      const result = await executeJobCore(buildState(), buildPluginRoutedJob("clawsy"));
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      expect(result.summary).toBe("second");
    } finally {
      unregisterSecond();
    }
  });
});
