/**
 * 文本判定验收 —— 防止 `String(x).trim()` 这类假防护回潮。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一套（2026-10-19）
 *
 *   `if (!String(x ?? "").trim())` 这个判定在本项目写了 6 遍，
 *   它拦不住：
 *     String({a:1})   → "[object Object]"   非空 ⇒ 通过
 *     String(0)       → "0"                 非空 ⇒ 通过
 *     "\u200b"        → trim() 不删零宽字符  ⇒ 通过（视觉上完全空白）
 *
 *   实测后果：这三种提示词都提交成功，跑出一张随机的图。
 *
 *   这份验收做两件事：
 *     ① 单测 text-guard.mjs 的判定是否正确（12 项）
 *     ② grep 全项目，确认没有新的 `String(x).trim()` 判空写法回潮
 *
 * 用法：
 *   node verify-text-guard.mjs
 *   node verify-text-guard.mjs --root <WORKSPACE>     # 改扫描根
 *
 * 退出码：有失败 → 1
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
// 工作区根 = packages 的上一级
const ROOT = argOf("--root", path.resolve(HERE, "..", ".."));

let pass = 0;
let fail = 0;
const failures = [];
const ok = (n, d = "") => { pass++; console.log(`  ✅ ${n}${d ? "  " + d : ""}`); };
const bad = (n, d = "") => { fail++; failures.push(n); console.log(`  ❌ ${n}${d ? "  " + d : ""}`); };

console.log("═".repeat(62));
console.log("  文本判定验收（防 `String(x).trim()` 假防护回潮）");
console.log("═".repeat(62));

// ─── ① 单测 text-guard ──────────────────────────────────────────
console.log("\n① text-guard 判定");

const GUARD = path.join(HERE, "dsh-comfy-bridge", "src", "text-guard.mjs");
if (!fs.existsSync(GUARD)) {
  bad("text-guard.mjs 存在", `找不到 ${GUARD}`);
} else {
  const { hasVisibleText } = await import(pathToFileURL(GUARD).href);

  const mustBeTrue = [
    ["正常中文", "一只猫坐在窗台上"],
    ["正常英文", "a cat sitting on the windowsill"],
    ["中英混合", "a cat 坐在窗台"],
    ["带标点", "。，！"],
    ["数字串", "12345"],
    ["单字符", "a"],
    ["emoji", "🐱"],
  ];
  for (const [n, v] of mustBeTrue) {
    hasVisibleText(v) ? ok(`${n} 判为有内容`) : bad(`${n} 判为有内容`, `实际 false，值=${JSON.stringify(v)}`);
  }

  const mustBeFalse = [
    ["空串", ""],
    ["半角空格", "   "],
    ["制表换行", "\t\n\r"],
    // ── 零宽与方向标记 ──
    ["零宽空格 \\u200b", "\u200b"],
    ["零宽非连接 \\u200c", "\u200c"],
    ["零宽连接 \\u200d", "\u200d"],
    ["LRM \\u200e", "\u200e"],
    ["RLM \\u200f", "\u200f"],
    // ── 各类空白 ──
    ["BOM \\ufeff", "\ufeff"],
    ["全角空格 \\u3000", "\u3000"],
    ["不间断空格 \\u00a0", "\u00a0"],
    ["数字空格 \\u2007", "\u2007"],
    ["中数空格 \\u205f", "\u205f"],
    // ── 行/段分隔 ──
    ["行分隔符 \\u2028", "\u2028"],
    ["段分隔符 \\u2029", "\u2029"],
    // ── 视觉空白但不是 Zs 类（2026-10-19 实测漏掉的）──
    ["韩文填充符 \\u3164", "\u3164"],
    ["韩文填充 \\u115f", "\u115f"],
    ["半角韩文填充 \\uffa0", "\uffa0"],
    ["word joiner \\u2060", "\u2060"],
    ["注音标记 \\ufff9", "\ufff9"],
    // ── 控制字符 ──
    ["NUL \\u0000", "\u0000"],
    ["BEL \\u0007", "\u0007"],
    ["ESC \\u001b", "\u001b"],
    ["DEL \\u007f", "\u007f"],
    // ── 组合 ──
    ["混合不可见", " \u200b\u3000\ufeff "],
    ["NUL+零宽", "\u0000\u200b"],
    // ── 非字符串 ──
    ["对象", { a: 1 }],
    ["数组", []],
    ["数字 0", 0],
    ["数字 1", 1],
    ["布尔 true", true],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [n, v] of mustBeFalse) {
    hasVisibleText(v) === false
      ? ok(`${n} 判为空`)
      : bad(`${n} 判为空`, `实际 true，值=${JSON.stringify(v)}`);
  }
}

// ─── ② 扫描回潮 ─────────────────────────────────────────────────
console.log("\n② 扫描是否有新的 `String(x).trim()` 判空写法");

/**
 * 允许出现的地方（白名单）：
 *   · 注释里（说明「原来写错了」）
 *   · text-guard.mjs 自己
 *   · 规范化用途（把输入变成干净字符串），不是判空 —— 这种要人工确认
 */
const ALLOW = [
  /^\s*\/\//,                 // 整行注释
  /^\s*\*/,                   // 块注释
  /text-guard\.mjs$/,
];

/** 判空的典型形状：!String(...).trim()  或  String(...).trim() === "" */
const BAD_PATTERNS = [
  { re: /!\s*String\([^)]*\)\s*\.\s*trim\(\)/, why: "!String(x).trim()" },
  { re: /String\([^)]*\)\s*\.\s*trim\(\)\s*(===?|!==?)\s*["'`]["'`]/, why: "String(x).trim() 与空串比较" },
];

const SCAN_DIRS = [
  path.join(HERE, "dsh-comfy-bridge", "src"),
  path.join(HERE, "dsh-comfy-workbench-tab", "src"),
  path.join(ROOT, "DSH视频工作站", "packages", "dsh-editor", "src"),
];

let scannedFiles = 0;
let hits = [];
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const full = path.join(dir, name);
    if (ALLOW.some((re) => re.test(full))) continue;
    scannedFiles++;
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (ALLOW.some((re) => re.test(line))) return;
      for (const { re, why } of BAD_PATTERNS) {
        if (re.test(line)) {
          hits.push({ file: name, line: i + 1, why, text: line.trim().slice(0, 70) });
        }
      }
    });
  }
}

console.log(`  （扫描了 ${scannedFiles} 个文件）`);

// ─── ②b 扫描「按文件名猜类型」的子串匹配（2026-10-19 推广）────────────────
//
// ★ 与 ② 同源：子串匹配 = 黑名单思维（只要「包含」就算）。
//   实测 AssetCanvas.js 曾用 /png|jpe?g|webp/i.test(name) 判图片，
//   于是 "mypngdata.json" 被当成图片、"video_mp4_report.txt" 被当成视频，
//   最后 <video src="...txt"> 去加载文本文件，永远失败。
//   ⇒ 必须用扩展名后缀白名单（endsWith / 提取后缀后 includes）。
//
//   这里扫「用正则子串判扩展名」的写法，endsWith/startsWith 是白名单，允许。
// 「子串正则判扩展名」的判据（★ 全部用 includes，不用正则 —— 见下方说明）
//
//   为什么不用正则：我写了三遍复杂正则都没写对（转义被吃、贪婪匹配）。
//   这个判据本来就是「同时满足几个简单条件」，用 includes 反而清楚、可验。
//
//   ❌ 错写法：/png|jpe?g|webp/i.test(name)        —— 文件名任意位置含 png 就算图片
//   ✅ 对写法：/\.(png|jpe?g|webp)($|\?)/.test(e) —— \\. 锚定后缀
//   ✅ 对写法：IMG_EXT.includes(extOf(o))          —— 提取后缀后查数组
function looksLikeSubstringExtTest(line) {
  const exts = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "webm", "mov", "mkv", "mp3", "wav"];
  const lower = line.toLowerCase();
  if (!exts.some((e) => lower.includes(e))) return false;
  if (!line.includes(".test(") || line.indexOf("/") < 0) return false;
  if (line.includes("endsWith") || line.includes("startsWith")) return false;
  // ★ 关键：有 "\." 锚定或 "($" / "($|" 收尾的，是「后缀匹配」的正确写法，放过
  if (line.includes("\\.")) return false;   // 源码里出现 \.  说明锚定了点
  if (line.includes("($")) return false;      // ($|?) 结尾锚定
  return true;
}
const typeHits = [];
for (const dir of SCAN_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const full = path.join(dir, name);
    if (ALLOW.some((re) => re.test(full))) continue;
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (ALLOW.some((re) => re.test(line))) return;
      if (looksLikeSubstringExtTest(line)) {
        typeHits.push({ file: name, line: i + 1, text: line.trim().slice(0, 80) });
      }
    });
  }
}
if (typeHits.length === 0) {
  ok("没有用子串正则判文件类型");
} else {
  for (const h of typeHits) {
    console.log(`     ${h.file}:${h.line}`);
    console.log(`       ${h.text}`);
  }
  bad("子串正则判类型回潮", `${typeHits.length} 处 — 改用扩展名后缀白名单`);
}
if (hits.length === 0) {
  ok("没有发现 String(x).trim() 判空写法");
} else {
  for (const h of hits) {
    console.log(`     ${h.file}:${h.line}  ${h.why}`);
    console.log(`       ${h.text}`);
  }
  bad(`String(x).trim() 判空回潮`, `${hits.length} 处 — 改用 hasVisibleText()`);
}

// ─── 汇总 ───────────────────────────────────────────────────────
console.log("\n" + "═".repeat(62));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  文本判定验收全过");
