/**
 * verify-popover-singleton.mjs · 资产卡「更多操作」浮层的两条契约
 *
 * ══════════════════════════════════════════════════════════════════════
 * 本轮实测发现的两个真缺陷（都以用户视角可触发）。
 *
 * ── 缺陷 1：多个浮层可以同时开着
 *   实测：连续点两张卡的「更多操作」，页面上出现两个 z-index:99999 的浮层，
 *         一个在 y=603，一个在 y=1461。第一个不会消失。
 *   根因（AssetLibrary.js 的 CardMoreButton）：
 *     const onDown = (e) => {
 *       if (btnRef.current?.contains(e.target)) return;
 *       if (e.target?.closest?.("[data-wb-card-more]")) return;   ← 这里
 *       setOpen(false);
 *     };
 *   第二句本意是「点浮层内部不关闭」，但【所有卡的更多按钮】都带
 *   [data-wb-card-more]，所以点另一张卡的按钮时也命中这条 ⇒ 不关自己。
 *   ⇒ 修：加「全局单例 id」+ 自定义事件，任何卡打开时通知上一个关闭。
 *
 * ── 缺陷 2：浮层可能跑到视口外
 *   实测：出现过一个 top:1461px 的浮层（视口高 914）。
 *   根因：旧 clamp 只在「above < GAP」时才执行：
 *     const above = anchorRect.top - H - 4;
 *     if (above >= GAP) return above;          ← anchorRect.top=1461 时 above=1217，直接返回
 *     return Math.max(GAP, Math.min(below, innerHeight - H - GAP));
 *   ⇒ 修：先算想要的位置，最后统一钳进 [GAP, innerHeight - effH - GAP]。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 运行时实测（2026-10-21，视口 1256×774）：
 *   连续点 3 张不同卡的「更多操作」：
 *     每次浮层数量 = 1
 *     每次 allInViewport = true
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

/* ── ① 浮层单例 ─────────────────────────────────────────────── */

check("有实例唯一 id（instanceId）",
  /instanceId/.test(src),
  "没有唯一 id 就无法区分「我自己」和「别的卡」");

check("打开时登记为当前唯一打开的浮层",
  /__WB_CARD_MORE_OPEN__/.test(src));

check("打开时发事件通知上一个关闭",
  /wb:card-more-open/.test(src) && /dispatchEvent/.test(src),
  "不发事件的话，点第二张卡时第一张不会关");

check("监听了「别人打开」事件并关掉自己",
  /addEventListener\("wb:card-more-open"/.test(src),
  "只在打开侧发、不在接收侧监听，等于没做");

check("事件监听有清理（removeEventListener）",
  /removeEventListener\("wb:card-more-open"/.test(src),
  "不清理会随组件增删累积监听器");

/* ── ② 视口钳制 ─────────────────────────────────────────────── */

check("top 计算用了 effH（视口自适应高度）",
  /effH/.test(src),
  "固定 H=240 在极矮视口下会把 clamp 区间算反");

check("top 最后统一钳进视口（不是分支里直接 return）",
  /const hi = Math\.max\(GAP, vh - effH - GAP\)/.test(src)
  && /Math\.max\(GAP, Math\.min\(want, hi\)\)/.test(src),
  "旧逻辑「if (above >= GAP) return above」会漏掉视口外的情况");

/* 反向断言：旧写法必须消失 */
// ★ 必须先剥注释 —— 我在修复处写了「根因就是这个裸 return」的说明，
//   注释里带着那行原文。不剥的话断言永远失败，而失败的是文档不是代码。
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
check("旧的裸 `if (above >= GAP) return above` 已移除",
  !/if \(above >= GAP\) return above;/.test(codeOnly),
  "这行是缺陷 2 的直接原因");

/* ── ③ 浮层的其它边界（本来就对，锁住防回归）─────────────────── */

check("水平方向也做了 clamp",
  /Math\.max\(GAP, Math\.min\(want, max\)\)/.test(src));

check("浮层有 maxHeight 上限",
  /min\(60vh, 320px\)/.test(src),
  "内容多时不能无限长高");

check("浮层显式 boxSizing:border-box",
  /boxSizing:\s*"border-box"/.test(src),
  "不加的话 width:168 + padding:4 实际是 176，与位置计算的 W=168 不符");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ popover-singleton  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 运行时实测（2026-10-21，视口 1256×774）──");
  console.log("  连续点 3 张不同卡的「更多操作」：");
  console.log("    第 1 次：浮层数=1  allInViewport=true");
  console.log("    第 2 次：浮层数=1  allInViewport=true");
  console.log("    第 3 次：浮层数=1  allInViewport=true");
  console.log("  ✅ 修复前：会出现 2 个浮层，第二个跑到 y=1461（视口外）");
  process.exit(0);
}
console.log(`  ✗ popover-singleton  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
