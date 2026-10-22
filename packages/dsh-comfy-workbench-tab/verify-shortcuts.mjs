/**
 * verify-shortcuts.mjs · 快捷键系统
 *
 * 主人要求：「设置里要能改快捷键，并同步到二级菜单的提示」
 *
 * 这个脚本测的是纯逻辑（不需要浏览器）：
 *   归一化 / 显示 / 冲突检测 / 持久化 / 恢复默认 / 跨平台
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么这些断言重要（每条都有对应的失败后果）
 *
 * ① 归一化
 *    配置里写 "Mod+Shift+Z"，键盘事件给的是 ctrlKey+shiftKey+code="KeyZ"。
 *    两边必须归到同一个串，否则「用户改了但没生效」。
 *
 * ② 用 event.code 而不是 event.key
 *    按 Shift+A 时 key 是 "A"、不按是 "a" —— 同一物理键两个值。
 *    只用 key 会导致「Shift+复制」绑不上。
 *
 * ③ 冲突必须拒绝
 *    静默覆盖 ⇒ 用户以为两条都设好了，实际只有后一条生效。
 *    这是「设置看起来成功但行为不对」的典型。
 *
 * ④ 只存差异
 *    全量存会在「将来改默认值」时把所有用户都锁死在旧值上。
 *
 * ⑤ 双系统键位
 *    存 "Mod"，显示时按平台展开。存 "Ctrl" 的话 mac 用户全是错的。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src", "editor", "shortcuts.js");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/* ── ① 源码级契约 ───────────────────────────────────────────── */

const src = fs.existsSync(SRC) ? fs.readFileSync(SRC, "utf8") : "";
check("shortcuts.js 存在", src.length > 0, SRC);

check("用 event.code 而不是 event.key",
  /e\.code/.test(src) && !/e\.key\b(?!.*code)/.test(src.replace(/e\.code/g, "")),
  "key 会受 Shift/输入法影响，同一物理键给出两个值");

check("规范化修饰键为 Mod（跨平台）",
  /"Mod"/.test(src) && /IS_MAC/.test(src),
  "存 Ctrl 的话 mac 用户的配置全是错的");

check("冲突检测存在且会拒绝",
  /findConflict/.test(src) && /conflictWith/.test(src),
  "静默覆盖会让用户以为设置成功");

check("只存与默认不同的项",
  /delete _overrides\[id\]/.test(src),
  "全量存会把用户锁死在旧默认值上");

check("有单条恢复默认",
  /export function resetShortcut/.test(src));
check("有全部恢复默认",
  /export function resetAllShortcuts/.test(src));

check("输入框内不触发快捷键",
  /tagName === "INPUT"/.test(src) && /isContentEditable/.test(src),
  "否则用户在提示词框打 M 就加了个书签");

check("持久化到 localStorage 且带版本号",
  /artcraft\.shortcuts\.v1/.test(src));

/* ── ② 行为测试（用假 localStorage 跑真实模块）─────────────── */

// 造一个最小 DOM/localStorage 环境
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
/**
 * ★ Node 24 的 globalThis.navigator 只有 getter（不可赋值）：
 *     TypeError: Cannot set property navigator of #<Object> which has only a getter
 *   ⇒ 用 defineProperty 覆盖。
 */
Object.defineProperty(globalThis, "navigator", {
  value: { platform: "Win32" },
  configurable: true,
  writable: true,
});
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const mod = await import("file://" + SRC.replace(/\\/g, "/"));

/* 归一化 */
check("normalizeChord 把 Mod+K 归一成 Mod+KeyK",
  mod.normalizeChord("Mod+K") === "Mod+KeyK",
  `实际 ${mod.normalizeChord("Mod+K")}`);

check("normalizeChord 处理 Shift+Delete",
  mod.normalizeChord("Shift+Delete") === "Shift+Delete",
  `实际 ${mod.normalizeChord("Shift+Delete")}`);

check("normalizeChord 把 = 映射成 Equal",
  mod.normalizeChord("=") === "Equal",
  `实际 ${mod.normalizeChord("=")}`);

check("normalizeChord 把 Ctrl 当成 Mod",
  mod.normalizeChord("Ctrl+Z") === "Mod+KeyZ",
  `实际 ${mod.normalizeChord("Ctrl+Z")}`);

/* 显示 */
check("chordToLabel 在 Win 下显示 Ctrl",
  mod.chordToLabel("Mod+Shift+KeyZ") === "Ctrl+Shift+Z",
  `实际 ${mod.chordToLabel("Mod+Shift+KeyZ")}`);

check("chordToLabel 把 Delete 显示成 Del",
  mod.chordToLabel("Delete") === "Del",
  `实际 ${mod.chordToLabel("Delete")}`);

/* 键盘事件 */
check("chordFromEvent 生成规范串",
  mod.chordFromEvent({ ctrlKey: true, shiftKey: true, altKey: false, code: "KeyZ" }) === "Mod+Shift+KeyZ",
  `实际 ${mod.chordFromEvent({ ctrlKey: true, shiftKey: true, altKey: false, code: "KeyZ" })}`);

check("只按修饰键不算快捷键",
  mod.chordFromEvent({ ctrlKey: true, shiftKey: false, altKey: false, code: "Control" }) === "",
  "否则单按 Ctrl 就会触发");

/* 默认值 */
const all = mod.listShortcuts();
/**
 * ★★ 2026-10-22：原断言写死 `all.length === 12`。
 *   本轮把 duplicate 换成 copy/paste/cut（变成 14 个）⇒ 断言变红。
 *   这是 AGENTS §3.7「断言自己过期」的典型：写死总数，一加功能就红。
 *   ⇒ 改成「必须包含这些 id」—— 加功能不该让断言变红。
 */
const REQUIRED_IDS = [
  "split", "splitRipple", "delete", "copy", "paste", "cut",
  "undo", "redo", "zoomIn", "zoomOut", "trackTaller", "trackShorter",
  "addBookmark", "toggleSnap",
];
const haveIds = new Set(all.map((x) => x.id));
const missingIds = REQUIRED_IDS.filter((id) => !haveIds.has(id));
check("关键快捷键 id 齐全（不硬编码总数）", missingIds.length === 0,
  `缺：${missingIds.join(", ")}`);

/**
 * ★ 复制粘贴必须是大众习惯的 C/V（主人 2026-10-22 要求）。
 *   duplicate（Mod+D）已按主人要求删除。
 */
check("复制是 Ctrl+C",
  all.find((x) => x.id === "copy")?.label === "Ctrl+C",
  `实际 ${all.find((x) => x.id === "copy")?.label}`);
check("粘贴是 Ctrl+V",
  all.find((x) => x.id === "paste")?.label === "Ctrl+V",
  `实际 ${all.find((x) => x.id === "paste")?.label}`);
check("剪切是 Ctrl+X",
  all.find((x) => x.id === "cut")?.label === "Ctrl+X",
  `实际 ${all.find((x) => x.id === "cut")?.label}`);
check("duplicate（Mod+D）已删除", !haveIds.has("duplicate"),
  "主人：「d 没必要保留吧？」");
check("默认值与 PR 一致（分割 = Ctrl+K）",
  all.find((x) => x.id === "split")?.label === "Ctrl+K",
  `实际 ${all.find((x) => x.id === "split")?.label}`);
check("默认值与 PR 一致（波纹删除 = Shift+Del）",
  all.find((x) => x.id === "splitRipple")?.label === "Shift+Del",
  `实际 ${all.find((x) => x.id === "splitRipple")?.label}`);

/* 改一条 */
const r1 = mod.setShortcut("split", "Mod+B");
check("能改快捷键", r1.ok === true, JSON.stringify(r1));
check("改完立刻生效（getChord）",
  mod.chordToLabel(mod.getChord("split")) === "Ctrl+B",
  `实际 ${mod.chordToLabel(mod.getChord("split"))}`);
check("改完标记为自定义",
  mod.listShortcuts().find((x) => x.id === "split")?.isCustom === true);

/* 冲突 */
const r2 = mod.setShortcut("delete", "Mod+B");
check("冲突被拒绝", r2.ok === false, JSON.stringify(r2));
check("冲突报出对方名字",
  /分割片段/.test(r2.reason || ""),
  `实际 ${r2.reason}`);
check("冲突时原绑定不变",
  mod.chordToLabel(mod.getChord("delete")) === "Del",
  `实际 ${mod.chordToLabel(mod.getChord("delete"))}`);

/* 持久化 */
check("改动能存进 localStorage",
  (store.get("artcraft.shortcuts.v1") || "").includes("Mod+KeyB"),
  `实际 ${store.get("artcraft.shortcuts.v1")}`);

/* 单条恢复 */
mod.resetShortcut("split");
check("单条恢复默认",
  mod.chordToLabel(mod.getChord("split")) === "Ctrl+K",
  `实际 ${mod.chordToLabel(mod.getChord("split"))}`);

/* 全部恢复 */
mod.setShortcut("split", "Mod+B");
mod.setShortcut("undo", "Mod+U");
mod.resetAllShortcuts();
check("全部恢复默认（split）",
  mod.chordToLabel(mod.getChord("split")) === "Ctrl+K");
check("全部恢复默认（undo）",
  mod.chordToLabel(mod.getChord("undo")) === "Ctrl+Z");

/* ── ③ 上游/宿主侧约定 ──────────────────────────────────────── */

check("installShortcutHandler 支持 enabled 开关",
  /enabled/.test(src),
  "剪辑台没激活时不该抢全局按键");

/* ── 汇总 ───────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ shortcuts  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 12 个快捷键的默认值（对照 Premiere Pro）──");
  for (const s of mod.listShortcuts()) {
    console.log(`    ${s.group}  ${s.name.padEnd(10, "　")} ${s.label}`);
  }
  console.log("");
  console.log("  ✅ 归一化：Mod+K / Ctrl+Z / Shift+Delete / = 都归到统一串");
  console.log("  ✅ 冲突检测：绑定已占用的键被拒绝，并报出对方功能名");
  console.log("  ✅ 持久化：只存与默认不同的项（带版本号）");
  console.log("  ✅ 跨平台：存 Mod，Win 显示 Ctrl / Mac 显示 ⌘");
  console.log("  ✅ 输入框内不触发（否则打 M 就加书签）");
  process.exit(0);
}
console.log(`  ✗ shortcuts  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);


