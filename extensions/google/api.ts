import {
  resolveProviderHttpRequestConfig,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import { parseGeminiAuth } from "./gemini-auth.js";
export { parseGeminiAuth };
export { applyGoogleGeminiModelDefault, GOOGLE_GEMINI_DEFAULT_MODEL } from "./onboard.js";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
} from "./provider-policy.js";
export { normalizeAntigravityModelId, normalizeGoogleModelId } from "./model-id.js";
export {
  createGoogleThinkingPayloadWrapper,
  createGoogleThinkingStreamWrapper,
  isGoogleGemini3FlashModel,
  isGoogleGemini3ProModel,
  isGoogleGemini3ThinkingLevelModel,
  isGoogleThinkingRequiredModel,
  resolveGoogleGemini3ThinkingLevel,
  sanitizeGoogleThinkingPayload,
  stripInvalidGoogleThinkingBudget,
  type GoogleThinkingInputLevel,
  type GoogleThinkingLevel,
} from "./thinking-api.js";
export {
  buildGoogleGenerativeAiParams,
  createGoogleGenerativeAiTransportStreamFn,
} from "./transport-stream.js";
export {
  DEFAULT_GOOGLE_API_BASE_URL,
  isGoogleGenerativeAiApi,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleGenerativeAiBaseUrl,
  normalizeGoogleProviderConfig,
  resolveGoogleGenerativeAiApiOrigin,
  resolveGoogleGenerativeAiTransport,
  shouldNormalizeGoogleGenerativeAiProviderConfig,
  shouldNormalizeGoogleProviderConfig,
} from "./provider-policy.js";
export { buildGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
export { buildGoogleProvider } from "./provider-registration.js";

type GoogleGenerativeAiRequestOverrides = ProviderRequestTransportOverrides & {
  allowPrivateNetwork?: boolean;
};

// Hostname allowlist for the Gemini-shape baseUrl. Default = the real Google
// endpoint. The OPENCLAW_GEMINI_TRUSTED_HOSTS env var (comma-separated list)
// extends the allowlist for self-hosted Gemini-shape proxies. Used by the
// Clawsy fork to route Gemini-shape video/audio traffic through our gateway,
// which translates to a local Qwen2.5-VL on an L4 GPU. The trust here is
// transport-level only — auth is unchanged (still parseGeminiAuth on the
// apiKey), so a misconfigured trusted host can leak the api key to the wrong
// origin but cannot exfiltrate user data via the request body alone.
function isTrustedGeminiHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "generativelanguage.googleapis.com") {
    return true;
  }
  const extra = (process.env.OPENCLAW_GEMINI_TRUSTED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(lower);
}

// Exported so the gemini-web-search-provider runtime (and any other
// gemini-shape sub-extension) can route its endpoint through the same
// trust gate as the main image/audio/video transport. Same env-var
// allowlist (OPENCLAW_GEMINI_TRUSTED_HOSTS) governs all paths so there's
// only one place to whitelist a self-hosted proxy. Original Clawsy fork
// patch added the allowlist for image/audio/video; widening the export
// surface lets web_search join without duplicating the trust logic.
export function resolveTrustedGoogleGenerativeAiBaseUrl(baseUrl?: string): string {
  const normalized =
    normalizeGoogleGenerativeAiBaseUrl(baseUrl ?? DEFAULT_GOOGLE_API_BASE_URL) ??
    DEFAULT_GOOGLE_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(
      "Google Generative AI baseUrl must be a valid https URL on generativelanguage.googleapis.com",
    );
  }
  if (url.protocol !== "https:" || !isTrustedGeminiHostname(url.hostname)) {
    throw new Error(
      "Google Generative AI baseUrl must use https://generativelanguage.googleapis.com (or a host listed in OPENCLAW_GEMINI_TRUSTED_HOSTS)",
    );
  }
  return normalized;
}

export function resolveGoogleGenerativeAiHttpRequestConfig(params: {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  request?: GoogleGenerativeAiRequestOverrides;
  capability: "image" | "audio" | "video";
  transport: "http" | "media-understanding";
}) {
  return resolveProviderHttpRequestConfig({
    baseUrl: resolveTrustedGoogleGenerativeAiBaseUrl(params.baseUrl),
    defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
    allowPrivateNetwork: params.request?.allowPrivateNetwork,
    headers: params.headers,
    request: params.request,
    defaultHeaders: parseGeminiAuth(params.apiKey).headers,
    provider: "google",
    api: "google-generative-ai",
    capability: params.capability,
    transport: params.transport,
  });
}
