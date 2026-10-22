/**
 * 构建 lib/client.js（IIFE，宿主要求的形状）。
 *
 * 用 format: "cjs" 打包，只外部化 react —— 这样 esbuild 生成的
 * module.exports 里直接就有 apply / inject，不需要 globalName 那层。
 *
 * 用法：node build.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "file:///D:/主工作区/DSH视频工作站/packages/dsh-editor/node_modules/esbuild/lib/main.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "lib");
if (!fs.existsSync(LIB)) fs.mkdirSync(LIB, { recursive: true });
const TMP = path.join(HERE, ".build");
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const entry = path.join(HERE, "src", "client.js");

await build({
  entryPoints: [entry],
  bundle: true,
  format: "cjs",              // ★ 直接产出 module.exports，含 apply/inject
  platform: "browser",
  target: "chrome110",
  outfile: path.join(TMP, "impl.js"),
  external: ["react", "react-dom", "react/jsx-runtime"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
});

const impl = fs.readFileSync(path.join(TMP, "impl.js"), "utf8");

const bundle = `/**
 * dsh-comfy-workbench-tab client bundle — 由 build.mjs 生成，勿手改。
 * 改 src/ 后跑 node build.mjs。
 *
 * ★ 2026-10-22 合包：本包同时含
 *     · 视频工作台（conversation.view id=comfy-workbench, order 20）
 *     · 剪辑台（conversation.view id=artcraft, order 30）
 *   两者是同一插件内的两个模块，注册动作彼此隔离（各自 try/catch）。
 */
window.__ModuleLoader__.load({
  id: "dsh-comfy-workbench-tab",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    /**
     * ★★ 2026-10-22 合包关键：requireShim 必须放行官方 UI 基元
     *
     *   合包前这里是：
     *     if (n === "react" || n === "react/jsx-runtime" || n === "react-dom") return require(n);
     *     throw new Error("unexpected require: " + n);
     *
     *   而剪辑台要用 @deepseek-ai/dsh-client-ui-primitives（282 个导出）。
     *   不放行它 ⇒ 剪辑台一挂载就抛 ⇒ 整块渲染成错误框。
     *
     *   ⇒ 白名单扩到「react 三件套 + @deepseek-ai/ 前缀」。
     *   ★ 为什么用前缀而不是逐个列：
     *     官方 UI 包有 50+ 个（ui-slots / ui-conversation / ui-settings…），
     *     逐个列必漏，而漏了就是运行时抛错。
     *     放行整个 @deepseek-ai/ 是安全的 —— 它们都由宿主提供，
     *     宿主没有的自然会在 require 时抛「找不到模块」，比我们拦下来更准确。
     */
    var __requireShim = function (n) {
      if (n === "react" || n === "react/jsx-runtime" || n === "react-dom" || n === "react-dom/client") {
        return require(n);
      }
      if (n.lastIndexOf("@deepseek-ai/", 0) === 0) {
        return require(n);
      }
      throw new Error("unexpected require: " + n);
    };

    /**
     * ★ 把【真 require】挂到全局。
     *   剪辑台的 dsh-primitives.js 通过 resolveHostRequire() 优先取它 ——
     *   因为 esbuild 打包 CJS 时会把源码里的裸 require 换成它自己的桩，
     *   "typeof require === function" 判定通过但调用必抛。
     *   细节见 editor/dsh-primitives.js 文件头。
     */
    globalThis.__DSH_PLUGIN_REQUIRE__ = __requireShim;

    (function (require, module, exports) {
${impl}
    })(__requireShim, module, exports);

    return module.exports;
  }
});
`;

fs.writeFileSync(path.join(LIB, "client.js"), bundle, "utf8");
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`  ✓ lib/client.js  ${(Buffer.byteLength(bundle) / 1024).toFixed(1)} KB`);
