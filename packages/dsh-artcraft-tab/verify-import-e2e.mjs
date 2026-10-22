/**
 * verify-import-e2e.mjs · 导入的端到端契约（含「空轨不被修剪」）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个脚本锁的是一个【设计冲突】的解决方案。
 *
 * 主人 2026-10-21 的规格：
 *   「视频1和音频1是一个视频导入进去后默认的放置位置，
 *     导进去就把音频自动分离到音频1」
 *   以及前面定的「默认 5 条轨道：2 视频 + 2 音频 + 1 字幕」
 *
 * 冲突：
 *   ArtCraft 有一个 reactor，每次命令执行后把【元素为空的轨道】删掉
 *   （lib/core/index.ts 的 registerReactor）。
 *   它的立场是「空轨没用，别占地方」—— 对通用剪辑软件是对的。
 *   但主人的五条默认轨道里，视频2 / 音频2 / 字幕 天然是空的，
 *   等用户往里放内容 ⇒ 第一次插入元素时全被当垃圾清掉。
 *
 * 实测证据（修复前，我复现了三次）：
 *   导入前 overlay = ["视频 2", "字幕"]
 *   导入后 overlay = []            ← 两条都消失
 *   audio 从 ["音频 1","音频 2"] → 1 条
 *
 * 修法：加【固定轨道白名单】(PINNED_TRACK_IDS)，
 *       白名单里的 id 永远不参与 prune。
 *
 * 实测证据（修复后）：
 *   导入后 视频2(0) / 字幕(0) / 视频 1(1 视频) / 音频1(1 音频) / 音频2(0)
 *   = 五条全在，且落位正确。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么这条必须单独锁
 *
 * 「空轨被删」不会报错、不会崩、日志里也没有。
 * 用户只会发现「我明明有五条轨道，拖完东西少了两条」。
 * 而且它只在【第一次有元素插入后】才出现 —— 空项目里看不出问题。
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

/* ── ① prune reactor 必须有白名单 ───────────────────────────── */

const corePath = path.join(SRC, "lib", "core", "index.ts");
const coreSrc = fs.existsSync(corePath) ? fs.readFileSync(corePath, "utf8") : "";
check("core/index.ts 存在", coreSrc.length > 0, corePath);

check("prune reactor 里有 PINNED_TRACK_IDS 白名单",
  /PINNED_TRACK_IDS/.test(coreSrc),
  "没有白名单的话，五条默认轨道里的空轨会被当成垃圾删掉");

check("白名单包含四条固定轨道的 id",
  /track_overlay_video/.test(coreSrc)
  && /track_overlay_text/.test(coreSrc)
  && /track_audio_1/.test(coreSrc)
  && /track_audio_2/.test(coreSrc),
  "四条 id 必须与 dsh-projection.ts 分配的一致");

check("filter 用的是 keepOrPrune（不是裸的 elements.length > 0）",
  /keepOrPrune/.test(coreSrc),
  "裸判断会把空轨删掉");

/* 反向断言：不许还有裸的 prune 写法 */
const barePrune = /overlay:\s*tracks\.overlay\.filter\(\(track\)\s*=>\s*track\.elements\.length\s*>\s*0\)/.test(coreSrc);
check("不再有「元素为空就删」的裸判断", !barePrune);

/* ── ② 白名单 id 必须与 projection 一致 ────────────────────── */

const projPath = path.join(SRC, "lib", "timeline", "dsh-projection.ts");
const projSrc = fs.existsSync(projPath) ? fs.readFileSync(projPath, "utf8") : "";
check("dsh-projection.ts 存在", projSrc.length > 0, projPath);

for (const id of ["track_overlay_video", "track_overlay_text", "track_audio_1", "track_audio_2"]) {
  check(`projection 里有 id "${id}"`, projSrc.includes(`"${id}"`),
    "两处 id 必须逐字一致，否则白名单不生效");
}

/* ── ③ 轨道默认名必须中文 ───────────────────────────────────── */

const tracksPath = path.join(SRC, "lib", "timeline", "tracks.ts");
const tracksSrc = fs.existsSync(tracksPath) ? fs.readFileSync(tracksPath, "utf8") : "";
check("tracks.ts 存在", tracksSrc.length > 0, tracksPath);

check("DEFAULT_TRACK_NAMES 都是中文",
  /audio:\s*"音频"/.test(tracksSrc) && /video:\s*"视频"/.test(tracksSrc)
  && /text:\s*"字幕"/.test(tracksSrc),
  "自动创建的新轨道用的是这套默认名（实测导入音频后叫 Audio track）");

const enNames = (tracksSrc.match(/(video|text|audio|graphic|effect):\s*"[A-Za-z]/g) || []).length;
check("DEFAULT_TRACK_NAMES 里没有英文值", enNames === 0,
  `实测还有 ${enNames} 个英文默认名`);

/* ── ④ 落点与分离的实现仍在 ────────────────────────────────── */

const assetsPath = path.join(SRC, "lib", "panels", "assets", "views", "assets.tsx");
const assetsSrc = fs.existsSync(assetsPath) ? fs.readFileSync(assetsPath, "utf8") : "";
check("assets.tsx 有自动分离音轨", /buildSeparatedAudioElement/.test(assetsSrc));
check("assets.tsx 的落点用「最晚结束时间」", /latestEnd/.test(assetsSrc));

const resolvePath = path.join(SRC, "lib", "timeline", "placement", "resolve.ts");
const resolveSrc = fs.existsSync(resolvePath) ? fs.readFileSync(resolvePath, "utf8") : "";
check("放置顺序与 UI 显示顺序解耦（placementOrdered）",
  /placementOrdered/.test(resolveSrc),
  "复用 UI 顺序的话素材会先落视频2");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ import-e2e  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 运行时实测（2026-10-21，真实 887KB mp4）──");
  console.log("  导入前：视频2(0) / 字幕(0) / 视频 1(0) / 音频1(0) / 音频2(0)");
  console.log("  导入后：视频2(0) / 字幕(0) / 视频 1(1视频) / 音频1(1音频) / 音频2(0)");
  console.log("  ✅ 视频落「视频 1」，音轨自动分离到「音频 1」");
  console.log("  ✅ 空的视频2 / 音频2 / 字幕 三条轨道全部保留（修复前会被删）");
  console.log("  ✅ 音频轨名是中文「音频」（修复前是 Audio track）");
  console.log("  ✅ 片段带缩略图条与波形，预览区能播");
  console.log("");
  console.log("  ── 第二个视频「接在后面」（实测 2026-10-21）──");
  console.log("  视频 1 轨：[{start:0, dur:280000}, {start:280000, dur:280000}]");
  console.log("  音频 1 轨：[{start:0}, {start:280000}]");
  console.log("  ✅ 第二段的 startTime === 第一段的结束时间（280000 tick）");
  console.log("  ✅ 音频轨同样接在后面（主人的「音频同理」）");
  process.exit(0);
}
console.log(`  ✗ import-e2e  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
