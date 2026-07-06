import {
  isRetryableError,
  ProviderError,
  TimeoutError,
} from "../errors.js";
import type {
  ChatRequest,
  ChatResponse,
  DiscoveredModel,
  ObjectRequest,
  ObjectResponse,
  ProviderAdapter,
} from "../types.js";

export interface AnthropicStaticModel {
  id: string;
  qualityScore?: number;
  contextWindow?: number;
  free?: boolean;
}

export interface AnthropicProviderOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  staticModels?: AnthropicStaticModel[];
  timeoutMs?: number;
}

const DEFAULT_TOOL_NAME = "structured_output";
const ANTHROPIC_VERSION = "2023-06-01";

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Split leading system message(s) into Anthropic's top-level `system` field. */
function splitSystem(messages: ChatRequest["messages"]): {
  system?: string;
  messages: ChatRequest["messages"];
} {
  const system: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    const c = messages[i].content;
    system.push(typeof c === "string" ? c : JSON.stringify(c));
    i += 1;
  }
  return {
    ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
    messages: messages.slice(i),
  };
}

export class AnthropicMessagesProvider implements ProviderAdapter {
  readonly kind = "anthropic-messages";

  readonly name: string;

  private readonly baseUrl: string;

  private readonly apiKey: string;

  private readonly headers: Record<string, string>;

  private readonly staticModels: AnthropicStaticModel[];

  private readonly timeoutMs?: number;

  constructor(opts: AnthropicProviderOptions) {
    this.name = opts.name;
    this.baseUrl = stripTrailingSlash(opts.baseUrl);
    this.apiKey = opts.apiKey;
    this.headers = opts.headers ?? {};
    this.staticModels = opts.staticModels ?? [];
    this.timeoutMs = opts.timeoutMs;
  }

  private authHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      authorization: `Bearer ${this.apiKey}`,
      "anthropic-version": ANTHROPIC_VERSION,
      ...this.headers,
    };
  }

  private async request(path: string, body: unknown, timeoutMs?: number): Promise<unknown> {
    const effectiveTimeout = timeoutMs ?? this.timeoutMs ?? 60_000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), effectiveTimeout);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        signal: ac.signal,
        headers: this.authHeaders(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (ac.signal.aborted) throw new TimeoutError(this.name, effectiveTimeout);
      throw new ProviderError(this.name, `anthropic fetch failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(
        this.name,
        `anthropic HTTP ${res.status}: ${text}`,
        { status: res.status },
      );
    }
    return res.json();
  }

  async listModels(): Promise<DiscoveredModel[]> {
    return this.staticModels.map((m) => ({
      id: m.id,
      provider: this.name,
      name: m.id,
      free: m.free ?? false,
      source: "static" as const,
      ...(m.qualityScore !== undefined ? { qualityScore: m.qualityScore } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      capabilities: { chat: true, tools: true, vision: false },
    }));
  }

  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    const { system, messages } = splitSystem(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 1024,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(system ? { system } : {}),
    };
    const data = (await this.request("/v1/messages", body, request.timeoutMs)) as {
      id: string;
      model: string;
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const content = (data.content ?? [])
      .map((b) => b.text ?? "")
      .join("");
    return {
      id: data.id,
      model: data.model,
      provider: this.name,
      content,
      raw: data,
      ...(data.usage
        ? {
            usage: {
              promptTokens: data.usage.input_tokens,
              completionTokens: data.usage.output_tokens,
            },
          }
        : {}),
    };
  }

  async object(request: ObjectRequest & { model: string }): Promise<ObjectResponse> {
    const toolName = request.schemaName ?? DEFAULT_TOOL_NAME;
    const { system, messages } = splitSystem(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 1024,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      tools: [
        {
          name: toolName,
          description: "Return structured output matching the schema",
          input_schema: request.schema,
        },
      ],
      tool_choice: { type: "tool", name: toolName },
      ...(system ? { system } : {}),
    };
    const data = (await this.request("/v1/messages", body, request.timeoutMs)) as {
      id: string;
      model: string;
      content?: Array<{ type: string; input?: unknown }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const toolUse = (data.content ?? []).find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.input === undefined) {
      throw new ProviderError(this.name, "anthropic model did not return structured output");
    }
    return {
      id: data.id,
      model: data.model,
      provider: this.name,
      object: toolUse.input,
      raw: data,
      ...(data.usage
        ? {
            usage: {
              promptTokens: data.usage.input_tokens,
              completionTokens: data.usage.output_tokens,
            },
          }
        : {}),
    };
  }
}

// Re-exported so the import remains meaningful for callers that want to inspect
// error retryability without reaching into ../errors.js directly.
export { isRetryableError };
