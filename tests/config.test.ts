import { describe, expect, it } from "vitest";

import { createRouterFromConfig } from "../src/config.js";

describe("createRouterFromConfig", () => {
  it("builds providers from config and resolves env/ values", async () => {
    process.env.TEST_OPENROUTER_KEY = "sk-openrouter";

    const router = createRouterFromConfig({
      retry: { maxRetries: 1, baseDelayMs: 0 },
      providers: [
        {
          type: "openai-compatible",
          name: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "env/TEST_OPENROUTER_KEY",
          discoverModels: false,
          staticModels: [
            {
              id: "meta-llama/llama-3.3-70b-instruct:free",
              free: true,
              qualityScore: 0.82,
              contextWindow: 128000
            }
          ]
        },
        {
          type: "cloudflare-workers-ai",
          accountId: "acc",
          apiToken: "cf-token",
          staticModels: [
            {
              id: "@cf/meta/llama-3.1-8b-instruct",
              free: true,
              qualityScore: 0.55,
              contextWindow: 8192
            }
          ]
        }
      ]
    });

    const models = await router.listModels();

    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "openrouter" }),
        expect.objectContaining({ provider: "cloudflare" })
      ])
    );
  });
});
