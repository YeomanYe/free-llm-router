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
  it("classifies capable free models as high tier", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 128_000,
          capabilities: { chat: true, tools: true, vision: true },
          qualityScore: 0.9,
          rateLimit: { rpm: 60 }
        })
      )
    ).toBe("high");
  });

  it("classifies useful but constrained models as medium tier", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 32_000,
          capabilities: { chat: true },
          qualityScore: 0.62,
          rateLimit: { rpm: 20 }
        })
      )
    ).toBe("medium");
  });

  it("classifies weak or heavily constrained models as low tier", () => {
    expect(
      classifyModelTier(
        model({
          contextWindow: 4_096,
          capabilities: { chat: true },
          qualityScore: 0.35,
          rateLimit: { rpm: 3 }
        })
      )
    ).toBe("low");
  });
});
