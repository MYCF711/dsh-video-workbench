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
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * ★★ 2026-10-23 D2 去敏：esbuild 不再写死另一个仓库的绝对 URL。
 *
 *   原来：
 *     import { build } from "file:///<OLD_REPO>/packages/
 *                            dsh-editor/node_modules/esbuild/lib/main.js";
 *   ⇒ 别人 clone 下来构建直接失败，错误信息只是「找不到模块」，
 *     看不出是「esbuild 没装」。
 *
 *   现在按顺序找：① 本包 node_modules ② 仓库根 ③ tools/
 *   都找不到 ⇒ 打印明确的安装命令后退出。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function loadEsbuild() {
  const cands = [
    path.join(HERE, "node_modules", "esbuild", "lib", "main.js"),
    path.join(HERE, "..", "..", "node_modules", "esbuild", "lib", "main.js"),
    path.join(HERE, "..", "tools", "node_modules", "esbuild", "lib", "main.js"),
    /* ★ 2026-10-24：本机 _upstream 里常有现成的（构建上游时装的） */
    path.join(HERE, "..", "..", "..", "_upstream", "artcraft-demo", "node_modules", "esbuild", "lib", "main.js"),
  ];
  for (const p of cands) {
    if (fs.existsSync(p)) return import(pathToFileURL(p).href);
  }
  /* 也试一次裸 import（pnpm workspace 里常能直接解析） */
  try { return await import("esbuild"); } catch { /* 往下报错 */ }

  console.error("");
  console.error("  ✗ 找不到 esbuild —— 构建需要它。");
  console.error("");
  console.error("  它是本包的 devDependency，装一下就行：");
  console.error(`     cd "${HERE}"`);
  console.error("     npm install");
  console.error("");
  console.error("  如果 npm 报 EPERM（中文路径下 npm 会解析错 prefix）：");
  console.error("     npm install esbuild --no-save --prefix . --no-package-lock");
  console.error("");
  console.error("  ★ lib/client.js 是构建产物，不进 git ——");
  console.error("    所以使用者第一次用之前必须自己构建一次。");
  console.error("");
  process.exit(1);
}

const { build } = await loadEsbuild();

/**
 * ★★★ 2026-10-25 · 不再往产物里塞 ArtCraft payload
 *
 *   上一版的写法是「构建期补占位文件」，解决了「clone 后构建失败」，
 *   但没解决更贵的那一半：只要产物里内联了 payload，
 *   首屏就是 11.4 MB，而它只有【打开剪辑台】才用得上。
 *
 *   现在 editorHost.js 里已把静态 import 删掉，改成运行时
 *   GET /comfy-assets/artcraft-asset?name=... （host 侧读 .b64.txt）。
 *   ⇒ 打包产物 614 KB（实测），剪辑台打开时才付那 10 MB。
 *
 *   所以这里只需要检查「产物文件在不在」，在就提示一句，不影响构建。
 */
const ART_DIR = path.join(HERE, "src", "editor");
const hasPayload = fs.existsSync(path.join(ART_DIR, "artcraft-payload.b64.txt"))
  && fs.statSync(path.join(ART_DIR, "artcraft-payload.b64.txt")).size > 1000;
if (!hasPayload) {
  console.log("  · 没找到 ArtCraft 产物（artcraft-payload.b64.txt）");
  console.log("    剪辑台将显示「需要先准备 ArtCraft 产物」，视频工作台不受影响");
  console.log("    需要剪辑台：pwsh -NoProfile -File ./scripts/fetch-artcraft.ps1");
}

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
