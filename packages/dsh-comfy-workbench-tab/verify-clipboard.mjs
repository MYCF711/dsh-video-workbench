/**
 * verify-clipboard.mjs · C/V/X 剪贴板逻辑验收（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 *
 *   主人 2026-10-22：
 *     「复制粘贴为什么不是大众习惯的 c 和 v？」
 *     「d 没必要保留吧？」
 *
 *   原来只有 duplicate（Mod+D）= 原地复制一份，不经过剪贴板，
 *   也没有「粘贴到别处」—— 那是功能缺口，不只是键位不合习惯。
 *
 *   改了三件事，每件都必须验：
 *     ① 快捷键表：copy/paste/cut 存在，duplicate 已删
 *     ② 行为：copy 存快照 → paste 落到播放头 → cut 是先复制后删
 *     ③ 顺序安全：cut 必须先复制成功再删，否则失败就永久丢内容
 *
 * ── 为什么用假 editor 而不是真浏览器
 *   这几条是纯逻辑（快照构造 / 偏移计算 / 插入参数），
 *   与 DOM 无关。用假 editor 能把「插入了什么」精确断言出来，
 *   而真浏览器里只能看到「元素变多了」，看不出参数对不对。
 *   ★ 真实链路由 verify-editor-console.mjs 的源码断言 + 真机点验覆盖。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src", "editor");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const norm = (s) => s.replace(/\r\n/g, "\n");
const code = (s) => norm(stripComments(s));

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); return; }
  fails.push({ name, detail });
  console.log(`  ❌ ${name}${detail ? "\n      " + detail : ""}`);
};

/* ══ ① 快捷键表 ══════════════════════════════════════════════════════ */
console.log("\n① 快捷键表（大众习惯的 C/V）");

const shortcuts = code(read("shortcuts.js"));

check("copy 存在且默认 Mod+C",
  /id:\s*"copy"[\s\S]{0,120}default:\s*"Mod\+C"/.test(shortcuts));

check("paste 存在且默认 Mod+V",
  /id:\s*"paste"[\s\S]{0,120}default:\s*"Mod\+V"/.test(shortcuts));

check("cut 存在且默认 Mod+X",
  /id:\s*"cut"[\s\S]{0,120}default:\s*"Mod\+X"/.test(shortcuts));

check("duplicate 已从快捷键表删除",
  !/id:\s*"duplicate"/.test(shortcuts),
  "主人：「d 没必要保留吧？」");

/* ══ ② 工具栏 ════════════════════════════════════════════════════════ */
console.log("\n② 工具栏");

const toolbar = code(read("EditorToolbar.js"));

check("常驻「复制」按钮已是 copy（不是 duplicate）",
  /id:\s*"copy"[\s\S]{0,100}label:\s*"复制"/.test(toolbar) &&
  !/id:\s*"duplicate"/.test(toolbar));

check("粘贴 / 剪切 在「···」菜单里",
  /id:\s*"paste"/.test(toolbar) && /id:\s*"cut"/.test(toolbar),
  "常驻位只有 6 个，粘贴有快捷键不占位");

check("canCopy / canCut / canPaste 三个状态字段都有",
  /canCopy:/.test(code(read("editorHost.js"))) &&
  /canCut:/.test(code(read("editorHost.js"))) &&
  /canPaste:/.test(code(read("editorHost.js"))));

/* ══ ③ 剪贴板实现 ════════════════════════════════════════════════════ */
console.log("\n③ 剪贴板实现");

const clipRaw = read("clipboard.js");
const clip = code(clipRaw);

check("copy 按起点排序后算相对偏移（保持间隔）",
  /sort\(\(a,\s*b\)\s*=>\s*a\.startTime\s*-\s*b\.startTime\)/.test(clip) &&
  /offset:\s*p\.startTime\s*-\s*base/.test(clip),
  "选中相隔 2 秒的片段，粘出来也该相隔 2 秒");

/**
 * ★★ 这条原本写成 `注释里有说明 || 代码里没 id: el.id`，
 *   变异测试（往快照里塞 id: el.id）仍然通过 —— 因为注释那句始终为真，
 *   把代码那条掩护掉了。**假通过的断言比没有断言更危险。**
 *   ⇒ 只认代码。
 */
check("copy 的快照里不带原 id（否则粘贴会撞 id）",
  !/id:\s*el\.id/.test(clip),
  "快照必须剥离原 id，粘贴时生成新的");

check("★ cut 先复制、成功后才删除",
  (() => {
    const m = clip.match(/export function cutSelection[\s\S]{0,600}?\n\}/);
    if (!m) return false;
    const body = m[0];
    const iCopy = body.indexOf("copySelection(editor)");
    const iDel = body.indexOf("deleteElements");
    return iCopy >= 0 && iDel > iCopy;
  })(),
  "先删再复制：复制失败就永久丢内容");

check("paste 落点是播放头",
  /getCurrentTime/.test(clip) && /playhead/.test(clip));

check("paste 保持 offset（不是全部落在同一时刻）",
  /base\s*\+\s*\(it\.offset/.test(clip));

check("AudioElement 粘贴后仍带 sourceType",
  /type === "audio"[\s\S]{0,120}sourceType/.test(clip),
  "联合类型不带 sourceType 会导致导出无音频流（踩坑 6.39 ⑥）");

check("insertElement 用了 placement mode auto",
  /placement:\s*\{\s*mode:\s*"auto"/.test(clip),
  "冲突交给 ArtCraft 的放置规则，不自己解");

check("粘贴全失败时抛错（不静默）",
  /ok === 0[\s\S]{0,80}throw/.test(clip),
  "「按了没反应」比「报错」更难查");

/**
 * ★★ 2026-10-22 实测发现的真 bug，必须锁住：
 *
 *   insertElement 的 placement 用 strategy: { type: "firstAvailable" }，
 *   它是【从轨道起点找空位】，不吃 element.startTime。
 *   实测：传 600000（5 秒），插入后读回来是 0。
 *   ⇒ 必须在插入后显式 updateElements 改回目标时间。
 */
check("粘贴后显式改回 startTime（insertElement 不吃它）",
  /updateElements\(\{[\s\S]{0,200}startTime/.test(clip),
  "实测传 5 秒进去、落在 0 秒 —— firstAvailable 从轨道起点找空位");

check("定位失败要留 warn（不静默）",
  /粘贴后定位失败/.test(clipRaw));

/* ══ ④ 滚动条滚轮缩放（本轮同时修的） ════════════════════════════════ */
console.log("\n④ 滚动条滚轮缩放（容错 + 不误抢）");

const zoom = code(read("timelineZoomGestures.js"));

check("容错不再写死 8px，改为现场量 barW/barH",
  /r\.width - el\.clientWidth/.test(zoom) && /r\.height - el\.clientHeight/.test(zoom),
  "实测物理占位 10px，写死 8 会有 2px 死角 ⇒「偶尔脱离就失效」");

check("右下角交汇格不缩放（返回 null）",
  /if \(nearRight && nearBottom\) return null/.test(zoom),
  "原来「一律优先横向」⇒ 纵向条上差几像素就缩放错方向");

check("用 stopImmediatePropagation 掐断 ArtCraft 的监听",
  /stopImmediatePropagation/.test(zoom),
  "ArtCraft 在 timelineRef 上有 capture 监听，会抢走所有滚轮");

check("监听挂在 document（最顶层祖先）",
  /document\.addEventListener\("wheel"/.test(zoom),
  "挂在容器上会被祖先的 capture 抢先");

check("卸载时从 document 摘监听",
  /document\.removeEventListener\("wheel"/.test(zoom));

/* ══ 汇总 ════════════════════════════════════════════════════════════ */
console.log("");
const total = pass + fails.length;
if (fails.length === 0) {
  console.log(`  ✅ 全部通过：${pass} / ${total}`);
  process.exit(0);
}
console.log(`  ❌ ${fails.length} 项失败，通过 ${pass} / ${total}`);
for (const f of fails) console.log(`     · ${f.name}`);
process.exit(1);
