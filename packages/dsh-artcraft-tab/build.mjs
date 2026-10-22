/**
 * dsh-artcraft-tab 打包（2026-10-20 · 第二版）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 第一版失败的原因（值得记住）
 *
 *   我把 ArtCraft 产物放 assets/artcraft.js，client.js 里用 <script src> 加载：
 *     /plugin-assets/dsh-artcraft-tab/assets/artcraft.js
 *
 *   实测：这个路径根本不存在。
 *     /plugin-assets/**         → 全 404
 *     /plugin-assets/<任意插件>/package.json → 404
 *     /plugins/??<name>/assets/… → 404
 *
 *   而 client.js 本身是加载成功的（它出现在 /plugins/?? 批量列表里，
 *   且「时间轴」tab 确实出现了）。
 *   ⇒ 这个 DSH 版本没有把插件目录下的任意文件暴露成静态资源，
 *     只暴露 package.json 的 main / client 入口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 现在的做法：内联
 *
 *   ArtCraft 的 CJS 产物作为【字符串常量】嵌进 client.js，
 *   运行时用 new Function 求值。这样不依赖任何静态资源路由。
 *
 *   代价：client.js 从 3.4KB 变成约 8MB
 *   收益：能在真实 DSH 里跑起来（第一版跑不起来，体积小也没意义）
 *
 *   ★ 为什么可以接受：
 *     · gzip 后 2.23MB，本机传输 <100ms
 *     · 8MB JS 解析约 300~600ms，只在用户点「时间轴」tab 时发生
 *     · 它是独立插件包，不拖慢 dsh-comfy-workbench-tab
 *
 *   ★ 为什么还是延迟到点击时才求值：
 *     不在 client.js 顶层 new Function —— 那样 DSH 启动时就要解析 8MB，
 *     所有 tab 都变慢。改成第一次渲染组件时才求值。
 */

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = "D:/主工作区/_upstream/artcraft-demo";
const OUT = path.join(HERE, "lib");
const ASSETS = path.join(HERE, "assets");

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

/* ── ① 读 ArtCraft 产物 ─────────────────────────────────── */
const cjsPath = path.join(ART, "dsh-dist", "artcraft-dsh.cjs");
if (!fs.existsSync(cjsPath)) {
  console.log("  ★ 找不到 ArtCraft 产物：" + cjsPath);
  console.log("    先跑：cd " + ART + " && node build-dsh-proof.mjs");
  process.exit(1);
}
const raw = fs.readFileSync(cjsPath, "utf8");

/* ── ② CSS 也内联（同样没有静态资源路由可用）───────────── */
const cssPath = path.join(ART, "dsh-dist", "ac.css");
let css = "";
if (fs.existsSync(cssPath)) {
  css = fs.readFileSync(cssPath, "utf8");
  console.log(`  ✓ ac.css  ${(Buffer.byteLength(css) / 1024).toFixed(1)}KB（将内联）`);
} else {
  console.log("  ⚠ 没有 ac.css（ArtCraft 的界面会很难看）");
}

/* ── ③ 生成运行时引导文件 ──────────────────────────────── */
/**
 * 把 8MB 的 CJS 源码存成一个【单独的 .js 文件】，
 * 由 esbuild 用 text loader 作为字符串导入 client.js。
 *
 * ★ 为什么用 text loader 而不是直接拼字符串：
 *   直接拼进 client.js 的源码会让 esbuild 把它当代码解析 ——
 *   8MB 的第三方代码里可能有 client.js 打包配置不认的语法。
 *   用 text loader 当字符串，原样搬运，不解析。
 */
/**
 * ★★ 2026-10-20 关键修：payload 必须 base64 编码
 *
 *   第一版写的是 `export default ${JSON.stringify(raw)}` ——
 *   看起来只是把源码变成一个字符串字面量，应该没问题。
 *
 *   实测灾难性后果（这是今晚最难查的一个 bug）：
 *     ArtCraft 的 CJS 产物里有这几行：
 *       var dsh_entry_exports = {};
 *       __export(dsh_entry_exports, { mount: ..., toProject: ..., unmount: ... });
 *       module.exports = __toCommonJS(dsh_entry_exports);
 *
 *     esbuild 做 CJS 导出分析时【不区分内容是否在字符串里】——
 *     它在整个 bundle 里扫到 `__export(xxx_entry_exports, {...})`
 *     和 `module.exports = __toCommonJS(...)`，
 *     就把它们当成【本模块的导出声明】。
 *
 *   ⇒ 最终产物的导出变成：
 *       __export(dsh_entry_exports, { mount, toProject, unmount })
 *     而我的 exports.apply 完全消失。
 *   ⇒ DSH 拿不到 apply ⇒ 插件静默不激活 ⇒
 *     时间轴 tab 在、但内容区是空的（data-slot-error="conversation.view"）
 *
 *   ★ 为什么错误这么难查：
 *     · 没有报错，没有日志
 *     · tab 出现了（说明插件被加载）
 *     · 只是内容区空 —— 看起来像组件渲染问题
 *     · 我一开始以为是主题改动引入的
 *
 *   修法：base64 编码后再放进字符串。
 *     base64 只含 A-Za-z0-9+/=，esbuild 扫不到任何代码特征。
 *     运行时 atob + TextDecoder 还原。
 *
 *   ★ 验证过：用 base64 之后导出块恢复正常
 *     __export(xxx_entry_exports, { apply: () => apply, name: () => name })
 */
const b64 = Buffer.from(raw, "utf8").toString("base64");
const bootstrapPath = path.join(HERE, "src", "_artcraft-payload.js");
const payloadSource = `/**
 * ArtCraft 的 CJS 产物【base64 编码】，由 build.mjs 生成，勿手改。
 *
 * 源：${path.basename(cjsPath)}  ${(Buffer.byteLength(raw) / 1024 / 1024).toFixed(2)}MB
 * 编码后：${(b64.length / 1024 / 1024).toFixed(2)}MB
 * 生成时间：${new Date().toISOString()}
 *
 * ★ 为什么 base64 而不是直接放字符串：
 *   产物里有 \`module.exports = __toCommonJS(...)\`，
 *   esbuild 会在整个 bundle 里扫到它并当成【本模块的导出声明】，
 *   覆盖掉我们真正的 exports.apply ⇒ 插件静默不激活。
 *   base64 只含字母数字，扫不到任何代码特征。
 *
 * ★ 为什么不用 <script src> 从 assets/ 加载：
 *   实测这个 DSH 版本没有插件静态资源路由（/plugin-assets/** 全 404）。
 */
export default "${b64}";
`;
fs.writeFileSync(bootstrapPath, payloadSource, "utf8");
console.log(`  ✓ src/_artcraft-payload.js  ${(Buffer.byteLength(payloadSource) / 1024 / 1024).toFixed(2)}MB`);

/* ── ④ 生成 CSS 载荷 ───────────────────────────────────── */
const cssPayloadPath = path.join(HERE, "src", "_artcraft-css.js");
fs.writeFileSync(cssPayloadPath, `/**
 * ArtCraft 的 CSS 原文，作为字符串被 client.js 导入。
 * 由 build.mjs 生成，勿手改。
 *
 * 源：ac.css  ${(Buffer.byteLength(css) / 1024).toFixed(1)}KB
 * 已用 postcss-prefix-selector 加了 .ac-scope 前缀（第 0 期实测 0 处未作用域）。
 */
export default "${Buffer.from(css, "utf8").toString("base64")}";
`, "utf8");
console.log(`  ✓ src/_artcraft-css.js  ${(Buffer.byteLength(css) / 1024).toFixed(1)}KB（base64）`);

/* ── ⑤ 打本插件的 client 入口 ──────────────────────────── */
const entry = path.join(HERE, "src", "client.js");
const tmpOut = path.join(OUT, ".client.cjs");

await build({
  entryPoints: [entry],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: tmpOut,
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  define: { "process.env.NODE_ENV": '"production"', "global": "globalThis" },
  logLevel: "warning",
  // 需要的 loader：_artcraft-payload.js 与 _artcraft-css.js 都是普通 JS
  // （内容是 `export default "..."`，esbuild 会打成字符串常量）
});

const clientCjs = fs.readFileSync(tmpOut, "utf8");

/**
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-22 关键修复：宿主的 require 必须显式搭桥
 *
 *   【症状】剪辑台 tab 出现了，但整块渲染成
 *     「[剪辑台] 渲染失败：DSH 原生基元缺导出：… 加载
 *      @deepseek-ai/dsh-client-ui-primitives 失败」
 *
 *   【根因】源码里写的是
 *     hostRequire: typeof require === "function" ? require : null
 *   而 esbuild 打包 CJS 时，把裸 `require` 解析成它自己的
 *   `__require` 辅助函数（一个「Dynamic require of X is not supported」的桩），
 *   只有 `typeof require` 这个字面量被原样留下。
 *   ⇒ 判定为 function（通过），但拿到的是 esbuild 的桩，
 *     调它必然抛 ⇒ hostRequire 实际不可用。
 *
 *   【为什么之前没暴露】上一版根本不 require 任何官方包 ——
 *     它只用 react（external，走工厂的 require 参数，那条路是通的）。
 *     这一版开始用 @deepseek-ai/dsh-client-ui-primitives，
 *     才第一次真正调用 hostRequire。
 *
 *   【修法】工厂里把 require 挂到一个明确的全局名，
 *     源码侧优先用它。三层兜底：
 *       ① globalThis.__DSH_PLUGIN_REQUIRE__（本包装写入，最可靠）
 *       ② 工厂参数 require（IIFE 的正常路径）
 *       ③ null（报错，不静默降级）
 */
const clientIife = `
/**
 * dsh-artcraft-tab client bundle — 由 build.mjs 生成，勿手改。
 * 改 src/ 后跑 node build.mjs。
 *
 * ★ ArtCraft 的 8MB 产物已内联在本文件里（字符串常量）。
 *   原因见 build.mjs 顶部注释：这个 DSH 版本没有插件静态资源路由。
 */
window.__ModuleLoader__.load({
  id: "dsh-artcraft-tab",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var __requireShim = function (n) {
      return require(n);
    };

    /**
     * ★ 把宿主的 require 挂到全局 —— esbuild 会把源码里的裸 require
     *   替换成它自己的桩函数，见 build.mjs 那段长注释。
     *   这里挂的是【真】require（工厂参数）。
     */
    globalThis.__DSH_PLUGIN_REQUIRE__ = __requireShim;

    (function (require, module, exports) {
${clientCjs.split("\n").map((l) => "      " + l).join("\n")}
    })(__requireShim, module, exports);

    return module.exports;
  }
});
`;
fs.writeFileSync(path.join(OUT, "client.js"), clientIife, "utf8");
fs.unlinkSync(tmpOut);
console.log(`  ✓ lib/client.js  ${(Buffer.byteLength(clientIife) / 1024 / 1024).toFixed(2)}MB`);

/* ── ⑥ host 侧入口（空）───────────────────────────────── */
fs.writeFileSync(path.join(OUT, "index.js"), `/**
 * dsh-artcraft-tab · host 侧入口
 *
 * 本插件没有 host 侧能力 —— 纯客户端 UI 挂载。
 * ArtCraft 需要的数据（资产、工程）由 dsh-comfy-workbench-tab 的
 * HTTP 路由提供，本插件只消费。
 */
export const name = "dsh-artcraft-tab";
export function apply() {
  // 无 host 侧能力
}
`, "utf8");
console.log("  ✓ lib/index.js");

/* ── ⑦ 清理不再需要的 assets ───────────────────────────── */
for (const stale of ["artcraft.js", "ac.css"]) {
  const p = path.join(ASSETS, stale);
  if (fs.existsSync(p)) { fs.unlinkSync(p); }
}
try { fs.rmdirSync(ASSETS); } catch { /* 非空或不存在 */ }

/* ── 汇总 ───────────────────────────────────────────────── */
console.log("");
console.log("  ── 产物 ──");
for (const f of ["lib/client.js", "lib/index.js"]) {
  const p = path.join(HERE, f);
  if (fs.existsSync(p)) {
    console.log(`  ${f.padEnd(24)} ${(fs.statSync(p).size / 1024 / 1024).toFixed(2)}MB`);
  }
}
