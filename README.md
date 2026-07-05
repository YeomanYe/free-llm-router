# Free LLM Router

Config-driven Node.js router for free and low-cost LLM providers. Can be imported as a library or invoked as a CLI (`flr`).

The project intentionally does not try to scrape or bypass provider policies. Provider APIs often do not expose whether a model is free, so free eligibility is a mix of discovery plus your maintained static policy metadata.

## Features

- OpenAI-compatible free-quota providers: OpenRouter, Groq, Google (Gemini OpenAI endpoint), Mistral, Hugging Face Router, GitHub Models, Cerebras, Requesty, NVIDIA NIM, Vercel AI Gateway, Z.AI (智谱 GLM), and similar providers.
- Cloudflare Workers AI support through the Cloudflare chat completions endpoint.
- Model discovery through `/models` where providers support it.
- Static free-model metadata for providers that do not expose reliable free flags.
- Nine-tier classification (`high-1` … `low-3`, three sub-tiers per band).
- Retry and fallback across providers.

## Install

Install the package in your application:

```bash
npm install free-llm-router
```

For local development in this repository:

```bash
npm install
cp router.config.example.json router.config.json
```

Fill in the keys you actually want to use. Delete providers you do not use from `router.config.json`.

Configuration values such as `"env/OPEN_ROUTER_API_KEY"` are resolved from `process.env`. Load environment variables in the consuming application if you keep keys in a `.env` file.

Numeric-suffixed variables are picked up as fallback keys automatically. If both `OPEN_ROUTER_API_KEY` and `OPEN_ROUTER_API_KEY2` are set, the router creates two provider instances (`openrouter` and `openrouter#2`) and falls back to the next one when the previous fails. The walk stops at the first gap (`KEY`, `KEY2`, `KEY3`, ...).

## Use In A Node Project

```ts
import { createRouterFromFile } from "free-llm-router";

const router = await createRouterFromFile("router.config.json");

const response = await router.chat({
  tier: "high-1",
  messages: [{ role: "user", content: "Summarize free model routing in one sentence" }]
});

console.log(response.content);
```

Alongside `chat` (sequential fallback) the router also exposes two parallel primitives:

```ts
// Fire every matching candidate in parallel, resolve with the first success.
const fastest = await router.chatRace({ tier: "medium-1", messages });

// Fire every matching candidate in parallel, return per-candidate {response, error}.
const compared = await router.chatAll({ tier: "medium-1", messages });
```

Every call is tallied into an in-memory usage counter:

```ts
router.getUsage();                    // { [providerName]: UsageStats }
router.getUsage({ by: "model" });     // { [`${provider}/${modelId}`]: UsageStats }
router.resetUsage();                  // clear the counters
```

`UsageStats` tracks `requests`, `successes`, `errors`, `promptTokens`, `completionTokens`, `totalTokens`. Every provider HTTP attempt (including retries) increments `requests`, so the number aligns with what the provider bills.

## CLI

The package installs a `flr` binary. Point it at a config and (optionally) an env file:

```bash
# One-shot chat, tier fallback picks the best available model
flr chat --config router.config.example.json --env-file ~/.env "Explain routers in one sentence"

# Force a specific tier or model
flr chat --tier medium-1 "..."
flr chat --model bigmodel/glm-4.5-flash "..."

# Ordered sequences: walk the list, first success wins
flr chat --models "bigmodel/glm-4-flash,cloudflare/@cf/openai/gpt-oss-20b" "..."
flr chat --providers "bigmodel,cloudflare,openrouter" --tier medium-1 "..."

# Preferred prefix + fall through to the rest of the tier pool if all preferred fail
flr chat --providers "bigmodel" --fallback-to-rest --tier medium-1 "..."

# Fire every candidate in parallel and return whoever answers first
flr race --tier medium-1 "..."
flr race --providers "bigmodel,cloudflare" "..."

# Fan-out to one model per provider (top qualityScore) instead of every model
flr broadcast --per-provider --tier medium-1 "..."
flr race --per-provider "..."

# Usage report at end (broadcast always prints, chat/race opt-in via --stats)
flr chat --stats --model bigmodel/glm-4-flash "..."
flr broadcast --stats-by model "..."     # switch aggregation to per-model

# Enumerate every callable model, grouped by provider
flr models
flr models --json

# Send one prompt to every free model and print each response
flr broadcast "用一句话中文自我介绍并说出你是什么模型"
flr broadcast --tier medium-1 --timeout 30000 "hi"
```

During local development the same commands are available via `npm run cli -- <args>`, which shells to `tsx src/cli.ts` and skips the build step.

## Provider Notes

OpenAI-compatible providers use:

```json
{
  "type": "openai-compatible",
  "name": "openrouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "env/OPEN_ROUTER_API_KEY",
  "freeModelPatterns": [":free"],
  "staticModels": [
    {
      "id": "meta-llama/llama-3.3-70b-instruct:free",
      "free": true,
      "contextWindow": 131072,
      "qualityScore": 0.82
    }
  ]
}
```

Cloudflare Workers AI uses account credentials instead of per-model keys. `accountId` is optional — if omitted, the router calls `GET /accounts` with the token and uses the first account it returns:

```json
{
  "type": "cloudflare-workers-ai",
  "apiToken": "env/CLOUDFLARE_API_TOKEN",
  "staticModels": [
    {
      "id": "@cf/meta/llama-3.1-8b-instruct",
      "free": true,
      "contextWindow": 8192,
      "qualityScore": 0.55
    }
  ]
}
```

## Tiering

Models are scored from:

- `qualityScore`
- `contextWindow`
- chat/tool/vision capabilities
- rough rate-limit metadata

The score maps into nine tiers arranged best-to-worst, three sub-tiers per band:

- `high-1` `high-2` `high-3` (score ≥ 10 / 8 / 7)
- `medium-1` `medium-2` `medium-3` (score = 6 / 5 / 4)
- `low-1` `low-2` `low-3` (score = 3 / 2 / ≤ 1)

Within a band the lower suffix is the stronger model. `fallback.tiers` defaults to all nine in order, so the router walks from `high-1` down to `low-3`.

You should tune `qualityScore` and `staticModels` for your own model list. Provider APIs do not consistently expose benchmark quality or free quota status.

## Limitations

- Streaming is not implemented in this MVP.
- Tool calling is not normalized yet.
- Cloudflare model discovery is static by default; keep the model catalog in config.
- Free quota and availability are policy facts, not protocol facts. Keep your policy metadata up to date.
