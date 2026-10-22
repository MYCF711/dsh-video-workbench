/**
 * verify-track-order.mjs · 轨道 UI 顺序契约
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-21 定的规格：
 *   「轨道顺序应该改一下，视频2 视频1 音频1 音频2，字幕」
 *
 * 本脚本锁三件事：
 *   ① display-order.ts 的实现符合规格
 *   ② 14 处 UI 侧都调 getDisplayTracks（不再手写 [...overlay, main, ...audio]）
 *   ③ 6 处渲染/无关侧保留原写法，且带「勿改成 UI 顺序」标注
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 为什么必须写成静态断言
 *
 * 顺序改动横跨 20 处。漏一处的后果是「渲染用新顺序、命中用旧顺序」——
 * 点击位置与视觉错位，且【不报错、不崩】，只能靠人眼看出来。
 * 这是 AGENTS §6.43 的典型场景（一个字段有 N 条构造路径）。
 */

import fs from "node:fs";
import path from "node:path";

const SRC = "D:/主工作区/_upstream/artcraft-demo/video-editor/src";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

if (!fs.existsSync(SRC)) {
  console.error(`  ✗ 找不到上游源码：${SRC}`);
  process.exit(2);
}

/* ── ① display-order.ts 实现正确 ─────────────────────────────── */

const doPath = path.join(SRC, "lib", "timeline", "display-order.ts");
check("display-order.ts 存在", fs.existsSync(doPath), doPath);

if (fs.existsSync(doPath)) {
  const src = fs.readFileSync(doPath, "utf8");

  check("有 getDisplayTracks（UI 顺序）", /export function getDisplayTracks/.test(src));
  check("有 getRenderTracks（渲染顺序，显式命名避免混用）",
    /export function getRenderTracks/.test(src));

  // 取 getDisplayTracks 函数体
  const i = src.indexOf("export function getDisplayTracks");
  const body = src.slice(i, i + 800);

  check("overlay 里的 video 排在 main 之前",
    /overlayVideos[\s\S]{0,200}tracks\.main/.test(body),
    "规格：视频2（overlay video）在视频1（main）之上");
  check("audio 排在 main 之后",
    /tracks\.main[\s\S]{0,200}tracks\.audio/.test(body),
    "规格：音频在视频1之下");
  check("非 video 的 overlay（字幕）排在最后",
    /\.\.\.tracks\.audio[\s\S]{0,200}overlayOthers/.test(body),
    "规格：字幕在最下");
  check("按 type 分流而不是按索引",
    /t\.type === "video"/.test(body),
    "按索引写死会错位（用户可能加第 3 条 overlay 视频）");
}

/* ── ② UI 侧 14 处必须调 getDisplayTracks ───────────────────── */

/* 判定表里的 14 处 UI 侧文件（见 docs/方案-轨道顺序改造-20261021.md） */
const UI_FILES = [
  "lib/timeline/components/drop-target.ts",
  "lib/timeline/components/index.tsx",
  "lib/timeline/controllers/drag-drop-controller.ts",
  "lib/timeline/controllers/element-interaction-controller.ts",
  "lib/timeline/controllers/resize-controller.ts",
  "lib/timeline/group-move/track-placement.ts",
  "lib/timeline/placement/apply.ts",
  "lib/timeline/placement/resolve.ts",
  "lib/timeline/animation-snap-points.ts",
  "lib/timeline/element-snap-source.ts",
];

for (const rel of UI_FILES) {
  const p = path.join(SRC, rel.replace(/\//g, path.sep));
  if (!fs.existsSync(p)) {
    check(`${rel} 存在`, false);
    continue;
  }
  const src = fs.readFileSync(p, "utf8");
  check(`${rel} 调用了 getDisplayTracks`, /getDisplayTracks/.test(src),
    "没调 ⇒ 这一处还用旧顺序 ⇒ 与渲染错位");

  // 去掉注释后，不该再出现手写的 [...overlay, main, ...audio]
  const noComment = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const stillHardcoded = /\.\.\.\s*(scene\.)?tracks\.overlay,\s*(scene\.)?tracks\.main/.test(noComment)
    || /\.\.\.\s*sceneTracks\.overlay,\s*sceneTracks\.main/.test(noComment);
  check(`${rel} 不再手写旧顺序`, !stillHardcoded,
    "UI 侧必须统一走 getDisplayTracks");
}

/* ── ③ 渲染/无关侧保留原写法且有标注 ───────────────────────── */

const RENDER_FILES = [
  "lib/media/audio.ts",
  "lib/timeline/components/graph-editor/session.ts",
  "lib/timeline/calculate-duration.ts",
  "lib/timeline/element-utils.ts",
];

for (const rel of RENDER_FILES) {
  const p = path.join(SRC, rel.replace(/\//g, path.sep));
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, "utf8");
  check(`${rel} 有「勿改成 UI 顺序」标注`,
    /勿改成 UI 顺序|渲染\/无关顺序/.test(src),
    "没标注的话，后人看到这行会以为是漏改");
}

/* ── ④ 自引用检查（本轮踩过：函数体调自己 ⇒ 无限递归）──────── */

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(__tests__|node_modules)$/.test(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.bak/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const selfRefs = [];
for (const f of walk(SRC)) {
  const src = fs.readFileSync(f, "utf8");
  // 找 `export function NAME({ ... }): T {  return [...NAME({ ... })] }` 这种自引用
  for (const m of src.matchAll(/export function (\w+)\([\s\S]{0,300}?\}\)[\s\S]{0,80}?return\s+\[?\.\.\.\1\(/g)) {
    selfRefs.push({ file: f.replace(SRC, ""), name: m[1] });
  }
}
check("没有函数体自称自引（会导致无限递归）",
  selfRefs.length === 0,
  selfRefs.map(r => `${r.file} 的 ${r.name}`).join("; "));

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ track-order  ${pass}/${total} 全过`);
  console.log("");
  console.log("  规格：视频2 → 视频1 → 音频1 → 音频2 → 字幕");
  console.log("  ★ 渲染顺序（画面叠加）仍为 overlay→main，与本顺序故意不同。");
  process.exit(0);
}
console.log(`  ✗ track-order  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
