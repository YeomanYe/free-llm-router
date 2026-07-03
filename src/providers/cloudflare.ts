import {
  ProviderError,
  RetryableProviderError,
  isRetryableStatus
} from "../errors.js";
import type { ChatRequest, ChatResponse, DiscoveredModel, ProviderAdapter } from "../types.js";

export interface CloudflareStaticModelConfig {
  id: string;
  free?: boolean;
  contextWindow?: number;
  qualityScore?: number;
}

export interface CloudflareWorkersAIProviderOptions {
  accountId: string;
  apiToken: string;
  name?: string;
  staticModels?: CloudflareStaticModelConfig[];
}

export class CloudflareWorkersAIProvider implements ProviderAdapter {
  readonly kind = "cloudflare-workers-ai";

  readonly name: string;

  private readonly accountId: string;

  private readonly apiToken: string;

  private readonly staticModels: CloudflareStaticModelConfig[];

  constructor(options: CloudflareWorkersAIProviderOptions) {
    this.name = options.name ?? "cloudflare";
    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.staticModels = options.staticModels ?? [];
  }

  async listModels(): Promise<DiscoveredModel[]> {
    return this.staticModels.map((model) => ({
      id: model.id,
      provider: this.name,
      name: model.id,
      free: model.free ?? true,
      source: "static",
      capabilities: { chat: true },
      contextWindow: model.contextWindow,
      qualityScore: model.qualityScore
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

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      throw this.errorFromResponse(response, "Cloudflare chat completion failed");
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

  private errorFromResponse(response: Response, message: string): ProviderError {
    const ErrorClass = isRetryableStatus(response.status) ? RetryableProviderError : ProviderError;
    return new ErrorClass(this.name, `${message}: HTTP ${response.status}`, response.status);
  }
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
