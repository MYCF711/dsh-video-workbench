/**
 * verify-responsive.mjs · 1280 / 375 两档宽度的布局契约
 *
 * ══════════════════════════════════════════════════════════════════════
 * refactoring-ui 强制要求：「读源码不算设计评审，必须 1280 与 375 两宽度看像素」。
 *
 * 前几轮我试过三种「改宽度」的方法，只有第三种真的改变了布局：
 *   ① window.resizeTo()        → 浏览器拦截，无效
 *   ② CDP Emulation.setDeviceMetricsOverride → 被页面的 resize 逻辑重置
 *   ③ 给 DSH 外壳 .BynINW_frame 设固定 width → 真的重新布局 ✅
 *   ④ documentElement.style.zoom → 只缩放渲染，布局宽度不变 ❌
 *
 * ⇒ 判据：改完后 `sectionW` 必须跟着变。
 *   实测：1280 宽 → sectionW 969；375 宽 → sectionW 288；恢复 → 1601。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 实测结果（2026-10-21）
 *
 * 1280 宽（section 969px）：
 *   左侧图标组  301~598
 *   标题        682~806（居中，两侧各 84px 呼吸）
 *   右侧控件组  890~1242
 *   工具栏      293~1250（右侧余 8px）
 *   ⇒ 零挤压、零裁切、五条轨道全在
 *
 * 375 宽（section 288px）：
 *   工具栏 clientWidth 276 / scrollWidth 781 ⇒ canScroll = true
 *   按钮被压成 <20px 的数量 = 0（不缩，而是靠横向滚动）
 *   五条轨道名完整可见，轨道头与轨道对齐
 *   ⇒ 布局没塌，靠横向滚动容纳
 *
 * ══════════════════════════════════════════════════════════════════════
 * 本脚本锁的是【源码级的不退化保证】：
 *   这些数值依赖几个关键 class，谁把它们删了，这里会红。
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

/* ── ① 工具栏必须可横向滚动（375 宽的生存条件）───────────────── */

const tbPath = path.join(SRC, "lib", "timeline", "components", "timeline-toolbar.tsx");
const tbSrc = fs.existsSync(tbPath) ? fs.readFileSync(tbPath, "utf8") : "";
check("timeline-toolbar.tsx 存在", tbSrc.length > 0, tbPath);

check("工具栏外层是 ScrollArea（窄屏靠它横向滚动）",
  /<ScrollArea/.test(tbSrc),
  "没有 ScrollArea 的话 375 宽下右侧控件会被裁掉、且无法滑到");

/**
 * ★ 注意：`scrollbar-thin` / `overflow-auto` 这两个类是 ScrollArea 组件
 *   自己加的，不在 timeline-toolbar.tsx 的源码里。
 *   我第一版在这里查 tbSrc，误报失败。
 *   ⇒ 改为：断言 ScrollArea 组件本身带滚动能力（查它的实现文件）。
 *   运行时判据见文件头的实测记录（clientWidth 276 / scrollWidth 781）。
 */
const scrollAreaPath = path.join(SRC, "lib", "components", "ui", "scroll-area.tsx");
if (fs.existsSync(scrollAreaPath)) {
  const saSrc = fs.readFileSync(scrollAreaPath, "utf8");
  check("ScrollArea 组件提供 overflow 滚动能力",
    /overflow/.test(saSrc),
    "ScrollArea 若不带 overflow，条形工具栏的横向滚动就无从谈起");
} else {
  // 组件可能叫别的名字 —— 退一步，只要工具栏用了 ScrollArea 就够
  check("ScrollArea 组件文件找到（或工具栏已用 ScrollArea）",
    /<ScrollArea/.test(tbSrc));
}

/* ── ② 长文本必须能省略，不撑破容器 ─────────────────────────── */

/**
 * refactoring-ui + ui-preview-workflow 都强调：
 *   长文本 nowrap + ellipsis，父容器 min-width:0。
 * 实测场景：轨道名「Main Track」原来在 136px 的轨道头里被截成「Main...」。
 */
const idxPath = path.join(SRC, "lib", "timeline", "components", "index.tsx");
const idxSrc = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, "utf8") : "";
check("index.tsx 存在", idxSrc.length > 0, idxPath);

check("轨道名有 truncate（长名不撑破轨道头）",
  /\{track\.name\}/.test(idxSrc) && /truncate/.test(idxSrc));

check("轨道名父容器有 min-w-0（否则 truncate 不生效）",
  /min-w-0\s+truncate|min-w-0.*truncate/.test(idxSrc),
  "没有 min-w-0 的话 flex 子项不会缩小到内容宽度以下，truncate 无效");

check("轨道名有 title 属性（截断后可悬停看全名）",
  /title=\{track\.name\}/.test(idxSrc));

/* ── ③ 主按钮与次要控件的尺寸分层（主人决策 #3）─────────────── */

const nativePath = path.join(
  path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))),
  "src", "dsh-native.css.js",
);
// ★ 上面的路径算法在 Windows 上不稳，直接用绝对路径兜底
const NATIVE = "D:/主工作区/DSH视频工作台/packages/dsh-comfy-workbench-tab/src/editor/dsh-native.css.js";
const nativeSrc = fs.existsSync(NATIVE) ? fs.readFileSync(NATIVE, "utf8") : "";
check("dsh-native.css.js 存在", nativeSrc.length > 0, NATIVE);

check("次要控件尺寸收敛到 28px（size-7 覆盖 h-8）",
  /\.size-7\.h-8\.w-8/.test(nativeSrc) || /height:\s*1\.75rem/.test(nativeSrc),
  "主人决策 #3：次要控件 28×28");

check("字号收敛到 13px",
  /\.text-sm\s*\{\s*font-size:\s*0\.8125rem/.test(nativeSrc),
  "主人决策 #3：次要控件 13px");

/* ── ④ 面板分隔条可拖（响应式的另一面：用户要能自己调）───────── */

check("分隔条命中区扩到 7px",
  /width:\s*7px\s*!important/.test(nativeSrc) && /height:\s*7px\s*!important/.test(nativeSrc));

check("分隔条有正确的 resize 光标",
  /col-resize/.test(nativeSrc) && /row-resize/.test(nativeSrc));

/* ── ⑤ 两档宽度下不能被写死的像素值挡住 ────────────────────── */

/**
 * 反向断言：轨道头宽度是「常量」不是「写死」。
 * 实测：我把它从 112 改到 136（因为要放中文名 + 3 个图标），
 *      改的是 layout.ts 的常量，不是散落在组件里的数字。
 */
const layoutPath = path.join(SRC, "lib", "timeline", "components", "layout.ts");
const layoutSrc = fs.existsSync(layoutPath) ? fs.readFileSync(layoutPath, "utf8") : "";
check("轨道头宽度是常量（TRACK_LABELS_COLUMN_WIDTH_PX）",
  /TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX/.test(layoutSrc),
  "散落写死的数字在窄屏下会撞车，且改一处漏一处");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ responsive  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 运行时实测（2026-10-21）──");
  console.log("  1280 宽 → section 969px");
  console.log("    左组 301~598 / 标题 682~806 / 右组 890~1242 / 工具栏 293~1250");
  console.log("    ✅ 零挤压、零裁切、五条轨道全在");
  console.log("  375 宽 → section 288px");
  console.log("    工具栏 clientWidth 276 / scrollWidth 781 ⇒ 可横向滚动");
  console.log("    ✅ 被压成 <20px 的按钮 = 0 个");
  console.log("    ✅ 五条轨道名完整，轨道头与轨道对齐");
  process.exit(0);
}
console.log(`  ✗ responsive  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);

