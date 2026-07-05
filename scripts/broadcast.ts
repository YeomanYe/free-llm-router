// Broadcast one prompt to every static model in router.config.example.json
// that has its env key set, and print each response side by side.
//
// Usage:
//   npx tsx scripts/broadcast.ts "your prompt"
//   npx tsx scripts/broadcast.ts               # uses the default prompt

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createRouterFromConfig } from "../src/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const CALL_TIMEOUT_MS = 60_000;

loadEnvFile(process.env.LOCAL_ENV_FILE ?? `${process.env.HOME}/Documents/knowledge/local/.env`);

const prompt =
  process.argv.slice(2).join(" ").trim() ||
  "Say hi in exactly one short English sentence and mention which model you are.";

const rawConfig = JSON.parse(
  readFileSync(resolve(projectRoot, "router.config.example.json"), "utf8")
);

const availableProviders = rawConfig.providers.filter((provider: any) => {
  const refs: string[] = [];
  if (typeof provider.apiKey === "string") refs.push(provider.apiKey);
  if (typeof provider.apiToken === "string") refs.push(provider.apiToken);
  return refs.every((ref) => {
    if (!ref.startsWith("env/")) return true;
    return Boolean(process.env[ref.slice("env/".length)]);
  });
});

const skipped = rawConfig.providers.length - availableProviders.length;
if (availableProviders.length === 0) {
  console.error("No providers have their env keys set — nothing to broadcast.");
  process.exit(1);
}

const router = createRouterFromConfig({ ...rawConfig, providers: availableProviders });
const models = await router.listModels();

console.log(`Prompt: ${prompt}`);
console.log(`Providers available: ${availableProviders.length} (skipped ${skipped} missing keys)`);
console.log(`Models to call: ${models.length}\n`);

const results = await Promise.all(
  models.map(async (model) => {
    const label = `${model.provider}/${model.id}`;
    const started = Date.now();
    try {
      const response = await withTimeout(
        router.chat({
          model: label,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 200
        }),
        CALL_TIMEOUT_MS
      );
      return {
        label,
        tier: model.tier,
        ms: Date.now() - started,
        ok: true as const,
        content: response.content.trim()
      };
    } catch (error) {
      return {
        label,
        tier: model.tier,
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    )
  ]);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function loadEnvFile(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
