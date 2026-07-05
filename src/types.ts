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
  "low-3"
];

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface ChatRequest {
  model?: string;
  models?: string[];
  providers?: string[];
  tier?: ModelTier;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: false;
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

export interface ChatAllResult {
  provider: string;
  model: string;
  response?: ChatResponse;
  error?: Error;
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
}
