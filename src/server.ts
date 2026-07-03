import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";

import "dotenv/config";

import { createRouterFromFile } from "./config.js";
import { ModelRouter } from "./router.js";
import type { ChatMessage } from "./types.js";

export function createFetchHandler(router: ModelRouter) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const models = await router.listModels({ refresh: url.searchParams.get("refresh") === "true" });
        return json({
          object: "list",
          data: models.map((model) => ({
            id: model.id,
            object: "model",
            provider: model.provider,
            free: model.free,
            tier: model.tier,
            context_window: model.contextWindow,
            capabilities: model.capabilities
          }))
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as {
          model?: string;
          messages?: ChatMessage[];
          temperature?: number;
          max_tokens?: number;
          stream?: boolean;
        };

        if (!Array.isArray(body.messages)) {
          return json({ error: { message: "messages must be an array" } }, 400);
        }

        if (body.stream) {
          return json({ error: { message: "streaming is not implemented in this MVP" } }, 400);
        }

        const response = await router.chat({
          model: body.model,
          messages: body.messages,
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          stream: false
        });

        return json({
          id: response.id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: response.model,
          provider: response.provider,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: response.content
              },
              finish_reason: "stop"
            }
          ],
          usage: response.usage
        });
      }

      return json({ error: { message: "not found" } }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return json({ error: { message } }, 500);
    }
  };
}

export function startServer(router: ModelRouter, port: number): void {
  const handler = createFetchHandler(router);
  const server = createServer(async (req, res) => {
    const request = await nodeRequestToFetchRequest(req);
    const response = await handler(request);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  server.listen(port, () => {
    console.log(`free-llm-router listening on http://localhost:${port}`);
  });
}

async function nodeRequestToFetchRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);

  return new Request(url, {
    method,
    headers: req.headers as HeadersInit,
    body
  });
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*"
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.env.ROUTER_CONFIG ?? process.argv[2] ?? "router.config.json";
  const port = Number(process.env.PORT ?? 8787);
  const router = await createRouterFromFile(configPath);
  startServer(router, port);
}
