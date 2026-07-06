export type ModelTier =
  | "high-1"
  | "high-2"
  | "high-3"
  | "medium-1"
  | "medium-2"
  | "medium-3"
  | "low-1"
  | "low-2"
  | "low-3";

export const MODEL_TIERS: readonly ModelTier[] = [
  "high-1",
  "high-2",
  "high-3",
  "medium-1",
  "medium-2",
  "medium-3",
  "low-1",
  "low-2",
  "low-3",
];

export const MODEL_TIER_NAMES = MODEL_TIERS as readonly string[];

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export type SortDimension = "quality" | "context" | "speed" | "cost";

export interface ChatRequest {
  model?: string;
  models?: string[];
  providers?: string[];
  // When true the explicit model/models/providers list is treated as a
  // preferred prefix and the router falls through to the tier-filtered pool
  // instead of hard-failing when the whole list errors out.
  fallbackToRest?: boolean;
  tier?: ModelTier;
  minQuality?: number;
  minContextWindow?: number;
  maxLatencyMs?: number;
  maxInputCostPerMillion?: number;
  // Default true — models under cooldown (recent 429/5xx) are dropped.
  excludeCooling?: boolean;
  sortBy?: SortDimension;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  // Streaming is opt-in. When true the provider yields incremental content
  // chunks; when false (default) the provider returns one buffered response.
  stream?: boolean;
  // Per-request timeout. Providers must abort the underlying fetch when it
  // elapses, surfacing a retryable TimeoutError.
  timeoutMs?: number;
  // Optional external abort signal. Cancels the in-flight request when aborted.
  signal?: AbortSignal;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  provider: string;
  content: string;
  raw: unknown;
  usage?: ChatUsage;
}

export interface ObjectRequest extends ChatRequest {
  /** JSON Schema object describing the desired output shape. Callers build it. */
  schema: Record<string, unknown>;
  /** Optional tool name; providers default to "structured_output". */
  schemaName?: string;
}

export interface ObjectResponse {
  id: string;
  model: string;
  provider: string;
  /** The model's output parsed into the requested schema shape. */
  object: unknown;
  raw: unknown;
  usage?: ChatUsage;
}

export interface ChatAllResult {
  provider: string;
  model: string;
  response?: ChatResponse;
  error?: Error;
}

// A single delta yielded by a streaming chat call. `content` is the
// incremental text since the previous chunk; `done` marks the final yield.
// `provider`/`model` identify the serving candidate and are populated on at
// least the first chunk so consumers can label output without bookkeeping.
export interface ChatStreamChunk {
  content: string;
  done: boolean;
  provider?: string;
  model?: string;
  usage?: ChatUsage;
}

// Rolling counters kept per provider (or provider/model when queried in that mode).
// Requests counts every provider.chat() attempt including retries, so it aligns
// with what the provider actually bills. Latency is a simple running average
// over successful calls only; cooldownUntil is set once a model accumulates
// `consecutiveErrors` >= the router's configured threshold (rate limits, 5xx)
// and is cleared on the next successful call.
export interface UsageStats {
  requests: number;
  successes: number;
  errors: number;
  // Consecutive failures since the last success — drives the cooldown gate
  // so a single transient 5xx doesn't yank a healthy model offline.
  consecutiveErrors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  lastLatencyMs: number;
  cooldownUntil?: number;
}

export interface ModelCapabilities {
  chat?: boolean;
  tools?: boolean;
  vision?: boolean;
  embeddings?: boolean;
  image?: boolean;
  audio?: boolean;
}

export interface ModelRateLimit {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

export interface ModelPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  currency?: "USD";
}

export interface DiscoveredModel {
  id: string;
  provider: string;
  name: string;
  free: boolean;
  source: "discovered" | "static";
  tier?: ModelTier;
  capabilities: ModelCapabilities;
  contextWindow?: number;
  qualityScore?: number;
  rateLimit?: ModelRateLimit;
  pricing?: ModelPricing;
  raw?: unknown;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly kind: string;
  listModels(): Promise<DiscoveredModel[]>;
  chat(request: ChatRequest & { model: string }): Promise<ChatResponse>;
  // Optional streaming chat. Providers that don't support SSE may leave this
  // undefined; the router falls back to buffered chat for them.
  streamChat?(request: ChatRequest & { model: string }): AsyncIterable<ChatStreamChunk>;
  // Optional structured output. Providers that can enforce a JSON Schema
  // (Anthropic tool-use, OpenAI tool-calling) implement this; others leave it
  // undefined and the router skips them for object() calls.
  object?(request: ObjectRequest & { model: string }): Promise<ObjectResponse>;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
}

export interface FallbackPolicy {
  tiers: ModelTier[];
}

export interface RouterOptions {
  providers: ProviderAdapter[];
  retry?: Partial<RetryPolicy>;
  fallback?: Partial<FallbackPolicy>;
  freeOnly?: boolean;
  cooldownMs?: number;
  // How many consecutive failures before a model enters cooldown. Default 2 —
  // one transient blip shouldn't disable a model, but two in a row probably
  // means the upstream is genuinely degraded.
  cooldownThreshold?: number;
  // Default per-request timeout applied to every provider.chat / streamChat
  // call that doesn't set its own timeoutMs. Undefined = no timeout.
  timeoutMs?: number;
  // TTL for the discovered-model catalog cache, in ms. Default 5 minutes.
  // Pass 0 to disable caching entirely (re-discover on every call).
  catalogTtlMs?: number;
}
