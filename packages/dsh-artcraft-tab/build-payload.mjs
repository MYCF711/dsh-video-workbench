/**
 * build-payload.mjs · 重新生成 ArtCraft 产物载荷（2026-10-22 合包后抽出）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 为什么从 build.mjs 里抽出来
 *
 *   合包前，dsh-artcraft-tab/build.mjs 每次构建都做两件事：
 *     ① 读 ArtsCraft 上游产物（D:/主工作区/_upstream/artcraft-demo/dsh-dist/）
 *        → base64 → 写成 src/_artcraft-payload.js（10.43MB）
 *     ② 打本插件的 client.js（把 payload 内联进去）
 *
 *   合包后，payload 归 dsh-comfy-workbench-tab/src/editor/ 管，
 *   而 workbench 的 build.mjs 只负责「打包自己的源码」。
 *   ⇒ 两件事拆开：
 *       · 本脚本 = 只在【ArtCraft 上游变了】时才跑（几分钟，读 10MB）
 *       · workbench/build.mjs = 日常改剪辑台代码后跑（几秒）
 *
 *   ★ 为什么这样拆：build.mjs 每次都要读 10MB 上游文件并做 base64，
 *     改一行 UI 也要等它 —— 那是纯浪费。而 payload 只在
 *     `cd _upstream/artcraft-demo && node build-dsh-proof.mjs` 之后才需要更新。
 *
 * ── 用法
 *     node build-payload.mjs          重新生成 payload
 *     然后 node build.mjs             重新打包插件
 *
 * ── 什么时候需要跑本脚本
 *   · 改了 _upstream/artcraft-demo 的源码并重新 build-dsh-proof
 *   · 升级 ArtCraft 版本
 *   · 否则不需要（payload 是已编码好的常量）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ payload 必须 base64 —— 这是本项目最险的一个坑
 *
 *   第一版写的是 `export default ${JSON.stringify(raw)}`，
 *   看起来只是把源码变成字符串字面量，应该没问题。
 *
 *   实测灾难：ArtCraft 的 CJS 产物里有
 *     __export(dsh_entry_exports, { mount, toProject, unmount });
 *     module.exports = __toCommonJS(dsh_entry_exports);
 *   esbuild 做 CJS 导出分析时【不区分内容是否在字符串里】，
 *   把它当成【本模块的导出声明】⇒ 覆盖掉我们真正的 exports.apply
 *   ⇒ DSH 拿不到 apply ⇒ 插件静默不激活
 *   ⇒ tab 在、内容区空、没有任何报错。
 *
 *   base64 只含 A-Za-z0-9+/=，esbuild 扫不到任何代码特征。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** ArtCraft 上游产物的位置（不在本仓库内） */
const ART = "D:/主工作区/_upstream/artcraft-demo";
/** 生成目标：合包后归 workbench 包的 src/editor/ */
const DEST = path.join(HERE, "..", "dsh-comfy-workbench-tab", "src", "editor");

const cjsPath = path.join(ART, "dsh-dist", "artcraft-dsh.cjs");
if (!fs.existsSync(cjsPath)) {
  console.log("  ★ 找不到 ArtCraft 产物：" + cjsPath);
  console.log("    先跑：cd " + ART + " && node build-dsh-proof.mjs");
  process.exit(1);
}

const raw = fs.readFileSync(cjsPath, "utf8");
const b64 = Buffer.from(raw, "utf8").toString("base64");

const payloadSource = `/**
 * ArtCraft 的 CJS 产物【base64 编码】，由 build-payload.mjs 生成，勿手改。
 *
 * 源：${path.basename(cjsPath)}  ${(Buffer.byteLength(raw) / 1024 / 1024).toFixed(2)}MB
 * 编码后：${(b64.length / 1024 / 1024).toFixed(2)}MB
 * 生成时间：${new Date().toISOString()}
 *
 * ★ 为什么 base64 而不是直接放字符串：
 *   产物里有 module.exports = __toCommonJS(...)，
 *   esbuild 会在整个 bundle 里扫到它并当成【本模块的导出声明】，
 *   覆盖掉真正的 exports.apply ⇒ 插件静默不激活。
 *   base64 只含字母数字，扫不到任何代码特征。
 *
 * ★ 为什么不用 <script src> 从 assets/ 加载：
 *   实测这个 DSH 版本没有插件静态资源路由（/plugin-assets/** 全 404）。
 *
 * ★ 重新生成：node build-payload.mjs（只在 ArtCraft 上游变了时需要）
 */
export default "${b64}";
`;
fs.mkdirSync(DEST, { recursive: true });
fs.writeFileSync(path.join(DEST, "_artcraft-payload.js"), payloadSource, "utf8");
console.log(`  ✓ _artcraft-payload.js  ${(Buffer.byteLength(payloadSource) / 1024 / 1024).toFixed(2)}MB`);

/* ── CSS 载荷 ───────────────────────────────────────────── */
const cssPath = path.join(ART, "dsh-dist", "ac.css");
if (fs.existsSync(cssPath)) {
  const css = fs.readFileSync(cssPath, "utf8");
  fs.writeFileSync(path.join(DEST, "_artcraft-css.js"), `/**
 * ArtCraft 的 CSS 原文（base64），由 build-payload.mjs 生成，勿手改。
 *
 * 源：ac.css  ${(Buffer.byteLength(css) / 1024).toFixed(1)}KB
 * 已用 postcss-prefix-selector 加了 .ac-scope 前缀（第 0 期实测 0 处未作用域）。
 */
export default "${Buffer.from(css, "utf8").toString("base64")}";
`, "utf8");
  console.log(`  ✓ _artcraft-css.js  ${(Buffer.byteLength(css) / 1024).toFixed(1)}KB（base64）`);
} else {
  console.log("  ⚠ 没有 ac.css（ArtCraft 的界面会很难看）");
}

console.log("");
console.log("  下一步：cd ../dsh-comfy-workbench-tab && node build.mjs");
