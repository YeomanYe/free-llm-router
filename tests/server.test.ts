import { describe, expect, it } from "vitest";

import { createFetchHandler } from "../src/server.js";
import { ModelRouter } from "../src/router.js";
import type {
  ChatRequest,
  ChatResponse,
  DiscoveredModel,
  ProviderAdapter
} from "../src/types.js";

class StaticProvider implements ProviderAdapter {
  readonly name = "static";

  readonly kind = "test";

  async listModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: "static/free-model",
        provider: this.name,
        name: "static/free-model",
        free: true,
        source: "static",
        capabilities: { chat: true },
        contextWindow: 32_000,
        qualityScore: 0.7
      }
    ];
  }

  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    return {
      id: "chatcmpl-static",
      model: request.model,
      provider: this.name,
      content: "server ok",
      raw: {}
    };
  }
}

describe("createFetchHandler", () => {
  it("serves an OpenAI-compatible /v1/models endpoint", async () => {
    const router = new ModelRouter({ providers: [new StaticProvider()] });
    const handler = createFetchHandler(router);

    const response = await handler(new Request("http://localhost/v1/models"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([
      expect.objectContaining({
        id: "static/free-model",
        object: "model",
        provider: "static"
      })
    ]);
  });

  it("serves an OpenAI-compatible /v1/chat/completions endpoint", async () => {
    const router = new ModelRouter({ providers: [new StaticProvider()] });
    const handler = createFetchHandler(router);

    const response = await handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }]
        })
      })
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.choices[0].message.content).toBe("server ok");
  });
});
