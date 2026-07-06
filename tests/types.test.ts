import { describe, expect, it } from "vitest";
import type { ChatRequest, ObjectRequest, ObjectResponse, ProviderAdapter } from "../src/types.js";

describe("structured-output types", () => {
  it("ObjectRequest extends ChatRequest with schema + optional schemaName", () => {
    const req: ObjectRequest = {
      ...({} as ChatRequest),
      messages: [],
      schema: { type: "object", properties: {} },
    };
    expect(req.schema).toEqual({ type: "object", properties: {} });
    expect(req.schemaName).toBeUndefined();
  });

  it("ObjectResponse carries object + raw + identity", () => {
    const res: ObjectResponse = {
      id: "1",
      model: "m",
      provider: "p",
      object: { ok: true },
      raw: {},
    };
    expect(res.object).toEqual({ ok: true });
  });

  it("ProviderAdapter.object is optional", () => {
    const p: ProviderAdapter = {
      name: "x",
      kind: "test",
      listModels: async () => [],
      chat: async () => ({}) as never,
    };
    expect(p.object).toBeUndefined();
  });
});
