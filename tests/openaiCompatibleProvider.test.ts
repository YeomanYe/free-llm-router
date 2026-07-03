import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openaiCompatible.js";

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers models from a standard /models response", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [
          { id: "meta-llama/llama-3.3-70b-instruct:free" },
          { id: "paid/model" }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      freeModelPatterns: [":free"]
    });

    const models = await provider.listModels();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" })
      })
    );
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "meta-llama/llama-3.3-70b-instruct:free",
          free: true
        }),
        expect.objectContaining({ id: "paid/model", free: false })
      ])
    );
  });

  it("sends chat requests using the OpenAI-compatible chat completions shape", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "chatcmpl-1",
        model: "test-model",
        choices: [{ message: { content: "hello" } }]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test"
    });

    const response = await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          stream: false
        })
      })
    );
  });
});
