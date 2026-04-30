import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebSearchConfig,
} from "./legacy-web-search-migrate.js";

describe("legacy web search config", () => {
  it("migrates legacy provider config through bundled web search ownership metadata", () => {
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            provider: "grok",
            apiKey: "brave-key",
            grok: {
              apiKey: "xai-key",
              model: "grok-4-search",
            },
            kimi: {
              apiKey: "kimi-key",
              model: "kimi-k2.5",
            },
          },
        },
      },
    });

    expect(res.config.tools?.web?.search).toEqual({
      provider: "grok",
    });
    expect(res.config.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "brave-key",
        },
      },
    });
    expect(res.config.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-key",
          model: "grok-4-search",
        },
      },
    });
    expect(res.config.plugins?.entries?.moonshot).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "kimi-key",
          model: "kimi-k2.5",
        },
      },
    });
    expect(res.changes).toEqual([
      "Moved tools.web.search.apiKey → plugins.entries.brave.config.webSearch.apiKey.",
      "Moved tools.web.search.grok → plugins.entries.xai.config.webSearch.",
      "Moved tools.web.search.kimi → plugins.entries.moonshot.config.webSearch.",
    ]);
  });

  it("lists legacy paths for metadata-owned provider config", () => {
    expect(
      listLegacyWebSearchConfigPaths({
        tools: {
          web: {
            search: {
              apiKey: "brave-key",
              grok: {
                apiKey: "xai-key",
                model: "grok-4-search",
              },
              kimi: {
                model: "kimi-k2.5",
              },
            },
          },
        },
      }),
    ).toEqual([
      "tools.web.search.apiKey",
      "tools.web.search.grok.apiKey",
      "tools.web.search.grok.model",
      "tools.web.search.kimi.model",
    ]);
  });

  it("participates in shared legacy detection and migration", () => {
    const rawConfig = {
      tools: {
        web: {
          search: {
            provider: "brave",
            brave: {
              apiKey: "brave-key",
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(findLegacyConfigIssues(rawConfig)).toEqual([
      {
        path: "tools.web.search",
        message:
          'tools.web.search provider-owned config moved to plugins.entries.<plugin>.config.webSearch. Run "openclaw doctor --fix".',
      },
    ]);

    const migrated = migrateLegacyConfig(rawConfig);
    expect(migrated.config).not.toBeNull();
    expect(migrated.config?.tools?.web?.search).toEqual({
      provider: "brave",
    });
    expect(migrated.config?.plugins?.entries?.brave).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "brave-key",
        },
      },
    });
    expect(migrated.changes).toEqual([
      "Moved tools.web.search.brave → plugins.entries.brave.config.webSearch.",
    ]);
  });

  it("leaves tools.web.search.gemini in place (runtime-config path, not legacy)", () => {
    const res = migrateLegacyWebSearchConfig<OpenClawConfig>({
      tools: {
        web: {
          search: {
            provider: "gemini",
            gemini: {
              apiKey: "gemini-key",
              model: "gemini-2.5-flash",
              baseUrl: "https://example.test/api/v1/llm/gemini/v1beta",
            },
          },
        },
      },
    });

    expect(res.changes).toEqual([]);
    expect(res.config.tools?.web?.search).toEqual({
      provider: "gemini",
      gemini: {
        apiKey: "gemini-key",
        model: "gemini-2.5-flash",
        baseUrl: "https://example.test/api/v1/llm/gemini/v1beta",
      },
    });
    expect(res.config.plugins?.entries?.google).toBeUndefined();
  });
});
