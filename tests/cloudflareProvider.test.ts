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
        choices: [{ message: { content: "cloudflare ok" } }],
      }),
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
          qualityScore: 0.55,
        },
      ],
    });

    const response = await provider.chat({
      model: "@cf/meta/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.content).toBe("cloudflare ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/acc_123/ai/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer cf-token",
        }),
      }),
    );
  });

  it("auto-discovers the account id when only the api token is configured", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.cloudflare.com/client/v4/accounts") {
        return Response.json({ result: [{ id: "auto_acc", name: "primary" }] });
      }
      return Response.json({
        id: "cf-chat-2",
        model: "@cf/meta/llama-3.1-8b-instruct",
        choices: [{ message: { content: "discovered ok" } }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CloudflareWorkersAIProvider({
      apiToken: "cf-token",
      staticModels: [{ id: "@cf/meta/llama-3.1-8b-instruct", free: true }],
    });

    const first = await provider.chat({
      model: "@cf/meta/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: "hi" }],
    });
    const second = await provider.chat({
      model: "@cf/meta/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: "again" }],
    });

    expect(first.content).toBe("discovered ok");
    expect(second.content).toBe("discovered ok");

    const chatCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === "string" && url.includes("/ai/v1/chat/completions"),
    );
    expect(chatCalls).toHaveLength(2);
    for (const [url] of chatCalls) {
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/auto_acc/ai/v1/chat/completions",
      );
    }

    const discoveryCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "https://api.cloudflare.com/client/v4/accounts",
    );
    expect(discoveryCalls).toHaveLength(1);
  });
});
