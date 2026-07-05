// List every callable model per provider (env key), regardless of the free flag.
// Usage: npx tsx scripts/list-models.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { createRouterFromConfig } from "../src/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

loadEnvFile(process.env.LOCAL_ENV_FILE ?? `${process.env.HOME}/Documents/knowledge/local/.env`);

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

const router = createRouterFromConfig({
  ...rawConfig,
  freeOnly: false,
  providers: availableProviders
});

const models = await router.listModels();
const byProvider = new Map<string, typeof models>();
for (const model of models) {
  const list = byProvider.get(model.provider) ?? [];
  list.push(model);
  byProvider.set(model.provider, list);
}

const names = [...byProvider.keys()].sort();
for (const name of names) {
  const list = byProvider.get(name)!;
  const freeCount = list.filter((m) => m.free).length;
  console.log(`\n▸ ${name}  (${list.length} models, ${freeCount} flagged free)`);
  for (const m of list) {
    const flag = m.free ? "free" : "paid";
    const ctx = m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx` : "";
    const tier = m.tier ? `[${m.tier}]` : "";
    console.log(`  · [${flag}] ${tier} ${m.id}${ctx ? "  " + ctx : ""}`);
  }
}

console.log(`\nTotal: ${models.length} models across ${byProvider.size} providers.`);

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
    if (!(key in process.env)) process.env[key] = value;
  }
}
