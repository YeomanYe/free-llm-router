import { describe, expect, it } from "vitest";

import { ModelRouter, ProviderError, RetryableProviderError } from "../src/index.js";
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
