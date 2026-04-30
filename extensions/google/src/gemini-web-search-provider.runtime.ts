import {
  createProviderHttpError,
  formatProviderHttpErrorMessage,
} from "openclaw/plugin-sdk/provider-http";
import {
  buildSearchCacheKey,
  buildUnsupportedSearchFilterResponse,
  DEFAULT_SEARCH_COUNT,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readNumberParam,
  readProviderEnvValue,
  readStringParam,
  resolveCitationRedirectUrl,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { DEFAULT_GOOGLE_API_BASE_URL, resolveTrustedGoogleGenerativeAiBaseUrl } from "../api.js";
import {
  resolveGeminiBaseUrl,
  resolveGeminiConfig,
  resolveGeminiModel,
  type GeminiConfig,
} from "./gemini-web-search-provider.shared.js";

const GEMINI_API_BASE = DEFAULT_GOOGLE_API_BASE_URL;

// Resolve the API base for a single web_search call. When the agent's
// rendered config sets `tools.web.search.gemini.baseUrl`, route through
// that host (validated by the shared trust gate so OPENCLAW_GEMINI_TRUSTED_HOSTS
// applies). Falls back to the hardcoded default for self-hosted /
// API-key-direct setups that don't run a proxy. A throw from the trust
// gate (unknown host, http://, malformed) surfaces as a clean caller-side
// error message; we don't silently fall back, since that would mask a
// misconfigured proxy.
function resolveSearchApiBase(gemini?: GeminiConfig): string {
  const configured = resolveGeminiBaseUrl(gemini);
  if (!configured) {
    return GEMINI_API_BASE;
  }
  return resolveTrustedGoogleGenerativeAiBaseUrl(configured);
}

type GeminiGroundingResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: {
          uri?: string;
          title?: string;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export function resolveGeminiRuntimeApiKey(gemini?: GeminiConfig): string | undefined {
  return (
    readConfiguredSecretString(gemini?.apiKey, "tools.web.search.gemini.apiKey") ??
    readProviderEnvValue(["GEMINI_API_KEY"])
  );
}

async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  apiBase: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: Array<{ url: string; title?: string }> }> {
  const endpoint = `${params.apiBase}/models/${params.model}:generateContent`;

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": params.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: params.query }] }],
          tools: [{ google_search: {} }],
        }),
      },
    },
    async (res) => {
      if (!res.ok) {
        const error = await createProviderHttpError(res, "Gemini API error");
        throw new Error(error.message.replace(/key=[^&\s]+/giu, "key=***"));
      }

      let data: GeminiGroundingResponse;
      try {
        data = (await res.json()) as GeminiGroundingResponse;
      } catch (error) {
        const safeError = String(error).replace(/key=[^&\s]+/giu, "key=***");
        throw new Error(`Gemini API returned invalid JSON: ${safeError}`, { cause: error });
      }

      if (data.error) {
        const rawMessage = data.error.message || data.error.status || "unknown";
        throw new Error(
          formatProviderHttpErrorMessage({
            label: "Gemini API error",
            status: data.error.code ?? 0,
            detail: rawMessage.replace(/key=[^&\s]+/giu, "key=***"),
          }),
        );
      }

      const candidate = data.candidates?.[0];
      const content =
        candidate?.content?.parts
          ?.map((part) => part.text)
          .filter(Boolean)
          .join("\n") ?? "No response";
      const rawCitations = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .filter((chunk) => chunk.web?.uri)
        .map((chunk) => ({
          url: chunk.web!.uri!,
          title: chunk.web?.title || undefined,
        }));

      const citations: Array<{ url: string; title?: string }> = [];
      for (let index = 0; index < rawCitations.length; index += 10) {
        const batch = rawCitations.slice(index, index + 10);
        const resolved = await Promise.all(
          batch.map(async (citation) =>
            Object.assign({}, citation, { url: await resolveCitationRedirectUrl(citation.url) }),
          ),
        );
        citations.push(...resolved);
      }

      return { content, citations };
    },
  );
}

export async function executeGeminiSearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const unsupportedResponse = buildUnsupportedSearchFilterResponse(args, "gemini");
  if (unsupportedResponse) {
    return unsupportedResponse;
  }

  const geminiConfig = resolveGeminiConfig(searchConfig);
  const apiKey = resolveGeminiRuntimeApiKey(geminiConfig);
  if (!apiKey) {
    return {
      error: "missing_gemini_api_key",
      message:
        "web_search (gemini) needs an API key. Set GEMINI_API_KEY in the Gateway environment, or configure tools.web.search.gemini.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const query = readStringParam(args, "query", { required: true });
  const count =
    readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const model = resolveGeminiModel(geminiConfig);
  const cacheKey = buildSearchCacheKey([
    "gemini",
    query,
    resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    model,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const apiBase = resolveSearchApiBase(geminiConfig);
  const result = await runGeminiSearch({
    query,
    apiKey,
    model,
    apiBase,
    timeoutSeconds: resolveSearchTimeoutSeconds(searchConfig),
  });
  const payload = {
    query,
    provider: "gemini",
    model,
    tookMs: Date.now() - start,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "gemini",
      wrapped: true,
    },
    content: wrapWebContent(result.content),
    citations: result.citations,
  };
  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}
