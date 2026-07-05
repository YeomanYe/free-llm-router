#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { createRouterFromConfig } from "./config.js";
import { pickBestModelPerProvider, type ModelRouter } from "./router.js";
import { MODEL_TIERS, type ChatMessage, type ModelTier, type UsageStats } from "./types.js";

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
  const filtered = tier ? allModels.filter((m) => m.tier === tier) : allModels;
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

async function bootstrap(options: CommonOptions) {
  for (const path of options.envFile ?? []) loadEnvFile(path);
  if (existsSync(".env")) loadEnvFile(".env");

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

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`env file not readable: ${path}`);
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

Common flags:
  --config <path>       Config file (default: ./router.config.json, then router.config.example.json)
  --env-file <path>     Load an env file into process.env (repeatable)
  --free-only           Only route to models flagged free (default from config)
  --no-free-only        Route to any model (paid included)

chat flags:
  --tier <t>            Force a tier, e.g. high-1, medium-2, low-3
  --model <name>        Force a specific model (e.g. openrouter/openai/gpt-oss-20b)
  --models <a,b,c>      Try each in order, first success wins (comma separated)
  --providers <a,b,c>   Restrict + order providers (combines with --tier)
  --fallback-to-rest    Treat --model/--models/--providers as preferred prefix,
                        fall through to the remaining tier-filtered pool
  --system <text>       Prepend a system message
  --max-tokens <n>      Response cap
  --temperature <n>     Sampling temperature

models flags:
  --json                Emit raw JSON instead of the grouped table

race flags:
  Same as chat, plus:
  --per-provider        Race one best-quality model per provider (dedup fan-out)

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
