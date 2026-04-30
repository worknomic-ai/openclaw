export const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-2.5-flash";

export type GeminiConfig = {
  apiKey?: unknown;
  model?: unknown;
  // Optional baseUrl override — when set, the runtime points at this URL
  // instead of the hardcoded generativelanguage.googleapis.com endpoint.
  // Validated through resolveTrustedGoogleGenerativeAiBaseUrl in api.ts so
  // the same OPENCLAW_GEMINI_TRUSTED_HOSTS allowlist that gates image /
  // audio / video baseUrl overrides also applies here. Hosting environments
  // (Clawsy specifically) point this at their central LLM gateway so the
  // VM never holds the upstream Gemini key directly.
  baseUrl?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function resolveGeminiConfig(searchConfig?: Record<string, unknown>): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return isRecord(gemini) ? gemini : {};
}

export function resolveGeminiApiKey(
  gemini?: GeminiConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return trimToUndefined(gemini?.apiKey) ?? trimToUndefined(env.GEMINI_API_KEY);
}

export function resolveGeminiModel(gemini?: GeminiConfig): string {
  return trimToUndefined(gemini?.model) ?? DEFAULT_GEMINI_WEB_SEARCH_MODEL;
}

export function resolveGeminiBaseUrl(gemini?: GeminiConfig): string | undefined {
  return trimToUndefined(gemini?.baseUrl);
}
