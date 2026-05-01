export const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";
export const INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR = "invalid cron sessionTarget plugin id";

export function isInvalidCronSessionTargetIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR;
}

export function isInvalidCronSessionTargetPluginIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR;
}

export function assertSafeCronSessionTargetId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  return trimmed;
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function assertSafeCronSessionTargetPluginId(pluginId: string): string {
  const trimmed = pluginId.trim().toLowerCase();
  if (!trimmed) {
    throw new Error(INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR);
  }
  if (!PLUGIN_ID_PATTERN.test(trimmed)) {
    throw new Error(INVALID_CRON_SESSION_TARGET_PLUGIN_ID_ERROR);
  }
  return trimmed;
}
