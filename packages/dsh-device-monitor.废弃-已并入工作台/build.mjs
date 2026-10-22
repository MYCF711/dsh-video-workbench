/**
 * 构建 lib/client.js（IIFE，宿主要求的形状）。
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
  format: "cjs",
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
 * dsh-device-monitor client bundle — 由 build.mjs 生成，勿手改。
 */
window.__ModuleLoader__.load({
  id: "dsh-device-monitor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var __requireShim = function (n) {
      if (n === "react" || n === "react/jsx-runtime" || n === "react-dom") return require(n);
      throw new Error("unexpected require: " + n);
    };

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
