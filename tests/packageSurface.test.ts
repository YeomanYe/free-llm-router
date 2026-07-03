import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import * as publicApi from "../src/index.js";

describe("package surface", () => {
  it("does not expose the optional HTTP gateway from the package entrypoint", () => {
    expect(publicApi).not.toHaveProperty("createFetchHandler");
    expect(publicApi).not.toHaveProperty("startServer");
  });

  it("does not ship server-only scripts or dependencies", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(manifest.scripts).not.toHaveProperty("dev");
    expect(manifest.scripts).not.toHaveProperty("start");
    expect(manifest.dependencies).not.toHaveProperty("dotenv");
  });
});
