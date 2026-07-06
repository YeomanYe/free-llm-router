import { describe, expect, it } from "vitest";
import { ModelRouter } from "../src/router.js";
import type { ObjectRequest, ObjectResponse, ProviderAdapter } from "../src/types.js";
import { NoAvailableModelError, ProviderError } from "../src/errors.js";

/** A fake provider that implements object() and succeeds. */
function withObject(): { provider: ProviderAdapter; calls: number } {
  let calls = 0;
  const provider: ProviderAdapter = {
    name: "p-with",
    kind: "test",
    listModels: async () => [
      {
        id: "m1",
        provider: "p-with",
        name: "m1",
        free: true,
        source: "static",
        qualityScore: 0.9,
        tier: "medium-1",
        capabilities: { chat: true, tools: true, vision: false },
      },
    ],
    chat: async () => ({ id: "1", model: "m1", provider: "p-with", content: "x", raw: {} }),
    object: async (req): Promise<ObjectResponse> => {
      calls += 1;
      return { id: "1", model: req.model, provider: "p-with", object: { ok: true }, raw: {} };
    },
  };
  return { provider, get calls() { return calls; } } as never;
}

describe("ModelRouter.object", () => {
  it("calls a provider that implements object() and returns its object", async () => {
    const { provider } = withObject();
    const router = new ModelRouter({ providers: [provider] });
    const req: ObjectRequest = {
      model: "m1",
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object" },
    };
    const res = await router.object(req);
    expect(res.object).toEqual({ ok: true });
  });

  it("skips providers without object() and throws NoAvailableModelError if none have it", async () => {
    const noObject: ProviderAdapter = {
      name: "p-without",
      kind: "test",
      listModels: async () => [
        {
          id: "m2",
          provider: "p-without",
          name: "m2",
          free: true,
          source: "static",
          qualityScore: 0.5,
          tier: "low-2",
          capabilities: { chat: true, tools: false, vision: false },
        },
      ],
      chat: async () => ({ id: "1", model: "m2", provider: "p-without", content: "", raw: {} }),
    };
    const router = new ModelRouter({ providers: [noObject] });
    await expect(
      router.object({
        model: "m2",
        messages: [{ role: "user", content: "x" }],
        schema: { type: "object" },
      }),
    ).rejects.toBeInstanceOf(NoAvailableModelError);
  });

  it("falls back to the next provider when the first object() throws a retryable error then second succeeds", async () => {
    let first = true;
    const flaky: ProviderAdapter = {
      name: "flaky",
      kind: "test",
      listModels: async () => [
        {
          id: "mf",
          provider: "flaky",
          name: "mf",
          free: true,
          source: "static",
          qualityScore: 0.5,
          tier: "low-2",
          capabilities: { chat: true, tools: true, vision: false },
        },
      ],
      chat: async () => ({ id: "1", model: "mf", provider: "flaky", content: "", raw: {} }),
      object: async () => {
        if (first) {
          first = false;
          throw new ProviderError("flaky", "rate limited", { retryable: true });
        }
        return { id: "1", model: "mf", provider: "flaky", object: { recovered: true }, raw: {} };
      },
    };
    const good: ProviderAdapter = {
      name: "good",
      kind: "test",
      listModels: async () => [
        {
          id: "mg",
          provider: "good",
          name: "mg",
          free: true,
          source: "static",
          qualityScore: 0.6,
          tier: "low-2",
          capabilities: { chat: true, tools: true, vision: false },
        },
      ],
      chat: async () => ({ id: "1", model: "mg", provider: "good", content: "", raw: {} }),
      object: async (req) => ({ id: "2", model: req.model, provider: "good", object: { ok: true }, raw: {} }),
    };
    // maxRetries=0 so the flaky provider throws once and the router falls
    // through to `good` deterministically.
    const router = new ModelRouter({
      providers: [flaky, good],
      retry: { maxRetries: 0, baseDelayMs: 0 },
    });
    const res = await router.object({
      tier: "low-2",
      messages: [{ role: "user", content: "x" }],
      schema: { type: "object" },
    });
    expect(res.object).toEqual({ ok: true });
  });
});
