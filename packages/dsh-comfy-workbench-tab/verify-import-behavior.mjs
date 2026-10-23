/**
 * verify-import-behavior.mjs · 导入素材的行为规格
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-21 的规格（原话）：
 *   「视频1和音频1是一个视频导入进去后默认的放置位置，
 *     导进去就把音频自动分离到音频1，
 *     然后第二个视频默认接在视频1轨道中的已有视频后面，
 *     如果手动拖，就可以拖到视频2，音频同理」
 *
 * 按之前问过的三个决策：
 *   ① 只对【带音轨的视频】自动分离；纯音频文件直接进音频轨；无声视频不产生空片段
 *   ② 音频1 有内容就接在后面；音频1 满了用音频2
 *   ③ 轨道顺序：视频2 → 视频1 → 音频1 → 音频2 → 字幕
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 为什么用静态断言而不是运行时点击
 *
 * 运行时验证需要：真实 mp4（有音轨）→ 素材面板非空 → 点「+」→ 看落轨结果。
 * 而本机 ComfyUI 已按主人指令关闭，素材面板是空的，走不到那一步。
 * 实测已确认：/comfy-assets/upload 不依赖 ComfyUI（只落盘），返回 200；
 *            但 /comfy-assets/file 依赖它（读 ComfyUI output），返回 400。
 *
 * ⇒ 在这个环境里，「落轨 + 分离」这段逻辑只能用静态断言锁住，
 *   并明确标注【未运行时验证】，等主人开着 ComfyUI 时再补。
 */

import fs from "node:fs";
import { UPSTREAM, upstreamFile, skipWithoutUpstream } from "../tools/upstream-env.mjs";
if (!UPSTREAM) skipWithoutUpstream("verify-import-behavior.mjs");
import path from "node:path";

const SRC = UPSTREAM;
const ASSETS = path.join(SRC, "lib", "panels", "assets", "views", "assets.tsx");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

if (!fs.existsSync(ASSETS)) {
  console.error(`  ✗ 找不到 ${ASSETS}`);
  process.exit(2);
}

const src = fs.readFileSync(ASSETS, "utf8");

/* 取 addElementAtTime 的函数体 */
const i = src.indexOf("const addElementAtTime");
check("有 addElementAtTime 函数", i >= 0);
const body = i >= 0 ? src.slice(i, i + 3600) : "";

/* ── ① 落点：接在已有内容后面，不是播放头 ─────────────────── */

check("落点计算用了「最晚结束时间」",
  /latestEnd/.test(body),
  "必须算已有元素的最大 end，否则会落在播放头处");

check("落点遍历了同类型轨道的元素",
  /\.elements/.test(body) && /startTime/.test(body) && /duration/.test(body),
  "要按 startTime + duration 算结束时间");

check("落点不再直接用播放头作为主路径",
  /latestEnd > 0 \? latestEnd/.test(body),
  "应该是「有内容就接后面，没有才用播放头」");

/* ── ② 音轨自动分离 ─────────────────────────────────────── */

check("导入时调用了 buildSeparatedAudioElement",
  /buildSeparatedAudioElement/.test(body),
  "不调就不会分离音轨");

check("分离前判了「是视频 + 有音轨」",
  /hasAudioTrack/.test(body) && /isVideoAsset/.test(body),
  "规格：只对带音轨的视频分离；纯音频直接进音频轨；无声视频不产生空片段");

check("hasAudio 的判定是 !== false（默认视为有音轨）",
  /asset\.hasAudio !== false/.test(body),
  "MediaAsset 的 hasAudio 是可选的，未设置时应视为有音轨");

check("分离失败不影响视频插入",
  /分离失败|catch/.test(body),
  "视频已经插进去了，分离失败只能 warn，不能回滚");

/* ── ③ 音频轨选择：autoplay 由 firstAvailable 决定 ────────── */

check("分离出的音轨用 auto 放置（firstAvailable）",
  /mode:\s*"auto"/.test(body),
  "音频1 装得下就用音频1，装不下自动用音频2 —— 这正是 firstAvailable 的行为");

/* ── ④ 视频落「视频 1」而不是「视频 2」─────────────────────── */

/**
 * ★★ 这条是【本轮引入又修掉】的问题，必须锁死
 *
 *   UI 显示顺序改成「视频2 → 视频1 → …」后，
 *   firstAvailable 若继续用同一个顺序，素材会先落【视频2】，
 *   与主人规格「素材默认落视频1、手动拖才进视频2」相反。
 *
 *   修法：放置用独立的 placementOrdered（主轨优先），与 UI 顺序解耦。
 *   判据：resolve.ts 里 firstAvailable 分支必须是 placementOrdered，不是 orderedTracks。
 */
const resolvePath = path.join(SRC, "lib", "timeline", "placement", "resolve.ts");
const resolveSrc = fs.existsSync(resolvePath) ? fs.readFileSync(resolvePath, "utf8") : "";

check("resolve.ts 存在", resolveSrc.length > 0);
check("firstAvailable 用独立的放置顺序（placementOrdered）",
  /placementOrdered/.test(resolveSrc),
  "用 orderedTracks 的话，素材会默认落到视频2（与主人规格相反）");
check("放置顺序里 main 排在最前（视频1 优先）",
  /tracks\.main,\s*\n?\s*\.\.\.orderedTracks\.filter/.test(resolveSrc),
  "video 类型的放置顺序必须以 tracks.main 开头");
check("音频类型用 audio 优先顺序",
  /trackType === "audio"[\s\S]{0,200}\.\.\.orderedTracks\.filter\(\(t\) => t\.type === "audio"\)/.test(resolveSrc)
  || /type === "audio"\)/.test(resolveSrc),
  "音频要优先落到 audio 数组里靠前的轨（音频1）");
check("UI 显示顺序与放置顺序是两个变量",
  /orderedTracks[\s\S]{0,300}placementOrdered/.test(resolveSrc),
  "两者必须解耦，否则改一个会顶掉另一个");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ import-behavior  ${pass}/${total} 全过`);
} else {
  console.log(`  ✗ import-behavior  ${pass}/${total}，失败 ${fails.length} 项：`);
  for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
}

console.log("");
console.log("  ── 验证状态（如实登记）──");
console.log("  ✅ 已运行时验证：/comfy-assets/upload 返回 200 + 真实 id（不依赖 ComfyUI）");
console.log("  ⬜ 未运行时验证：导入后的落轨位置与音轨分离结果");
console.log("     原因：本机 ComfyUI 已关闭，素材面板为空，走不到「点+加素材」那一步");
console.log("     待主人开 ComfyUI 后补：上传真实带音轨 mp4 → 两次点+ → 查");
console.log("       ① 第一个视频落「视频 1」，音频落「音频 1」");
console.log("       ② 第二个视频 startTime = 第一个的结束时间（接在后面）");
console.log("       ③ 手动拖可拖到「视频 2」");
console.log("");

process.exit(fails.length === 0 ? 0 : 1);
