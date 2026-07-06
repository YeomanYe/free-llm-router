import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfter, RetryableProviderError } from "../src/errors.js";
import { OpenAICompatibleProvider } from "../src/providers/openaiCompatible.js";

function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenAICompatibleProvider timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("passes an AbortSignal derived from timeoutMs to fetch", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      // Simulate the underlying request respecting the abort by rejecting.
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const provider = new OpenAICompatibleProvider({
      name: "slow",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
      timeoutMs: 50,
    });

    const pending = provider.chat({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    });

    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).rejects.toThrow(/timed out after 50ms/);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("OpenAICompatibleProvider streaming", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses SSE delta chunks into ChatStreamChunk content", async () => {
    const sse =
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: "!" } }] })}\n\n` +
      `data: [DONE]\n\n`;
    vi.stubGlobal("fetch", async () => streamingResponse([sse]));

    const provider = new OpenAICompatibleProvider({
      name: "stream",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
    });

    const chunks: string[] = [];
    for await (const chunk of provider.streamChat!({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join("")).toBe("Hello!");
  });
});

describe("OpenAICompatibleProvider Retry-After", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces Retry-After (seconds) on a 429 as a retryable error", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "12" },
        }),
    );

    const provider = new OpenAICompatibleProvider({
      name: "rl",
      baseUrl: "https://example.test/v1",
      apiKey: "sk-test",
    });

    try {
      await provider.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryableProviderError);
      expect((error as RetryableProviderError).retryAfterMs).toBe(12_000);
    }
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds form", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
  });

  it("parses HTTP-date form", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThan(70_000);
  });

  it("returns undefined for garbage", () => {
    expect(parseRetryAfter("nope")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
