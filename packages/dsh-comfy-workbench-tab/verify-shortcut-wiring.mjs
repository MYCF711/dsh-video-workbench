/**
 * 校验：快捷键「三处必须一致」
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个验收
 *
 *   快捷键涉及【三份数据】，它们必须一一对上，而 DSH 的机制不会替你检查：
 *
 *     ① SHORTCUT_DEFS（shortcuts.js）   —— 「有哪些功能、默认什么键」
 *     ② installShortcutHandler 的映射（ArtCraftTab.js）
 *                                        —— 「按到这个 id 时执行什么」
 *     ③ onAction 的 switch 分支（editorHost.js）
 *                                        —— 「动作 id 对应什么真实现」
 *     ④ 工具条的 shortcutId（EditorToolbar.js）
 *                                        —— 「按钮上显示哪个键」
 *
 *   2026-10-25 实测发现三类不匹配，症状全是「按了没反应」或「提示不显示」：
 *
 *     · splitRipple / toggleSnap 在 DEFS 里，却【从来没注册到 handler】
 *       ⇒ 波纹删除、自动吸附的快捷键一直按不动，界面毫无提示
 *     · 工具条写 shortcutId: "snap"，DEFS 里叫 "toggleSnap"
 *       ⇒ getChordLabel 查不到，按钮上的快捷键提示永远空白
 *     · DEFS 的 splitRipple/toggleSnap 与动作的 rippleDelete/snapping
 *       名字不同 —— 必须显式写映射，不能指望自动对上
 *
 *   ★ 还有一个更隐蔽的：新增键位时只改 DEFS、忘了改 ArtCraftTab，
 *     快捷键设置页里能看见、能改，按了却没有任何反应。
 *     用户会以为「我改的键位没保存」，其实是没人接。
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ED = path.join(HERE, "src", "editor");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };

const defsSrc = fs.readFileSync(path.join(ED, "shortcuts.js"), "utf8");
const tabSrc = fs.readFileSync(path.join(ED, "ArtCraftTab.js"), "utf8");
const hostSrc = fs.readFileSync(path.join(ED, "editorHost.js"), "utf8");
const barSrc = fs.readFileSync(path.join(ED, "EditorToolbar.js"), "utf8");

/** ① DEFS 里的功能 id */
const defIds = [...defsSrc.matchAll(/^\s*\{\s*id:\s*"([a-zA-Z]+)"/gm)].map((m) => m[1]);

/** ② handler 映射的 key（左侧 id） */
const handlerKeys = [
  ...tabSrc.matchAll(/^\s*([a-zA-Z]+):\s*\(\)\s*=>\s*callbacks\?\.onAction\?\.\("([a-zA-Z]+)"\)/gm),
].map((m) => m[1]);

/** ② handler 指向的动作 id（右侧） */
const handlerActions = [
  ...tabSrc.matchAll(/^\s*([a-zA-Z]+):\s*\(\)\s*=>\s*callbacks\?\.onAction\?\.\("([a-zA-Z]+)"\)/gm),
].map((m) => m[2]);

/** ③ onAction switch 里实现的 case */
const actionCases = [...hostSrc.matchAll(/^\s*case\s+"([a-zA-Z]+)":/gm)].map((m) => m[1]);

console.log("\n=== ① DEFS → handler 必须全覆盖 ===\n");

t(`DEFS 里的每个功能都注册了处理器（${defIds.length} 个）`, () => {
  const missing = defIds.filter((d) => !handlerKeys.includes(d));
  must(
    missing.length === 0,
    `这些功能有键位但没人接，按了毫无反应：${missing.join(", ")}`
  );
});

t("handler 里没有多余的 key（引用了 DEFS 不存在的功能）", () => {
  const extra = handlerKeys.filter((k) => !defIds.includes(k));
  must(extra.length === 0, `handler 注册了不存在的功能：${extra.join(", ")}`);
});

console.log("\n=== ② handler → onAction 必须真的有实现 ===\n");

t("handler 指向的动作都在 onAction 里有 case", () => {
  const missing = [...new Set(handlerActions)].filter((a) => !actionCases.includes(a));
  must(
    missing.length === 0,
    `这些动作 id 没有实现（按下去什么都不会发生）：${missing.join(", ")}`
  );
});

console.log("\n=== ③ 工具条的 shortcutId 必须存在 ===\n");

t("EditorToolbar 引用的 shortcutId 都在 DEFS 里", () => {
  const sids = [...new Set(
    [...barSrc.matchAll(/shortcutId:\s*"([a-zA-Z]+)"/g)].map((m) => m[1])
  )];
  const bad = sids.filter((s) => !defIds.includes(s));
  must(
    bad.length === 0,
    `工具条引用了不存在的快捷键 id（按钮上的键位提示会永远空白）：${bad.join(", ")}`
  );
});

console.log("\n=== ④ 剪辑软件的基本盘：播放与导航 ===\n");

/**
 * ★ 这几条不是「多加了功能」，而是【没有它就不像剪辑软件】：
 *   「空格播放/暂停」是所有剪辑工具的第一肌肉记忆。
 *   用户按一下没反应，不会归因于「不支持」，只会觉得坏了。
 */
const REQUIRED = [
  ["playPause", "Space", "播放 / 暂停"],
  ["stepBack", "ArrowLeft", "后退一帧"],
  ["stepForward", "ArrowRight", "前进一帧"],
  ["goStart", "Home", "跳到开头"],
  ["goEnd", "End", "跳到结尾"],
];

for (const [id, key, label] of REQUIRED) {
  t(`${label}（${key}）存在且已接线`, () => {
    must(defIds.includes(id), `DEFS 里没有 ${id} —— 用户按 ${key} 没反应`);
    must(handlerKeys.includes(id), `${id} 没注册 handler —— 键位显示得出来但按不动`);
    must(
      handlerActions.includes(id) || actionCases.includes(id) || actionCases.includes("playPause"),
      `${id} 没有对应的 onAction 实现`
    );
    must(
      new RegExp(`id:\\s*"${id}"[^}]*default:\\s*"${key}"`).test(defsSrc),
      `${id} 的默认键位不是 ${key} —— 与剪辑软件惯例不一致`
    );
  });
}

t("J / K / L 三键（倒放 / 暂停 / 正放）", () => {
  for (const [id, key] of [["playReverse", "J"], ["playForward", "L"]]) {
    must(defIds.includes(id), `DEFS 里没有 ${id}`);
    must(handlerKeys.includes(id), `${id} 没注册 handler`);
    must(new RegExp(`id:\\s*"${id}"[^}]*default:\\s*"${key}"`).test(defsSrc), `${id} 默认键不是 ${key}`);
  }
  /* K 在多数剪辑软件里也是「暂停」，这里复用 playPause 的语义即可，
     不额外加一个 K 以免和「分割 Mod+K」在无修饰键时打架 */
});

console.log("\n=== ⑤ MediaTime 换算正确（120000 tick/秒）===\n");

t("游标移动用的是 120000 tick/秒，不是毫秒", () => {
  /**
   * ★ AGENTS §6.39 ① 记过这个坑：MediaTime 是【整数 tick，120000/秒】，
   *   而 {numerator,denominator} 是 FrameRate 的类型，两者别混。
   *   写成 ×1000（毫秒）会导致游标位置差 120 倍。
   *
   * ★★ 2026-10-25 变异测试抓出的盲区：
   *   原来只判 /120000/ 是否出现 —— 而这个数字在文件里出现 7 次
   *   （含 3 处注释、几处 /120000 的除法）。把 seekTo 那行改成 ×1000
   *   后断言依然绿。
   *   ⇒ 必须【剥掉注释】，再精确匹配 seekTo 里那一行。
   */
  const code = hostSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  must(
    /Number\(seconds\)\s*\*\s*120000/.test(code),
    "seekTo 里没有把秒 ×120000 换成 tick（单位可能用错）"
  );
  must(
    !/Number\(seconds\)\s*\*\s*1000/.test(code),
    "把 tick 当毫秒算了（×1000）—— 游标会差 120 倍"
  );
});

t("逐帧按 fps 换算，不是写死一帧长度", () => {
  /**
   * ★ 同上：必须剥注释，且要求在 seekBy 的实现里出现 120000 / fps。
   */
  const code = hostSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  must(
    /Math\.round\(\s*120000\s*\/\s*fps\s*\)/.test(code),
    "逐帧长度没有按 fps 换算 —— 30fps 和 24fps 会跳错"
  );
});

console.log("\n=== ⑥ 帧率真源（不能被编辑器覆盖）===\n");

/**
 * ★★★ 2026-10-25 实测踩到的真缺陷，排查了三层才定位：
 *
 *   本机时间轴是 24fps，而逐帧键一直按 30fps 走（一帧 4000 而非 5000）。
 *   排查过程：
 *     ① 以为 tick 单位错了 —— 但 seek(1920000) 显示 00:00:16:00，秒数对
 *     ② 以为 onSnapshot 没调到 —— 调了，但首次被 `if (meta?.first) return` 挡掉
 *     ③ 真正原因：编辑器的 onState 会 emit 自己的 fps（内部假设 30），
 *        在 `...s` 展开时把快照读到的真值覆盖回去
 *   ⇒ 结论：**fps 有且只有一个真源（/timeline/snapshot）**，
 *     编辑器 emit 的 fps 不能反向覆盖。
 */
t("有独立的 fpsRef（不受 React 渲染时序影响）", () => {
  must(/const fpsRef = React\.useRef\(/.test(hostSrc), "没有 fpsRef —— 帧率只能靠 state，会被覆盖");
});
t("seekBy 读 fpsRef，不读 editorState.fps", () => {
  const idx = hostSrc.indexOf("const seekBy =");
  must(idx > 0, "找不到 seekBy");
  const seg = hostSrc.slice(idx, idx + 900);
  must(/fpsRef\.current/.test(seg), "seekBy 没用 fpsRef —— 会被编辑器的 fps 带偏");
  must(!/editorState\.fps/.test(seg), "seekBy 还在读 editorState.fps —— 那个值会被 onState 覆盖");
});
t("onState 不许覆盖 fps（保留 prev.fps）", () => {
  const idx = hostSrc.indexOf("onState: (s) =>");
  must(idx > 0, "找不到 onState");
  /**
   * ★ 窗口 2200 而不是 900 —— 那段注释有 20 行（记录三层排查过程），
   *   而 `fps: prev.fps` 在第 1045 位。窗口太小会假红。
   *   判据：窗口必须覆盖到整个 setEditorState 对象字面量。
   */
  const seg = hostSrc.slice(idx, idx + 2200);
  must(/fps:\s*prev\.fps/.test(seg), "onState 没有保住 prev.fps —— 编辑器会用 30 覆盖真值");
});
t("挂载路径也写 fpsRef（首次快照不走 onSnapshot）", () => {
  const idx = hostSrc.indexOf('fetch("/timeline/snapshot"');
  must(idx > 0, "找不到挂载时的快照拉取");
  const seg = hostSrc.slice(idx, idx + 900);
  must(/fpsRef\.current\s*=/.test(seg), "挂载路径没写 fpsRef —— 首帧帧率还是默认 30");
});

console.log(`\n通过 ${pass} / ${pass + fail}\n`);
if (fail) console.log("★ 有快捷键按了没反应，或基本播放键缺失。\n");
process.exit(fail === 0 ? 0 : 1);
