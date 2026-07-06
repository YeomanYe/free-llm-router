import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/providers/openaiCompatible.js";
import { ProviderError } from "../src/errors.js";

function oaiRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("OpenAICompatibleProvider.object", () => {
  afterEach(() => vi.restoreAllMocks());

  const base = {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "or-key",
  };

  it("sends tools + tool_choice and parses tool_calls[0].function.arguments", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init;
        return oaiRes({
          id: "chatcmpl-1",
          model: "gpt-4o-mini",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "structured_output", arguments: '{"category":"AI","is_ad":false}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        });
      }),
    );
    const p = new OpenAICompatibleProvider(base);
    const res = await p.object({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "summarize" }],
      maxTokens: 200,
      schema: { type: "object", properties: { category: { type: "string" } } },
    });
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "structured_output",
          description: "Return structured output matching the schema",
          parameters: { type: "object", properties: { category: { type: "string" } } },
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "structured_output" } });
    expect(res.object).toEqual({ category: "AI", is_ad: false });
    expect(res.provider).toBe("openrouter");
  });

  it("honors schemaName", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init;
        return oaiRes({
          id: "1",
          model: "m",
          choices: [{ message: { tool_calls: [{ function: { name: "my_tool", arguments: "{}" } }] } }],
        });
      }),
    );
    const p = new OpenAICompatibleProvider(base);
    await p.object({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      maxTokens: 10,
      schema: { type: "object" },
      schemaName: "my_tool",
    });
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.tools[0].function.name).toBe("my_tool");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "my_tool" } });
  });

  it("throws ProviderError when arguments is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        oaiRes({
          id: "1",
          model: "m",
          choices: [{ message: { tool_calls: [{ function: { name: "structured_output", arguments: "not-json" } }] } }],
        }),
      ),
    );
    const p = new OpenAICompatibleProvider(base);
    await expect(
      p.object({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10, schema: { type: "object" } }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("throws ProviderError when no tool_calls returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        oaiRes({ id: "1", model: "m", choices: [{ message: { content: "no tools" } }] }),
      ),
    );
    const p = new OpenAICompatibleProvider(base);
    await expect(
      p.object({ model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 10, schema: { type: "object" } }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
