// Per-provider free-tier quota probe. Some providers (OpenRouter, Vercel AI
// Gateway) expose a REST balance endpoint; the rest are documented from their
// public free-tier policy and can be optionally probed by sending a tiny chat
// call to detect the current 429/403 state.

import { HARDCODED_FREE_POLICY, QUOTA_POLICY_AS_OF } from "./quotaPolicy.js";

export { QUOTA_POLICY_AS_OF };

export interface ProviderQuotaResult {
  provider: string;
  source: "api" | "policy" | "no-key";
  isFreeTier?: boolean;
  usageUsd?: number;
  balanceUsd?: number;
  remainingUsd?: number;
  freePolicy?: string;
  callable?: "ok" | "rate-limited" | "unauthorized" | "unreachable";
  callableDetail?: string;
  error?: string;
}

interface ProbeContext {
  providerName: string;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  probe?: boolean;
  freeModelId?: string;
}

// Strips the numeric `#N` suffix we append to fallback provider instances so
// probes hit the same physical service for `openrouter` and `openrouter#2`.
function canonicalName(providerName: string): string {
  const hashIndex = providerName.indexOf("#");
  return hashIndex === -1 ? providerName : providerName.slice(0, hashIndex);
}

export async function probeQuota(ctx: ProbeContext): Promise<ProviderQuotaResult> {
  const base = canonicalName(ctx.providerName);
  if (!ctx.apiKey && base !== "cloudflare") {
    return { provider: ctx.providerName, source: "no-key" };
  }

  let result: ProviderQuotaResult;
  switch (base) {
    case "openrouter":
      result = await probeOpenRouter(ctx.providerName, ctx.apiKey!);
      break;
    default:
      result = policyOnly(ctx.providerName);
  }

  if (ctx.probe && ctx.baseUrl && ctx.apiKey && ctx.freeModelId) {
    const call = await probeChat(ctx.baseUrl, ctx.apiKey, ctx.freeModelId);
    result.callable = call.status;
    result.callableDetail = call.detail;
  }
  return result;
}

async function probeOpenRouter(name: string, apiKey: string): Promise<ProviderQuotaResult> {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return {
        provider: name,
        source: "api",
        error: `HTTP ${response.status}`,
        freePolicy: HARDCODED_FREE_POLICY.openrouter,
      };
    }
    const payload = (await response.json()) as {
      data?: {
        is_free_tier?: boolean;
        limit?: number | null;
        limit_remaining?: number | null;
        usage?: number;
      };
    };
    const data = payload.data ?? {};
    const result: ProviderQuotaResult = {
      provider: name,
      source: "api",
      isFreeTier: data.is_free_tier,
      usageUsd: data.usage,
      freePolicy: HARDCODED_FREE_POLICY.openrouter,
    };
    if (typeof data.limit === "number") result.balanceUsd = data.limit;
    if (typeof data.limit_remaining === "number") result.remainingUsd = data.limit_remaining;
    return result;
  } catch (error) {
    return {
      provider: name,
      source: "api",
      error: error instanceof Error ? error.message : String(error),
      freePolicy: HARDCODED_FREE_POLICY.openrouter,
    };
  }
}

function policyOnly(name: string): ProviderQuotaResult {
  const canonical = canonicalName(name);
  return {
    provider: name,
    source: "policy",
    freePolicy:
      HARDCODED_FREE_POLICY[canonical] ?? "No public quota API. Check the provider dashboard.",
  };
}

async function probeChat(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<{ status: NonNullable<ProviderQuotaResult["callable"]>; detail?: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    if (response.ok) return { status: "ok" };
    if (response.status === 401 || response.status === 403) {
      return { status: "unauthorized", detail: `HTTP ${response.status}` };
    }
    if (response.status === 429) return { status: "rate-limited", detail: `HTTP 429` };
    return { status: "unreachable", detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      status: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
