/**
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
  console.log(`  – 跳过 ${scriptName}：本机没有 ArtCraft 上游参考源`);
  console.log("");
  console.log("     这些验收对照的是 ArtCraft 的原始 TS 源码（不在本仓库里）。");
  console.log("     要跑它们，任选一种：");
  console.log("       ARTCRAFT_UPSTREAM=<artcraft-demo/video-editor/src 的绝对路径>");
  console.log("       ARTCRAFT_UPSTREAM_ROOT=<含 artcraft-demo/ 的父目录>");
  console.log("       或把它放到 <仓库同级>/_upstream/artcraft-demo/video-editor/src");
  if (extra) console.log(`     ${extra}`);
  console.log("");
  console.log("  通过 0 / 0（跳过）");
  process.exit(0);
}
