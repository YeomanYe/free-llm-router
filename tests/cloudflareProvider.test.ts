import { afterEach, describe, expect, it, vi } from "vitest";

import { CloudflareWorkersAIProvider } from "../src/providers/cloudflare.js";

describe("CloudflareWorkersAIProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Cloudflare chat completions endpoint with account credentials", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "cf-chat-1",
        model: "@cf/meta/llama-3.1-8b-instruct",
        choices: [{ message: { content: "cloudflare ok" } }]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CloudflareWorkersAIProvider({
      accountId: "acc_123",
      apiToken: "cf-token",
      staticModels: [
        {
          id: "@cf/meta/llama-3.1-8b-instruct",
          free: true,
          contextWindow: 8_192,
          qualityScore: 0.55
        }
      ]
    });

    const response = await provider.chat({
      model: "@cf/meta/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response.content).toBe("cloudflare ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acc_123/ai/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer cf-token"
        })
      })
    );
  });
});
