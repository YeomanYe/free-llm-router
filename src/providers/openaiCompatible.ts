import {
  ProviderError,
  RetryableProviderError,
  isRetryableStatus
} from "../errors.js";
import type { ChatRequest, ChatResponse, DiscoveredModel, ProviderAdapter } from "../types.js";

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

  constructor(options: OpenAICompatibleProviderOptions) {
    this.name = options.name;
    this.baseUrl = stripTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.freeModelPatterns = options.freeModelPatterns ?? [":free", "free"];
    this.staticModels = options.staticModels ?? [];
    this.discoverModels = options.discoverModels ?? true;
  }

  async listModels(): Promise<DiscoveredModel[]> {
    if (!this.discoverModels) {
      return this.staticModels.map((model) => this.toStaticModel(model));
    }

    const response = await fetch(`${this.baseUrl}/models`, {
      headers: this.requestHeaders()
    });

    if (!response.ok) {
      if (this.staticModels.length > 0) {
        return this.staticModels.map((model) => this.toStaticModel(model));
      }

      throw this.errorFromResponse(response, "Failed to discover models");
    }

    const payload = (await response.json()) as { data?: Array<{ id?: string; [key: string]: unknown }> };
    const remoteModels = payload.data ?? [];

    return remoteModels
      .filter((model): model is { id: string; [key: string]: unknown } => typeof model.id === "string")
      .map((model) => ({
        id: model.id,
        provider: this.name,
        name: model.id,
        free: this.isFreeModel(model.id),
        source: "discovered" as const,
        capabilities: { chat: true },
        raw: model
      }));
  }

  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: request.stream ?? false
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.requestHeaders(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw this.errorFromResponse(response, "Chat completion failed");
    }

    const payload = await response.json();
    const content = extractOpenAIContent(payload);

    return {
      id: typeof payload.id === "string" ? payload.id : `${this.name}-${Date.now()}`,
      model: typeof payload.model === "string" ? payload.model : request.model,
      provider: this.name,
      content,
      raw: payload,
      usage: normalizeUsage(payload.usage)
    };
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.headers
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
      qualityScore: model.qualityScore
    };
  }

  private errorFromResponse(response: Response, message: string): ProviderError {
    const ErrorClass = isRetryableStatus(response.status) ? RetryableProviderError : ProviderError;
    return new ErrorClass(this.name, `${message}: HTTP ${response.status}`, response.status);
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function extractOpenAIContent(payload: any): string {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return typeof part?.text === "string" ? part.text : "";
      })
      .join("");
  }

  return "";
}

function normalizeUsage(usage: any) {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}
