import { readFile } from "node:fs/promises";

import { z } from "zod";

import { ModelRouter } from "./router.js";
import { CloudflareWorkersAIProvider } from "./providers/cloudflare.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import type { ProviderAdapter, RouterOptions } from "./types.js";

const staticModelSchema = z.object({
  id: z.string(),
  free: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  qualityScore: z.number().min(0).max(1).optional()
});

const openAICompatibleProviderSchema = z.object({
  type: z.literal("openai-compatible"),
  name: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  headers: z.record(z.string()).optional(),
  freeModelPatterns: z.array(z.string()).optional(),
  staticModels: z.array(staticModelSchema).optional(),
  discoverModels: z.boolean().optional()
});

const cloudflareProviderSchema = z.object({
  type: z.literal("cloudflare-workers-ai"),
  name: z.string().optional(),
  accountId: z.string().optional(),
  apiToken: z.string(),
  staticModels: z.array(staticModelSchema).optional()
});

const providerSchema = z.discriminatedUnion("type", [
  openAICompatibleProviderSchema,
  cloudflareProviderSchema
]);

const configSchema = z.object({
  freeOnly: z.boolean().optional(),
  retry: z
    .object({
      maxRetries: z.number().int().min(0).optional(),
      baseDelayMs: z.number().int().min(0).optional()
    })
    .optional(),
  fallback: z
    .object({
      tiers: z
        .array(
          z.enum([
            "high-1",
            "high-2",
            "high-3",
            "medium-1",
            "medium-2",
            "medium-3",
            "low-1",
            "low-2",
            "low-3"
          ])
        )
        .optional()
    })
    .optional(),
  providers: z.array(providerSchema).min(1)
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
      const variants = apiKeys.length > 0 ? apiKeys : [undefined];
      return variants.map((apiKey, index) =>
        new OpenAICompatibleProvider({
          name: instanceName(provider.name, index),
          baseUrl: provider.baseUrl,
          apiKey,
          headers: provider.headers,
          freeModelPatterns: provider.freeModelPatterns,
          staticModels: provider.staticModels,
          discoverModels: provider.discoverModels
        })
      );
    }

    const accountId = resolveOptionalSecret(provider.accountId);
    const apiTokens = resolveSecretList(provider.apiToken);
    const baseName = provider.name ?? "cloudflare";
    return apiTokens.map((apiToken, index) =>
      new CloudflareWorkersAIProvider({
        name: instanceName(baseName, index),
        accountId,
        apiToken,
        staticModels: provider.staticModels
      })
    );
  });

  const options: RouterOptions = {
    providers,
    freeOnly: config.freeOnly,
    retry: config.retry,
    fallback: config.fallback
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

  if (values.length === 0) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return values;
}
