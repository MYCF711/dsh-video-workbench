/**
 * 构建 dsh-editor 的客户端 bundle（SSE 订阅版）。
 *
 * 客户端只做两件事：
 *   1. 订阅 host 的 SSE 状态
 *   2. 发命令回 host
 * 所有状态与逻辑都在 host 侧，客户端包很小。
 *
 * 用法：node build.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib");
if (!fs.existsSync(LIB)) fs.mkdirSync(LIB, { recursive: true });
const tmp = path.join(HERE, ".build");
if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });

const entry = path.join(tmp, "entry.js");
fs.writeFileSync(
  entry,
  `
import React from "react";
import { createWorkbenchView } from ${JSON.stringify(path.join(HERE, "src", "WorkbenchView.mjs"))};
import { zh, en } from ${JSON.stringify(path.join(HERE, "src", "locale.mjs"))};

const NS = "dsh-editor";
const WorkbenchView = createWorkbenchView(React);

export function apply(ctx, config) {
  const t = ctx.locale.bind(NS);
  const prefix = (config && config.routePrefix) || "/timeline";
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-editor: dictionaries");
  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "timeline",
        order: 25,
        locale: NS,
        label: () => t("view.label"),
        children: {},
        inject: () => ({ t, prefix }),
      },
      WorkbenchView
    )
  );
}

export const inject = ["slots", "locale"];
`,
  "utf8"
);

await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  globalName: "__dshEditorImpl",
  platform: "browser",
  target: "chrome110",
  outfile: path.join(tmp, "impl.js"),
  external: ["react", "react-dom", "react/jsx-runtime"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});

const impl = fs.readFileSync(path.join(tmp, "impl.js"), "utf8");

const bundle = `/**
 * dsh-editor client bundle — 由 build.mjs 生成，勿手改。
 *
 * 客户端很薄：订阅 host 的 SSE 状态 + 发命令回 host。
 * 所有业务逻辑（时间轴模型、分镜状态机、ffmpeg 渲染）都在 host 侧。
 */
window.__ModuleLoader__.load({
  id: "dsh-editor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var __platformReact = require("react");

    var __impl = (function (React) {
${impl.replace(/^var __dshEditorImpl = /m, "return ").replace(/;\s*$/, "")}
    })(__platformReact);

    exports.apply = __impl.apply;
    exports.inject = __impl.inject;
    return module.exports;
  }
});
`;

fs.writeFileSync(path.join(LIB, "client.js"), bundle, "utf8");

// host 入口：把 ESM 的 index-host.mjs 转成 lib/index.js
// 宿主加载 lib/index.js 时是原生 ESM import，直接 re-export 即可
fs.writeFileSync(
  path.join(LIB, "index.js"),
  `/**
 * Host loader entry for dsh-editor.
 *
 * 直接 re-export src/index-host.mjs —— 它是原生 ESM，宿主按 import 加载。
 * 不打包：host 侧有真实的 node 环境，可以直接跑 .mjs。
 */
export { apply, inject, name } from "../src/index-host.mjs";
`,
  "utf8"
);

fs.rmSync(tmp, { recursive: true, force: true });

const kb = (n) => (n / 1024).toFixed(1);
console.log(`  ✓ lib/client.js  ${kb(Buffer.byteLength(bundle))} KB`);
console.log(`  ✓ lib/index.js   re-export src/index-host.mjs`);
