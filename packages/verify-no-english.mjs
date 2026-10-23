#!/usr/bin/env node
/**
 * 漏翻检测 —— 扫时间轴 tab，列出非白名单的英文
 *
 * 为什么需要（方案 G4）：
 *   时间轴 tab 2026-10-21 实测「零英文单词」，但那是人工扫的。
 *   将来改文案可能漏一处，靠人眼看截图不可靠（63 条看不全）。
 *   ⇒ 用脚本守住：把 DOM 里的英文全列出来，对照白名单。
 *
 * 用法：
 *   node verify-no-english.mjs            读当前页面（需先打开时间轴 tab）
 *   node verify-no-english.mjs --self-test 自检（验证脚本真的能抓到英文）
 *
 * 白名单（翻译后会让用户更看不懂的，保留原文）：
 *   品牌/格式：ComfyUI MP4 WebM VP9 H264 AAC fps PNG JPG
 *   技术标识：时间码 00:00:00:00、画幅 16:9
 *   文件扩展名：.mp4 .png .m4a
 *
 * ★ 注意：本脚本必须在浏览器里跑（DOM 只在浏览器里有）。
 *   所以它不登记进 verify-all（那是 Node 端），而是独立手动跑。
 *   登记方式见文件末尾。
 */

import fs from "node:fs";

import { BASE as TEST_BASE, TOKEN, authCookie } from "./tools/test-env.mjs";

/**
 * ★ 2026-10-23 D3 去敏：原来这里有一行
 *     const TOKEN_FILE = "C:/Users/<本机用户>/dsh-tok.txt";
 *   但它【从未被使用】—— 死代码，且把本机路径留在了仓库里。
 *   ⇒ 删掉，改用 test-env.mjs 的统一取值（BASE / TOKEN / authCookie）。
 */
const BASE = process.env.COMFY_WB_BASE ?? TEST_BASE;
void TOKEN; void authCookie;

const WHITELIST = new Set([
  // 品牌与格式
  "ComfyUI", "MP4", "WebM", "VP9", "H264", "AAC", "fps", "PNG", "JPG", "JPEG",
  "GIF", "WebP", "WAV", "MP3", "OGG",
  // 单位与标识
  "px", "ms", "KB", "MB", "GB", "Hz", "kHz", "dB",
  // 常见专有
  "ArtCraft", "DeepSeek", "DSH",
]);

/**
 * 从一段文字里提取「看起来是英文单词」的 token。
 * 判据：连续 3+ 个拉丁字母，首字母大写或全小写都算。
 * 排除：纯数字、时间码、扩展名、URL。
 */
function extractEnglish(text) {
  const out = [];
  // 先去掉时间码 00:00:00:00
  const cleaned = String(text ?? "").replace(/\d{2}:\d{2}:\d{2}[:;]\d{2}/g, " ");
  // 去掉扩展名
  const noExt = cleaned.replace(/\.[a-z0-9]{2,5}\b/gi, " ");
  // 抓英文词
  for (const m of noExt.matchAll(/\b[A-Za-z][A-Za-z'-]{2,}\b/g)) {
    const w = m[0];
    if (WHITELIST.has(w)) continue;
    out.push(w);
  }
  return out;
}

/** 自检：验证 extractEnglish 真的能抓到英文 */
function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    if (cond) { console.log(`    ✅ ${name}`); pass++; }
    else { console.log(`    ❌ ${name}${detail ? `  ${detail}` : ""}`); fail++; }
  };

  console.log("\n  === 自检：提取器能抓到英文吗 ===");
  check("抓到 Export", extractEnglish("Export").includes("Export"));
  check("抓到 Drag and drop", extractEnglish("Drag and drop videos").includes("Drag"));
  check("白名单不误报", !extractEnglish("MP4 和 WebM").includes("MP4"));
  check("时间码不误报", extractEnglish("00:00:00:00").length === 0,
    JSON.stringify(extractEnglish("00:00:00:00")));
  check("扩展名不误报", extractEnglish("a.mp4 b.png").length === 0,
    JSON.stringify(extractEnglish("a.mp4 b.png")));
  check("中文不误报", extractEnglish("这里是空的").length === 0);
  check("数字不误报", extractEnglish("875 项 1024").length === 0);

  console.log(`\n  自检：${pass} 通过 / ${fail} 失败`);
  return fail === 0;
}

/**
 * 从页面 DOM 里收集所有可见文字。
 * ★ 需要浏览器环境 —— 本脚本在 Node 里跑，所以通过 CDP 取。
 *   但为了不引依赖，这里改成「读一个预先导出的 DOM 文本文件」。
 *
 *   实际用法：
 *     ① 在浏览器里跑一段 JS 把 ac-scope 的 innerText 存到文件
 *     ② 再跑本脚本分析那个文件
 *   ⇒ 这样脚本本身是纯 Node，可测可复用。
 */
function analyzeFile(path) {
  if (!fs.existsSync(path)) {
    console.log(`  ★ 找不到 ${path}`);
    console.log("    先在浏览器里导出：");
    console.log("      document.querySelector('.ac-scope').innerText");
    console.log("    存成该文件后重跑。");
    return null;
  }
  const text = fs.readFileSync(path, "utf8");
  const words = extractEnglish(text);
  const uniq = [...new Set(words)].sort();
  return { total: words.length, uniq, textLen: text.length };
}

// ── 主流程 ──────────────────────────────────────────────────
const argv = process.argv.slice(2);

if (argv.includes("--self-test")) {
  const ok = selfTest();
  process.exit(ok ? 0 : 1);
}

const dumpPath = argv.find((a) => !a.startsWith("--"))
  ?? "D:/主工作区/DSH视频工作台/.state/timeline-text.txt";

console.log("\n  漏翻检测");
const r = analyzeFile(dumpPath);
if (!r) process.exit(2);

console.log(`  文本长度：${r.textLen}`);
console.log(`  英文词总数：${r.total}`);
console.log(`  去重后：${r.uniq.length}`);

if (!r.uniq.length) {
  console.log("\n  ✅ 零英文（白名单之外）");
  process.exit(0);
}

console.log("\n  ⚠ 以下英文不在白名单里：");
for (const w of r.uniq.slice(0, 60)) console.log(`      ${w}`);
if (r.uniq.length > 60) console.log(`      ……还有 ${r.uniq.length - 60} 个`);

console.log("\n  ★ 如果这些是有意保留的（品牌名/格式），加进 WHITELIST；");
console.log("    如果是漏翻的，去改 .tsx 文案。");
process.exit(1);

