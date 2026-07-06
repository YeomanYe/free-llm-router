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
              contextWindow: 128000,
            },
          ],
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
              contextWindow: 8192,
            },
          ],
        },
      ],
    });

    const models = await router.listModels();

    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "openrouter" }),
        expect.objectContaining({ provider: "cloudflare" }),
      ]),
    );
  });

  it("expands numeric-suffixed env vars into fallback provider instances", async () => {
    process.env.TEST_MULTI_KEY = "sk-primary";
    process.env.TEST_MULTI_KEY2 = "sk-second";
    process.env.TEST_MULTI_KEY3 = "sk-third";

    const router = createRouterFromConfig({
      providers: [
        {
          type: "openai-compatible",
          name: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "env/TEST_MULTI_KEY",
          discoverModels: false,
          staticModels: [
            {
              id: "meta-llama/llama-3.3-70b-instruct:free",
              free: true,
              qualityScore: 0.82,
              contextWindow: 128000,
            },
          ],
        },
      ],
    });

    const models = await router.listModels();
    const providerNames = models.map((model) => model.provider);

    expect(providerNames).toEqual(["openrouter", "openrouter#2", "openrouter#3"]);
  });

  it("throws when env/ reference has no matching variable", () => {
    delete process.env.TEST_MISSING_KEY;

    expect(() =>
      createRouterFromConfig({
        providers: [
          {
            type: "openai-compatible",
            name: "x",
            baseUrl: "https://example.com/v1",
            apiKey: "env/TEST_MISSING_KEY",
            discoverModels: false,
            staticModels: [{ id: "m", free: true }],
          },
        ],
      }),
    ).toThrow(/TEST_MISSING_KEY/);
  });

  it("constructs an anthropic-messages provider", () => {
    const router = createRouterFromConfig({
      providers: [
        {
          type: "anthropic-messages",
          name: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKey: "sk-test",
          staticModels: [{ id: "claude-sonnet-4-6" }],
        },
      ],
    });
    expect(router).toBeDefined();
    // provider is private; verify indirectly via listModels through the router if exposed,
    // otherwise just assert construction did not throw.
  });

  it("anthropic-messages resolves env/ apiKey", () => {
    process.env.ANTHROPIC_TEST_KEY = "from-env";
    const router = createRouterFromConfig({
      providers: [
        {
          type: "anthropic-messages",
          name: "anthropic",
          baseUrl: "https://api.anthropic.com",
          apiKey: "env/ANTHROPIC_TEST_KEY",
          staticModels: [{ id: "claude-sonnet-4-6" }],
        },
      ],
    });
    expect(router).toBeDefined();
    delete process.env.ANTHROPIC_TEST_KEY;
  });

  it("rejects anthropic-messages with missing apiKey", () => {
    expect(() =>
      createRouterFromConfig({
        providers: [
          {
            type: "anthropic-messages",
            name: "anthropic",
            baseUrl: "https://api.anthropic.com",
            // apiKey missing
            staticModels: [{ id: "claude-sonnet-4-6" }],
          } as unknown as Record<string, unknown>,
        ],
      }),
    ).toThrow();
  });
});
