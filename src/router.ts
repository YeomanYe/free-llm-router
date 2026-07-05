import { NoAvailableModelError, isRetryableError } from "./errors.js";
import { withTier } from "./tiering.js";
import {
  MODEL_TIERS,
  type ChatAllResult,
  type ChatRequest,
  type ChatResponse,
  type DiscoveredModel,
  type ModelTier,
  type ProviderAdapter,
  type RetryPolicy,
  type RouterOptions,
  type SortDimension,
  type UsageStats
} from "./types.js";

interface Candidate {
  provider: ProviderAdapter;
  model: DiscoveredModel;
}

export interface FanOutOptions {
  perProvider?: boolean;
}

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

  private catalogCache?: Candidate[];

  private readonly usageByProvider = new Map<string, UsageStats>();

  private readonly usageByModel = new Map<string, UsageStats>();

  private readonly cooldownMs: number;

  constructor(options: RouterOptions) {
    this.providers = options.providers;
    this.retry = {
      maxRetries: options.retry?.maxRetries ?? 2,
      baseDelayMs: options.retry?.baseDelayMs ?? 250
    };
    this.fallbackTiers = options.fallback?.tiers ?? [...MODEL_TIERS];
    this.freeOnly = options.freeOnly ?? true;
    this.cooldownMs = options.cooldownMs ?? 60_000;
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
      })
    );
  }

  private async callWithRetry(candidate: Candidate, request: ChatRequest): Promise<ChatResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt += 1) {
      const started = Date.now();
      try {
        const response = await candidate.provider.chat({ ...request, model: candidate.model.id });
        this.recordSuccess(candidate.provider.name, candidate.model.id, response, Date.now() - started);
        return response;
      } catch (error) {
        lastError = error;
        this.recordError(candidate.provider.name, candidate.model.id, isRetryableError(error));
        if (!isRetryableError(error)) break;
        if (attempt < this.retry.maxRetries) {
          await sleep(this.retry.baseDelayMs * attempt);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("chat failed");
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
    latencyMs: number
  ): void {
    const providerStats = this.getOrInitUsage(this.usageByProvider, providerName);
    const modelStats = this.getOrInitUsage(this.usageByModel, `${providerName}/${modelId}`);
    for (const stats of [providerStats, modelStats]) {
      stats.requests += 1;
      stats.successes += 1;
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

  private recordError(providerName: string, modelId: string, retryable: boolean): void {
    for (const [map, key] of [
      [this.usageByProvider, providerName],
      [this.usageByModel, `${providerName}/${modelId}`]
    ] as const) {
      const stats = this.getOrInitUsage(map, key);
      stats.requests += 1;
      stats.errors += 1;
      if (retryable) {
        stats.cooldownUntil = Date.now() + this.cooldownMs;
      }
    }
  }

  private getOrInitUsage(map: Map<string, UsageStats>, key: string): UsageStats {
    const existing = map.get(key);
    if (existing) return existing;
    const created: UsageStats = {
      requests: 0,
      successes: 0,
      errors: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      avgLatencyMs: 0,
      lastLatencyMs: 0
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
    const tail = this.sort(filteredTier.filter((c) => !seen.has(c)), request.sortBy);
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
    if (!refresh && this.catalogCache) {
      return this.catalogCache;
    }

    const discovered = await Promise.all(
      this.providers.map(async (provider) => {
        const models = await provider.listModels();
        return models.map((model) => ({
          provider,
          model: withTier(model)
        }));
      })
    );

    this.catalogCache = discovered.flat().filter((candidate) => {
      if (this.freeOnly && !candidate.model.free) {
        return false;
      }

      return candidate.model.capabilities.chat !== false;
    });

    return this.catalogCache;
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
      `${candidate.provider.name}/${candidate.model.id}` === target
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
