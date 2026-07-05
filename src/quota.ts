// Per-provider free-tier quota probe. Some providers (OpenRouter, Vercel AI
// Gateway) expose a REST balance endpoint; the rest are documented from their
// public free-tier policy and can be optionally probed by sending a tiny chat
// call to detect the current 429/403 state.

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

const HARDCODED_FREE_POLICY: Record<string, string> = {
  openrouter:
    "20 rpm on `:free` models (free tier). 1000 rpd once account has $10+ credit; no daily cap for a free-tier account otherwise.",
  "gemini-openai-compatible":
    "gemini-2.0-flash free tier: 15 rpm / 1M tpm / 1 500 rpd. Rolls at UTC 00:00.",
  groq:
    "~30 rpm per model, ~6-14k tpm, 500k tpd (per model). Free tier is generous but not queryable.",
  cerebras: "30 rpm, 60k tpm, ~900k tpd on llama-3.1-8b free tier.",
  bigmodel: "glm-4-flash / glm-4v-flash: officially permanent free, no advertised cap.",
  nvidia: "NIM free credits (~5k requests / personal account). Not queryable via REST.",
  "vercel-ai-gateway": "$5 signup credit; balance is queryable, model-level free lists via /credits.",
  cloudflare: "Workers AI: 10 000 neurons / day rolling. Analytics via GraphQL requires separate scope.",
  "cloudflare-workers-ai":
    "Workers AI: 10 000 neurons / day rolling. Analytics via GraphQL requires separate scope.",
  requesty: "Aggregator free tier ~ $1 signup credit; individual model quota depends on backing provider.",
  mistral: "Free tier: 1 rps and 500k tokens/mo on la Plateforme (not queryable).",
  huggingface: "Router free tier: rate-limited per model, no per-key balance API.",
  "github-models": "GitHub Models free tier: shared rate limit tied to your GitHub account (see docs)."
};

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
    case "vercel-ai-gateway":
      result = await probeVercelAiGateway(ctx.providerName, ctx.apiKey!);
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
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      return {
        provider: name,
        source: "api",
        error: `HTTP ${response.status}`,
        freePolicy: HARDCODED_FREE_POLICY.openrouter
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
      freePolicy: HARDCODED_FREE_POLICY.openrouter
    };
    if (typeof data.limit === "number") result.balanceUsd = data.limit;
    if (typeof data.limit_remaining === "number") result.remainingUsd = data.limit_remaining;
    return result;
  } catch (error) {
    return {
      provider: name,
      source: "api",
      error: error instanceof Error ? error.message : String(error),
      freePolicy: HARDCODED_FREE_POLICY.openrouter
    };
  }
}

async function probeVercelAiGateway(name: string, apiKey: string): Promise<ProviderQuotaResult> {
  try {
    const response = await fetch("https://ai-gateway.vercel.sh/v1/credits", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      return {
        provider: name,
        source: "api",
        error: `HTTP ${response.status}`,
        freePolicy: HARDCODED_FREE_POLICY["vercel-ai-gateway"]
      };
    }
    const payload = (await response.json()) as { balance?: string; total_used?: string };
    return {
      provider: name,
      source: "api",
      balanceUsd: payload.balance ? Number(payload.balance) : undefined,
      usageUsd: payload.total_used ? Number(payload.total_used) : undefined,
      freePolicy: HARDCODED_FREE_POLICY["vercel-ai-gateway"]
    };
  } catch (error) {
    return {
      provider: name,
      source: "api",
      error: error instanceof Error ? error.message : String(error),
      freePolicy: HARDCODED_FREE_POLICY["vercel-ai-gateway"]
    };
  }
}

function policyOnly(name: string): ProviderQuotaResult {
  const canonical = canonicalName(name);
  return {
    provider: name,
    source: "policy",
    freePolicy: HARDCODED_FREE_POLICY[canonical] ?? "No public quota API. Check the provider dashboard."
  };
}

async function probeChat(
  baseUrl: string,
  apiKey: string,
  modelId: string
): Promise<{ status: NonNullable<ProviderQuotaResult["callable"]>; detail?: string }> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      })
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
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
