import type { DiscoveredModel, ModelTier } from "./types.js";

export function classifyModelTier(model: DiscoveredModel): ModelTier {
  let score = 0;

  if ((model.qualityScore ?? 0) >= 0.85) {
    score += 4;
  } else if ((model.qualityScore ?? 0) >= 0.6) {
    score += 2;
  } else if ((model.qualityScore ?? 0) >= 0.45) {
    score += 1;
  }

  if ((model.contextWindow ?? 0) >= 128_000) {
    score += 3;
  } else if ((model.contextWindow ?? 0) >= 32_000) {
    score += 2;
  } else if ((model.contextWindow ?? 0) >= 8_000) {
    score += 1;
  }

  if (model.capabilities.chat) {
    score += 1;
  }

  if (model.capabilities.tools) {
    score += 1;
  }

  if (model.capabilities.vision) {
    score += 1;
  }

  if ((model.rateLimit?.rpm ?? 0) >= 60) {
    score += 2;
  } else if ((model.rateLimit?.rpm ?? 0) >= 15) {
    score += 1;
  } else if ((model.rateLimit?.rpm ?? Number.POSITIVE_INFINITY) <= 5) {
    score -= 1;
  }

  if (score >= 10) return "high-1";
  if (score >= 8) return "high-2";
  if (score >= 7) return "high-3";
  if (score >= 6) return "medium-1";
  if (score >= 5) return "medium-2";
  if (score >= 4) return "medium-3";
  if (score >= 3) return "low-1";
  if (score >= 2) return "low-2";
  return "low-3";
}

export function withTier(model: DiscoveredModel): DiscoveredModel {
  return {
    ...model,
    tier: model.tier ?? classifyModelTier(model),
  };
}
