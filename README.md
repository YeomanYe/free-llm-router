# Free LLM Router

Config-driven Node.js router for free and low-cost LLM providers. It can be used as a library inside a Node project or as a small OpenAI-compatible gateway.

The project intentionally does not try to scrape or bypass provider policies. Provider APIs often do not expose whether a model is free, so free eligibility is a mix of discovery plus your maintained static policy metadata.

## Features

- OpenAI-compatible free-quota providers: OpenRouter, Groq, Mistral, Hugging Face Router, GitHub Models, Cerebras, Requesty, and similar providers.
- Cloudflare Workers AI support through the Cloudflare chat completions endpoint.
- Model discovery through `/models` where providers support it.
- Static free-model metadata for providers that do not expose reliable free flags.
- High / medium / low tier classification.
- Retry and fallback across providers.
- OpenAI-compatible HTTP endpoints: `/v1/models` and `/v1/chat/completions`.

## Install

```bash
npm install
cp .env.example .env
cp router.config.example.json router.config.json
```

Fill in the keys you actually want to use. Delete providers you do not use from `router.config.json`.

## Run As Gateway

```bash
npm run dev -- router.config.json
```

List models:

```bash
curl http://localhost:8787/v1/models
```

Call chat completions:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      { "role": "user", "content": "hello" }
    ]
  }'
```

## Use As A Node Library

```ts
import { createRouterFromFile } from "./src/config.js";

const router = await createRouterFromFile("router.config.json");

const response = await router.chat({
  tier: "high",
  messages: [{ role: "user", content: "Summarize free model routing in one sentence" }]
});

console.log(response.content);
```

## Provider Notes

OpenAI-compatible providers use:

```json
{
  "type": "openai-compatible",
  "name": "openrouter",
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "env/OPENROUTER_API_KEY",
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

Cloudflare Workers AI uses account credentials instead of per-model keys:

```json
{
  "type": "cloudflare-workers-ai",
  "accountId": "env/CLOUDFLARE_ACCOUNT_ID",
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

The score maps into:

- `high`
- `medium`
- `low`

You should tune `qualityScore` and `staticModels` for your own model list. Provider APIs do not consistently expose benchmark quality or free quota status.

## Limitations

- Streaming is not implemented in this MVP.
- Tool calling is not normalized yet.
- Cloudflare model discovery is static by default; keep the model catalog in config.
- Free quota and availability are policy facts, not protocol facts. Keep your policy metadata up to date.
