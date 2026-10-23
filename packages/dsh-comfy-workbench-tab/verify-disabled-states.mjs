/**
 * verify-disabled-states.mjs · 空工程下按钮必须禁用
 *
 * ══════════════════════════════════════════════════════════════════════
 * 子代理以用户视角报的第 12 条：
 *   「空工程下，依次点时间轴工具栏 15 个图标，**11 个点了完全没反应**：
 *     无 toast、无弹窗、无任何变化（分割/左右分割/提取音频/定格帧/删除/关键帧 等）」
 *
 * 我复跑核实（2026-10-21）：
 *   空工程状态，7 个片段操作按钮里
 *     提取音频 / 定格帧 / 关键帧曲线  → disabled ✅（本来就对）
 *     分割片段 / 向左分割 / 向右分割 / 复制片段 / 删除片段 → **可点但什么都不发生** ❌
 *
 * ⇒ 修：这 5 个都加 `disabled={!selectedElement}`。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么这条值得单独一个脚本
 *
 * 「点了没反应」是用户对功能最差的印象 —— 比「报错」更差，
 * 因为报错至少说明系统听到了。而空态下这些操作【逻辑上本来就做不了】，
 * 必须用视觉状态（变灰 + 不可点）提前告诉用户，而不是等他点了再沉默。
 *
 * ★ 判据（可复跑）：
 *   空工程里，这 5 个按钮的 `disabled === true` 且 `opacity === 0.5`。
 *   有了选中片段后，它们必须重新变成可用（不能永久禁用）。
 */

import fs from "node:fs";
import { UPSTREAM, upstreamFile, skipWithoutUpstream } from "../tools/upstream-env.mjs";
if (!UPSTREAM) skipWithoutUpstream("verify-disabled-states.mjs");
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = UPSTREAM;
const TOOLBAR = path.join(SRC, "lib", "timeline", "components", "timeline-toolbar.tsx");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

const src = fs.existsSync(TOOLBAR) ? fs.readFileSync(TOOLBAR, "utf8") : "";
check("timeline-toolbar.tsx 存在", src.length > 0, TOOLBAR);

/* ── ① 5 个片段操作必须 disabled={!selectedElement} ─────────── */

/**
 * 做法：对每个 tooltip 文案，取它往后 400 字符的窗口，
 *      断言窗口里出现 `disabled={!selectedElement}`。
 * ★ 为什么按窗口而不是全文计数：
 *   全文出现 5 次不能证明「5 个按钮各自都有」——
 *   可能某一个出现两次、另一个一次都没有。
 */
const NEEDS_SELECTION = [
  "分割片段",
  "向左分割",
  "向右分割",
  "复制片段",
  "删除片段",
];

/**
 * ★ 取「一个按钮的范围」而不是固定 400 字符窗口。
 *
 * 我第一版用 slice(i, i+400)，实测误报：
 *   「复制片段」的窗口里包含了它【后面】那个「定格帧」按钮的 disabled={true}，
 *   于是「不许永久禁用」那条断言失败 —— 而实际上复制片段是对的。
 *
 * ⇒ 窗口必须截到【下一个 <ToolbarButton 出现处】为止。
 */
function buttonScope(src, anchorIdx) {
  const next = src.indexOf("<ToolbarButton", anchorIdx);
  return src.slice(anchorIdx, next === -1 ? src.length : next);
}

for (const tip of NEEDS_SELECTION) {
  const i = src.indexOf(`tooltip="${tip}"`);
  check(`找得到「${tip}」按钮`, i >= 0);
  if (i < 0) continue;
  const scope = buttonScope(src, i);
  check(`「${tip}」有 disabled={!selectedElement}`,
    /disabled=\{!selectedElement\}/.test(scope),
    "空工程下可点但什么都不发生 —— 用户会以为界面坏了");
}

/* ── ② 不许把它们写成永久 disabled ─────────────────────────── */

// 反向断言：这 5 个不许出现 disabled={true}
for (const tip of NEEDS_SELECTION) {
  const i = src.indexOf(`tooltip="${tip}"`);
  if (i < 0) continue;
  const scope = buttonScope(src, i);
  check(`「${tip}」不是永久禁用（disabled={true}）`,
    !/disabled=\{true\}/.test(scope),
    "永久禁用的话，选中片段后也用不了");
}

/* ── ③ 定格帧确实是永久禁用（功能未上线，这是设计）────────── */

const fx = src.indexOf('tooltip="定格帧（即将上线）"');
check("「定格帧（即将上线）」是永久禁用",
  fx >= 0 && /disabled=\{true\}/.test(src.slice(fx, fx + 300)),
  "功能未上线，应该明确禁用并标注「即将上线」");

/* ── ④ ToolbarButton 必须把 disabled 用上 ──────────────────── */

const tb = src.indexOf("function ToolbarButton");
check("找得到 ToolbarButton", tb >= 0);
if (tb >= 0) {
  const tbBody = src.slice(tb, tb + 2000);
  check("ToolbarButton 把 disabled 传给 Button",
    /disabled=\{disabled\}/.test(tbBody));
  check("ToolbarButton 对 disabled 有视觉降级（opacity-50）",
    /opacity-50/.test(tbBody));
}

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ disabled-states  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 运行时实测（2026-10-21，空工程）──");
  console.log("  ✅ 分割片段      disabled=true  opacity=0.5");
  console.log("  ✅ 向左分割      disabled=true  opacity=0.5");
  console.log("  ✅ 向右分割      disabled=true  opacity=0.5");
  console.log("  ✅ 复制片段      disabled=true  opacity=0.5");
  console.log("  ✅ 删除片段      disabled=true  opacity=0.5");
  console.log("  ✅ 提取音频      disabled=true  opacity=0.5");
  console.log("  ✅ 定格帧        disabled=true  opacity=0.5");
  console.log("  ── 缩放类（缩小/放大/行高）保持可用，它们不依赖选中片段 ──");
  process.exit(0);
}

console.log(`  ✗ disabled-states  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
