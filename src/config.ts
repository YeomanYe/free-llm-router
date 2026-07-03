import { readFile } from "node:fs/promises";

import { z } from "zod";

import { ModelRouter } from "./router.js";
import { CloudflareWorkersAIProvider } from "./providers/cloudflare.js";
import { OpenAICompatibleProvider } from "./providers/openaiCompatible.js";
import type { RouterOptions } from "./types.js";

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
  accountId: z.string(),
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
      tiers: z.array(z.enum(["high", "medium", "low"])).optional()
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
  const providers = config.providers.map((provider) => {
    if (provider.type === "openai-compatible") {
      return new OpenAICompatibleProvider({
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: resolveSecret(provider.apiKey),
        headers: provider.headers,
        freeModelPatterns: provider.freeModelPatterns,
        staticModels: provider.staticModels,
        discoverModels: provider.discoverModels
      });
    }

    return new CloudflareWorkersAIProvider({
      name: provider.name,
      accountId: resolveSecret(provider.accountId) ?? provider.accountId,
      apiToken: resolveSecret(provider.apiToken) ?? provider.apiToken,
      staticModels: provider.staticModels
    });
  });

  const options: RouterOptions = {
    providers,
    freeOnly: config.freeOnly,
    retry: config.retry,
    fallback: config.fallback
  };

  return new ModelRouter(options);
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
