#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { createRouterFromConfig, createRouterFromFile } from "./config.js";
import { type ProviderQuotaResult, probeQuota, QUOTA_POLICY_AS_OF } from "./quota.js";
import { type ModelRouter, pickBestModelPerProvider } from "./router.js";
import {
  type ChatMessage,
  type ChatRequest,
  type DiscoveredModel,
  MODEL_TIERS,
  type ModelTier,
  type SortDimension,
} from "./types.js";

interface CommonOptions {
  config?: string;
  envFile?: string[];
  freeOnly?: boolean;
}

// Coerces a parseArgs `multiple` value (string | string[] | undefined) down to
// the string[] bootstrap expects.
function envFileList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

// Options shared by every chat-shaped command (chat / race / stream). Returned
// by a function so TypeScript infers the literal option keys into parseArgs's
// `values` type — declaring it as a top-level const widens the keys to string
// and loses the per-flag typing downstream.
function chatOptions() {
  return {
    config: { type: "string" as const },
    "env-file": { type: "string" as const, multiple: true },
    "free-only": { type: "boolean" as const },
    "no-free-only": { type: "boolean" as const },
    tier: { type: "string" as const },
    model: { type: "string" as const },
    models: { type: "string" as const },
    providers: { type: "string" as const },
    "fallback-to-rest": { type: "boolean" as const },
    "min-quality": { type: "string" as const },
    "min-ctx": { type: "string" as const },
    "max-latency": { type: "string" as const },
    "max-input-cost": { type: "string" as const },
    "include-cooling": { type: "boolean" as const },
    shuffle: { type: "boolean" as const },
    "no-shuffle": { type: "boolean" as const },
    "sort-by": { type: "string" as const },
    stats: { type: "boolean" as const },
    "stats-by": { type: "string" as const },
    "max-tokens": { type: "string" as const },
    temperature: { type: "string" as const },
    system: { type: "string" as const },
    timeout: { type: "string" as const },
  };
}

const SORT_DIMENSIONS: readonly SortDimension[] = ["quality", "context", "speed", "cost"];

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
    case "stream":
      await runStream(rest);
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

function parseChatArgs(
  argv: string[],
  extra: Record<string, { type: "string" } | { type: "boolean" }> = {},
) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...chatOptions(), ...extra },
  });
}

// Builds the shared ChatRequest envelope from parsed CLI flags. Throws a
// friendly error (handled by main's catch) on invalid dimension/tier values.
function buildChatRequest(values: Record<string, unknown>, prompt: string): ChatRequest {
  const messages: ChatMessage[] = [];
  const system = values.system;
  if (typeof system === "string" && system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  return {
    messages,
    tier: coerceTier(values.tier),
    model: asString(values.model),
    models: splitList(asString(values.models)),
    providers: splitList(asString(values.providers)),
    fallbackToRest: values["fallback-to-rest"] === true ? true : undefined,
    ...dimensionFilters(values),
    maxTokens: asNumber(values["max-tokens"]),
    temperature: asNumber(values.temperature),
    timeoutMs: asNumber(values.timeout),
  };
}

async function runChat(argv: string[]): Promise<void> {
  const { values, positionals } = parseChatArgs(argv);

  const prompt = positionals.join(" ").trim();
  requirePrompt("chat", prompt);

  const router = await bootstrap({
    config: values.config,
    envFile: envFileList(values["env-file"]),
    freeOnly: resolveFreeOnly(values),
  });

  const response = await router.chat(buildChatRequest(values, prompt));

  process.stdout.write(response.content);
  console.error(`\n(via ${response.provider}/${response.model})`);
  if (values.stats) printUsage(router, values["stats-by"]);
}

async function runStream(argv: string[]): Promise<void> {
  const { values, positionals } = parseChatArgs(argv);

  const prompt = positionals.join(" ").trim();
  requirePrompt("stream", prompt);

  const router = await bootstrap({
    config: values.config,
    envFile: envFileList(values["env-file"]),
    freeOnly: resolveFreeOnly(values),
  });

  let lastProvider = "";
  let lastModel = "";
  for await (const chunk of router.streamChat(buildChatRequest(values, prompt))) {
    if (chunk.content) process.stdout.write(chunk.content);
    lastProvider = chunk.provider ?? lastProvider;
    lastModel = chunk.model ?? lastModel;
    if (chunk.done) break;
  }
  if (lastProvider && lastModel) {
    console.error(`\n(via ${lastProvider}/${lastModel})`);
  }
  if (values.stats) printUsage(router, values["stats-by"]);
}

async function runRace(argv: string[]): Promise<void> {
  const { values, positionals } = parseChatArgs(argv, {
    "per-provider": { type: "boolean" },
  });

  const prompt = positionals.join(" ").trim();
  requirePrompt("race", prompt);

  const router = await bootstrap({
    config: values.config,
    envFile: envFileList(values["env-file"]),
    freeOnly: resolveFreeOnly(values),
  });

  const started = Date.now();
  const perProvider = (values as Record<string, unknown>)["per-provider"] === true;
  const response = await router.chatRace(buildChatRequest(values, prompt), {
    perProvider,
  });

  process.stdout.write(response.content);
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
      json: { type: "boolean" },
    },
  });

  const router = await bootstrap({
    config: values.config,
    envFile: envFileList(values["env-file"]),
    freeOnly: resolveFreeOnly(values),
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
      console.log(`  · [${flag}] ${tier} ${m.id}${ctx ? `  ${ctx}` : ""}`);
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
      "stats-by": { type: "string" },
    },
  });

  const prompt = positionals.join(" ").trim();
  requirePrompt("broadcast", prompt);

  const timeoutMs = asNumber(values.timeout) ?? 60_000;
  const maxTokens = asNumber(values["max-tokens"]) ?? 200;

  const router = await bootstrap({
    config: values.config,
    envFile: envFileList(values["env-file"]),
    freeOnly: resolveFreeOnly(values),
  });

  const allModels = await router.listModels();
  const tier = coerceTier(values.tier);
  const minQuality = asNumber(values["min-quality"]);
  const minCtx = asNumber(values["min-ctx"]);
  const maxCost = asNumber(values["max-input-cost"]);
  const sortBy = asString(values["sort-by"]);

  let filtered = tier ? allModels.filter((m) => m.tier === tier) : allModels;
  if (minQuality !== undefined)
    filtered = filtered.filter((m) => (m.qualityScore ?? 0) >= minQuality);
  if (minCtx !== undefined) filtered = filtered.filter((m) => (m.contextWindow ?? 0) >= minCtx);
  if (maxCost !== undefined)
    filtered = filtered.filter((m) => (m.pricing?.inputPerMillion ?? 0) <= maxCost);
  if (sortBy) {
    requireSortDimension(sortBy);
    filtered = [...filtered].sort(
      (a, b) => modelDimensionScore(b, sortBy) - modelDimensionScore(a, sortBy),
    );
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
        const response = await router.chat({
          model: label,
          messages: [{ role: "user", content: prompt }],
          maxTokens,
          timeoutMs,
        });
        return {
          label,
          tier: m.tier,
          ms: Date.now() - started,
          ok: true as const,
          content: response.content.trim(),
        };
      } catch (error) {
        return {
          label,
          tier: m.tier,
          ms: Date.now() - started,
          ok: false as const,
          content: error instanceof Error ? error.message : String(error),
        };
      }
    }),
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
      json: { type: "boolean" },
    },
  });

  loadDefaultEnvFiles(values["env-file"] ?? []);
  const configPath = resolveConfigPath(values.config);
  const rawConfig = readJson(configPath) as {
    providers?: Array<Record<string, unknown>>;
  };

  const results = (
    await Promise.all(
      (rawConfig.providers ?? []).flatMap((provider) =>
        expandProviderKeys(provider).map((expanded) =>
          probeProviderQuota(expanded, Boolean(values.probe)),
        ),
      ),
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
  console.error(`(free-tier policy notes as of ${QUOTA_POLICY_AS_OF})`);
}

async function probeProviderQuota(
  expanded: { provider: Record<string, unknown>; label: string },
  probe: boolean,
): Promise<ProviderQuotaResult> {
  const { provider, label } = expanded;
  const apiKey =
    typeof provider.apiKey === "string" && !provider.apiKey.startsWith("env/")
      ? provider.apiKey
      : (readEnvRef(provider.apiKey) ??
        (typeof provider.apiToken === "string" && !provider.apiToken.startsWith("env/")
          ? provider.apiToken
          : readEnvRef(provider.apiToken)));
  const accountId = readEnvRef(provider.accountId);
  const freeModelId = firstFreeStaticModelId(provider.staticModels);
  return probeQuota({
    providerName: label,
    apiKey,
    baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
    accountId,
    probe,
    freeModelId,
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
  provider: Record<string, unknown>,
): Array<{ provider: Record<string, unknown>; label: string }> {
  const baseName = (provider.name as string) ?? (provider.type as string);
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
    label: suffix ? `${baseName}${suffix}` : baseName,
  }));
}

function firstFreeStaticModelId(models: unknown): string | undefined {
  if (!Array.isArray(models)) return undefined;
  const first = models.find((m) => (m as { free?: boolean })?.free === true);
  const id = (first as { id?: unknown })?.id;
  return typeof id === "string" ? id : undefined;
}

function printQuotaRow(r: ProviderQuotaResult): void {
  const tag = r.source === "api" ? "[api]   " : r.source === "policy" ? "[policy]" : "[no-key]";
  const parts: string[] = [];
  if (r.balanceUsd !== undefined) parts.push(`limit=$${r.balanceUsd.toFixed(2)}`);
  if (r.remainingUsd !== undefined) parts.push(`remaining=$${r.remainingUsd.toFixed(4)}`);
  if (r.usageUsd !== undefined) parts.push(`used=$${r.usageUsd.toFixed(4)}`);
  if (r.isFreeTier !== undefined) parts.push(`freeTier=${r.isFreeTier}`);
  if (r.callable)
    parts.push(`callable=${r.callable}${r.callableDetail ? `(${r.callableDetail})` : ""}`);
  if (r.error) parts.push(`error=${r.error}`);
  console.log(`▸ ${tag} ${r.provider.padEnd(28)} ${parts.join("  ")}`);
  if (r.freePolicy) console.log(`   ↳ ${r.freePolicy}`);
}

async function bootstrap(options: CommonOptions): Promise<ModelRouter> {
  loadDefaultEnvFiles(options.envFile ?? []);

  const configPath = resolveConfigPath(options.config);
  const rawConfig = readJson(configPath);
  const overrides = options.freeOnly === undefined ? {} : { freeOnly: options.freeOnly };
  const providers = filterAvailableProviders(
    (rawConfig.providers ?? []) as Array<Record<string, unknown>>,
  );

  if (providers.length === 0) {
    console.error(
      `No providers have their env keys set. Load an env file with --env-file or export the vars.`,
    );
    process.exit(1);
  }

  // createRouterFromFile runs zod, so config errors surface as readable messages
  // instead of raw JSON SyntaxErrors. We pass the env-filtered provider list
  // through so partial env files don't break the whole router.
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
    "No config file found. Pass --config <path>, or create router.config.json in the current directory.",
  );
  process.exit(1);
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Failed to parse config ${path}: ${reason}`);
    process.exit(1);
  }
}

// Silently ignores providers whose `env/*` refs aren't set, so partial env files
// don't break the whole router.
function filterAvailableProviders(
  providers: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
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
  for (const [key, s] of entries as Array<[string, (typeof entries)[number][1]]>) {
    console.log(
      `  ${key.padEnd(48)}  req=${s.requests} ok=${s.successes} err=${s.errors}  ` +
        `tokens=${s.totalTokens} (prompt=${s.promptTokens} out=${s.completionTokens})`,
    );
  }
}

function dimensionFilters(values: Record<string, unknown>): Partial<ChatRequest> {
  const out: Partial<ChatRequest> = {};
  const q = asNumber(values["min-quality"]);
  const c = asNumber(values["min-ctx"]);
  const l = asNumber(values["max-latency"]);
  const cost = asNumber(values["max-input-cost"]);
  const sort = asString(values["sort-by"]);
  const cooling = values["include-cooling"];
  if (q !== undefined) out.minQuality = q;
  if (c !== undefined) out.minContextWindow = c;
  if (l !== undefined) out.maxLatencyMs = l;
  if (cost !== undefined) out.maxInputCostPerMillion = cost;
  if (sort) {
    requireSortDimension(sort);
    out.sortBy = sort;
  }
  if (cooling === true) out.excludeCooling = false;
  if (values["no-shuffle"] === true) out.shuffle = false;
  else if (values.shuffle === true) out.shuffle = true;
  return out;
}

// Score used by the CLI's broadcast sorter. Mirrors ModelRouter.dimensionScore
// except for `speed`: before any calls have been made there is no observed
// latency in the catalog, so it ranks everything equally (0). Kept local so the
// broadcast path doesn't need to reach into the router's internals.
function modelDimensionScore(model: DiscoveredModel, dim: SortDimension): number {
  switch (dim) {
    case "quality":
      return model.qualityScore ?? 0;
    case "context":
      return model.contextWindow ?? 0;
    case "cost":
      return model.pricing?.inputPerMillion !== undefined ? -model.pricing.inputPerMillion : 0;
    case "speed":
      return 0;
  }
}

function requireSortDimension(value: string): asserts value is SortDimension {
  if (!(SORT_DIMENSIONS as readonly string[]).includes(value)) {
    console.error(`Invalid --sort-by "${value}". Expected one of: ${SORT_DIMENSIONS.join(", ")}`);
    process.exit(1);
  }
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function coerceTier(value: unknown): ModelTier | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!(MODEL_TIERS as readonly string[]).includes(value)) {
    console.error(`Invalid tier "${value}". Expected one of: ${MODEL_TIERS.join(", ")}`);
    process.exit(1);
  }
  return value as ModelTier;
}

function resolveFreeOnly(values: {
  "free-only"?: boolean;
  "no-free-only"?: boolean;
}): boolean | undefined {
  if (values["no-free-only"]) return false;
  if (values["free-only"]) return true;
  return undefined;
}

function requirePrompt(command: string, prompt: string): void {
  if (!prompt) {
    console.error(`${command}: missing prompt`);
    process.exit(1);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

// Ensure createRouterFromFile stays part of the public surface even when the
// CLI only calls createRouterFromConfig directly; avoids dead-export churn if
// the bootstrap path is refactored later.
void createRouterFromFile;

function printHelp(): void {
  console.log(`free-llm-router CLI

Usage:
  flr <command> [flags]

Commands:
  chat <prompt>       Sequential fallback, first success wins
  stream <prompt>     Stream incremental tokens from the first reachable model
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

chat / stream / race flags:
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
  --shuffle             Randomize candidate order (overrides config default)
  --no-shuffle          Keep deterministic order (overrides config default)
  --include-cooling     Include models under cooldown (recent 429/5xx)
  --system <text>       Prepend a system message
  --max-tokens <n>      Response cap
  --temperature <n>     Sampling temperature
  --timeout <ms>        Per-call timeout (also enforced at the fetch layer)

models flags:
  --json                Emit raw JSON instead of the grouped table

race flags:
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
  and token usage in memory. chat/race/stream print the table when --stats is
  passed; broadcast prints it automatically at the end.
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
