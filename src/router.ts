import { isRetryableError, NoAvailableModelError } from "./errors.js";
import { withTier } from "./tiering.js";
import {
  type ChatAllResult,
  type ChatRequest,
  type ChatResponse,
  type ChatStreamChunk,
  type DiscoveredModel,
  MODEL_TIERS,
  type ModelTier,
  type ProviderAdapter,
  type RetryPolicy,
  type RouterOptions,
  type SortDimension,
  type UsageStats,
} from "./types.js";

interface Candidate {
  provider: ProviderAdapter;
  model: DiscoveredModel;
}

export interface FanOutOptions {
  perProvider?: boolean;
}

const DEFAULT_CATALOG_TTL_MS = 5 * 60_000;

// Keeps only the highest-qualityScore candidate per provider name, preserving
// the first-seen provider order so downstream printing stays deterministic.
function pickCandidates(candidates: Candidate[], options?: FanOutOptions): Candidate[] {
  if (!options?.perProvider) return candidates;
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const cur = best.get(c.provider.name);
    if (!cur || (c.model.qualityScore ?? 0) > (cur.model.qualityScore ?? 0)) {
      best.set(c.provider.name, c);
    }
  }
  return [...best.values()];
}

export function pickBestModelPerProvider(models: DiscoveredModel[]): DiscoveredModel[] {
  const best = new Map<string, DiscoveredModel>();
  for (const m of models) {
    const cur = best.get(m.provider);
    if (!cur || (m.qualityScore ?? 0) > (cur.qualityScore ?? 0)) {
      best.set(m.provider, m);
    }
  }
  return [...best.values()];
}

export class ModelRouter {
  private readonly providers: ProviderAdapter[];

  private readonly retry: RetryPolicy;

  private readonly fallbackTiers: ModelTier[];

  private readonly freeOnly: boolean;

  private readonly defaultTimeoutMs?: number;

  private catalogCache?: Candidate[];

  private catalogCacheAt = 0;

  private readonly catalogTtlMs: number;

  private readonly usageByProvider = new Map<string, UsageStats>();

  private readonly usageByModel = new Map<string, UsageStats>();

  private readonly cooldownMs: number;

  private readonly cooldownThreshold: number;

  constructor(options: RouterOptions) {
    this.providers = options.providers;
    this.retry = {
      maxRetries: options.retry?.maxRetries ?? 2,
      baseDelayMs: options.retry?.baseDelayMs ?? 250,
    };
    this.fallbackTiers = options.fallback?.tiers ?? [...MODEL_TIERS];
    this.freeOnly = options.freeOnly ?? true;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.cooldownThreshold = options.cooldownThreshold ?? 2;
    this.defaultTimeoutMs = options.timeoutMs;
    // 0 disables caching (re-discover every call); otherwise honour the TTL.
    this.catalogTtlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
  }

  async listModels(options: { refresh?: boolean } = {}): Promise<DiscoveredModel[]> {
    const candidates = await this.getCandidates(options.refresh ?? false);
    return candidates.map((candidate) => candidate.model);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const candidates = await this.selectCandidates(request);

    if (candidates.length === 0) {
      throw new NoAvailableModelError();
    }

    let lastError: unknown;

    for (const candidate of candidates) {
      try {
        return await this.callWithRetry(candidate, request);
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new NoAvailableModelError();
  }

  /**
   * Streams incremental content chunks. Tries candidates in order; on a
   * retryable failure before any byte is yielded, falls through to the next
   * candidate (matching chat's sequential semantics). Once the first chunk is
   * emitted the stream is committed to that candidate — providers that don't
   * implement streamChat transparently fall back to buffered chat.
   */
  async *streamChat(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    const candidates = await this.selectCandidates(request);

    if (candidates.length === 0) {
      throw new NoAvailableModelError();
    }

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        yield* this.streamWithRetry(candidate, request);
        return;
      } catch (error) {
        // If the consumer aborted, propagate immediately — no fallback.
        if (request.signal?.aborted) throw error;
        lastError = error;
      }
    }

    if (lastError instanceof Error) throw lastError;
    throw new NoAvailableModelError();
  }

  async chatRace(request: ChatRequest, options?: FanOutOptions): Promise<ChatResponse> {
    const candidates = pickCandidates(await this.selectCandidates(request), options);
    if (candidates.length === 0) throw new NoAvailableModelError();

    try {
      return await Promise.any(candidates.map((c) => this.callWithRetry(c, request)));
    } catch (aggregate) {
      const first = (aggregate as AggregateError).errors?.[0];
      throw first instanceof Error ? first : new NoAvailableModelError();
    }
  }

  async chatAll(request: ChatRequest, options?: FanOutOptions): Promise<ChatAllResult[]> {
    const candidates = pickCandidates(await this.selectCandidates(request), options);
    if (candidates.length === 0) throw new NoAvailableModelError();

    return Promise.all(
      candidates.map(async (candidate) => {
        const label = { provider: candidate.provider.name, model: candidate.model.id };
        try {
          const response = await this.callWithRetry(candidate, request);
          return { ...label, response };
        } catch (error) {
          return { ...label, error: error instanceof Error ? error : new Error(String(error)) };
        }
      }),
    );
  }

  private async callWithRetry(candidate: Candidate, request: ChatRequest): Promise<ChatResponse> {
    const effectiveRequest = { ...request, timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs };
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt += 1) {
      const started = Date.now();
      try {
        const response = await candidate.provider.chat({
          ...effectiveRequest,
          model: candidate.model.id,
        });
        this.recordSuccess(
          candidate.provider.name,
          candidate.model.id,
          response,
          Date.now() - started,
        );
        return response;
      } catch (error) {
        lastError = error;
        const retryable = isRetryableError(error);
        this.recordError(candidate.provider.name, candidate.model.id, retryable, error);
        if (!retryable) break;
        if (attempt < this.retry.maxRetries) {
          await sleep(this.retry.baseDelayMs * attempt);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("chat failed");
  }

  private async *streamWithRetry(
    candidate: Candidate,
    request: ChatRequest,
  ): AsyncGenerator<ChatStreamChunk> {
    const effectiveRequest = {
      ...request,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
    };
    const provider = candidate.provider;

    // Providers without a native stream implementation get a buffered call
    // emitted as a single chunk, so callers can always iterate uniformly.
    if (typeof provider.streamChat !== "function") {
      const started = Date.now();
      const response = await provider.chat({ ...effectiveRequest, model: candidate.model.id });
      this.recordSuccess(provider.name, candidate.model.id, response, Date.now() - started);
      yield {
        content: response.content,
        done: true,
        provider: provider.name,
        model: candidate.model.id,
        usage: response.usage,
      };
      return;
    }

    let attempt = 0;
    const maxRetries = this.retry.maxRetries;
    // Buffer chunks so we only commit usage stats once we know the stream
    // either completed or failed mid-way. A failure before the first real
    // chunk is retriable; once we've yielded, we cannot retry without
    // duplicating output.
    while (attempt <= maxRetries) {
      const collected: ChatStreamChunk[] = [];
      const started = Date.now();
      const tag = { provider: provider.name, model: candidate.model.id };
      try {
        for await (const raw of provider.streamChat({
          ...effectiveRequest,
          model: candidate.model.id,
        })) {
          const chunk: ChatStreamChunk = { ...raw, provider: tag.provider, model: tag.model };
          collected.push(chunk);
          yield chunk;
          if (chunk.done) {
            const final = collected[collected.length - 1];
            const usage = final.usage;
            this.recordSuccess(
              provider.name,
              candidate.model.id,
              { usage } as ChatResponse,
              Date.now() - started,
            );
            return;
          }
        }
        // Stream ended without an explicit done marker — treat as complete.
        this.recordSuccess(
          provider.name,
          candidate.model.id,
          {} as ChatResponse,
          Date.now() - started,
        );
        return;
      } catch (error) {
        const retryable = isRetryableError(error);
        this.recordError(provider.name, candidate.model.id, retryable, error);
        // Only retry if nothing has been emitted yet AND it's retryable.
        if (collected.length === 0 && retryable && attempt < maxRetries) {
          attempt += 1;
          await sleep(this.retry.baseDelayMs * attempt);
          continue;
        }
        throw error;
      }
    }
  }

  getUsage(options?: { by?: "provider" | "model" }): Record<string, UsageStats> {
    const map = options?.by === "model" ? this.usageByModel : this.usageByProvider;
    const out: Record<string, UsageStats> = {};
    for (const [key, value] of map) out[key] = { ...value };
    return out;
  }

  resetUsage(): void {
    this.usageByProvider.clear();
    this.usageByModel.clear();
  }

  private recordSuccess(
    providerName: string,
    modelId: string,
    response: ChatResponse,
    latencyMs: number,
  ): void {
    const providerStats = this.getOrInitUsage(this.usageByProvider, providerName);
    const modelStats = this.getOrInitUsage(this.usageByModel, `${providerName}/${modelId}`);
    for (const stats of [providerStats, modelStats]) {
      stats.requests += 1;
      stats.successes += 1;
      stats.consecutiveErrors = 0;
      stats.lastLatencyMs = latencyMs;
      stats.avgLatencyMs =
        stats.successes === 1
          ? latencyMs
          : stats.avgLatencyMs + (latencyMs - stats.avgLatencyMs) / stats.successes;
      stats.cooldownUntil = undefined;
      if (response.usage) {
        stats.promptTokens += response.usage.promptTokens ?? 0;
        stats.completionTokens += response.usage.completionTokens ?? 0;
        stats.totalTokens += response.usage.totalTokens ?? 0;
      }
    }
  }

  private recordError(
    providerName: string,
    modelId: string,
    retryable: boolean,
    error: unknown,
  ): void {
    for (const [map, key] of [
      [this.usageByProvider, providerName],
      [this.usageByModel, `${providerName}/${modelId}`],
    ] as const) {
      const stats = this.getOrInitUsage(map, key);
      stats.requests += 1;
      stats.errors += 1;
      if (retryable) {
        stats.consecutiveErrors += 1;
        // Only enter cooldown once the model has failed enough times in a row
        // to look genuinely degraded — a single transient blip is tolerated.
        if (stats.consecutiveErrors >= this.cooldownThreshold) {
          stats.cooldownUntil = Date.now() + this.cooldownFromError(error);
        }
      } else {
        // Non-retryable (4xx) failures reset the streak — they're not a sign
        // of upstream degradation, just a bad request for this model.
        stats.consecutiveErrors = 0;
      }
    }
  }

  // Prefers the upstream's Retry-After when present; falls back to the router's
  // fixed cooldown window otherwise.
  private cooldownFromError(error: unknown): number {
    if (
      error instanceof Error &&
      "retryAfterMs" in error &&
      typeof error.retryAfterMs === "number"
    ) {
      return Math.max(error.retryAfterMs, 1000);
    }
    return this.cooldownMs;
  }

  private getOrInitUsage(map: Map<string, UsageStats>, key: string): UsageStats {
    const existing = map.get(key);
    if (existing) return existing;
    const created: UsageStats = {
      requests: 0,
      successes: 0,
      errors: 0,
      consecutiveErrors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      avgLatencyMs: 0,
      lastLatencyMs: 0,
    };
    map.set(key, created);
    return created;
  }

  private async selectCandidates(request: ChatRequest): Promise<Candidate[]> {
    const candidates = await this.getCandidates(false);
    const tiered = candidates.filter((candidate) => {
      if (request.tier && candidate.model.tier !== request.tier) return false;
      return this.fallbackTiers.includes(candidate.model.tier ?? "low-3");
    });
    const filteredTier = this.applyDimensionFilters(tiered, request);

    let head: Candidate[] | undefined;
    if (request.models && request.models.length > 0) {
      head = orderedMatch(candidates, request.models);
    } else if (request.model) {
      head = matchModel(candidates, request.model);
    } else if (request.providers && request.providers.length > 0) {
      head = orderByProviders(filteredTier, request.providers);
    }

    if (head === undefined) return this.sort(filteredTier, request.sortBy);
    if (!request.fallbackToRest) return head;

    const seen = new Set(head);
    const tail = this.sort(
      filteredTier.filter((c) => !seen.has(c)),
      request.sortBy,
    );
    return [...head, ...tail];
  }

  private applyDimensionFilters(candidates: Candidate[], request: ChatRequest): Candidate[] {
    const excludeCooling = request.excludeCooling ?? true;
    const now = Date.now();
    return candidates.filter((c) => {
      const model = c.model;
      if (request.minQuality !== undefined && (model.qualityScore ?? 0) < request.minQuality) {
        return false;
      }
      if (
        request.minContextWindow !== undefined &&
        (model.contextWindow ?? 0) < request.minContextWindow
      ) {
        return false;
      }
      if (
        request.maxInputCostPerMillion !== undefined &&
        (model.pricing?.inputPerMillion ?? 0) > request.maxInputCostPerMillion
      ) {
        return false;
      }
      const stats = this.usageByModel.get(`${c.provider.name}/${model.id}`);
      if (request.maxLatencyMs !== undefined) {
        const observed = stats?.avgLatencyMs ?? 0;
        // Never-called models pass the latency filter — no observation to reject on.
        if (observed > 0 && observed > request.maxLatencyMs) return false;
      }
      if (excludeCooling && stats?.cooldownUntil && stats.cooldownUntil > now) {
        return false;
      }
      return true;
    });
  }

  private sort(candidates: Candidate[], dim: SortDimension | undefined): Candidate[] {
    if (!dim) return candidates;
    const scored = candidates.map((c) => ({ c, score: this.dimensionScore(c, dim) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.c);
  }

  private dimensionScore(candidate: Candidate, dim: SortDimension): number {
    switch (dim) {
      case "quality":
        return candidate.model.qualityScore ?? 0;
      case "context":
        return candidate.model.contextWindow ?? 0;
      case "speed": {
        const stats = this.usageByModel.get(`${candidate.provider.name}/${candidate.model.id}`);
        const latency = stats?.avgLatencyMs;
        return latency && latency > 0 ? -latency : 0;
      }
      case "cost": {
        const cost = candidate.model.pricing?.inputPerMillion;
        return cost !== undefined ? -cost : 0;
      }
    }
  }

  private async getCandidates(refresh: boolean): Promise<Candidate[]> {
    const now = Date.now();
    // catalogTtlMs === 0 disables caching entirely (re-discover every call);
    // otherwise the cache is valid until the TTL elapses.
    const cacheValid =
      this.catalogTtlMs > 0 &&
      !refresh &&
      this.catalogCache &&
      now - this.catalogCacheAt < this.catalogTtlMs;
    if (cacheValid) {
      return this.catalogCache!;
    }

    // Promise.allSettled so a single broken provider never tanks the whole
    // catalog — its models are simply absent and the rest keep working.
    const settled = await Promise.allSettled(
      this.providers.map(async (provider) => {
        const models = await provider.listModels();
        return models.map((model) => ({ provider, model: withTier(model) }));
      }),
    );

    const catalog = settled
      .filter((r): r is PromiseFulfilledResult<Candidate[]> => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter((candidate) => {
        if (this.freeOnly && !candidate.model.free) {
          return false;
        }

        return candidate.model.capabilities.chat !== false;
      });

    this.catalogCache = catalog;
    this.catalogCacheAt = now;
    return catalog;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchModel(candidates: Candidate[], target: string): Candidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.model.id === target ||
      `${candidate.provider.name}/${candidate.model.id}` === target,
  );
}

// Preserves the caller's order and drops entries that match no candidate,
// so `models: ["a", "b", "c"]` tries a, then b, then c even if a comes last in config.
function orderedMatch(candidates: Candidate[], targets: string[]): Candidate[] {
  const seen = new Set<Candidate>();
  const ordered: Candidate[] = [];
  for (const target of targets) {
    for (const candidate of matchModel(candidates, target)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        ordered.push(candidate);
      }
    }
  }
  return ordered;
}

function orderByProviders(candidates: Candidate[], providers: string[]): Candidate[] {
  const rank = new Map(providers.map((name, index) => [name, index]));
  return candidates
    .filter((candidate) => rank.has(candidate.provider.name))
    .sort((a, b) => rank.get(a.provider.name)! - rank.get(b.provider.name)!);
}
