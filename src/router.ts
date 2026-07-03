import { NoAvailableModelError, isRetryableError } from "./errors.js";
import { withTier } from "./tiering.js";
import type {
  ChatRequest,
  ChatResponse,
  DiscoveredModel,
  ModelTier,
  ProviderAdapter,
  RetryPolicy,
  RouterOptions
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
    this.fallbackTiers = options.fallback?.tiers ?? ["high", "medium", "low"];
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
      for (let attempt = 0; attempt <= this.retry.maxRetries; attempt += 1) {
        try {
          return await candidate.provider.chat({
            ...request,
            model: candidate.model.id
          });
        } catch (error) {
          lastError = error;

          if (!isRetryableError(error)) {
            break;
          }

          if (attempt < this.retry.maxRetries) {
            await sleep(this.retry.baseDelayMs * attempt);
          }
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new NoAvailableModelError();
  }

  private async selectCandidates(request: ChatRequest): Promise<Candidate[]> {
    const candidates = await this.getCandidates(false);

    if (request.model) {
      return candidates.filter(
        (candidate) =>
          candidate.model.id === request.model ||
          `${candidate.provider.name}/${candidate.model.id}` === request.model
      );
    }

    return candidates.filter((candidate) => {
      if (request.tier && candidate.model.tier !== request.tier) {
        return false;
      }

      return this.fallbackTiers.includes(candidate.model.tier ?? "low");
    });
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
