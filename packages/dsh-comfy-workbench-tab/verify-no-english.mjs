/**
 * verify-no-english.mjs · 漏翻检测（静态版）
 *
 * ══════════════════════════════════════════════════════════════════
 * 它检查什么
 *
 * 扫 ArtCraft 上游源码里的「用户可见文案」，找出仍是英文的。
 * 不是扫 DOM —— 扫 DOM 需要活实例 + 逐层点开，那部分在
 * verify-dsh-native-ui.live 里做；这里是能进 verify-all 静态段的部分。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 白名单（这些英文保留 —— 判据：翻译后用户会更看不懂）
 *
 *   fps           帧率单位，行业惯例
 *   MP4/WebM/...  容器格式名
 *   H.264/VP9     编码器名
 *   AAC           音频编码
 *   ComfyUI/DSH  品牌
 *   x:y           画幅比（16:9）
 *   00:00:00:00   时间码
 *   .mp4/.png     扩展名
 *   PNG/JPEG/GIF  图片格式
 *   Phase/...     代码标识（data-*、class 名不在这条扫描范围）
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 已知的「不该算漏翻」的位置（扫描时排除）
 *
 *   · 注释里（// 与 /* *\/）
 *   · import / export 语句
 *   · className 字符串
 *   · aria-label 里的英文【要】报（无障碍也要中文）
 */

import fs from "node:fs";
import { UPSTREAM, upstreamFile, skipWithoutUpstream } from "../tools/upstream-env.mjs";
if (!UPSTREAM) skipWithoutUpstream("verify-no-english.mjs");
import path from "node:path";
const WHITELIST = new Set([
  "fps", "FPS",
  "MP4", "WebM", "WEBM", "MOV", "MKV", "AVI",
  "H.264", "H264", "VP9", "HEVC", "AV1",
  "AAC", "MP3", "WAV", "OPUS",
  "ComfyUI", "DSH", "DeepSeek", "Harness",
  "PNG", "JPEG", "JPG", "GIF", "WebP", "SVG",
  "Square", "Plus",            // 画幅名（Square / Square Plus 是预设名）
  "Blur", "blur",              // 特效参数名（保留原词便于对照专业术语）
  "Timeline",                  // 代码标识，界面已中文化
]);

/* 允许的整体模式（整串匹配则放行） */
const WHITELIST_PATTERNS = [
  /^\d{2}:\d{2}(:\d{2}(:\d{2})?)?$/,        // 时间码
  /^\d+:\d+$/,                              // 16:9
  /^\d+(\.\d+)?%$/,                         // 25%
  /^\d+\s*(fps|秒|帧|px)$/i,
  /^\.\w{2,4}$/,                            // .mp4
  /^[\d\s.]+$/,                             // 纯数字
  /^[×x]$/,
  /^\d+×\d+$/,
];

const isWhitelisted = (s) => {
  if (WHITELIST.has(s)) return true;
  return WHITELIST_PATTERNS.some((re) => re.test(s));
};

/* ── 收集 JSX 里的字符串字面量与 JSX 文本 ───────────────────── */

function stripComments(src) {
  // 去块注释（保留行数，便于报错定位）
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // 去行注释
  return noBlock.split(/\r?\n/).map((l) => {
    const i = l.indexOf("//");
    if (i < 0) return l;
    // 粗略判断：// 在引号外才算注释
    const before = l.slice(0, i);
    const quotes = (before.match(/["'`]/g) ?? []).length;
    if (quotes % 2 === 0) return before;
    return l;
  }).join("\n");
}

const findings = [];

function scanFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const src = stripComments(raw);
  const lines = src.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 跳过 import / export 行
    if (/^\s*(import|export)\b/.test(line)) return;

    // 收集 aria-label / title / placeholder 的属性值
    for (const m of line.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*)"/g)) {
      const val = m[2].trim();
      if (!val) continue;
      const words = val.match(/[A-Za-z][A-Za-z.]*/g) ?? [];
      const bad = words.filter((w) => !isWhitelisted(w));
      if (bad.length > 0) {
        findings.push({ file, lineNo, kind: m[1], text: val, badWords: bad });
      }
    }
    for (const m of line.matchAll(/\b(aria-label|title|placeholder|alt)=\{'([^']*)'\}/g)) {
      const val = m[2].trim();
      if (!val) continue;
      const words = val.match(/[A-Za-z][A-Za-z.]*/g) ?? [];
      const bad = words.filter((w) => !isWhitelisted(w));
      if (bad.length > 0) {
        findings.push({ file, lineNo, kind: m[1], text: val, badWords: bad });
      }
    }

    // 收集 JSX 文本：>纯文字<
    for (const m of line.matchAll(/>([^<>{}\n]{2,})</g)) {
      const val = m[1].trim();
      if (!val || !/[A-Za-z]/.test(val)) continue;
      const words = val.match(/[A-Za-z][A-Za-z.]*/g) ?? [];
      const bad = words.filter((w) => !isWhitelisted(w));
      if (bad.length > 0) {
        findings.push({ file, lineNo, kind: "jsx-text", text: val, badWords: bad });
      }
    }
  });
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") continue;
      walk(p);
    } else if (/\.(tsx|ts)$/.test(e.name)) {
      scanFile(p);
    }
  }
}

if (!fs.existsSync(UPSTREAM)) {
  console.error(`  ✗ 找不到上游源码：${UPSTREAM}`);
  console.error("    这是本项目的私有分支路径，换机器要改这里。");
  process.exit(2);
}

walk(UPSTREAM);

/* ── 汇总 ─────────────────────────────────────────────────────── */

const byFile = new Map();
for (const f of findings) {
  const rel = f.file.replace(UPSTREAM, "").replace(/^[\\/]/, "");
  const arr = byFile.get(rel) ?? [];
  arr.push(f);
  byFile.set(rel, arr);
}

console.log("");
if (findings.length === 0) {
  console.log("  ✓ 漏翻检测  0 处非白名单英文");
  process.exit(0);
}

console.log(`  ⚠ 漏翻检测  发现 ${findings.length} 处非白名单英文（${byFile.size} 个文件）\n`);
for (const [rel, arr] of [...byFile.entries()].sort()) {
  console.log(`  ${rel}`);
  for (const f of arr.slice(0, 8)) {
    console.log(`    L${f.lineNo}  [${f.kind}] "${f.text.slice(0, 60)}"`);
    console.log(`         未白名单：${f.badWords.join(", ")}`);
  }
  if (arr.length > 8) console.log(`    …还有 ${arr.length - 8} 处`);
  console.log("");
}

console.log("  ── 白名单（这些英文保留）──");
console.log("    " + [...WHITELIST].join(" · "));
console.log("");
console.log("  判据：翻译后让用户【更看不懂】的就保留原文。");
console.log("       要新增白名单，先回答：这个英文翻成中文会不会更糟？");
console.log("");

// ★ 退出码：0 = 全白名单；1 = 有漏翻
//   注意：本项目现有英文可能多于 0，所以第一版先不阻塞 verify-all，
//   用 --strict 才返回 1。等把已知项清完再改成默认阻塞。
const strict = process.argv.includes("--strict");
process.exit(strict ? 1 : 0);

