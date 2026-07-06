import {
  isRetryableStatus,
  ProviderError,
  parseRetryAfter,
  RetryableProviderError,
  TimeoutError,
} from "../errors.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatStreamChunk,
  ChatUsage,
  ToolChoice,
  ToolDef,
} from "../types.js";

/**
 * Serialize our ChatMessage to the OpenAI wire shape. Three special cases:
 * - role:'tool' → {role:'tool', content, tool_call_id} (the result of a prior tool call)
 * - role:'assistant' with toolCalls → {role:'assistant', content, tool_calls:[...]} (echoing back the model's prior tool request)
 * - everything else → {role, content}
 */
function toOpenAIMessage(msg: ChatMessage): unknown {
  if (msg.role === "tool") {
    return {
      role: "tool",
      content: msg.content,
      ...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
    };
  }
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: msg.content || null,
      tool_calls: msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
      })),
    };
  }
  const base: Record<string, unknown> = { role: msg.role, content: msg.content };
  if (msg.name) base.name = msg.name;
  return base;
}

/** Build the OpenAI tools array from provider-agnostic ToolDefs. */
function toOpenAITools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/** Build OpenAI tool_choice from the provider-agnostic directive. */
function toOpenAIToolChoice(choice: ToolChoice): unknown {
  if (choice === "auto") return "auto";
  if (choice === "none") return "none";
  return { type: "function", function: { name: choice.name } };
}

// Builds the OpenAI-compatible /chat/completions request body shared by every
// provider that speaks this dialect (OpenRouter, Cloudflare AI v1, etc.).
export function buildChatBody(request: ChatRequest & { model: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toOpenAIMessage),
    stream: request.stream ?? false,
  };

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.maxTokens !== undefined) {
    body.max_tokens = request.maxTokens;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = toOpenAITools(request.tools);
    body.tool_choice = toOpenAIToolChoice(request.toolChoice ?? "auto");
  }

  return body;
}

// Extracts the assistant text from an OpenAI-shaped chat completion. Handles
// both plain-string content and the content-part array form (vision/tool models).
export function extractOpenAIContent(payload: OpenAIChatPayload): string {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return typeof part?.text === "string" ? part.text : "";
      })
      .join("");
  }

  return "";
}

export function normalizeUsage(usage: unknown): ChatUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const u = usage as Record<string, unknown>;
  return {
    promptTokens: asNumber(u.prompt_tokens),
    completionTokens: asNumber(u.completion_tokens),
    totalTokens: asNumber(u.total_tokens),
  };
}

interface OpenAIChatPayload {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: unknown;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

// Converts a fetch Response into the right ProviderError subclass, attaching a
// parsed Retry-After when the upstream supplied one so the router can honour it.
export function errorFromResponse(
  providerName: string,
  response: Response,
  message: string,
): ProviderError {
  const ErrorClass = isRetryableStatus(response.status) ? RetryableProviderError : ProviderError;
  return new ErrorClass(
    providerName,
    `${message}: HTTP ${response.status}`,
    response.status,
    parseRetryAfter(response.headers.get("Retry-After")),
  );
}

// Composes an AbortSignal that fires on whichever of {external, timeout, both}
// triggers first. Returns undefined when neither is supplied so callers can
// pass it straight to fetch without branching.
export function composeAbortSignal(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!external && timeoutMs === undefined) return undefined;

  // AbortSignal.any is available on Node 20+ and modern browsers; fall back to
  // a manual controller for older runtimes.
  const timeoutSignal = timeoutMs !== undefined ? timeoutSignalFrom(timeoutMs) : undefined;
  const signals = [external, timeoutSignal].filter((s): s is AbortSignal => s != null);

  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];

  if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
    return AbortSignal.any(signals);
  }

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function timeoutSignalFrom(timeoutMs: number): AbortSignal {
  // AbortSignal.timeout is the cleanest path on Node 20+.
  if (typeof (AbortSignal as unknown as { timeout?: unknown }).timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  return controller.signal;
}

// Re-throws an abort error as a TimeoutError when the abort came from our own
// timeout signal, otherwise re-throws as-is. Called from provider catch blocks
// so the router sees a typed, retryable error rather than a raw DOMException.
export function classifyAbort(
  providerName: string,
  error: unknown,
  timeoutMs: number | undefined,
): Error {
  if (
    timeoutMs !== undefined &&
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new TimeoutError(providerName, timeoutMs);
  }
  return error instanceof Error ? error : new Error(String(error));
}

// Parses a Server-Sent Events stream from an OpenAI-compatible /chat/completions
// `stream: true` response into ChatStreamChunk deltas. The `data: [DONE]`
// sentinel terminates the stream. Returns the generator; the caller owns
// iteration (and aborting when the consumer stops pulling).
export async function* parseOpenAIStream(response: Response): AsyncGenerator<ChatStreamChunk> {
  if (!response.body) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.trim();
        newlineIndex = buffer.indexOf("\n");
        if (!line || line.startsWith(":")) continue; // skip comments/keepalives
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          yield { content: "", done: true };
          return;
        }

        try {
          const parsed = JSON.parse(data) as OpenAIStreamDelta;
          const content = extractDeltaContent(parsed);
          if (content) {
            yield { content, done: false, usage: normalizeUsage(parsed.usage) };
          }
        } catch {
          // Malformed JSON chunk — skip; the next read usually carries a clean one.
        }
      }
    }
    // Stream ended without [DONE] — emit a terminal chunk so callers unwind.
    yield { content: "", done: true };
  } finally {
    reader.releaseLock();
  }
}

interface OpenAIStreamDelta {
  choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string | null }>;
  usage?: unknown;
}

function extractDeltaContent(parsed: OpenAIStreamDelta): string {
  const delta = parsed.choices?.[0]?.delta?.content;
  if (typeof delta === "string") return delta;
  if (Array.isArray(delta)) {
    return delta
      .map((part) =>
        typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "",
      )
      .join("");
  }
  return "";
}
