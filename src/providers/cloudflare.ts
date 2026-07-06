import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  DiscoveredModel,
  ProviderAdapter,
} from "../types.js";
import {
  buildChatBody,
  classifyAbort,
  composeAbortSignal,
  errorFromResponse,
  extractOpenAIContent,
  normalizeUsage,
  parseOpenAIStream,
} from "./openaiShared.js";

export interface CloudflareStaticModelConfig {
  id: string;
  free?: boolean;
  contextWindow?: number;
  qualityScore?: number;
}

export interface CloudflareWorkersAIProviderOptions {
  accountId?: string;
  apiToken: string;
  name?: string;
  staticModels?: CloudflareStaticModelConfig[];
  timeoutMs?: number;
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export class CloudflareWorkersAIProvider implements ProviderAdapter {
  readonly kind = "cloudflare-workers-ai";

  readonly name: string;

  private readonly apiToken: string;

  private readonly staticModels: CloudflareStaticModelConfig[];

  private readonly defaultTimeoutMs?: number;

  private accountIdPromise?: Promise<string>;

  constructor(options: CloudflareWorkersAIProviderOptions) {
    this.name = options.name ?? "cloudflare";
    this.apiToken = options.apiToken;
    this.staticModels = options.staticModels ?? [];
    this.defaultTimeoutMs = options.timeoutMs;
    if (options.accountId) {
      this.accountIdPromise = Promise.resolve(options.accountId);
    }
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
      qualityScore: model.qualityScore,
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

  private async postCompletion(
    request: ChatRequest & { model: string },
    stream: boolean,
    timeoutMs: number | undefined,
  ): Promise<Response> {
    const body = buildChatBody({ ...request, stream });
    const accountId = await this.resolveAccountId();
    let response: Response;
    try {
      response = await fetch(`${CF_API_BASE}/accounts/${accountId}/ai/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: composeAbortSignal(request.signal, timeoutMs),
      });
    } catch (error) {
      throw classifyAbort(this.name, error, timeoutMs);
    }

    if (!response.ok) {
      throw errorFromResponse(this.name, response, "Cloudflare chat completion failed");
    }

    return response;
  }

  private resolveAccountId(): Promise<string> {
    if (!this.accountIdPromise) {
      this.accountIdPromise = this.discoverAccountId().catch((error) => {
        // Allow a retry on the next call — a transient failure shouldn't
        // permanently poison the cached promise.
        this.accountIdPromise = undefined;
        throw error;
      });
    }
    return this.accountIdPromise;
  }

  private async discoverAccountId(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${CF_API_BASE}/accounts`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: "application/json",
        },
        signal: composeAbortSignal(undefined, this.defaultTimeoutMs),
      });
    } catch (error) {
      throw classifyAbort(this.name, error, this.defaultTimeoutMs);
    }

    if (!response.ok) {
      throw errorFromResponse(this.name, response, "Failed to discover Cloudflare account id");
    }

    const payload = (await response.json()) as { result?: Array<{ id?: unknown }> };
    const first = payload.result?.[0]?.id;
    if (typeof first !== "string" || first.length === 0) {
      throw new Error(`${this.name}: Cloudflare API returned no accounts for this token`);
    }
    return first;
  }
}
