import { describe, expect, it } from "vitest";

import { classifyModelTier } from "../src/tiering.js";
import type { DiscoveredModel } from "../src/types.js";

function model(overrides: Partial<DiscoveredModel>): DiscoveredModel {
  return {
    id: "provider/model",
    provider: "test",
    name: "provider/model",
    free: true,
    source: "discovered",
    capabilities: {},
    ...overrides
  };
}

describe("classifyModelTier", () => {
  it("classifies top-of-line free models as high-1", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 128_000,
          capabilities: { chat: true, tools: true, vision: true },
          qualityScore: 0.9,
          rateLimit: { rpm: 60 }
        })
      )
    ).toBe("high-1");
  });

  it("classifies solid high-quality models as high-2", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 128_000,
          capabilities: { chat: true },
          qualityScore: 0.9,
          rateLimit: { rpm: 15 }
        })
      )
    ).toBe("high-2");
  });

  it("classifies entry high-quality models as high-3", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 32_000,
          capabilities: { chat: true },
          qualityScore: 0.9
        })
      )
    ).toBe("high-3");
  });

  it("classifies useful but constrained models as medium-1", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 32_000,
          capabilities: { chat: true },
          qualityScore: 0.62,
          rateLimit: { rpm: 20 }
        })
      )
    ).toBe("medium-1");
  });

  it("classifies mid-band models as medium-2", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 32_000,
          capabilities: { chat: true },
          qualityScore: 0.62
        })
      )
    ).toBe("medium-2");
  });

  it("classifies entry medium models as medium-3", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 8_000,
          capabilities: { chat: true },
          qualityScore: 0.5,
          rateLimit: { rpm: 15 }
        })
      )
    ).toBe("medium-3");
  });

  it("classifies constrained small models as low-1", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 8_000,
          capabilities: { chat: true },
          qualityScore: 0.5
        })
      )
    ).toBe("low-1");
  });

  it("classifies bare-minimum chat models as low-3", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 4_096,
          capabilities: { chat: true },
          qualityScore: 0.35,
          rateLimit: { rpm: 3 }
        })
      )
    ).toBe("low-3");
  });
});
