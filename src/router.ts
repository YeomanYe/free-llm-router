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
  type RouterOptions
} from "./types.js";

interface Candidate {
  provider: ProviderAdapter;
  model: DiscoveredModel;
}

export class ModelRouter {
  private readonly providers: ProviderAdapter[];

  private readonly retry: RetryPolicy;

  private readonly fallbackTiers: ModelTier[];

  private readonly freeOnly: boolean;

  private catalogCache?: Candidate[];

  constructor(options: RouterOptions) {
    this.providers = options.providers;
    this.retry = {
      maxRetries: options.retry?.maxRetries ?? 2,
      baseDelayMs: options.retry?.baseDelayMs ?? 250
    };
    this.fallbackTiers = options.fallback?.tiers ?? [...MODEL_TIERS];
    this.freeOnly = options.freeOnly ?? true;
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

  async chatRace(request: ChatRequest): Promise<ChatResponse> {
    const candidates = await this.selectCandidates(request);
    if (candidates.length === 0) throw new NoAvailableModelError();

    try {
      return await Promise.any(candidates.map((c) => this.callWithRetry(c, request)));
    } catch (aggregate) {
      const first = (aggregate as AggregateError).errors?.[0];
      throw first instanceof Error ? first : new NoAvailableModelError();
    }
  }

  async chatAll(request: ChatRequest): Promise<ChatAllResult[]> {
    const candidates = await this.selectCandidates(request);
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
      try {
        return await candidate.provider.chat({ ...request, model: candidate.model.id });
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error)) break;
        if (attempt < this.retry.maxRetries) {
          await sleep(this.retry.baseDelayMs * attempt);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("chat failed");
  }

  private async selectCandidates(request: ChatRequest): Promise<Candidate[]> {
    const candidates = await this.getCandidates(false);

    if (request.models && request.models.length > 0) {
      return orderedMatch(candidates, request.models);
    }

    if (request.model) {
      return matchModel(candidates, request.model);
    }

    let filtered = candidates.filter((candidate) => {
      if (request.tier && candidate.model.tier !== request.tier) {
        return false;
      }

      return this.fallbackTiers.includes(candidate.model.tier ?? "low-3");
    });

    if (request.providers && request.providers.length > 0) {
      filtered = orderByProviders(filtered, request.providers);
    }

    return filtered;
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
