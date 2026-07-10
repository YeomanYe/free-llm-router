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
  /**
   * Tool-result messages only: the id this result answers.
   * Anthropic `tool_use_id` / OpenAI `tool_call_id`. Ignored for non-tool roles.
   */
  toolCallId?: string;
  /**
   * Assistant messages only (when echoing back a prior model response that
   * requested tools). Providers serialize this into their native assistant
   * tool-call shape (Anthropic tool_use content blocks / OpenAI tool_calls).
   * Source: copy verbatim from the prior ChatResponse.toolCalls.
   */
  toolCalls?: ToolCall[];
}

export type SortDimension = "quality" | "context" | "speed" | "cost";

/**
 * Tool definition passed in ChatRequest.tools. Provider-agnostic:
 * - Anthropic maps `parameters` → `input_schema`
 * - OpenAI-compatible maps `parameters` → `function.parameters`
 * `parameters` is a JSON Schema object (callers build it; for Zod callers
 * see the zod-to-json-schema adapter in the upper layer).
 */
export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema describing the tool's input shape. */
  parameters?: Record<string, unknown>;
}

/**
 * A tool invocation the model wants the caller to execute.
 * `id` must be echoed back as `toolCallId` in the follow-up `role: "tool"` message.
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed tool input (already JSON-decoded by the provider). */
  input: unknown;
}

/**
 * Normalized stop reason across providers.
 * - `tool_use`: model requested tool execution; caller should run tools and continue
 * - `end_turn`: model finished naturally (terminal)
 * - `max_tokens`: hit output cap (terminal unless caller raises the cap)
 * - `stop_sequence`: hit a stop sequence (terminal)
 * - `other`: provider-specific or unrecognized (treat as terminal)
 */
export type StopReason = "tool_use" | "end_turn" | "max_tokens" | "stop_sequence" | "other";

/**
 * Tool-choice directive. `'auto'` lets the model decide; `'none'` forbids tools;
 * `{type:'tool', name}` forces a specific tool.
 */
export type ToolChoice = "auto" | "none" | { type: "tool"; name: string };

export interface ChatRequest {
  model?: string;
  models?: string[];
  providers?: string[];
  /** 排除这些 provider(黑名单,优先于 providers 白名单)。用于内容验收失败后强制轮转。 */
  excludeProviders?: string[];
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
  /**
   * Shuffle candidate order before sequential traversal.
   * - No explicit model/models/providers: the whole tier-filtered pool is randomized.
   * - With model/models + fallbackToRest: the explicit list keeps its order, the
   *   fallback tail is randomized (honour the caller's stated preference, then
   *   spread load across the rest).
   * - With model/models and no fallbackToRest: matches for the explicit list are
   *   shuffled among themselves (relevant when multiple providers host the same id).
   * Override the router-level default (RouterOptions.shuffle).
   */
  shuffle?: boolean;
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
  /**
   * Tools the model may call. When present (and toolChoice !== 'none'),
   * providers forward them to the model; the response's `toolCalls` lists
   * invocations the caller must execute and echo back via role:'tool' messages.
   */
  tools?: ToolDef[];
  /** Controls whether/how tools are chosen. Default 'auto' when tools present. */
  toolChoice?: ToolChoice;
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
  /**
   * Tool invocations the model requested (only populated when the request
   * carried `tools` and the model chose to call one). Empty/undefined means
   * the model produced a terminal text response.
   */
  toolCalls?: ToolCall[];
  /**
   * Why the model stopped generating. `tool_use` means the caller should run
   * the tools and continue; anything else is terminal.
   */
  stopReason?: StopReason;
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
  /**
   * Router-level default for ChatRequest.shuffle. When true every call
   * randomizes its candidate order unless the request sets shuffle:false.
   */
  shuffle?: boolean;
}
