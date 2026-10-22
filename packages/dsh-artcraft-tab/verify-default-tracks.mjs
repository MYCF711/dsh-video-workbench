/**
 * verify-default-tracks.mjs · 验证默认轨道是 5 条
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-21 原话：
 *   「下方的轨道应该默认有两条视频两条音频，一条文本（字幕）」
 *
 * 这个脚本读上游源码，断言 buildDefaultScene 产出的轨道结构。
 * 不需要浏览器，能进 verify-all 的静态段。
 *
 * ★★ 路径坑（本轮踩了两次，务必记住）：
 *   本机有【两份】artcraft 源码：
 *     D:\主工作区\_upstream\artcraft-src\    ← 参考源，构建【不读】它
 *     D:\主工作区\_upstream\artcraft-demo\video-editor\src\  ← ★ 构建真正读这份
 *   第一次改 ruler-utils 改在 artcraft-src 上，构建毫无变化，
 *   我一度以为「改了没生效」。第二版文件头已经写过这个坑，这次又踩了。
 *   ⇒ 判据：改完构建，产物体积/mtime 没变 ⇒ 先确认改的是不是构建读的那份。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 为什么读源码而不是 grep：
 *   grep 只能说明「源码里有几个 type: 'video'」，不能说明
 *   ① 它们落在 overlay / main / audio 哪个位置
 *   ② 最终返回的对象形状对不对
 *   AGENTS §6.40：「我没找到」是观测，「不存在」是推论，中间必须换方法再验。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本脚本所在目录（不依赖 cwd —— AGENTS §6.18 的坑）
const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ★ 必须是 artcraft-demo 那份（构建真正读的），不是 artcraft-src
const SRC = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/scenes.ts";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

if (!fs.existsSync(SRC)) {
  console.error(`  ✗ 找不到 ${SRC}（这是本项目私有分支路径，换机器要改）`);
  process.exit(2);
}

const src = fs.readFileSync(SRC, "utf8");

/* 只截取 buildDefaultScene 的【函数体】，避免把整个文件里别处的
   type: "video" 也算进来（比如 ensureMainScene 里也调了一次）

   ★★ 括号配对修正（本轮连踩两次，把过程记下来）：
     第 1 版：let i = src.indexOf("{", fnStart)
              —— 从函数名后的第一个 { 开始数。
              但函数签名是 `export function buildDefaultScene({ name, isMain }: {...}): TScene {`
              参数解构 `{ name, isMain }` 就提供了第一个 { 和它的配对 }，
              于是 depth 在参数处就归零，body 只截到 57 字符（实测）。
     第 2 版（本版）：先定位 `): TScene {` 这个返回类型标注之后的 { 才开始数。
              —— 更稳的写法是不靠字面量，而是找「前面是 ) 或 : 且后面是换行的 {」。
              这里函数只有一个，直接用 `): TScene {` 定位足够，但加个兜底：
              找不到就用「最后一个 { 之前最近的 {」。 */

function sliceFunctionBody(text, fnName) {
  const fnStart = text.indexOf(`export function ${fnName}`);
  if (fnStart < 0) return "";
  // 从函数签名结束处（`): TScene {` 或 `): ... {`）开始
  const sigEnd = text.indexOf("): ", fnStart);
  const braceStart = sigEnd >= 0 ? text.indexOf("{", text.indexOf("{", sigEnd) - 1) : text.indexOf("{", fnStart);
  let depth = 0, i = braceStart, end = -1;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  return end > 0 ? text.slice(braceStart, end + 1) : "";
}

const body = sliceFunctionBody(src, "buildDefaultScene");
if (!body) {
  console.error("  ✗ 没截出 buildDefaultScene 的函数体");
  process.exit(1);
}

/* ★ 正则修正（本轮踩了一次）：第一版用
     /overlay:\s*\[([\s\S]*?)\]\s*,\s*\/\/\s*main/
   但源码里 overlay: [ 之后紧跟换行 + 注释 + 多个对象，
   而 `],\s*main:` 之间还有 `// main：视频1（主轨）` 这行注释，
   `[\s\S]*?` 非贪婪匹配会在第一个 `]` 处停 —— 而对象里的数组 `elements: []`
   正好提供了那个 `]` ⇒ 截出来的 block 是空的。
   ⇒ 改成按【括号配对】精确切出三个字段的内容，不靠正则猜。 */

/** 从 body 里抠出 `<field>: [` ... 配对的 `]` 之间的内容 */
function sliceArrayField(text, field) {
  const key = `${field}: [`;
  const start = text.indexOf(key);
  if (start < 0) return "";
  let depth = 0, i = start + key.length - 1, begin = i + 1;
  for (; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") { depth--; if (depth === 0) return text.slice(begin, i); }
  }
  return "";
}

/** 从 body 里抠出 `<field>: {` ... 配对的 `}` 之间的内容 */
function sliceObjectField(text, field) {
  const key = `${field}: {`;
  const start = text.indexOf(key);
  if (start < 0) return "";
  let depth = 0, i = start + key.length - 1, begin = i + 1;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(begin, i); }
  }
  return "";
}

const overlayBlock = sliceArrayField(body, "overlay");
const mainBlock = sliceObjectField(body, "main");
const audioBlock = sliceArrayField(body, "audio");

const overlayVideo = (overlayBlock.match(/type:\s*"video"/g) ?? []).length;
const overlayText = (overlayBlock.match(/type:\s*"text"/g) ?? []).length;

check("overlay 里有 1 条视频轨", overlayVideo === 1, `实测 ${overlayVideo} 条`);
check("overlay 里有 1 条文本轨（字幕）", overlayText === 1, `实测 ${overlayText} 条`);

// ② main 必须是 video
check("main 是 video 轨", /type:\s*"video"/.test(mainBlock),
  mainBlock ? `main 内容前 60 字：${mainBlock.trim().slice(0, 60)}` : "main 字段没切出来");

// ③ audio 数组里必须有 2 条
const audioCount = (audioBlock.match(/type:\s*"audio"/g) ?? []).length;
check("audio 里有 2 条音频轨", audioCount === 2, `实测 ${audioCount} 条`);

// ④ 总数 = 5
const total = overlayVideo + overlayText + 1 /*main*/ + audioCount;
check("默认轨道总数 = 5（2 视频 + 1 文本 + 2 音频）", total === 5, `实测 ${total} 条`);

// ⑤ 轨道名必须是中文（否则界面又出英文）
check("视频2 的轨道名是「视频 2」", /name:\s*"视频 2"/.test(body));
check("字幕轨道名是「字幕」", /name:\s*"字幕"/.test(body));
check("音频1 的轨道名是「音频 1」", /name:\s*"音频 1"/.test(body));
check("音频2 的轨道名是「音频 2」", /name:\s*"音频 2"/.test(body));

/* ── ⑥ ★ 主轨名必须两处都改 ──────────────────────────────────
   ★ 这是本项目的老坑（AGENTS §6.43）：
     主轨名有【两条构造路径】，只改一处等于没改。
       ① lib/timeline/placement/main-track.ts 的 MAIN_TRACK_NAME 常量
          → 被 buildDefaultScene 用（新建场景）
       ② lib/timeline/dsh-projection.ts 里【手写】的 name: "Main Track"
          → DSH 打开时间轴必走这条路
     实测踩到：改完 ① 之后界面仍显示 Main Track，因为运行时走的是 ②。
   ⇒ 断言两条路径都是「视频 1」。 */
const mtPath = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/placement/main-track.ts";
const projPath = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/dsh-projection.ts";

if (fs.existsSync(mtPath)) {
  const mt = fs.readFileSync(mtPath, "utf8");
  check("主轨常量 MAIN_TRACK_NAME = 视频 1（路径①：新建场景）",
    /export const MAIN_TRACK_NAME\s*=\s*"视频 1"/.test(mt),
    "还是 Main Track");
} else {
  check("找不到 main-track.ts", false, mtPath);
}

if (fs.existsSync(projPath)) {
  const pj = fs.readFileSync(projPath, "utf8");
  check("投影层主轨名 = 视频 1（路径②：DSH 打开时间轴）",
    /name:\s*"视频 1"/.test(pj),
    "还是 Main Track —— 只改常量对它无效");
  // 反向断言：不许再有 Main Track 字面量（注释除外）
  const pjNoComment = pj.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  check("投影层不再有 Main Track 字面量",
    !/"Main Track"/.test(pjNoComment));
} else {
  check("找不到 dsh-projection.ts", false, projPath);
}

/* ── ⑦ 轨道头必须渲染轨道名 ──────────────────────────────────
   ★ 实测（子代理 + 我复跑）：原来轨道头只有 justify-end 的图标，
     完全没渲染 track.name，用户看到五条轨道但不知道哪条是什么。
   判据：index.tsx 里要有 {track.name}。 */
const idxPath = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/components/index.tsx";
if (fs.existsSync(idxPath)) {
  const idx = fs.readFileSync(idxPath, "utf8");
  check("轨道头渲染了 track.name", /\{track\.name\}/.test(idx),
    "缺 {track.name}，用户看不出哪条轨道是什么");
  check("轨道名有 truncate 防溢出", /track\.name\}/.test(idx) && /truncate/.test(idx));
}

/* ── ⑧ 轨道区必须能装下五条（914px 视口）────────────────────
   ★ 实测：原轨道高 video 65/audio 50 + 间距 6，五条合计 285px，
     而可用容器只有 278px ⇒ 第五条被裁在滚动区外。
   判据：layout.ts 里 video ≤ 58、audio ≤ 46。 */
const layoutPath = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/components/layout.ts";
if (fs.existsSync(layoutPath)) {
  const lo = fs.readFileSync(layoutPath, "utf8");
  const vMatch = /video:\s*(\d+)/.exec(lo);
  const aMatch = /audio:\s*(\d+)/.exec(lo);
  const videoH = vMatch ? Number(vMatch[1]) : NaN;
  const audioH = aMatch ? Number(aMatch[1]) : NaN;
  check("视频轨高度 ≤ 58px（否则五条放不下）", videoH <= 58, `实测 video: ${videoH}`);
  check("音频轨高度 ≤ 46px", audioH <= 46, `实测 audio: ${audioH}`);

  // 五条合计必须 ≤ 280
  const total = videoH * 2 + 25 /*text*/ + audioH * 2 + 4 * 6 /*gap*/;
  check(`五条轨道合计 ≤ 280px（实测 ${total}px）`, total <= 280,
    `超出的话第五条会被裁在滚动区外`);
}

/* ── ⑨ 纵向缩放（主人：「加一个纵向的滑动条，也支持缩放」）─────────
   ★ 实测两轮才对，两个坑都记下：
     ① 第一版把滑块写在 ToolbarRightSection，trackScale 却只定义在
        TimelineToolbar 的参数里 —— 两个函数，报 "trackScale is not defined"
     ② 改成滑块后宽度被 flex 压成 0px（工具栏太挤），
        最终改成 ↑↓ 按钮
 */
const tlToolbar = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/components/timeline-toolbar.tsx";
if (fs.existsSync(tlToolbar)) {
  const tb = fs.readFileSync(tlToolbar, "utf8");
  check("工具栏接受 trackScale / onTrackScaleChange",
    /trackScale:\s*number/.test(tb) && /onTrackScaleChange:\s*\(scale:\s*number\)/.test(tb),
    "缺 props 声明");
  check("ToolbarRightSection 也声明了这两个 props（否则跨作用域报未定义）",
    /function ToolbarRightSection\(\{[\s\S]{0,400}trackScale[\s\S]{0,200}onTrackScaleChange/.test(tb),
    "子组件缺参数，运行时 ReferenceError");
  check("有增高 / 减矮轨道的按钮", /增高轨道/.test(tb) && /减矮轨道/.test(tb));
  check("纵向缩放范围 0.6~2.0 被钳制",
    /Math\.min\(2,\s*trackScale/.test(tb) && /Math\.max\(0\.6,\s*trackScale/.test(tb));
}

const tlLayout = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/components/track-layout.ts";
if (fs.existsSync(tlLayout)) {
  const tr = fs.readFileSync(tlLayout, "utf8");
  check("轨道行高有缩放因子", /trackHeightScale/.test(tr));
  check("行高因子被钳制在 0.6~2.0",
    /Math\.max\(0\.6,\s*Math\.min\(2\.0/.test(tr));
  check("getTrackHeight 用因子计算", /return Math\.round\(TIMELINE_TRACK_HEIGHTS_PX\[type\] \* trackHeightScale\)/.test(tr),
    "getTrackHeight 没乘因子，缩放不会生效");
}

/* ── ⑩ 面板分隔条必须能拖 ────────────────────────────────────
   ★ 实测：react-resizable-panels 的 handle 只有 1px 宽、cursor auto，
     用户根本按不到 —— 主人说的「高度锁死了」就是这件事。 */
const nativeCssPath = path.join(HERE_DIR, "src", "dsh-native.css.js");
if (fs.existsSync(nativeCssPath)) {
  const nativeCss = fs.readFileSync(nativeCssPath, "utf8");
  check("分隔条命中区扩到 7px", /width:\s*7px\s*!important/.test(nativeCss) && /height:\s*7px\s*!important/.test(nativeCss),
    "1px 的命中区等于拖不动");
  check("分隔条有正确 cursor",
    /col-resize/.test(nativeCss) && /row-resize/.test(nativeCss));
  check("轨道区滚动条预留槽位（scrollbar-gutter: stable）",
    /scrollbar-gutter:\s*stable/.test(nativeCss),
    "不预留的话轨道变多时内容宽度会跳");
  check("补了 border-style 兜底（否则 .border-l 刻度线宽度算成 0）",
    /\.ac-scope \.border-l \{ border-left-style: solid/.test(nativeCss));
}

/* ── ⑫ 轨道头与轨道必须同步滚动（2026-10-21，错位的真正根因）─────
   ★ 现象：时间轴面板压矮后，轨道名与轨道整体错位（子代理报过，我复跑确认）。
     实测：右侧轨道区 scrollTop=168 / 左侧轨道头 scrollTop=122，差 46px。
   ★ 根因：syncFollowers 只在【滚动事件】里调用。面板尺寸变化（拖分隔条）时，
     两侧 scrollHeight 变了、浏览器各自 clamp 了 scrollTop，
     但没人再同步一次 ⇒ 两侧停在不同的位置。
   ★ 修：加一个依赖尺寸信号的 useEffect，在 rAF 里强制同步一次。
   ★ 判据（实测 4 档面板高度）：两侧 scrollTop 差 ≤ 1px。 */
const idxPath2 = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/components/index.tsx";
if (fs.existsSync(idxPath2)) {
  const idx2 = fs.readFileSync(idxPath2, "utf8");
  check("有 syncFollowers（轨道区 → 标尺/轨道头的单向同步）",
    /const syncFollowers = useCallback/.test(idx2));
  check("面板尺寸变化后会强制同步（不能只靠滚动事件）",
    /requestAnimationFrame\(\(\) => syncFollowers\(\)\)/.test(idx2),
    "只在滚动事件里同步的话，拖分隔条后两侧会停在不同位置");
  check("同步 effect 依赖了尺寸信号",
    /\}, \[syncFollowers, timelineHeaderHeightValue/.test(idx2),
    "不依赖尺寸的话 effect 不会重跑");
}

/* ── ⑪ 时间轴面板高度必须可调（2026-10-21 主人两次纠正）─────────
   ★ 第一版 minSize=15：时间轴能压到 15%，轨道区只剩 60px，一条都看不全
   ★ 第二版 minSize=58：五条全看到了，但【高度锁死】—— 主人明确否掉
   ★ 第三版 minSize=26：只保证「至少一条轨道完整可见」，五条靠默认值 + 滚动
   判据：minSize ≤ 30（能压缩），且 maxSize ≥ 60（能拉大） */
const vePath = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/VideoEditor.tsx";
if (fs.existsSync(vePath)) {
  const ve = fs.readFileSync(vePath, "utf8");

  // 取时间轴那个 ResizablePanel（含 <Timeline /> 的那个）
  const tlIdx = ve.indexOf("<Timeline />");
  check("找到 <Timeline /> 面板", tlIdx >= 0);
  if (tlIdx >= 0) {
    const seg = ve.slice(Math.max(0, tlIdx - 2500), tlIdx);
    const minM = /minSize=\{(\d+)\}/g;
    const maxM = /maxSize=\{(\d+)\}/g;
    let minV = null, maxV = null, m;
    while ((m = minM.exec(seg))) minV = Number(m[1]);
    while ((m = maxM.exec(seg))) maxV = Number(m[1]);

    check(`时间轴 minSize ≤ 30（实测 ${minV}）`, minV !== null && minV <= 30,
      "太大就锁死了高度，主人明确否掉过 minSize=58");
    check(`时间轴 maxSize ≥ 60（实测 ${maxV}）`, maxV !== null && maxV >= 60,
      "太小的话用户拉不大");

    // 与主内容互补
    const mainIdx = ve.indexOf("<ResizablePanelGroup");
    const mainSeg = ve.slice(Math.max(0, mainIdx - 1200), mainIdx);
    let mainMax = null;
    const mm = /maxSize=\{(\d+)\}/g;
    let q;
    while ((q = mm.exec(mainSeg))) mainMax = Number(q[1]);
    if (mainMax !== null && minV !== null) {
      check(`主内容 max(${mainMax}) + 时间轴 min(${minV}) = 100`,
        mainMax + minV === 100,
        "不互补的话拖到极限会「突然拖不动」");
    }
  }
}

// ⑥ 每个轨道都要有独立的 id（不能用同一个 generateUUID 的返回值复用）
const idCalls = (body.match(/generateUUID\(\)/g) ?? []).length;
check("id 逐条生成（≥ 6 次：scene + 5 条轨道）", idCalls >= 6, `实测 ${idCalls} 次`);

// ⑦ 保留说明注释（防止后人删掉又改回 1 条）
check("代码里记录了为什么是 5 条", body.includes("主人 2026-10-21") || body.includes("两视频"));

/* ── 汇总 ─────────────────────────────────────────────────────── */

const tot = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ default-tracks  ${pass}/${tot} 全过`);
  console.log("");
  console.log("  ⚠ 本脚本验的是源码结构，不是运行时。");
  console.log("    真正跑起来要看浏览器里轨道数 = 5（需要新建场景，旧存档不会变）。");
  process.exit(0);
}
console.log(`  ✗ default-tracks  ${pass}/${tot}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `：${f.detail}` : ""}`);
process.exit(1);
