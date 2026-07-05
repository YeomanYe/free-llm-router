#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { createRouterFromConfig } from "./config.js";
import { pickBestModelPerProvider, type ModelRouter } from "./router.js";
import { probeQuota, type ProviderQuotaResult } from "./quota.js";
import {
  MODEL_TIERS,
  type ChatMessage,
  type ChatRequest,
  type DiscoveredModel,
  type ModelTier,
  type SortDimension,
  type UsageStats
} from "./types.js";

function modelDimensionScore(model: DiscoveredModel, dim: SortDimension): number {
  switch (dim) {
    case "quality":
      return model.qualityScore ?? 0;
    case "context":
      return model.contextWindow ?? 0;
    case "cost":
      return model.pricing?.inputPerMillion !== undefined ? -model.pricing.inputPerMillion : 0;
    case "speed":
      // No per-model latency in the pre-broadcast catalog; fall through to 0.
      return 0;
  }
}

interface CommonOptions {
  config?: string;
  envFile?: string[];
  freeOnly?: boolean;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  switch (command) {
    case "chat":
      await runChat(rest);
      return;
    case "race":
      await runRace(rest);
      return;
    case "models":
      await runModels(rest);
      return;
    case "broadcast":
      await runBroadcast(rest);
      return;
    case "quota":
      await runQuota(rest);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function runChat(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "env-file": { type: "string", multiple: true },
      "free-only": { type: "boolean" },
      "no-free-only": { type: "boolean" },
      tier: { type: "string" },
      model: { type: "string" },
      models: { type: "string" },
      providers: { type: "string" },
      "fallback-to-rest": { type: "boolean" },
      "min-quality": { type: "string" },
      "min-ctx": { type: "string" },
      "max-latency": { type: "string" },
      "max-input-cost": { type: "string" },
      "include-cooling": { type: "boolean" },
      "sort-by": { type: "string" },
      stats: { type: "boolean" },
      "stats-by": { type: "string" },
      "max-tokens": { type: "string" },
      temperature: { type: "string" },
      system: { type: "string" }
    }
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.error("chat: missing prompt");
    process.exit(1);
  }

  const router = await bootstrap({
    config: values.config,
    envFile: values["env-file"],
    freeOnly: resolveFreeOnly(values)
  });

  const messages: ChatMessage[] = [];
  if (values.system) messages.push({ role: "system", content: values.system });
  messages.push({ role: "user", content: prompt });

  const response = await router.chat({
    messages,
    tier: coerceTier(values.tier),
    model: values.model,
    models: splitList(values.models),
    providers: splitList(values.providers),
    fallbackToRest: values["fallback-to-rest"],
    ...dimensionFilters(values),
    maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
    temperature: values.temperature ? Number(values.temperature) : undefined
  });

  console.log(response.content);
  console.error(`\n(via ${response.provider}/${response.model})`);
  if (values.stats) printUsage(router, values["stats-by"]);
}

async function runRace(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "env-file": { type: "string", multiple: true },
      "free-only": { type: "boolean" },
      "no-free-only": { type: "boolean" },
      tier: { type: "string" },
      model: { type: "string" },
      models: { type: "string" },
      providers: { type: "string" },
      "fallback-to-rest": { type: "boolean" },
      "min-quality": { type: "string" },
      "min-ctx": { type: "string" },
      "max-latency": { type: "string" },
      "max-input-cost": { type: "string" },
      "include-cooling": { type: "boolean" },
      "sort-by": { type: "string" },
      stats: { type: "boolean" },
      "stats-by": { type: "string" },
      "per-provider": { type: "boolean" },
      "max-tokens": { type: "string" },
      temperature: { type: "string" },
      system: { type: "string" }
    }
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.error("race: missing prompt");
    process.exit(1);
  }

  const router = await bootstrap({
    config: values.config,
    envFile: values["env-file"],
    freeOnly: resolveFreeOnly(values)
  });

  const messages: ChatMessage[] = [];
  if (values.system) messages.push({ role: "system", content: values.system });
  messages.push({ role: "user", content: prompt });

  const started = Date.now();
  const response = await router.chatRace(
    {
      messages,
      tier: coerceTier(values.tier),
      model: values.model,
      models: splitList(values.models),
      providers: splitList(values.providers),
      fallbackToRest: values["fallback-to-rest"],
      ...dimensionFilters(values),
      maxTokens: values["max-tokens"] ? Number(values["max-tokens"]) : undefined,
      temperature: values.temperature ? Number(values.temperature) : undefined
    },
    { perProvider: values["per-provider"] }
  );

  console.log(response.content);
  console.error(`\n(via ${response.provider}/${response.model} in ${Date.now() - started}ms)`);
  if (values.stats) printUsage(router, values["stats-by"]);
}

async function runModels(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      config: { type: "string" },
      "env-file": { type: "string", multiple: true },
      "free-only": { type: "boolean" },
      "no-free-only": { type: "boolean" },
      json: { type: "boolean" }
    }
  });

  const router = await bootstrap({
    config: values.config,
    envFile: values["env-file"],
    freeOnly: resolveFreeOnly(values)
  });

  const models = await router.listModels();

  if (values.json) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }

  const byProvider = new Map<string, typeof models>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  for (const name of [...byProvider.keys()].sort()) {
    const list = byProvider.get(name)!;
    console.log(`\n▸ ${name}  (${list.length})`);
    for (const m of list) {
      const flag = m.free ? "free" : "paid";
      const tier = m.tier ? `[${m.tier}]` : "";
      const ctx = m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx` : "";
      console.log(`  · [${flag}] ${tier} ${m.id}${ctx ? "  " + ctx : ""}`);
    }
  }
  console.log(`\nTotal: ${models.length} models across ${byProvider.size} providers.`);
}

async function runBroadcast(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "env-file": { type: "string", multiple: true },
      "free-only": { type: "boolean" },
      "no-free-only": { type: "boolean" },
      "max-tokens": { type: "string" },
      timeout: { type: "string" },
      tier: { type: "string" },
      "per-provider": { type: "boolean" },
      "min-quality": { type: "string" },
      "min-ctx": { type: "string" },
      "max-input-cost": { type: "string" },
      "sort-by": { type: "string" },
      "stats-by": { type: "string" }
    }
  });

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.error("broadcast: missing prompt");
    process.exit(1);
  }

  const timeoutMs = values.timeout ? Number(values.timeout) : 60_000;
  const maxTokens = values["max-tokens"] ? Number(values["max-tokens"]) : 200;

  const router = await bootstrap({
    config: values.config,
    envFile: values["env-file"],
    freeOnly: resolveFreeOnly(values)
  });

  const allModels = await router.listModels();
  const tier = coerceTier(values.tier);
  const minQuality = values["min-quality"] ? Number(values["min-quality"]) : undefined;
  const minCtx = values["min-ctx"] ? Number(values["min-ctx"]) : undefined;
  const maxCost = values["max-input-cost"] ? Number(values["max-input-cost"]) : undefined;
  const sortBy = typeof values["sort-by"] === "string" ? values["sort-by"] : undefined;

  let filtered = tier ? allModels.filter((m) => m.tier === tier) : allModels;
  if (minQuality !== undefined) filtered = filtered.filter((m) => (m.qualityScore ?? 0) >= minQuality);
  if (minCtx !== undefined) filtered = filtered.filter((m) => (m.contextWindow ?? 0) >= minCtx);
  if (maxCost !== undefined) filtered = filtered.filter((m) => (m.pricing?.inputPerMillion ?? 0) <= maxCost);
  if (sortBy) {
    if (!(SORT_DIMENSIONS as readonly string[]).includes(sortBy)) {
      console.error(`Invalid --sort-by "${sortBy}". Expected one of: ${SORT_DIMENSIONS.join(", ")}`);
      process.exit(1);
    }
    filtered = [...filtered].sort((a, b) => modelDimensionScore(b, sortBy as SortDimension) - modelDimensionScore(a, sortBy as SortDimension));
  }
  const models = values["per-provider"] ? pickBestModelPerProvider(filtered) : filtered;

  if (models.length === 0) {
    console.error("broadcast: no models matched the filter");
    process.exit(1);
  }

  console.log(`Prompt: ${prompt}`);
  console.log(`Broadcasting to ${models.length} models...\n`);

  const results = await Promise.all(
    models.map(async (m) => {
      const label = `${m.provider}/${m.id}`;
      const started = Date.now();
      try {
        const response = await withTimeout(
          router.chat({
            model: label,
            messages: [{ role: "user", content: prompt }],
            maxTokens
          }),
          timeoutMs
        );
        return { label, tier: m.tier, ms: Date.now() - started, ok: true as const, content: response.content.trim() };
      } catch (error) {
        return {
          label,
          tier: m.tier,
          ms: Date.now() - started,
          ok: false as const,
          content: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  for (const r of results) {
    const badge = r.ok ? "OK " : "ERR";
    console.log(`── [${badge}] ${r.label}  tier=${r.tier ?? "?"}  ${r.ms}ms`);
    console.log(indent(r.content || "(empty)"));
    console.log();
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log(`Done: ${okCount}/${results.length} ok`);
  printUsage(router, values["stats-by"]);
}

async function runQuota(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      config: { type: "string" },
      "env-file": { type: "string", multiple: true },
      probe: { type: "boolean" },
      json: { type: "boolean" }
    }
  });

  loadDefaultEnvFiles(values["env-file"] ?? []);
  const configPath = resolveConfigPath(values.config);
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as {
    providers?: Array<Record<string, any>>;
  };

  const results = (
    await Promise.all(
      (rawConfig.providers ?? []).flatMap((provider) =>
        expandProviderKeys(provider).map((expanded) =>
          probeProviderQuota(expanded, Boolean(values.probe))
        )
      )
    )
  ).flat();

  if (values.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const r of results) printQuotaRow(r);
  const totalRemaining = results
    .map((r) => r.remainingUsd ?? 0)
    .filter((v) => Number.isFinite(v))
    .reduce((sum, v) => sum + v, 0);
  if (totalRemaining > 0) {
    console.log(`\nTotal queryable balance remaining: $${totalRemaining.toFixed(2)}`);
  }
}

async function probeProviderQuota(
  expanded: { provider: Record<string, any>; label: string },
  probe: boolean
): Promise<ProviderQuotaResult> {
  const { provider, label } = expanded;
  const apiKey =
    typeof provider.apiKey === "string" && !provider.apiKey.startsWith("env/")
      ? provider.apiKey
      : readEnvRef(provider.apiKey) ??
        (typeof provider.apiToken === "string" && !provider.apiToken.startsWith("env/")
          ? provider.apiToken
          : readEnvRef(provider.apiToken));
  const accountId = readEnvRef(provider.accountId);
  const freeModelId = firstFreeStaticModelId(provider.staticModels);
  return probeQuota({
    providerName: label,
    apiKey,
    baseUrl: provider.baseUrl,
    accountId,
    probe,
    freeModelId
  });
}

function readEnvRef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("env/")) return value;
  return process.env[value.slice("env/".length)];
}

// Walks the same NAME, NAME2, NAME3 ... convention resolveSecretList uses so
// each numeric-suffix key gets its own quota probe (labelled `name#N`).
function expandProviderKeys(
  provider: Record<string, any>
): Array<{ provider: Record<string, any>; label: string }> {
  const baseName = provider.name ?? provider.type;
  const secretField = typeof provider.apiKey === "string" ? "apiKey" : "apiToken";
  const secretRef = provider[secretField];
  if (typeof secretRef !== "string" || !secretRef.startsWith("env/")) {
    return [{ provider, label: baseName }];
  }
  const varName = secretRef.slice("env/".length);
  const collected: Array<{ key: string; suffix: string }> = [];
  const primary = process.env[varName];
  if (primary) collected.push({ key: primary, suffix: "" });
  for (let i = 2; ; i += 1) {
    const next = process.env[`${varName}${i}`];
    if (!next) break;
    collected.push({ key: next, suffix: `#${i}` });
  }
  if (collected.length === 0) return [{ provider, label: baseName }];
  return collected.map(({ key, suffix }) => ({
    provider: { ...provider, [secretField]: key },
    label: suffix ? `${baseName}${suffix}` : baseName
  }));
}

function firstFreeStaticModelId(models: unknown): string | undefined {
  if (!Array.isArray(models)) return undefined;
  const first = models.find((m) => m?.free === true);
  return typeof first?.id === "string" ? first.id : undefined;
}

function printQuotaRow(r: ProviderQuotaResult): void {
  const tag =
    r.source === "api" ? "[api]   " : r.source === "policy" ? "[policy]" : "[no-key]";
  const parts: string[] = [];
  if (r.balanceUsd !== undefined) parts.push(`limit=$${r.balanceUsd.toFixed(2)}`);
  if (r.remainingUsd !== undefined) parts.push(`remaining=$${r.remainingUsd.toFixed(4)}`);
  if (r.usageUsd !== undefined) parts.push(`used=$${r.usageUsd.toFixed(4)}`);
  if (r.isFreeTier !== undefined) parts.push(`freeTier=${r.isFreeTier}`);
  if (r.callable) parts.push(`callable=${r.callable}${r.callableDetail ? `(${r.callableDetail})` : ""}`);
  if (r.error) parts.push(`error=${r.error}`);
  console.log(`▸ ${tag} ${r.provider.padEnd(28)} ${parts.join("  ")}`);
  if (r.freePolicy) console.log(`   ↳ ${r.freePolicy}`);
}

async function bootstrap(options: CommonOptions) {
  loadDefaultEnvFiles(options.envFile ?? []);

  const configPath = resolveConfigPath(options.config);
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const overrides = options.freeOnly === undefined ? {} : { freeOnly: options.freeOnly };
  const providers = filterAvailableProviders(rawConfig.providers ?? []);

  if (providers.length === 0) {
    console.error(`No providers have their env keys set. Load an env file with --env-file or export the vars.`);
    process.exit(1);
  }

  return createRouterFromConfig({ ...rawConfig, ...overrides, providers });
}

function resolveConfigPath(explicit?: string): string {
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) {
      console.error(`Config file not found: ${p}`);
      process.exit(1);
    }
    return p;
  }

  for (const candidate of ["router.config.json", "router.config.example.json"]) {
    const p = resolve(candidate);
    if (existsSync(p)) return p;
  }

  console.error(
    "No config file found. Pass --config <path>, or create router.config.json in the current directory."
  );
  process.exit(1);
}

// Silently ignores providers whose `env/*` refs aren't set, so partial env files
// don't break the whole router.
function filterAvailableProviders(providers: any[]): any[] {
  return providers.filter((provider) => {
    const refs: string[] = [];
    if (typeof provider.apiKey === "string") refs.push(provider.apiKey);
    if (typeof provider.apiToken === "string") refs.push(provider.apiToken);
    return refs.every((ref) => {
      if (!ref.startsWith("env/")) return true;
      return Boolean(process.env[ref.slice("env/".length)]);
    });
  });
}

function loadEnvFile(path: string, options: { quietMissing?: boolean } = {}): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    if (!options.quietMissing) console.error(`env file not readable: ${path}`);
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Layered env resolution: explicit --env-file wins first, then the project's
// .env, then a shell-configured default path, then the ~/.flr/env convention.
// A previously exported process.env value always beats every file source
// because loadEnvFile only sets keys not already present.
function loadDefaultEnvFiles(explicit: string[]): void {
  for (const path of explicit) loadEnvFile(path);
  if (existsSync(".env")) loadEnvFile(".env");
  const fromEnvVar = process.env.FLR_ENV_FILE;
  if (fromEnvVar) loadEnvFile(fromEnvVar, { quietMissing: true });
  const conventional = resolve(homedir(), ".flr", "env");
  if (existsSync(conventional)) loadEnvFile(conventional);
}

function printUsage(router: ModelRouter, byOption: string | undefined): void {
  const by = byOption === "model" ? "model" : "provider";
  const usage = router.getUsage({ by });
  const entries = Object.entries(usage);
  if (entries.length === 0) {
    console.log(`\n[usage] no calls recorded`);
    return;
  }
  entries.sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  console.log(`\n[usage] by ${by}`);
  const rows: Array<[string, UsageStats]> = entries;
  for (const [key, s] of rows) {
    console.log(
      `  ${key.padEnd(48)}  req=${s.requests} ok=${s.successes} err=${s.errors}  ` +
        `tokens=${s.totalTokens} (prompt=${s.promptTokens} out=${s.completionTokens})`
    );
  }
}

const SORT_DIMENSIONS: readonly SortDimension[] = ["quality", "context", "speed", "cost"];

function dimensionFilters(values: Record<string, unknown>): Partial<ChatRequest> {
  const out: Partial<ChatRequest> = {};
  const q = values["min-quality"];
  const c = values["min-ctx"];
  const l = values["max-latency"];
  const cost = values["max-input-cost"];
  const sort = values["sort-by"];
  const cooling = values["include-cooling"];
  if (typeof q === "string") out.minQuality = Number(q);
  if (typeof c === "string") out.minContextWindow = Number(c);
  if (typeof l === "string") out.maxLatencyMs = Number(l);
  if (typeof cost === "string") out.maxInputCostPerMillion = Number(cost);
  if (typeof sort === "string") {
    if (!(SORT_DIMENSIONS as readonly string[]).includes(sort)) {
      console.error(`Invalid --sort-by "${sort}". Expected one of: ${SORT_DIMENSIONS.join(", ")}`);
      process.exit(1);
    }
    out.sortBy = sort as SortDimension;
  }
  if (cooling === true) out.excludeCooling = false;
  return out;
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function coerceTier(value: string | undefined): ModelTier | undefined {
  if (!value) return undefined;
  if (!(MODEL_TIERS as readonly string[]).includes(value)) {
    console.error(`Invalid tier "${value}". Expected one of: ${MODEL_TIERS.join(", ")}`);
    process.exit(1);
  }
  return value as ModelTier;
}

function resolveFreeOnly(values: { "free-only"?: boolean; "no-free-only"?: boolean }): boolean | undefined {
  if (values["no-free-only"]) return false;
  if (values["free-only"]) return true;
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms))
  ]);
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function printHelp(): void {
  console.log(`free-llm-router CLI

Usage:
  flr <command> [flags]

Commands:
  chat <prompt>       Sequential fallback, first success wins
  race <prompt>       Fire every candidate in parallel, first success wins
  models              List every callable model, grouped by provider
  broadcast <prompt>  Fire every candidate in parallel, print all responses
  quota               Show free-tier quota / balance per provider

Common flags:
  --config <path>       Config file (default: ./router.config.json, then router.config.example.json)
  --env-file <path>     Load an extra env file into process.env (repeatable)
  --free-only           Only route to models flagged free (default from config)
  --no-free-only        Route to any model (paid included)

Env file resolution (loaded top-down, first-set wins; process.env always beats files):
  1. --env-file <path>          explicit CLI args
  2. ./.env                     project-local
  3. $FLR_ENV_FILE              user default via env var (e.g. export in shell rc)
  4. ~/.flr/env                 conventional user default (create or symlink here)

chat flags:
  --tier <t>            Force a tier, e.g. high-1, medium-2, low-3
  --model <name>        Force a specific model (e.g. openrouter/openai/gpt-oss-20b)
  --models <a,b,c>      Try each in order, first success wins (comma separated)
  --providers <a,b,c>   Restrict + order providers (combines with --tier)
  --fallback-to-rest    Treat --model/--models/--providers as preferred prefix,
                        fall through to the remaining tier-filtered pool
  --min-quality <0-1>   Drop models whose qualityScore is below this
  --min-ctx <tokens>    Drop models whose contextWindow is below this
  --max-latency <ms>    Drop models whose observed avg latency exceeds this
  --max-input-cost <$>  Drop models whose input price/M tokens exceeds this
  --sort-by <dim>       Sort by "quality" | "context" | "speed" | "cost"
  --include-cooling     Include models under cooldown (recent 429/5xx)
  --system <text>       Prepend a system message
  --max-tokens <n>      Response cap
  --temperature <n>     Sampling temperature

models flags:
  --json                Emit raw JSON instead of the grouped table

race flags:
  Same as chat, plus:
  --per-provider        Race one best-quality model per provider (dedup fan-out)

quota flags:
  --probe               Also send a 1-token chat to each provider's first free
                        model and report OK / rate-limited / unauthorized.
  --json                Emit raw JSON instead of the table.

broadcast flags:
  --tier <t>            Only broadcast to models in this tier
  --per-provider        Print one response per provider (top-qualityScore pick)
  --max-tokens <n>      Per-call cap (default 200)
  --timeout <ms>        Per-call timeout in ms (default 60000)
  --stats-by <p|m>      Aggregate the usage table by "provider" (default) or "model"

Usage tracking:
  Every command tallies per-provider/per-model requests, successes, errors,
  and token usage in memory. chat/race print the table when --stats is passed;
  broadcast prints it automatically at the end.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
