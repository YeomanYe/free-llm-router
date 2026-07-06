import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleProvider } from "../src/providers/openaiCompatible.js";

describe("OpenAICompatibleProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers models from a standard /models response", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: [{ id: "meta-llama/llama-3.3-70b-instruct:free" }, { id: "paid/model" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      freeModelPatterns: [":free"],
    });

    const models = await provider.listModels();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "meta-llama/llama-3.3-70b-instruct:free",
          free: true,
        }),
        expect.objectContaining({ id: "paid/model", free: false }),
      ]),
    );
  });

  it("sends chat requests using the OpenAI-compatible chat completions shape", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "chatcmpl-1",
        model: "test-model",
        choices: [{ message: { content: "hello" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
    });

    const response = await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.content).toBe("hello");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
  });

  it("chat forwards tools/tool_choice and parses toolCalls + stopReason", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "chatcmpl-2",
        model: "gpt-test",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"router"}' },
            }],
          },
        }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
    });

    const res = await provider.chat({
      model: "gpt-test",
      messages: [{ role: "user", content: "find router" }],
      tools: [{ name: "search", description: "web search", parameters: { type: "object", properties: { q: { type: "string" } } } }],
      toolChoice: "auto",
    });

    expect(res.content).toBe("");
    expect(res.toolCalls).toEqual([{ id: "call_1", name: "search", input: { q: "router" } }]);
    expect(res.stopReason).toBe("tool_use");

    const callBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.tools).toEqual([{
      type: "function",
      function: {
        name: "search",
        description: "web search",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    }]);
    expect(callBody.tool_choice).toBe("auto");
  });

  it("chat serializes assistant toolCalls + tool-result messages for multi-turn", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: "chatcmpl-3",
        model: "gpt-test",
        choices: [{ finish_reason: "stop", message: { content: "all done" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleProvider({
      name: "test",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
    });

    await provider.chat({
      model: "gpt-test",
      messages: [
        { role: "user", content: "search and summarize" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "search", input: { q: "x" } }] },
        { role: "tool", content: "result text", toolCallId: "call_1" },
      ],
      tools: [{ name: "search", parameters: { type: "object" } }],
    });

    const callBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "search", arguments: '{"q":"x"}' },
      }],
    });
    expect(callBody.messages[2]).toEqual({
      role: "tool",
      content: "result text",
      tool_call_id: "call_1",
    });
  });
});
