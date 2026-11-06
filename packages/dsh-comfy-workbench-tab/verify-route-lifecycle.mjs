import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { apply } from "./lib/index.js";

const temp = mkdtempSync(path.join(tmpdir(), "workbench-route-lifecycle-"));
const routes = new Map();
const effects = [];
const cleanups = [];
let disposed = false;

const ctx = {
  logger: { info() {}, warn() {} },
  webServer: {
    port: 9,
    register(definition) {
      assert.ok(definition?.path, "route path is required");
      assert.ok(!routes.has(definition.path), `duplicate route: ${definition.path}`);
      routes.set(definition.path, definition);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        routes.delete(definition.path);
      };
    },
  },
  llm: {},
  tools: {},
  effect(register) {
    effects.push(register);
  },
};

try {
  await apply(ctx, {
    assetStateFile: path.join(temp, "assets.json"),
    comfyBase: "http://127.0.0.1:9",
    selfBaseUrl: "http://127.0.0.1:9",
  });
  for (const effect of effects) cleanups.push(effect());

  for (const route of ["/comfy-assets/suggest-folder", "/comfy-assets/suggest-name"]) {
    assert.ok(routes.has(route), `${route} must be registered while active`);
  }
  console.log("PASS suggest-folder/suggest-name are registered while active");

  for (const cleanup of cleanups.reverse()) {
    if (typeof cleanup === "function") cleanup();
  }
  disposed = true;
  assert.deepEqual([...routes.keys()], [], "host dispose must remove every registered route");
  console.log(`PASS host dispose removes all ${cleanups.length} effects and their routes`);
  console.log("✓ route-lifecycle 2/2 全过");
} finally {
  if (!disposed) {
    for (const cleanup of cleanups.reverse()) {
      if (typeof cleanup === "function") cleanup();
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
