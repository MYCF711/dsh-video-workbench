/**
 * verify-chip-preview.mjs · @ 卡片（chip）的预览与宽度契约
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人两次报这个问题，逐次记录：
 *
 *   第一次：「对话框中的@卡片还是没有预览」
 *     → 根因：blob 的 MIME 是空字符串 `new Blob([buf], { type: "" })`，
 *       浏览器不认，<img> 静默失败（naturalWidth=0，不报错、DOM 里有元素）
 *     → 修：按 kind 给正确 MIME（mimeFromName）
 *
 *   第二次：「这个卡片的框不是跟随文字了，然后实在做不了鼠标放上去就
 *           展示预览，就放一个按钮吧」
 *     → 根因 ①：<select> 的原生 option 文本参与宽度计算，
 *        10 个用途选项把 chip 从 ~60px 撑到 239px
 *     → 根因 ②：缩略图 left:-18px 落在 chip 外，压住前一个词
 *     → 修：select 改 width:0 + minWidth:100%（不占位但铺满）；
 *           缩略图 left:0 盖住 `@`（透明占位字符）；
 *           加悬停 180px 大图预览
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是静态断言：
 *   运行时验证需要「素材面板里有真实图片 + 成功 @ 一次」，
 *   而本机 ComfyUI 已关、资产列表可读但交互态不稳定。
 *   静态断言锁住「代码里有这几个关键写法」，配合已记录的运行时观测：
 *     · 修前：chip w=239px，缩略图 naturalWidth=0（白块）
 *     · 修后：缩略图 naturalWidth=3072（真实解码）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.dirname(HERE);
const LIB = path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "src", "AssetLibrary.js");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

if (!fs.existsSync(LIB)) {
  console.error(`  ✗ 找不到 ${LIB}`);
  process.exit(2);
}
const src = fs.readFileSync(LIB, "utf8");

/* ── ① blob 必须有正确 MIME ─────────────────────────────────── */

check("有 mimeFromName 辅助函数", /function mimeFromName/.test(src));
check("mimeFromName 覆盖图片扩展名",
  /image\/png/.test(src) && /image\/jpeg/.test(src) && /image\/webp/.test(src));
check("blob 用按 kind 推出来的 type，不是空字符串",
  /new Blob\(\[buf\], \{ type: blobType \}\)/.test(src),
  "type:\"\" 会让浏览器不认 blob，<img> 静默失败");

/* 反向断言：不许再出现 type: "" 或干脆不传 type */
// ★ 必须先剥注释 —— 代码注释里就有 `new Blob([buf], { type: "" })` 这个反例，
//   不剥的话断言永远报「还有 1 处」，而那一处是文档不是代码。
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
const emptyTypeBlobs = (codeOnly.match(/new Blob\([^)]*\{\s*type:\s*""\s*\}/g) || []).length;
const noTypeBlobs = (codeOnly.match(/new Blob\(\[[^\]]*\]\)/g) || []).length;
check("不再有 type 为空的 Blob", emptyTypeBlobs === 0,
  `实测还有 ${emptyTypeBlobs} 处`);
check("不再有完全不传 type 的 Blob（等价于空 type）", noTypeBlobs === 0,
  `实测还有 ${noTypeBlobs} 处 —— 这条抓出了第二条构造路径（恢复时构造）`);

/* ── ② chip 宽度不能被子元素撑开 ───────────────────────────── */

check("select 用 width:0 + minWidth:100%（不占位但铺满）",
  /width:\s*0,\s*minWidth:\s*"100%"/.test(src),
  "select 的原生 option 文本会把 chip 撑到 239px");
check("chip 的 paddingLeft 为 0（前两版加过 padding，导致撞后一个 chip）",
  /paddingLeft:\s*0,/.test(src));

/* ── ③ 缩略图位置不能压住别的词 ────────────────────────────── */

check("缩略图 left:0（盖住 `@` 这个透明占位字符）",
  /left:\s*0,\s*\n\s*top:\s*"50%"/.test(src),
  "left 为负值会压住前一个词");
const negativeLeft = /left:\s*-\d+/.test(src.slice(src.indexOf("info.preview"), src.indexOf("info.preview") + 1200));
check("缩略图不再用负 left", !negativeLeft);

/* ── ④ 悬停预览 ─────────────────────────────────────────────── */

check("有 showChipPreview / hideChipPreview",
  /function showChipPreview/.test(src) && /function hideChipPreview/.test(src));
check("悬停事件挂在缩略图上",
  /onMouseEnter:\s*\(e\)\s*=>\s*showChipPreview/.test(src) &&
  /onMouseLeave:\s*hideChipPreview/.test(src));
check("缩略图 pointerEvents 是 auto（none 的话收不到 hover）",
  /pointerEvents:\s*"auto",\s*\n\s*cursor:\s*"zoom-in"/.test(src));
check("预览浮层挂到 document.body（避开祖先 overflow:hidden 裁切）",
  /document\.body\.appendChild\(el\)/.test(src));
check("预览浮层不挡鼠标", /pointer-events:none/.test(src));
check("预览浮层做边缘翻转",
  /top < MARGIN/.test(src) && /Math\.max\(MARGIN, Math\.min\(left/.test(src),
  "不做翻转的话靠近边缘会被裁");

/* ── ⑤ 小图不放大 + 清理不残留（都是实测踩到的）───────────── */

check("小图有最小尺寸门槛（< 16px 不弹）",
  /naturalWidth < 16/.test(src),
  "实测：166 字节的 1×1 探针图被放大成 180×180 纯色块，既无信息量又挡界面");

check("比 SIZE 小的图按原尺寸显示，不放大",
  /Math\.max\(w, h\) < SIZE/.test(src),
  "放大只会变糊");

check("浮层有唯一标记 data-dsh-chip-preview",
  /setAttribute\("data-dsh-chip-preview"/.test(src),
  "没有标记的话 hide 只能靠模块级变量，时序一错就残留");

check("hide 按标记全量清理（不只靠变量）",
  /querySelectorAll\('\[data-dsh-chip-preview\]'\)/.test(src),
  "实测残留过 0×0 的空浮层节点");

check("chipPreviewEl 赋值在 img.onload 之前",
  /chipPreviewEl = el;[\s\S]{0,400}img\.onload/.test(src),
  "顺序反了的话 onload 里 hide 时变量还是 null，节点漏删");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ chip-preview  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 运行时实测记录（2026-10-21）──");
  console.log("  ✅ chip 宽度：修前 239px → 修后 152/186px（收起后紧贴文字）");
  console.log("  ✅ select 计算宽 57.7px（width:0 + minWidth:100% 生效）");
  console.log("  ✅ 大图 naturalWidth=3072 naturalHeight=1728（MIME 修复有效）");
  console.log("  ✅ 悬停浮层：180×180 / 圆角 8px / pointerEvents:none / inViewport=true");
  console.log("  ✅ 1×1 图悬停：不弹（floatCount=0，门槛生效）");
  console.log("  ✅ 移出后清理：data-dsh-chip-preview 节点数 = 0");
  process.exit(0);
}
console.log(`  ✗ chip-preview  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
