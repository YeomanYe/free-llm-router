export interface Provider {
  name: string;
  status: "free" | "credit" | "action-required";
  envVar: string;
  models: string;
  quota: string;
  policy: string;
  applyUrl?: string;
}

export const providers: Provider[] = [
  {
    name: "OpenRouter",
    status: "free",
    envVar: "OPEN_ROUTER_API_KEY",
    models: "22+ discovered :free models · llama-3.3-70b:free, gpt-oss-120b:free, gemma-4-31b:free …",
    quota: "20 rpm on :free models · 1 000 rpd after $10 credit",
    policy: "Balance queryable via /auth/key. Backup keys picked up as NAME2, NAME3, …",
    applyUrl: "https://openrouter.ai/keys"
  },
  {
    name: "Google Gemini",
    status: "free",
    envVar: "GOOGLE_API_KEY",
    models: "gemini-2.0-flash · 1 M context",
    quota: "15 rpm · 1 500 rpd · 1 M tpm",
    policy: "Daily quota resets at UTC 00:00. Additional keys land as GOOGLE_API_KEY2, …",
    applyUrl: "https://aistudio.google.com/apikey"
  },
  {
    name: "Groq",
    status: "free",
    envVar: "GROQ_API_KEY",
    models: "llama-3.3-70b-versatile · llama-3.1-8b-instant",
    quota: "≈30 rpm · 6 000–14 000 tpm · 500 K tpd (per model)",
    policy: "Free tier is generous but not queryable via API.",
    applyUrl: "https://console.groq.com/keys"
  },
  {
    name: "Cerebras",
    status: "free",
    envVar: "CEREBRAS_API_KEY",
    models: "llama3.1-8b · qwen-3-32b",
    quota: "30 rpm · 60 K tpm · ~900 K tpd",
    policy: "Fastest inference in the free pool. Console at cloud.cerebras.ai.",
    applyUrl: "https://cloud.cerebras.ai/"
  },
  {
    name: "BigModel (智谱 GLM)",
    status: "free",
    envVar: "BIG_MODEL_API_KEY",
    models: "glm-4-flash · glm-4-flash-250414 · glm-4.5-flash · glm-4v-flash (vision)",
    quota: "128 K context · officially permanent free",
    policy: "Sign up with a personal developer account on open.bigmodel.cn.",
    applyUrl: "https://open.bigmodel.cn/"
  },
  {
    name: "Cloudflare Workers AI",
    status: "free",
    envVar: "CLOUDFLARE_WORKER_AI_TOKEN + CLOUDFLARE_ACCOUNT_ID",
    models: "@cf/meta/llama-3.2-3b-instruct · @cf/google/gemma-4-26b · @cf/openai/gpt-oss-20b · @cf/meta/llama-3.1-8b-fp8",
    quota: "10 000 neurons / day rolling",
    policy: "Workers-AI-scoped token can't list accounts — set CLOUDFLARE_ACCOUNT_ID explicitly.",
    applyUrl: "https://dash.cloudflare.com/profile/api-tokens"
  },
  {
    name: "GitHub Models",
    status: "free",
    envVar: "GITHUB_TOKEN",
    models: "37 models · gpt-4.1, gpt-4o, llama-3.3-70b, phi-4, mistral-medium, deepseek-r1, o1-mini, o3-mini …",
    quota: "low tier: 150 rpd · high tier: 50 rpd · custom: 8 rpd (reasoning models)",
    policy: "Reuse gh CLI: GITHUB_TOKEN=$(gh auth token). Works with existing PATs.",
    applyUrl: "https://github.com/settings/tokens/new"
  },
  {
    name: "Mistral la Plateforme",
    status: "free",
    envVar: "MISTRAL_API_KEY",
    models: "mistral-small-latest · codestral · ministral-3b",
    quota: "1 rps · 500 K tokens / month",
    policy: "Free tier requires a bit of KYC. Not queryable via API.",
    applyUrl: "https://console.mistral.ai/api-keys"
  },
  {
    name: "Hugging Face Router",
    status: "free",
    envVar: "HUGGINGFACE_TOKEN",
    models: "meta-llama/Llama-3.1-8B-Instruct and many others via HF Inference Providers",
    quota: "Rate-limited per model, no per-key balance API",
    policy: "Token permissions matter — grant Inference access.",
    applyUrl: "https://huggingface.co/settings/tokens"
  }
];

export interface Command {
  name: string;
  tag: string;
  blurb: string;
  code: string;
}

export const commands: Command[] = [
  {
    name: "chat",
    tag: "sequential fallback",
    blurb:
      "Try each candidate in order, first success wins. Retries retryable errors, then falls through.",
    code: `flr chat --tier medium-1 \\
  --sort-by quality \\
  "Explain BM25 in one sentence"`
  },
  {
    name: "race",
    tag: "parallel first-wins",
    blurb: "Fire every candidate concurrently, resolve with whoever answers first.",
    code: `flr race --providers "bigmodel,cloudflare" \\
  --max-tokens 200 \\
  "Draft a release note for v0.3"`
  },
  {
    name: "broadcast",
    tag: "parallel fan-out",
    blurb:
      "Send one prompt to every model (or one per provider with --per-provider) and print each response side by side.",
    code: `flr broadcast --tier medium-1 \\
  --per-provider \\
  "Say hi in exactly one sentence"`
  },
  {
    name: "models",
    tag: "catalog",
    blurb: "List every callable model grouped by provider, with context window and tier.",
    code: `flr models --json | \\
  jq '.[] | select(.free) | .id'`
  },
  {
    name: "quota",
    tag: "availability",
    blurb:
      "Read real balance from OpenRouter, plus documented free-tier policy for the rest. --probe checks live 429 / 403 state.",
    code: `flr quota --probe`
  }
];

export interface Feature {
  title: string;
  body: string;
}

export const features: Feature[] = [
  {
    title: "Ordered preference, soft fallback",
    body:
      "chat({ providers: [\"bigmodel\", \"cloudflare\"], fallbackToRest: true }) — walk your favourites first, fall through to the rest of the tier-filtered pool if all of them 429."
  },
  {
    title: "Nine-tier classification",
    body:
      "Every model lands in one of nine buckets from high-1 down to low-3. Filter by --tier, sort by quality / context / speed / cost."
  },
  {
    title: "Numeric-suffix key expansion",
    body:
      "Drop OPEN_ROUTER_API_KEY2, KEY3 into your env and each becomes its own fallback provider instance — openrouter, openrouter#2, openrouter#3."
  },
  {
    title: "Cooldown after 429",
    body:
      "Retryable errors mark the model as cooling for 60s (configurable). Subsequent calls skip it automatically unless you pass --include-cooling."
  },
  {
    title: "Cloudflare account auto-discovery",
    body:
      "Broad tokens get their account id fetched once from /accounts and cached. Workers-AI-scoped tokens can just pin CLOUDFLARE_ACCOUNT_ID explicitly."
  },
  {
    title: "In-memory usage counters",
    body:
      "router.getUsage() returns per-provider or per-model requests, successes, errors, tokens, and observed avg latency. Powers --sort-by speed."
  }
];
