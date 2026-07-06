import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesProvider } from "../src/providers/anthropic.js";
import { ProviderError } from "../src/errors.js";

function anthropicRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("AnthropicMessagesProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  const opts = {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-test",
    staticModels: [{ id: "claude-sonnet-4-6", qualityScore: 0.95 }],
  };

  it("chat sends /v1/messages with dual auth + anthropic-version and parses content text", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return anthropicRes({
          id: "msg_1",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Hello" }, { type: "text", text: " world" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        });
      }),
    );
    const p = new AnthropicMessagesProvider(opts);
    const res = await p.chat({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    expect(captured!.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["authorization"]).toBe("Bearer sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("Hello world");
    expect(res.model).toBe("claude-sonnet-4-6");
    expect(res.provider).toBe("anthropic");
  });

  it("chat lifts a leading system message into the system field", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init;
        return anthropicRes({ id: "1", model: "m", content: [{ type: "text", text: "ok" }] });
      }),
    );
    const p = new AnthropicMessagesProvider(opts);
    await p.chat({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
      maxTokens: 50,
    });
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("chat throws ProviderError on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => anthropicRes({ error: "bad" }, 400)),
    );
    const p = new AnthropicMessagesProvider(opts);
    await expect(
      p.chat({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("object sends tools + tool_choice and returns tool_use.input as object", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init;
        return anthropicRes({
          id: "msg_2",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "tu_1", name: "structured_output", input: { category: "AI", is_ad: false } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }),
    );
    const p = new AnthropicMessagesProvider(opts);
    const res = await p.object({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "summarize" }],
      maxTokens: 200,
      schema: { type: "object", properties: { category: { type: "string" } } },
    });
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.tools).toEqual([
      {
        name: "structured_output",
        description: "Return structured output matching the schema",
        input_schema: { type: "object", properties: { category: { type: "string" } } },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "tool", name: "structured_output" });
    expect(res.object).toEqual({ category: "AI", is_ad: false });
    expect(res.model).toBe("claude-sonnet-4-6");
  });

  it("object honors schemaName when provided", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init;
        return anthropicRes({
          id: "1",
          model: "m",
          content: [{ type: "tool_use", id: "x", name: "my_tool", input: { a: 1 } }],
        });
      }),
    );
    const p = new AnthropicMessagesProvider(opts);
    await p.object({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      schema: { type: "object" },
      schemaName: "my_tool",
    });
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.tools[0].name).toBe("my_tool");
    expect(body.tool_choice).toEqual({ type: "tool", name: "my_tool" });
  });

  it("object throws ProviderError when model returns no tool_use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        anthropicRes({ id: "1", model: "m", content: [{ type: "text", text: "I refuse" }] }),
      ),
    );
    const p = new AnthropicMessagesProvider(opts);
    await expect(
      p.object({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 10,
        schema: { type: "object" },
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("listModels returns staticModels with provider tag", async () => {
    const p = new AnthropicMessagesProvider(opts);
    const models = await p.listModels();
    expect(models.length).toBe(1);
    expect(models[0].id).toBe("claude-sonnet-4-6");
    expect(models[0].provider).toBe("anthropic");
  });
});
