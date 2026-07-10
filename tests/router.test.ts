import { describe, expect, it } from "vitest";

import {
  ModelRouter,
  ProviderError,
  pickBestModelPerProvider,
  RetryableProviderError,
} from "../src/index.js";
import type { ChatRequest, ChatResponse, DiscoveredModel, ProviderAdapter } from "../src/types.js";

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";

  attempts = 0;

  constructor(
    readonly name: string,
    private readonly behavior: "always-fail" | "succeed",
  ) {}

  async listModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: `${this.name}/model`,
        provider: this.name,
        name: `${this.name}/model`,
        free: true,
        source: "static",
        capabilities: { chat: true },
        contextWindow: 32_000,
        qualityScore: this.behavior === "succeed" ? 0.8 : 0.4,
      },
    ];
  }

  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    this.attempts += 1;
    if (this.behavior === "always-fail") {
      throw new RetryableProviderError(this.name, "rate limited");
    }

    return {
      id: "chatcmpl-test",
      model: request.model,
      provider: this.name,
      content: "fallback ok",
      raw: { ok: true },
    };
  }
}

describe("ModelRouter", () => {
  it("retries a failed model before falling back to the next candidate", async () => {
    const first = new FakeProvider("first", "always-fail");
    const second = new FakeProvider("second", "succeed");
    const router = new ModelRouter({
      providers: [first, second],
      retry: { maxRetries: 2, baseDelayMs: 0 },
      fallback: {
        tiers: [
          "high-1",
          "high-2",
          "high-3",
          "medium-1",
          "medium-2",
          "medium-3",
          "low-1",
          "low-2",
          "low-3",
        ],
      },
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.content).toBe("fallback ok");
    expect(response.provider).toBe("second");
    expect(first.attempts).toBe(3);
    expect(second.attempts).toBe(1);
  });

  it("walks the explicit models list in order regardless of config order", async () => {
    const alpha = new FakeProvider("alpha", "always-fail");
    const beta = new FakeProvider("beta", "always-fail");
    const gamma = new FakeProvider("gamma", "succeed");
    const router = new ModelRouter({
      providers: [gamma, alpha, beta],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
      models: ["alpha/model", "beta/model", "gamma/model"],
    });

    expect(response.provider).toBe("gamma");
    expect(alpha.attempts).toBe(1);
    expect(beta.attempts).toBe(1);
    expect(gamma.attempts).toBe(1);
  });

  it("restricts and orders candidates by the providers list", async () => {
    const alpha = new FakeProvider("alpha", "succeed");
    const beta = new FakeProvider("beta", "succeed");
    const gamma = new FakeProvider("gamma", "succeed");
    const router = new ModelRouter({
      providers: [alpha, beta, gamma],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
      providers: ["gamma", "beta"],
    });

    expect(response.provider).toBe("gamma");
    expect(alpha.attempts).toBe(0);
    expect(beta.attempts).toBe(0);
    expect(gamma.attempts).toBe(1);
  });

  it("fallbackToRest walks preferred providers then falls through to the rest", async () => {
    const preferred = new FakeProvider("preferred", "always-fail");
    const backup = new FakeProvider("backup", "succeed");
    const router = new ModelRouter({
      providers: [preferred, backup],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
      providers: ["preferred"],
      fallbackToRest: true,
    });

    expect(response.provider).toBe("backup");
    expect(preferred.attempts).toBe(1);
    expect(backup.attempts).toBe(1);
  });

  it("without fallbackToRest an exhausted providers list surfaces the last error", async () => {
    const preferred = new FakeProvider("preferred", "always-fail");
    const backup = new FakeProvider("backup", "succeed");
    const router = new ModelRouter({
      providers: [preferred, backup],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    await expect(
      router.chat({
        messages: [{ role: "user", content: "hi" }],
        providers: ["preferred"],
      }),
    ).rejects.toThrow(/rate limited/);
    expect(backup.attempts).toBe(0);
  });

  it("filters candidates by minQuality and minContextWindow before dispatching", async () => {
    const heavy = new MultiModelProvider("heavy", [
      { id: "heavy/big", qualityScore: 0.9, contextWindow: 128_000 },
      { id: "heavy/small", qualityScore: 0.4, contextWindow: 8_000 },
    ]);
    const solo = new MultiModelProvider("solo", [
      { id: "solo/tiny", qualityScore: 0.6, contextWindow: 4_000 },
    ]);
    const router = new ModelRouter({
      providers: [heavy, solo],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const results = await router.chatAll({
      messages: [{ role: "user", content: "hi" }],
      minQuality: 0.5,
      minContextWindow: 32_000,
    });
    expect(results.map((r) => r.model)).toEqual(["heavy/big"]);
  });

  it("sortBy quality reorders the fallback pool from best to worst", async () => {
    const provider = new MultiModelProvider("p", [
      { id: "p/mid", qualityScore: 0.6 },
      { id: "p/top", qualityScore: 0.9 },
      { id: "p/low", qualityScore: 0.3 },
    ]);
    const router = new ModelRouter({
      providers: [provider],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const results = await router.chatAll({
      messages: [{ role: "user", content: "hi" }],
      sortBy: "quality",
    });
    expect(results.map((r) => r.model)).toEqual(["p/top", "p/mid", "p/low"]);
  });

  it("excludes cooling models by default and includes them when opted-in", async () => {
    const flaky = new UsageProvider("flaky", { prompt: 1, completion: 1 }, { failFirst: 5 });
    const router = new ModelRouter({
      providers: [flaky],
      retry: { maxRetries: 0, baseDelayMs: 0 },
      cooldownMs: 60_000,
      // Threshold of 1 keeps this test focused on the cooldown filter itself:
      // a single failure is enough to take the model offline.
      cooldownThreshold: 1,
    });

    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();

    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /No available model/,
    );

    // Bypass cooldown filter so the retry actually goes out.
    await expect(
      router.chat({ messages: [{ role: "user", content: "hi" }], excludeCooling: false }),
    ).rejects.toThrow(/flaky/);
  });

  it("tolerates a single transient failure without cooling down (threshold gating)", async () => {
    // Default cooldownThreshold is 2: one blip must NOT remove the model.
    const blip = new UsageProvider("blip", { prompt: 1, completion: 1 }, { failFirst: 1 });
    const router = new ModelRouter({
      providers: [blip],
      retry: { maxRetries: 0, baseDelayMs: 0 },
      cooldownMs: 60_000,
    });

    // First call fails (consecutiveErrors = 1, below threshold → no cooldown).
    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /flaky/,
    );

    // Model is still selectable; the second attempt succeeds.
    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.content).toBe("ok");
  });

  it("honours Retry-After over the default cooldown window", async () => {
    const flaky = new RetryAfterProvider("ra", 5);
    const router = new ModelRouter({
      providers: [flaky],
      retry: { maxRetries: 0, baseDelayMs: 0 },
      cooldownMs: 60_000,
      cooldownThreshold: 1,
    });

    await expect(router.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();

    const usage = router.getUsage();
    // Retry-After of 5s should win over the 60s default cooldown.
    expect(usage.ra.cooldownUntil).toBeLessThan(Date.now() + 60_000);
  });

  it("chatRace returns the first successful response and hits every candidate", async () => {
    const slow = new SlowProvider("slow", 40);
    const fast = new SlowProvider("fast", 5);
    const router = new ModelRouter({
      providers: [slow, fast],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const response = await router.chatRace({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.provider).toBe("fast");
    expect(slow.attempts).toBe(1);
    expect(fast.attempts).toBe(1);
  });

  it("chatAll perProvider fires only the top-qualityScore model per provider", async () => {
    const heavy = new MultiModelProvider("heavy", [
      { id: "heavy/a", qualityScore: 0.4 },
      { id: "heavy/b", qualityScore: 0.9 },
      { id: "heavy/c", qualityScore: 0.7 },
    ]);
    const solo = new MultiModelProvider("solo", [{ id: "solo/x", qualityScore: 0.6 }]);
    const router = new ModelRouter({
      providers: [heavy, solo],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const results = await router.chatAll(
      { messages: [{ role: "user", content: "hi" }] },
      { perProvider: true },
    );

    expect(results.map((r) => r.model).sort()).toEqual(["heavy/b", "solo/x"]);
    expect(heavy.attemptedIds).toEqual(["heavy/b"]);
    expect(solo.attemptedIds).toEqual(["solo/x"]);
  });

  it("pickBestModelPerProvider keeps highest qualityScore only", () => {
    const picked = pickBestModelPerProvider([
      {
        id: "a",
        provider: "p1",
        name: "a",
        free: true,
        source: "static",
        capabilities: { chat: true },
        qualityScore: 0.4,
      },
      {
        id: "b",
        provider: "p1",
        name: "b",
        free: true,
        source: "static",
        capabilities: { chat: true },
        qualityScore: 0.8,
      },
      {
        id: "c",
        provider: "p2",
        name: "c",
        free: true,
        source: "static",
        capabilities: { chat: true },
        qualityScore: 0.5,
      },
    ]);
    expect(picked.map((m) => m.id).sort()).toEqual(["b", "c"]);
  });

  it("chatAll returns per-candidate results including errors", async () => {
    const ok = new FakeProvider("ok", "succeed");
    const broken = new FakeProvider("broken", "always-fail");
    const router = new ModelRouter({
      providers: [ok, broken],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const results = await router.chatAll({
      messages: [{ role: "user", content: "hi" }],
    });

    const okResult = results.find((r) => r.provider === "ok");
    const brokenResult = results.find((r) => r.provider === "broken");
    expect(okResult?.response?.content).toBe("fallback ok");
    expect(brokenResult?.error?.message).toContain("rate limited");
    expect(ok.attempts).toBe(1);
    expect(broken.attempts).toBe(1);
  });

  it("survives a provider whose listModels rejects (catalog fault tolerance)", async () => {
    const ok = new FakeProvider("ok", "succeed");
    const broken = new (class implements ProviderAdapter {
      readonly kind = "broken";
      readonly name = "broken";
      listModels() {
        return Promise.reject(new Error("discovery exploded"));
      }
      chat() {
        return Promise.reject(new Error("unused"));
      }
    })();
    const router = new ModelRouter({
      providers: [broken, ok],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const models = await router.listModels();
    expect(models.map((m) => m.provider)).toEqual(["ok"]);

    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.provider).toBe("ok");
  });

  it("catalog cache TTL re-discovers after the window elapses", async () => {
    let discoverCount = 0;
    const counting = new (class implements ProviderAdapter {
      readonly kind = "counting";
      readonly name = "counting";
      listModels() {
        discoverCount += 1;
        return Promise.resolve([
          {
            id: "counting/model",
            provider: "counting",
            name: "counting/model",
            free: true,
            source: "static" as const,
            capabilities: { chat: true },
          },
        ]);
      }
      chat(request: ChatRequest & { model: string }) {
        return Promise.resolve({
          id: "x",
          model: request.model,
          provider: "counting",
          content: "ok",
          raw: {},
        });
      }
    })();
    const router = new ModelRouter({
      providers: [counting],
      retry: { maxRetries: 0, baseDelayMs: 0 },
      catalogTtlMs: 0, // disable caching → re-discover every call
    });

    await router.listModels();
    await router.listModels();
    expect(discoverCount).toBe(2);
  });
});

describe("ModelRouter shuffle", () => {
  it("spreads load across providers when shuffle is set at the router level", async () => {
    const providers = Array.from({ length: 6 }, (_, i) => new FakeProvider(`p${i}`, "succeed"));
    const router = new ModelRouter({
      providers,
      retry: { maxRetries: 0, baseDelayMs: 0 },
      shuffle: true,
    });

    const picks = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const res = await router.chat({ messages: [{ role: "user", content: "hi" }] });
      picks.add(res.provider);
    }
    // With 6 always-succeed providers and Fisher–Yates shuffle, 60 calls must
    // touch more than one — a deterministic-quality order would always pick p0.
    expect(picks.size).toBeGreaterThan(1);
  });

  it("keeps the explicit models list order but shuffles the fallback tail", async () => {
    const pinned = new FakeProvider("pinned", "always-fail");
    const rest = Array.from({ length: 5 }, (_, i) => new FakeProvider(`rest${i}`, "succeed"));
    const router = new ModelRouter({
      providers: [pinned, ...rest],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const firstServicers = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const res = await router.chat({
        messages: [{ role: "user", content: "hi" }],
        model: "pinned/model",
        fallbackToRest: true,
        shuffle: true,
      });
      firstServicers.add(res.provider);
    }
    // pinned always fails so it never serves; the servicer comes from the
    // shuffled tail and must vary across calls.
    expect(firstServicers.has("pinned")).toBe(false);
    expect(firstServicers.size).toBeGreaterThan(1);
  });

  it("lets a per-call shuffle:false opt out of a router-level shuffle", async () => {
    const p0 = new FakeProvider("p0", "succeed");
    const p1 = new FakeProvider("p1", "succeed");
    const router = new ModelRouter({
      providers: [p0, p1],
      retry: { maxRetries: 0, baseDelayMs: 0 },
      shuffle: true,
    });

    // p0 has the higher qualityScore, so with shuffle off it always wins.
    for (let i = 0; i < 10; i += 1) {
      const res = await router.chat({
        messages: [{ role: "user", content: "hi" }],
        shuffle: false,
        sortBy: "quality",
      });
      expect(res.provider).toBe("p0");
    }
  });
});

describe("ModelRouter streaming", () => {
  it("streams chunks from a native streamChat provider", async () => {
    const streaming = new StreamingProvider("stream", ["Hel", "lo", " world"]);
    const router = new ModelRouter({
      providers: [streaming],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const chunks: string[] = [];
    for await (const chunk of router.streamChat({
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("Hello world");
    expect(streaming.invocations).toBe(1);
  });

  it("falls back to buffered chat for providers without streamChat", async () => {
    const buffered = new FakeProvider("buf", "succeed");
    const router = new ModelRouter({
      providers: [buffered],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    const chunks: string[] = [];
    for await (const chunk of router.streamChat({
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("fallback ok");
  });
});

class MultiModelProvider implements ProviderAdapter {
  readonly kind = "multi";
  attemptedIds: string[] = [];
  constructor(
    readonly name: string,
    private readonly models: Array<{ id: string; qualityScore?: number; contextWindow?: number }>,
  ) {}
  async listModels(): Promise<DiscoveredModel[]> {
    return this.models.map((m) => ({
      id: m.id,
      provider: this.name,
      name: m.id,
      free: true,
      source: "static",
      capabilities: { chat: true },
      qualityScore: m.qualityScore,
      contextWindow: m.contextWindow,
    }));
  }
  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    this.attemptedIds.push(request.model);
    return {
      id: `chat-${request.model}`,
      model: request.model,
      provider: this.name,
      content: `hello from ${request.model}`,
      raw: {},
    };
  }
}

describe("ModelRouter usage tracking", () => {
  it("aggregates per-provider tokens across chat calls and exposes reset", async () => {
    const alpha = new UsageProvider("alpha", { prompt: 10, completion: 20 });
    const beta = new UsageProvider("beta", { prompt: 5, completion: 15 });
    const router = new ModelRouter({
      providers: [alpha, beta],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });

    await router.chat({ messages: [{ role: "user", content: "hi" }], model: "alpha/model" });
    await router.chat({ messages: [{ role: "user", content: "hi" }], model: "alpha/model" });
    await router.chat({ messages: [{ role: "user", content: "hi" }], model: "beta/model" });

    const byProvider = router.getUsage();
    expect(byProvider.alpha).toMatchObject({
      requests: 2,
      successes: 2,
      errors: 0,
      promptTokens: 20,
      completionTokens: 40,
      totalTokens: 60,
    });
    expect(byProvider.beta.totalTokens).toBe(20);

    const byModel = router.getUsage({ by: "model" });
    expect(byModel["alpha/alpha/model"].requests).toBe(2);
    expect(byModel["beta/beta/model"].requests).toBe(1);

    router.resetUsage();
    expect(router.getUsage()).toEqual({});
  });

  it("counts retries as separate provider requests", async () => {
    const flaky = new UsageProvider("flaky", { prompt: 1, completion: 1 }, { failFirst: 2 });
    const router = new ModelRouter({
      providers: [flaky],
      retry: { maxRetries: 2, baseDelayMs: 0 },
    });

    await router.chat({ messages: [{ role: "user", content: "hi" }] });

    const usage = router.getUsage();
    expect(usage.flaky.requests).toBe(3);
    expect(usage.flaky.errors).toBe(2);
    expect(usage.flaky.successes).toBe(1);
  });
});

class UsageProvider implements ProviderAdapter {
  readonly kind = "usage";
  private attemptIndex = 0;
  constructor(
    readonly name: string,
    private readonly usage: { prompt: number; completion: number },
    private readonly options: { failFirst?: number } = {},
  ) {}
  async listModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: `${this.name}/model`,
        provider: this.name,
        name: `${this.name}/model`,
        free: true,
        source: "static",
        capabilities: { chat: true },
        qualityScore: 0.8,
      },
    ];
  }
  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    this.attemptIndex += 1;
    if (this.options.failFirst && this.attemptIndex <= this.options.failFirst) {
      throw new RetryableProviderError(this.name, "flaky");
    }
    return {
      id: `chat-${this.attemptIndex}`,
      model: request.model,
      provider: this.name,
      content: "ok",
      raw: {},
      usage: {
        promptTokens: this.usage.prompt,
        completionTokens: this.usage.completion,
        totalTokens: this.usage.prompt + this.usage.completion,
      },
    };
  }
}

class SlowProvider implements ProviderAdapter {
  readonly kind = "slow";
  attempts = 0;
  constructor(
    readonly name: string,
    private readonly delayMs: number,
  ) {}
  async listModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: `${this.name}/model`,
        provider: this.name,
        name: `${this.name}/model`,
        free: true,
        source: "static",
        capabilities: { chat: true },
        contextWindow: 32_000,
        qualityScore: 0.8,
      },
    ];
  }
  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    this.attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      id: `chat-${this.name}`,
      model: request.model,
      provider: this.name,
      content: `hello from ${this.name}`,
      raw: {},
    };
  }
}

// Always fails with a RetryableProviderError carrying a Retry-After hint,
// so the router can be asserted to honour it over its fixed cooldown window.
class RetryAfterProvider implements ProviderAdapter {
  readonly kind = "retry-after";
  constructor(
    readonly name: string,
    private readonly retryAfterSeconds: number,
  ) {}
  async listModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: `${this.name}/model`,
        provider: this.name,
        name: `${this.name}/model`,
        free: true,
        source: "static",
        capabilities: { chat: true },
        qualityScore: 0.8,
      },
    ];
  }
  async chat(): Promise<ChatResponse> {
    throw new RetryableProviderError(this.name, "rate limited", 429, this.retryAfterSeconds * 1000);
  }
}

// Yields a configurable sequence of content chunks, exercising the router's
// streaming path without a real network.
class StreamingProvider implements ProviderAdapter {
  readonly kind = "streaming";
  invocations = 0;
  constructor(
    readonly name: string,
    private readonly chunks: string[],
  ) {}
  async listModels(): Promise<DiscoveredModel[]> {
    return [
      {
        id: `${this.name}/model`,
        provider: this.name,
        name: `${this.name}/model`,
        free: true,
        source: "static",
        capabilities: { chat: true },
        qualityScore: 0.8,
      },
    ];
  }
  async chat(): Promise<ChatResponse> {
    throw new Error("use streamChat");
  }
  async *streamChat(request: ChatRequest & { model: string }) {
    this.invocations += 1;
    for (const content of this.chunks) {
      yield { content, done: false };
    }
    yield { content: "", done: true };
    void request;
  }
}
// Silence unused warning — ProviderError kept for future ergonomic imports.
void ProviderError;
