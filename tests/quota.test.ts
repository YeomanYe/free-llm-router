import { afterEach, describe, expect, it, vi } from "vitest";

import { probeQuota } from "../src/quota.js";

describe("probeQuota", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a no-key result when the provider has no API key", async () => {
    const result = await probeQuota({ providerName: "groq" });
    expect(result.source).toBe("no-key");
  });

  it("queries OpenRouter's auth/key endpoint and maps the balance fields", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          is_free_tier: true,
          limit: 10,
          limit_remaining: 7.5,
          usage: 2.5,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeQuota({ providerName: "openrouter", apiKey: "sk-test" });

    expect(result.source).toBe("api");
    expect(result.isFreeTier).toBe(true);
    expect(result.balanceUsd).toBe(10);
    expect(result.remainingUsd).toBe(7.5);
    expect(result.usageUsd).toBe(2.5);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/auth/key",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test" },
      }),
    );
  });

  it("falls back to a policy-only result for providers without a balance API", async () => {
    const result = await probeQuota({ providerName: "groq", apiKey: "sk-test" });
    expect(result.source).toBe("policy");
    expect(result.freePolicy).toBeTruthy();
  });

  it("canonicalises the #N suffix so probes hit the same logical provider", async () => {
    const result = await probeQuota({ providerName: "groq#2", apiKey: "sk-test" });
    // Should still resolve groq's policy, not the unknown-policy fallback.
    expect(result.source).toBe("policy");
    expect(result.freePolicy).toMatch(/rpm/i);
  });

  it("reports rate-limited callable state from a 429 probe response", async () => {
    vi.stubGlobal("fetch", async () => new Response("rl", { status: 429 }));

    const result = await probeQuota({
      providerName: "openrouter",
      apiKey: "sk-test",
      baseUrl: "https://openrouter.ai/api/v1",
      probe: true,
      freeModelId: "free/model",
    });
    expect(result.callable).toBe("rate-limited");
  });
});
