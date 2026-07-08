import { readFile } from "node:fs/promises";

import { z } from "zod";
import { AnthropicMessagesProvider } from "./providers/anthropic.js";
import { CloudflareWorkersAIProvider } from "./providers/cloudflare.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import { ModelRouter } from "./router.js";
import type { ProviderAdapter, RouterOptions } from "./types.js";
import { MODEL_TIERS, type ModelTier } from "./types.js";

const tierEnum = z.enum(MODEL_TIERS as [ModelTier, ...ModelTier[]]);

const staticModelSchema = z.object({
  id: z.string(),
  free: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  qualityScore: z.number().min(0).max(1).optional(),
});

const openAICompatibleProviderSchema = z.object({
  type: z.literal("openai-compatible"),
  name: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  headers: z.record(z.string()).optional(),
  freeModelPatterns: z.array(z.string()).optional(),
  staticModels: z.array(staticModelSchema).optional(),
  discoverModels: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const cloudflareProviderSchema = z.object({
  type: z.literal("cloudflare-workers-ai"),
  name: z.string().optional(),
  accountId: z.string().optional(),
  apiToken: z.string(),
  staticModels: z.array(staticModelSchema).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const anthropicProviderSchema = z.object({
  type: z.literal("anthropic-messages"),
  name: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string(),
  headers: z.record(z.string()).optional(),
  staticModels: z.array(staticModelSchema).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const providerSchema = z.discriminatedUnion("type", [
  openAICompatibleProviderSchema,
  cloudflareProviderSchema,
  anthropicProviderSchema,
]);

const configSchema = z.object({
  freeOnly: z.boolean().optional(),
  retry: z
    .object({
      maxRetries: z.number().int().min(0).optional(),
      baseDelayMs: z.number().int().min(0).optional(),
    })
    .optional(),
  fallback: z
    .object({
      tiers: z.array(tierEnum).optional(),
    })
    .optional(),
  cooldownMs: z.number().int().positive().optional(),
  cooldownThreshold: z.number().int().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  catalogTtlMs: z.number().int().min(0).optional(),
  providers: z.array(providerSchema).min(1),
});

export type RouterConfig = z.infer<typeof configSchema>;

export async function createRouterFromFile(path: string): Promise<ModelRouter> {
  const raw = await readFile(path, "utf8");
  return createRouterFromConfig(JSON.parse(raw));
}

export function createRouterFromConfig(input: unknown): ModelRouter {
  const config = configSchema.parse(input);
  const providers: ProviderAdapter[] = config.providers.flatMap((provider): ProviderAdapter[] => {
    if (provider.type === "openai-compatible") {
      const apiKeys = resolveSecretList(provider.apiKey);
      // apiKey 明确指定了(如 "env/NAME")但解析为空 → 运维本想给 key 却缺失 → 跳过该 provider,
      // 不建一个必然 401 的 keyless 实例。apiKey 未指定(undefined) → 允许 keyless(部分 OpenAI
      // 兼容端点无需 key)。
      if (provider.apiKey !== undefined && apiKeys.length === 0) {
        return [];
      }
      const variants = apiKeys.length > 0 ? apiKeys : [undefined];
      return variants.map(
        (apiKey, index) =>
          new OpenAICompatibleProvider({
            name: instanceName(provider.name, index),
            baseUrl: provider.baseUrl,
            apiKey,
            headers: provider.headers,
            freeModelPatterns: provider.freeModelPatterns,
            staticModels: provider.staticModels,
            discoverModels: provider.discoverModels,
            timeoutMs: provider.timeoutMs,
          }),
      );
    }

    if (provider.type === "anthropic-messages") {
      const apiKeys = resolveSecretList(provider.apiKey);
      return apiKeys.map(
        (apiKey, index) =>
          new AnthropicMessagesProvider({
            name: instanceName(provider.name, index),
            baseUrl: provider.baseUrl,
            apiKey,
            headers: provider.headers,
            staticModels: provider.staticModels,
            timeoutMs: provider.timeoutMs,
          }),
      );
    }

    const accountId = resolveOptionalSecret(provider.accountId);
    const apiTokens = resolveSecretList(provider.apiToken);
    const baseName = provider.name ?? "cloudflare";
    return apiTokens.map(
      (apiToken, index) =>
        new CloudflareWorkersAIProvider({
          name: instanceName(baseName, index),
          accountId,
          apiToken,
          staticModels: provider.staticModels,
          timeoutMs: provider.timeoutMs,
        }),
    );
  });

  const options: RouterOptions = {
    providers,
    freeOnly: config.freeOnly,
    retry: config.retry,
    fallback: config.fallback,
    cooldownMs: config.cooldownMs,
    cooldownThreshold: config.cooldownThreshold,
    timeoutMs: config.timeoutMs,
    catalogTtlMs: config.catalogTtlMs,
  };

  return new ModelRouter(options);
}

function instanceName(base: string, index: number): string {
  return index === 0 ? base : `${base}#${index + 1}`;
}

function resolveSecret(value: string | undefined): string | undefined {
  if (!value?.startsWith("env/")) {
    return value;
  }

  const name = value.slice("env/".length);
  const resolved = process.env[name];

  if (!resolved) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return resolved;
}

// Kept for API symmetry with resolveOptionalSecret; resolveSecretList handles
// every code path used by config today, but this stays exported for callers
// that resolve a single secret directly.
export { resolveSecret };

function resolveOptionalSecret(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value.startsWith("env/")) {
    return value;
  }
  const name = value.slice("env/".length);
  return process.env[name] || undefined;
}

// Resolves `env/NAME` by walking NAME, NAME2, NAME3, ... so operators can drop
// backup keys into their .env and get automatic fallback provider instances.
function resolveSecretList(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  if (!value.startsWith("env/")) {
    return [value];
  }

  const name = value.slice("env/".length);
  const values: string[] = [];
  const primary = process.env[name];
  if (primary) {
    values.push(primary);
  }

  for (let suffix = 2; ; suffix += 1) {
    const next = process.env[`${name}${suffix}`];
    if (!next) {
      break;
    }
    values.push(next);
  }

  // env/NAME 指向的变量缺失/为空 → 返回空列表(不再 throw)。让"没配某个可选 provider
  // 的 key"变成"优雅跳过该 provider",而不是炸掉整个 router 构造。调用方(见 openai-compatible
  // 分支)据此跳过该 provider。
  return values;
}
