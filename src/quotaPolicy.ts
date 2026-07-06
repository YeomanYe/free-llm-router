// Per-provider free-tier policy blurbs shown by `flr quota` for providers that
// don't expose a queryable balance API. Verified against public docs; update
// periodically — the asOf field below tracks the last review.
//
// Last reviewed: 2026-07.

export const QUOTA_POLICY_AS_OF = "2026-07";

export const HARDCODED_FREE_POLICY: Readonly<Record<string, string>> = {
  openrouter:
    "20 rpm on `:free` models (free tier). 1000 rpd once account has $10+ credit; no daily cap for a free-tier account otherwise.",
  "gemini-openai-compatible":
    "gemini-2.0-flash free tier: 15 rpm / 1M tpm / 1 500 rpd. Rolls at UTC 00:00.",
  groq: "~30 rpm per model, ~6-14k tpm, 500k tpd (per model). Free tier is generous but not queryable.",
  cerebras: "30 rpm, 60k tpm, ~900k tpd on llama-3.1-8b free tier.",
  bigmodel: "glm-4-flash / glm-4v-flash: officially permanent free, no advertised cap.",
  cloudflare:
    "Workers AI: 10 000 neurons / day rolling. Analytics via GraphQL requires separate scope.",
  "cloudflare-workers-ai":
    "Workers AI: 10 000 neurons / day rolling. Analytics via GraphQL requires separate scope.",
  mistral: "Free tier: 1 rps and 500k tokens/mo on la Plateforme (not queryable).",
  huggingface: "Router free tier: rate-limited per model, no per-key balance API.",
  "github-models":
    "GitHub Models free tier: shared rate limit tied to your GitHub account (see docs).",
};
