/**
 * 把脚本里的 _upstream 绝对路径改成「环境变量 + 缺则跳过」。
 *
 * ★ 问题：31 处硬编码 `D:/主工作区/_upstream/artcraft-demo/video-editor/src`。
 *   那是【仓库外】的上游参考源，别的机器不会有。
 *   现在这些脚本在新机器上一跑就失败，报「文件不存在」——
 *   但那不是功能坏了，是「本机没放上游参考源」。
 *
 * ★ 修法（与 D3 的 test-env.mjs 同一模式）：
 *   ① 加一个共享的 upstream-env.mjs，从环境变量/约定位置找
 *   ② 找不到 → 打印跳过说明并 exit 0
 *
 * ★ 为什么不直接替换成占位符 <UPSTREAM>：
 *   那就变成语法错误的字符串字面量，脚本直接崩。
 *   必须改成【真的能跑】的形式。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = "D:\\主工作区\\DSH视频工作台";

/* ── ① 先写共享模块 ── */
const SHARED = `/**
 * 上游参考源（artcraft-demo）的定位 —— 从环境变量或约定位置找。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   2026-10-24 公开仓库前审计发现：31 处硬编码
 *     D:/主工作区/_upstream/artcraft-demo/video-editor/src
 *
 *   那是【仓库外】的上游参考源（ArtCraft 的原始 TS 源码），
 *   本机放在 _upstream/ 下用于对照阅读，**不属于本仓库，别的机器没有**。
 *
 *   ⇒ 那些脚本在新机器上一跑就失败，报「文件不存在」。
 *     但那不是功能坏了，是「本机没放上游参考源」。
 *
 * ── 取值顺序
 *   ① 环境变量 ARTCRAFT_UPSTREAM   —— 直接给 src 目录
 *   ② 环境变量 ARTCRAFT_UPSTREAM_ROOT —— 给根，自动拼 artcraft-demo/video-editor/src
 *   ③ 仓库同级目录 _upstream/…    —— 本机的约定位置
 *
 * ★ 找不到时返回 null，由调用方决定跳过。不在这里 throw。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/** 候选路径，按优先级。 */
function candidates() {
  const out = [];
  if (process.env.ARTCRAFT_UPSTREAM) out.push(process.env.ARTCRAFT_UPSTREAM);
  if (process.env.ARTCRAFT_UPSTREAM_ROOT) {
    out.push(path.join(process.env.ARTCRAFT_UPSTREAM_ROOT, "artcraft-demo", "video-editor", "src"));
  }
  /* 本机约定：仓库同级目录 */
  out.push(path.join(REPO, "..", "_upstream", "artcraft-demo", "video-editor", "src"));
  out.push(path.join(REPO, "_upstream", "artcraft-demo", "video-editor", "src"));
  return out;
}

/** 上游 src 目录，找不到返回 null。 */
export function findUpstream() {
  for (const p of candidates()) {
    try { if (fs.existsSync(p)) return path.resolve(p); } catch { /* 下一个 */ }
  }
  return null;
}

export const UPSTREAM = findUpstream();

/** 相对 UPSTREAM 的某个文件；UPSTREAM 缺失时返回 null。 */
export function upstreamFile(rel) {
  if (!UPSTREAM) return null;
  return path.join(UPSTREAM, rel);
}

/**
 * 给脚本用的「找不到上游就跳过」。
 *
 * ★ 跳过 ≠ 失败：跳过=本机没放参考源；失败=代码真的不对。
 */
export function skipWithoutUpstream(scriptName, extra = "") {
  console.log("");
  console.log(\`  – 跳过 \${scriptName}：本机没有 ArtCraft 上游参考源\`);
  console.log("");
  console.log("     这些验收对照的是 ArtCraft 的原始 TS 源码（不在本仓库里）。");
  console.log("     要跑它们，任选一种：");
  console.log("       ARTCRAFT_UPSTREAM=<artcraft-demo/video-editor/src 的绝对路径>");
  console.log("       ARTCRAFT_UPSTREAM_ROOT=<含 artcraft-demo/ 的父目录>");
  console.log("       或把它放到 <仓库同级>/_upstream/artcraft-demo/video-editor/src");
  if (extra) console.log(\`     \${extra}\`);
  console.log("");
  console.log("  通过 0 / 0（跳过）");
  process.exit(0);
}
`;
fs.writeFileSync(path.join(REPO, "packages", "tools", "upstream-env.mjs"), SHARED, "utf8");
console.log("✅ 写入 packages/tools/upstream-env.mjs");

/* ── ② 批量改脚本 ── */
const files = spawnSync("git", ["-c", "core.quotepath=false", "ls-files"], {
  cwd: REPO, encoding: "utf8",
}).stdout.split("\n").filter((f) => /\.m?js$/.test(f));

let changed = 0;
const report = [];

for (const rel of files) {
  const full = path.join(REPO, rel);
  if (!fs.existsSync(full)) continue;
  let src = fs.readFileSync(full, "utf8");
  if (!/D:[\\/]主工作区[\\/]_upstream/.test(src)) continue;
  const before = src;

  /* 只改【非注释行】里的路径字面量 */
  const lines = src.split("\n");
  const out = lines.map((line) => {
    const t = line.trim();
    /* 注释行跳过（保留历史说明，脱敏时再统一替换） */
    if (/^(\*|\/\/|#)/.test(t)) return line;
    /* 把 "D:/主工作区/_upstream/artcraft-demo/video-editor/src" 及其子路径
       换成 upstreamFile("<子路径>") 或 UPSTREAM */
    return line.replace(
      /["']D:[\\/]主工作区[\\/]_upstream[\\/]artcraft-demo[\\/]video-editor[\\/]src([^"']*)["']/g,
      (m, rest) => {
        const relPath = (rest ?? "").replace(/^[\\/]/, "").replace(/\\/g, "/");
        return relPath ? `upstreamFile(${JSON.stringify(relPath)})` : "UPSTREAM";
      },
    );
  });
  src = out.join("\n");

  if (src === before) continue;

  /* 加 import（如果还没加） */
  if (!/from\s+["'][^"']*upstream-env\.mjs["']/.test(src)) {
    const fromDir = path.dirname(full);
    let relToTools = path.relative(fromDir, path.join(REPO, "packages", "tools", "upstream-env.mjs")).replace(/\\/g, "/");
    if (!relToTools.startsWith(".")) relToTools = "./" + relToTools;
    const imp = `import { UPSTREAM, upstreamFile, skipWithoutUpstream } from "${relToTools}";\nif (!UPSTREAM) skipWithoutUpstream(${JSON.stringify(path.basename(full))});\n`;
    /* 插在第一条 import 之后 */
    const m = src.match(/^import[^\n]*\n/m);
    if (m) src = src.slice(0, m.index + m[0].length) + imp + src.slice(m.index + m[0].length);
    else src = imp + src;
  } else if (!/if\s*\(\s*!UPSTREAM\s*\)/.test(src)) {
    /* 有 import 但没有跳过守卫 */
    src = src.replace(
      /(from\s+["'][^"']*upstream-env\.mjs["'];?\n)/,
      `$1if (!UPSTREAM) skipWithoutUpstream(${JSON.stringify(path.basename(full))});\n`,
    );
  }

  fs.writeFileSync(full, src, "utf8");
  changed += 1;
  report.push(rel);
}

console.log(`\n改了 ${changed} 个脚本：`);
for (const r of report) console.log(`  · ${r}`);
