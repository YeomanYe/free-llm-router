import { describe, expect, it } from "vitest";

import {
  ModelRouter,
  ProviderError,
  RetryableProviderError,
  pickBestModelPerProvider
} from "../src/index.js";
import type {
  ChatRequest,
  ChatResponse,
  DiscoveredModel,
  ProviderAdapter
} from "../src/types.js";

class FakeProvider implements ProviderAdapter {
  readonly kind = "fake";

  attempts = 0;

  constructor(
    readonly name: string,
    private readonly behavior: "always-fail" | "succeed"
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
        qualityScore: this.behavior === "succeed" ? 0.8 : 0.4
      }
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
      raw: { ok: true }
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
          "low-3"
        ]
      }
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hello" }]
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
      retry: { maxRetries: 0, baseDelayMs: 0 }
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
      models: ["alpha/model", "beta/model", "gamma/model"]
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
      retry: { maxRetries: 0, baseDelayMs: 0 }
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
      providers: ["gamma", "beta"]
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
      retry: { maxRetries: 0, baseDelayMs: 0 }
    });

    const response = await router.chat({
      messages: [{ role: "user", content: "hi" }],
      providers: ["preferred"],
      fallbackToRest: true
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
      retry: { maxRetries: 0, baseDelayMs: 0 }
    });

    await expect(
      router.chat({
        messages: [{ role: "user", content: "hi" }],
        providers: ["preferred"]
      })
    ).rejects.toThrow(/rate limited/);
    expect(backup.attempts).toBe(0);
  });

  it("chatRace returns the first successful response and hits every candidate", async () => {
    const slow = new SlowProvider("slow", 40);
    const fast = new SlowProvider("fast", 5);
    const router = new ModelRouter({
      providers: [slow, fast],
      retry: { maxRetries: 0, baseDelayMs: 0 }
    });

    const response = await router.chatRace({
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response.provider).toBe("fast");
    expect(slow.attempts).toBe(1);
    expect(fast.attempts).toBe(1);
  });

  it("chatAll perProvider fires only the top-qualityScore model per provider", async () => {
    const heavy = new MultiModelProvider("heavy", [
      { id: "heavy/a", qualityScore: 0.4 },
      { id: "heavy/b", qualityScore: 0.9 },
      { id: "heavy/c", qualityScore: 0.7 }
    ]);
    const solo = new MultiModelProvider("solo", [{ id: "solo/x", qualityScore: 0.6 }]);
    const router = new ModelRouter({
      providers: [heavy, solo],
      retry: { maxRetries: 0, baseDelayMs: 0 }
    });

    const results = await router.chatAll(
      { messages: [{ role: "user", content: "hi" }] },
      { perProvider: true }
    );

    expect(results.map((r) => r.model).sort()).toEqual(["heavy/b", "solo/x"]);
    expect(heavy.attemptedIds).toEqual(["heavy/b"]);
    expect(solo.attemptedIds).toEqual(["solo/x"]);
  });

  it("pickBestModelPerProvider keeps highest qualityScore only", () => {
    const picked = pickBestModelPerProvider([
      { id: "a", provider: "p1", name: "a", free: true, source: "static", capabilities: { chat: true }, qualityScore: 0.4 },
      { id: "b", provider: "p1", name: "b", free: true, source: "static", capabilities: { chat: true }, qualityScore: 0.8 },
      { id: "c", provider: "p2", name: "c", free: true, source: "static", capabilities: { chat: true }, qualityScore: 0.5 }
    ]);
    expect(picked.map((m) => m.id).sort()).toEqual(["b", "c"]);
  });

  it("chatAll returns per-candidate results including errors", async () => {
    const ok = new FakeProvider("ok", "succeed");
    const broken = new FakeProvider("broken", "always-fail");
    const router = new ModelRouter({
      providers: [ok, broken],
      retry: { maxRetries: 0, baseDelayMs: 0 }
    });

    const results = await router.chatAll({
      messages: [{ role: "user", content: "hi" }]
    });

    const okResult = results.find((r) => r.provider === "ok");
    const brokenResult = results.find((r) => r.provider === "broken");
    expect(okResult?.response?.content).toBe("fallback ok");
    expect(brokenResult?.error?.message).toContain("rate limited");
    expect(ok.attempts).toBe(1);
    expect(broken.attempts).toBe(1);
  });
});

class MultiModelProvider implements ProviderAdapter {
  readonly kind = "multi";
  attemptedIds: string[] = [];
  constructor(
    readonly name: string,
    private readonly models: Array<{ id: string; qualityScore?: number }>
  ) {}
  async listModels(): Promise<DiscoveredModel[]> {
    return this.models.map((m) => ({
      id: m.id,
      provider: this.name,
      name: m.id,
      free: true,
      source: "static",
      capabilities: { chat: true },
      qualityScore: m.qualityScore
    }));
  }
  async chat(request: ChatRequest & { model: string }): Promise<ChatResponse> {
    this.attemptedIds.push(request.model);
    return {
      id: `chat-${request.model}`,
      model: request.model,
      provider: this.name,
      content: `hello from ${request.model}`,
      raw: {}
    };
  }
}

class SlowProvider implements ProviderAdapter {
  readonly kind = "slow";
  attempts = 0;
  constructor(readonly name: string, private readonly delayMs: number) {}
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
        qualityScore: 0.8
      }
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
      raw: {}
    };
  }
}
// Silence unused warning — ProviderError kept for future ergonomic imports.
void ProviderError;
