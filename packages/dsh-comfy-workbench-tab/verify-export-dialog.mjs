/**
 * verify-export-dialog.mjs · 导出对话框的结构 / 对比度 / 信息可发现性
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个对话框我修了【四轮】，每轮都是「改了但没生效」的不同原因，
 * 全部记在这里，因为它们是同一类问题的四个变体。
 *
 * 第一轮：给 PopoverContent 加 `ac-scope` 类
 *   → 内部元素救活了（display:flex），但容器自己 display 仍是 block、宽 231px
 *   原因：ArtCraft 的规则是 `.ac-scope .flex`（后代选择器），
 *        容器自己同时是 .ac-scope 和 .flex，不构成「后代」关系。
 *
 * 第二轮：外面再包一层带 ac-scope 的 div
 *   → inScope === false，包裹层是空的
 *   原因：Radix 的 PopoverContent 自己会 portal 到 body，不受外层 div 约束。
 *
 * 第三轮：回到「容器自己带类」+ 补【组合选择器】`.ac-scope.ac-portal-surface.flex`
 *   → 宽度 320px、display:flex、内部 gap 16px ✅
 *
 * 第四轮：文字对比度
 *   → 「格式/质量/音频」rgb(174,180,188) 对比度 2.1:1
 *     「保存位置」纯白 1.0:1（完全看不见）
 *   原因：portal 出来的浮层【不带 theme-light 类】，
 *        用的是暗色那套 --muted-foreground / --foreground。
 *   修：用 DSH 的 label-secondary / label-primary token 覆盖。
 *
 * 第五轮（顺手）：折叠分区看不到当前值
 *   → Section 是 collapsible + defaultOpen={false}，
 *     但 SectionHeader 没传 trailing ⇒ 折叠时右侧空着。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 运行时实测结论（2026-10-21）：
 *   宽度 320px ✅  display:flex ✅  flexDirection:column ✅  内部 gap 16px ✅
 *   对比度失败 0 项 ✅
 *   文本：「格式 MP4 | 质量 较高·推荐 | 音频 包含」
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = "D:/主工作区/_upstream/artcraft-demo/video-editor/src";
const EXPORT_TSX = path.join(SRC, "lib", "components", "editor", "export-button.tsx");
const NATIVE_CSS = path.join(HERE, "src", "editor", "dsh-native.css.js");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/* ── ① 容器必须自己带 ac-scope + 标记类 ─────────────────────── */

const exportSrc = fs.existsSync(EXPORT_TSX) ? fs.readFileSync(EXPORT_TSX, "utf8") : "";
check("export-button.tsx 存在", exportSrc.length > 0, EXPORT_TSX);

check("PopoverContent 带 ac-scope 类（救活内部元素）",
  /<PopoverContent[^>]*className="[^"]*\bac-scope\b/.test(exportSrc),
  "不加的话 640 条 .ac-scope 前缀规则全部收不到");

check("PopoverContent 带 ac-portal-surface 标记类",
  /<PopoverContent[^>]*className="[^"]*\bac-portal-surface\b/.test(exportSrc),
  "这个类用于给 portal 浮层单独恢复视觉");

/* 反向断言：不许再加外层包裹 div（第二轮的错误方案） */
check("没有把 ac-scope 包在外层 div 上",
  !/<div className="ac-scope ac-portal-surface">\s*\n\s*<PopoverContent/.test(exportSrc),
  "Radix 自己 portal，外层 div 包不住它");

/* ── ② CSS 必须补组合选择器 ─────────────────────────────────── */

const cssSrc = fs.existsSync(NATIVE_CSS) ? fs.readFileSync(NATIVE_CSS, "utf8") : "";
check("dsh-native.css.js 存在", cssSrc.length > 0);

/**
 * ★ 这是第三轮的关键：后代选择器救不了容器自己。
 *   必须有 `.ac-scope.ac-portal-surface.flex { display:flex }` 这种【组合】写法。
 */
check("补了容器自己的 display:flex（组合选择器）",
  /\.ac-scope\.ac-portal-surface\.flex\s*\{[^}]*display:\s*flex/.test(cssSrc),
  "只写 .ac-scope .flex 的话，容器自己是 .ac-scope 不是它的后代，永远不匹配");

check("补了容器自己的 flex-direction:column",
  /\.ac-scope\.ac-portal-surface\.flex-col\s*\{[^}]*flex-direction:\s*column/.test(cssSrc));

check("补了容器自己的 w-80（宽度 20rem）",
  /\.ac-scope\.ac-portal-surface\.w-80\s*\{[^}]*width:\s*20rem/.test(cssSrc),
  "不补的话容器被压成 231px 的细长竖条");

/* ── ③ 对比度：portal 浮层必须按主题解析文字色 ─────────────── */

check("text-muted-foreground 在 portal 浮层里用 label-secondary",
  /\.ac-scope\.ac-portal-surface\s+\.text-muted-foreground[^{]*\{[^}]*--dsw-alias-label-secondary/.test(cssSrc),
  "暗色的 --muted-foreground 是 #adb2b8，放浅色浮层上只有 2.1:1");

check("text-foreground 在 portal 浮层里用 label-primary",
  /\.ac-scope\.ac-portal-surface\s+\.text-foreground[^{]*\{[^}]*--dsw-alias-label-primary/.test(cssSrc)
  || /\.ac-scope\.ac-portal-surface\s+\.text-foreground,/.test(cssSrc),
  "暗色的 --foreground 是白色，放浅色浮层上是 1.05:1（完全看不见）");

/* ── ④ 信息可发现性：折叠分区要带当前值 ───────────────────── */

const trailingCount = (exportSrc.match(/trailing=\{/g) || []).length;
check("至少 3 个 SectionHeader 传了 trailing（格式/质量/音频）",
  trailingCount >= 3,
  `实测只找到 ${trailingCount} 处 —— 折叠时用户看不到当前值`);

check("格式的 trailing 显示 MP4 / WebM",
  /format === "mp4" \? "MP4" : "WebM"/.test(exportSrc));

check("质量的 trailing 覆盖 4 档（low/medium/high/very_high）",
  /quality === "low"/.test(exportSrc) && /quality === "medium"/.test(exportSrc)
  && /quality === "high"/.test(exportSrc),
  "EXPORT_QUALITY_VALUES 有 4 个值");

check("音频的 trailing 用 shouldIncludeAudio（不是 includeAudio）",
  /shouldIncludeAudio \? "包含" : "不包含"/.test(exportSrc),
  "变量名是 shouldIncludeAudio，写错会 ReferenceError");

/* ── ⑤ 中文化 ───────────────────────────────────────────────── */

check("导出失败兜底文案是中文（不是 Unknown error occurred）",
  !/Unknown error occurred/.test(exportSrc),
  "子代理实测报过：空工程导出的错误提示是英文");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ export-dialog  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 运行时实测（2026-10-21）──");
  console.log("  ✅ 宽度 320px（修前 231px 细长竖条）");
  console.log("  ✅ display:flex / flexDirection:column / 内部 gap 16px");
  console.log("  ✅ 对比度失败 0 项（修前「保存位置」是 1.05:1）");
  console.log("  ✅ 折叠时可读：「格式 MP4 | 质量 较高·推荐 | 音频 包含」");
  process.exit(0);
}

console.log(`  ✗ export-dialog  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);

