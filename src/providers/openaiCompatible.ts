import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  DiscoveredModel,
  ObjectRequest,
  ObjectResponse,
  ProviderAdapter,
} from "../types.js";
import { ProviderError } from "../errors.js";
import {
  buildChatBody,
  classifyAbort,
  composeAbortSignal,
  errorFromResponse,
  extractOpenAIContent,
  normalizeUsage,
  parseOpenAIStream,
} from "./openaiShared.js";

export interface StaticModelConfig {
  id: string;
  free?: boolean;
  contextWindow?: number;
  qualityScore?: number;
}

export interface OpenAICompatibleProviderOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  freeModelPatterns?: string[];
  staticModels?: StaticModelConfig[];
  discoverModels?: boolean;
  // Default per-call timeout for this provider, applied when the request
  // doesn't carry its own timeoutMs.
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly kind = "openai-compatible";

  readonly name: string;

  private readonly baseUrl: string;

  private readonly apiKey?: string;

  private readonly headers: Record<string, string>;

  private readonly freeModelPatterns: string[];

  private readonly staticModels: StaticModelConfig[];

  private readonly discoverModels: boolean;

  private readonly defaultTimeoutMs?: number;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name;
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.freeModelPatterns = options.freeModelPatterns ?? [":free", "free"];
    this.staticModels = options.staticModels ?? [];
    this.discoverModels = options.discoverModels ?? true;
    this.defaultTimeoutMs = options.timeoutMs;
  }

  async listModels(): Promise<DiscoveredModel[]> {
    if (!this.discoverModels) {
      return this.staticModels.map((model) => this.toStaticModel(model));
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/models`, {
        headers: this.requestHeaders(),
        signal: composeAbortSignal(undefined, this.defaultTimeoutMs),
      });
    } catch (error) {
      // Network/timeout during discovery is non-fatal if we have static models
      // to fall back on; otherwise propagate so the router can report it.
      if (this.staticModels.length > 0) {
        return this.staticModels.map((model) => this.toStaticModel(model));
      }
      throw classifyAbort(this.name, error, this.defaultTimeoutMs);
    }

    if (!response.ok) {
      if (this.staticModels.length > 0) {
        return this.staticModels.map((model) => this.toStaticModel(model));
      }

      throw errorFromResponse(this.name, response, "Failed to discover models");
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string; [key: string]: unknown }>;
    };
    const remoteModels = payload.data ?? [];

    return remoteModels
      .filter(
        (model): model is { id: string; [key: string]: unknown } => typeof model.id === "string",
      )
      .map((model) => ({
        id: model.id,
        provider: this.name,
        name: model.id,
        free: this.isFreeModel(model.id),
        source: "discovered" as const,
        capabilities: { chat: true },
        raw: model,
      }));
  }

  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const response = await this.postCompletion(request, false, timeoutMs);

    const payload = (await response.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: unknown;
    };
    const content = extractOpenAIContent(payload);

    return {
      id: typeof payload.id === "string" ? payload.id : `${this.name}-${Date.now()}`,
      model: typeof payload.model === "string" ? payload.model : request.model,
      provider: this.name,
      content,
      raw: payload,
      usage: normalizeUsage(payload.usage),
    };
  }

  async *streamChat(request: ChatRequest & { model: string }): AsyncGenerator<ChatStreamChunk> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const response = await this.postCompletion(request, true, timeoutMs);
    yield* parseOpenAIStream(response);
  }

  async object(request: ObjectRequest & { model: string }): Promise<ObjectResponse> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const toolName = request.schemaName ?? "structured_output";
    const body = {
      ...buildChatBody({ ...request, stream: false }),
      tools: [
        {
          type: "function",
          function: {
            name: toolName,
            description: "Return structured output matching the schema",
            parameters: request.schema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: toolName } },
    };

    const response = await this.postCompletionBody(body, request.signal, timeoutMs);

    const payload = (await response.json()) as {
      id?: string;
      model?: string;
      choices?: Array<{
        message?: {
          tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: unknown;
    };

    const call = payload.choices?.[0]?.message?.tool_calls?.[0];
    const args = call?.function?.arguments;
    if (!args) {
      throw new ProviderError(
        this.name,
        "openai-compatible model did not return structured output",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch (error) {
      throw new ProviderError(this.name, "openai-compatible tool arguments were not valid JSON", {
        cause: error,
      });
    }

    return {
      id: typeof payload.id === "string" ? payload.id : `${this.name}-${Date.now()}`,
      model: typeof payload.model === "string" ? payload.model : request.model,
      provider: this.name,
      object: parsed,
      raw: payload,
      usage: normalizeUsage(payload.usage),
    };
  }

  private async postCompletion(
    request: ChatRequest & { model: string },
    stream: boolean,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    const body = buildChatBody({ ...request, stream });
    return this.postCompletionBody(body, request.signal, timeoutMs);
  }

  // Single HTTP path for /chat/completions shared by chat(), streamChat(), and
  // object(). Centralizes headers, abort/timeout composition, and error mapping
  // so every caller gets identical reliability guarantees.
  private async postCompletionBody(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          ...this.requestHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: composeAbortSignal(signal, timeoutMs),
      });
    } catch (error) {
      throw classifyAbort(this.name, error, timeoutMs);
    }

    if (!response.ok) {
      throw errorFromResponse(this.name, response, "Chat completion failed");
    }

    return response;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.headers,
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private isFreeModel(modelId: string): boolean {
    const normalized = modelId.toLowerCase();
    return this.freeModelPatterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
  }

  private toStaticModel(model: StaticModelConfig): DiscoveredModel {
    return {
      id: model.id,
      provider: this.name,
      name: model.id,
      free: model.free ?? this.isFreeModel(model.id),
      source: "static",
      capabilities: { chat: true },
      contextWindow: model.contextWindow,
      qualityScore: model.qualityScore,
    };
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
