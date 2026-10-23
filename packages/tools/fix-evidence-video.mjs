/**
 * 给 dsh-editor/test/ 下依赖 EVIDENCE_VIDEO 的三个脚本补默认素材 + 跳过语义。
 *
 * ★ 背景（2026-10-23）
 *   这三个脚本（verify-crop / verify-m7-render / verify-m7-trim）
 *   一直没被登记进 verify-all，原因是它们在没有 EVIDENCE_VIDEO
 *   环境变量时直接 exit(1) —— 登记了也必红。
 *
 *   而它们本来就有可用素材：docs/evidence/ 下有 5 个 mp4。
 *
 *   两处修：
 *     ① 给一个默认素材路径（仓库内的证据视频），不再依赖手工设环境变量
 *     ② 没有素材时走「跳过」（exit 0 + 明确说明），而不是「失败」
 *        —— 跳过和失败必须分开，否则「没素材」会被当成「功能坏了」
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** tools/ 的上一级是 packages/；再上一级才是仓库根（docs 在那）。 */
const PKG_ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(PKG_ROOT, "..");
const EDITOR = path.join(PKG_ROOT, "dsh-editor");

const FILES = [
  "test/verify-crop.mjs",
  "test/verify-m7-render.mjs",
  "test/verify-m7-trim.mjs",
];

/** 默认素材：优先用最新的证据视频。 */
function pickDefaultVideo() {
  const dir = path.join(REPO, "docs", "evidence");
  const cands = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (/\.(mp4|webm|mov)$/i.test(e.name)) {
        cands.push({ f, mtime: fs.statSync(f).mtimeMs });
      }
    }
  };
  walk(dir);
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0]?.f ?? null;
}

const fallback = pickDefaultVideo();
if (!fallback) {
  console.log("  ❌ docs/evidence 下没有可用视频，无法补默认素材");
  process.exit(1);
}
console.log("");
console.log("默认素材：" + fallback.replace(REPO + path.sep, ""));
console.log("");

/** 计算到 ROOT 的相对路径表达式（供生成代码用）。 */
const relExpr = JSON.stringify(path.relative(EDITOR, fallback).replace(/\\/g, "/"));

for (const rel of FILES) {
  const full = path.join(EDITOR, rel);
  if (!fs.existsSync(full)) { console.log(`  ⚠ 不存在：${rel}`); continue; }

  let src = fs.readFileSync(full, "utf8");

  /* ① 默认素材：把 `?? ""` 换成 `?? <回退路径>` */
  const oldSrc = /const SRC = process\.env\.EVIDENCE_VIDEO \?\? "";/;
  if (oldSrc.test(src)) {
    src = src.replace(oldSrc, `/**
 * ★ 2026-10-23：原来是 ?? ""，没有环境变量就直接 exit(1) ——
 *   导致这个脚本永远无法登记进 verify-all（登记了也必红）。
 *   改成回退到仓库里的证据视频（相对本文件解析，不写死绝对路径）。
 */
const __HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.EVIDENCE_VIDEO
  ?? path.resolve(__HERE, ${relExpr});`);
  }

  /* ② 缺素材 → 跳过而不是失败 */
  const oldGate = 'if (!fs.existsSync(SRC)) { console.error(`  ✗ 素材不存在：${SRC}`); process.exit(1); }';
  const newGate = `/**
 * ★ 2026-10-23：没素材时【跳过】而不是失败。
 *
 *   跳过与失败必须分开 ——
 *     跳过 = 这条验收今天不适用（没素材）
 *     失败 = 功能坏了
 *   混在一起会让「没素材」显示成「功能坏了」，把真问题淹掉。
 */
if (!fs.existsSync(SRC)) {
  console.log(\`  – 跳过：素材不存在（\${SRC}）\`);
  console.log("     设 EVIDENCE_VIDEO 环境变量指向一个视频即可运行本验收");
  console.log("");
  console.log("  通过 0 / 0（跳过）");
  process.exit(0);
}`;
  if (src.includes(oldGate)) {
    src = src.replace(oldGate, newGate);
  }

  /* ③ 确保有 path 与 fileURLToPath 的 import */
  if (!/import path from "node:path"/.test(src)) {
    src = src.replace(/import fs from "node:fs";/, 'import fs from "node:fs";\nimport path from "node:path";');
  }
  if (!/fileURLToPath/.test(src)) {
    src = src.replace(/import path from "node:path";/, 'import path from "node:path";\nimport { fileURLToPath } from "node:url";');
  }

  fs.writeFileSync(full, src, "utf8");
  console.log(`  ✅ ${rel}`);
}

console.log("");
console.log("跑一遍确认：");

