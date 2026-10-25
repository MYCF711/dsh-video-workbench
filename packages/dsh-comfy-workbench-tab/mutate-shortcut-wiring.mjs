/** 变异测试：verify-shortcut-wiring.mjs 必须能抓住「三处不一致」。 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = "src/editor/";
const MUTANTS = [
  { name: "handler 漏掉 splitRipple（按了没反应）", file: D + "ArtCraftTab.js", from: "      splitRipple: () => callbacks?.onAction?.(\"rippleDelete\"),", to: "      // 删掉" },
  { name: "handler 漏掉 toggleSnap", file: D + "ArtCraftTab.js", from: "      toggleSnap: () => callbacks?.onAction?.(\"snapping\"),", to: "      // 删掉" },
  { name: "handler 漏掉 playPause（空格失效）", file: D + "ArtCraftTab.js", from: "      playPause: () => callbacks?.onAction?.(\"playPause\"),", to: "      // 删掉" },
  { name: "handler 指向不存在的动作", file: D + "ArtCraftTab.js", from: "      goStart: () => callbacks?.onAction?.(\"goStart\"),", to: "      goStart: () => callbacks?.onAction?.(\"noSuchAction\")," },
  { name: "工具条 shortcutId 写错成 snap", file: D + "EditorToolbar.js", from: 'shortcutId: "toggleSnap"', to: 'shortcutId: "snap"' },
  { name: "播放键位不是 Space", file: D + "shortcuts.js", from: 'default: "Space"', to: 'default: "F5"' },
  { name: "跳开头不是 Home", file: D + "shortcuts.js", from: 'default: "Home"', to: 'default: "F1"' },
  { name: "MediaTime 当毫秒算", file: D + "editorHost.js", from: "const tick = Math.max(0, Math.round(Number(seconds) * 120000));", to: "const tick = Math.max(0, Math.round(Number(seconds) * 1000));" },
  { name: "逐帧写死一帧长度", file: D + "editorHost.js", from: "Math.round(120000 / fps)", to: "4000" },
  { name: "seekBy 改回读 editorState.fps", file: D + "editorHost.js", from: "const fps = fpsRef.current || 30;", to: "const fps = editorState.fps || 30;" },
  { name: "onState 允许覆盖 fps", file: D + "editorHost.js", from: "              fps: prev.fps,", to: "              fps: s.fps," },
  { name: "挂载路径不写 fpsRef", file: D + "editorHost.js", from: "if (Number.isFinite(mFps) && mFps > 0) fpsRef.current = mFps;", to: "void 0;" },
];

let caught = 0;
console.log("\n=== 变异测试：verify-shortcut-wiring.mjs ===\n");
for (const m of MUTANTS) {
  const f = path.join(HERE, m.file);
  const bak = f + ".mbak";
  fs.copyFileSync(f, bak);
  try {
    const before = fs.readFileSync(f, "utf8");
    if (!before.includes(m.from)) {
      console.log(`  !! ${m.name}\n     锚点不存在 —— 未验证`);
      continue;
    }
    fs.writeFileSync(f, before.split(m.from).join(m.to), "utf8");
    let red = false;
    try {
      execFileSync(process.execPath, ["verify-shortcut-wiring.mjs"], { cwd: HERE, stdio: "pipe", timeout: 60_000 });
    } catch { red = true; }
    if (red) { caught++; console.log(`  OK 变红：${m.name}`); }
    else console.log(`  NG 仍然绿：${m.name}   <- 有盲区`);
  } finally {
    fs.copyFileSync(bak, f);
    fs.unlinkSync(bak);
  }
}
console.log(`\n${caught} / ${MUTANTS.length} 个缺陷被抓住\n`);
process.exit(caught === MUTANTS.length ? 0 : 1);
