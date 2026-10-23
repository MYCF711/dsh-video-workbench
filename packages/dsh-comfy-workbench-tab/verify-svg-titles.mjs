/**
 * verify-svg-titles.mjs · SVG <title> 不许有英文
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独有这个脚本
 *
 * 主人要求「英文 aria-label/title 全中文化」。我前后扫过三轮：
 *   第一轮：扫 JSX 里的 aria-label= / title= 属性 → 全中文
 *   第二轮：扫 tooltip= / label= / 直接 JSX 文本 → 补了 8 + 18 处
 *   第三轮（本轮）：**按钮的 accessible name 仍然有一个 "Ripple"**
 *
 * 根因：图标组件里写着 `<title>Ripple</title>`。
 *   虽然 svg 上标了 aria-hidden，但 <title> 仍会参与 accessible name 计算，
 *   于是那个按钮在自动化/读屏里叫 "Ripple"，而它的 tooltip 是「波纹编辑」。
 *
 * ★ 判据：`document.querySelectorAll('button')` 里 aria-label/title 为纯英文的应为 0。
 *   实测（本轮修前）：时间轴 42 个按钮里有 1 个叫 "Ripple"。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 白名单：品牌名不译
 *   Vercel / Marble / Data Buddy 是产品名，
 *   译了反而错（就像不会把 GitHub 译成「饭桶」）。
 */

import fs from "node:fs";
import { UPSTREAM, upstreamFile, skipWithoutUpstream } from "../tools/upstream-env.mjs";
if (!UPSTREAM) skipWithoutUpstream("verify-svg-titles.mjs");
import path from "node:path";

const SRC = UPSTREAM;

/* 品牌名白名单 —— 这些是专有名词，不译 */
const BRAND_WHITELIST = new Set(["Vercel", "Marble", "Data Buddy"]);

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(__tests__|node_modules)$/.test(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith(".tsx") && !/\.bak/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/* ── 找出所有 <title>英文</title> ─────────────────────────── */

const offenders = [];
let totalTitles = 0;

for (const f of walk(SRC)) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/<title>([^<]*)<\/title>/g)) {
    totalTitles++;
    const text = m[1].trim();
    if (!text) continue;
    // 含中文 ⇒ 已本地化
    if (/[\u4e00-\u9fa5]/.test(text)) continue;
    // 纯英文才可疑
    if (!/^[A-Za-z0-9\s\-_.]+$/.test(text)) continue;
    // 品牌名跳过
    if (BRAND_WHITELIST.has(text)) continue;
    offenders.push({ file: f.replace(SRC, ""), text });
  }
}

check("找到了 SVG <title>（至少 10 个，说明扫描有效）",
  totalTitles >= 10,
  `实测只找到 ${totalTitles} 个，可能正则或路径不对`);

check("没有未本地化的英文 <title>", offenders.length === 0,
  offenders.map(o => `${o.file}: "${o.text}"`).join("; "));

/* ── 白名单里的品牌名确实存在（防止白名单写成死代码）────────── */

const brandFile = path.join(SRC, "lib", "components", "icons", "brand.tsx");
let brandFound = 0;
if (fs.existsSync(brandFile)) {
  const bsrc = fs.readFileSync(brandFile, "utf8");
  for (const name of BRAND_WHITELIST) {
    if (bsrc.includes(`<title>${name}</title>`)) brandFound++;
  }
}
check("白名单里的品牌名确实存在于 brand.tsx（白名单不是死代码）",
  brandFound === BRAND_WHITELIST.size || brandFile === null,
  `实测命中 ${brandFound}/${BRAND_WHITELIST.size}`);

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ svg-titles  ${pass}/${total} 全过`);
  console.log("");
  console.log(`  扫描 ${totalTitles} 个 <title>，0 个未本地化。`);
  console.log(`  白名单（品牌名不译）：${[...BRAND_WHITELIST].join(" / ")}`);
  process.exit(0);
}
console.log(`  ✗ svg-titles  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
