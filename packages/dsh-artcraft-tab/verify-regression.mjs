/**
 * ArtCraft 融合 · 回归护栏（2026-10-21）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这份验收的定位：**只防已经踩过的坑，不复测功能**
 *
 *   功能正确性由别的验收覆盖（projection / storage / save-trim）。
 *   这份专门锁住那些「不报错、界面看着正常、结果不对」的静默失效点 ——
 *   它们全部是端到端实测时逐个人肉挖出来的，
 *   如果不写进验收，下次改动会原样复发。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 锁住的 8 个坑（每个都有对应的实测证据在 docs/问题记录-20261020.md）
 *
 *   ① MediaTime 是整数 tick（120000/秒），不是 {numerator, denominator}
 *   ② TProjct 的 tracks 是 { overlay, main(单个对象), audio } ——
 *      main 单数、audio 复数，不是 video/audio 对称
 *   ③ element.type 按【实际扩展名】判，不是 clip.kind（后者是「在哪条轨上」）
 *   ④ duration = trimEnd - trimStart（时间轴上占多长），不是 out-in
 *   ⑤ startTime 累加用 element 实际时长，不是 out-in
 *   ⑥ AudioElement 必须声明 sourceType（联合类型）
 *   ⑦ mediaId 必须是资产表里的真实 id（不能靠猜前缀）
 *   ⑧ ArtCraft 的 payload 必须 base64（否则 esbuild 导出被劫持）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF = path.join(HERE, "..", "dsh-comfy-workbench-tab", "src", "timeline-projection.mjs");
const ART = "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/dsh-projection.ts";
const AC_TAB = path.join(HERE, "src");
const BUILD = path.join(HERE, "build.mjs");

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 260) : ""}`);
  }
}

console.log("═".repeat(66));
console.log("  ArtCraft 融合 · 回归护栏（只防已踩过的坑）");
console.log("═".repeat(66));

const wfSrc = fs.readFileSync(WF, "utf8");
const artSrc = fs.existsSync(ART) ? fs.readFileSync(ART, "utf8") : "";

/* ─── ① MediaTime 是整数 tick ──────────────────────────── */
console.log("\n① MediaTime 必须是整数 tick，不是 {numerator, denominator}");
{
  /**
   * 实测：传 {numerator, denominator} 进去，
   * addMediaTime 里 a + b 变成 "[object Object][object Object]"
   * → 报错 "expected an integer tick count"
   */
  t("定义了 TICKS_PER_SECOND = 120000（实测值）",
    /export const TICKS_PER_SECOND\s*=\s*120000/.test(wfSrc),
    (wfSrc.match(/TICKS_PER_SECOND\s*=\s*\S+/) || [])[0]);

  t("secToTime 返回整数（用 Math.round）",
    /export function secToTime\(sec\)\s*\{\s*return Math\.round\(/.test(wfSrc));

  // 绝不能出现 { numerator, denominator } 作为时间值
  const badTime = /secToTime\([^)]*\)\s*\{\s*[^}]*return\s*\{[^}]*numerator/.test(wfSrc);
  t("secToTime 不返回对象（那是 FrameRate 的类型）", !badTime);

  // 两份文件都要有这个常量
  t("ArtCraft 侧也有 TICKS_PER_SECOND = 120000",
    artSrc ? /export const TICKS_PER_SECOND\s*=\s*120000/.test(artSrc) : false);

  console.log("  · 运行时抽查（跑真实函数）");
}

/* ─── ② tracks 结构：overlay / main(单个) / audio ──────── */
console.log("\n② tracks 是 { overlay, main(单个对象), audio } —— 不是 video/audio 对称");
{
  t("有 overlay: []", /overlay:\s*\[\]/.test(wfSrc));
  t("main 是单个对象（有 elements 字段）", /main:\s*\{[\s\S]{0,200}?elements:/.test(wfSrc));
  t("没有 tracks.video 这种键（ArtCraft 不认）", !/\bvideo:\s*\[\s*\{[\s\S]{0,80}?type:\s*"video"/.test(wfSrc));

  // fromArtCraft 读的必须是 main
  t("fromArtCraft 读 tracks.main 而不是 tracks.video",
    /scene\.tracks\?\.main/.test(wfSrc) && !/scene\.tracks\?\.video/.test(wfSrc));

  // 两份文件一致
  t("ArtCraft 侧也有 overlay: []", artSrc ? /overlay:\s*\[\]/.test(artSrc) : false);
  t("ArtCraft 侧 main 也是单个对象", artSrc ? /main:\s*\{/.test(artSrc) : false);
}

/* ─── ③ element.type 按扩展名判 ─────────────────────────── */
console.log("\n③ element.type 按实际扩展名判，不是 clip.kind");
{
  /**
   * 实测：clip 在视频轨上（kind="video"），但 rendered.filename 是 .png
   * 按 kind 判成 type:"video" → ArtCraft 用 <video> 加载 PNG → 静默失败
   */
  t("有按扩展名的 IMAGE_EXT 集合", /IMAGE_EXT\s*=\s*new Set\(\[/.test(wfSrc));
  t("有按扩展名的 AUDIO_EXT 集合", /AUDIO_EXT\s*=\s*new Set\(\[/.test(wfSrc));
  t("用扩展名而不是 clip.kind 决定 type",
    /IMAGE_EXT\.has\(ext\)/.test(wfSrc) && !/const kind\s*=\s*clip\.kind === "audio" \? "audio" : \(clip\.kind === "image"/.test(wfSrc));

  // 运行时：一个 clip.kind="video" 但 src 是 .png 的，应该投影成 image
  console.log("  · 运行时抽查见第 ⑨ 段");
}

/* ─── ④ duration = trimEnd - trimStart ──────────────────── */
console.log("\n④ duration 必须按 trim 算，不是 out-in");
{
  /**
   * 实测：只改 trim 不改 duration → 界面毫无变化、导出仍按全长。
   * 静默失效：看起来保存了，实际没生效。
   */
  t("有 effectiveDur 计算", /effectiveDur/.test(wfSrc));
  t("effectiveDur 用 trimEnd - trimStart", /trimEndRaw\s*-\s*trimStartSec/.test(wfSrc));
  t("duration 用的是 effectiveDur 而不是 dur",
    /duration:\s*secToTime\(effectiveDur\)/.test(wfSrc));
  t("trimEnd 在没裁切时写成全长（不是 0）",
    /trimEnd:\s*secToTime\(hasTrim \? trimEndRaw : dur\)/.test(wfSrc));
}

/* ─── ⑤ startTime 累加用实际时长 ────────────────────────── */
console.log("\n⑤ startTime 累加用 element 实际时长，不是 out-in");
{
  /**
   * 实测（双 clip）：第一个裁到 1.5 秒、第二个 5 秒，
   * 用 out-in 累加会让两个 clip 之间出现 3.5 秒空隙。
   * 单 clip 时不可见 —— 位置类 bug 需要 ≥2 个元素才暴露。
   */
  t("累加用的是 timeToSec(el.duration)",
    /t \+= timeToSec\(el\.duration\)/.test(wfSrc));
  t("不是用 dur 累加（那样会留空隙）",
    !/t \+= dur;/.test(wfSrc));
}

/* ─── ⑥ AudioElement 必须声明 sourceType ────────────────── */
console.log("\n⑥ AudioElement 必须声明 sourceType（联合类型）");
{
  /**
   * 实测：不设 sourceType 时合成代码走到 fetch(undefined) → 抛错 → 静默丢弃
   * → 导出文件只有视频流、没有音频流（界面完全看不出来）
   */
  t("audio element 设了 sourceType", /element\.sourceType\s*=\s*"upload"/.test(wfSrc));

  // 且在 audio 分支里（不是随便绑到哪）
  const audioBlock = wfSrc.match(/if \(kind === "audio"\)\s*\{[\s\S]{0,600}?\}/);
  t("sourceType 在 kind === 'audio' 的分支内",
    !!(audioBlock && /sourceType/.test(audioBlock[0])), audioBlock ? audioBlock[0].slice(0, 120) : null);

  t("ArtCraft 侧也设了 sourceType", artSrc ? /sourceType\s*=\s*"upload"/.test(artSrc) : false);
}

/* ─── ⑦ mediaId 用资产表真实 id ─────────────────────────── */
console.log("\n⑦ mediaId 必须能修正成资产表里的真实 id");
{
  /**
   * 实测：音频资产 id 是 "editor:D:\...\test-mix.m4a"，
   * 投影猜 "output:test-mix.m4a" → 不存在 → 条带不渲染、也不注册媒体。
   * 视频恰好猜对（src 是 output），所以只在音频上暴露。
   */
  const mediaSrc = path.join(AC_TAB, "mediaAssets.js");
  const msrc = fs.existsSync(mediaSrc) ? fs.readFileSync(mediaSrc, "utf8") : "";
  t("有 fixupMediaIds 函数", /export function fixupMediaIds/.test(msrc));
  t("按文件名匹配（basename）", /byName\.get\(base\)/.test(msrc));
  t("client.js 里调了 fixupMediaIds", /fixupMediaIds\(/.test(
    fs.readFileSync(path.join(AC_TAB, "client.js"), "utf8")));

  // 投影侧要支持注入解析器
  t("clipToElement 支持 opts.mediaIdOf", /opts\.mediaIdOf/.test(wfSrc));
}

/* ─── ⑧ payload 必须 base64 ─────────────────────────────── */
console.log("\n⑧ ArtCraft payload 必须 base64（否则 esbuild 导出被劫持）");
{
  /**
   * 实测：payload 里含 module.exports = __toCommonJS(...)
   * esbuild 不区分内容是否在字符串里，把它当成本模块的导出声明
   * → 我的 exports.apply 消失 → DSH 拿不到 apply → 插件静默不激活
   * → 时间轴 tab 在、但内容区空白、没有任何报错
   */
  const bsrc = fs.readFileSync(BUILD, "utf8");
  t("build.mjs 用 base64 编码 payload", /toString\("base64"\)/.test(bsrc));
  /**
   * ★ 断言必须排除注释 —— build.mjs 的注释里写了旧写法做对照：
   *     「第一版写的是 `export default ${JSON.stringify(raw)}`」
   *   只搜全文会把这条注释当成违规。
   */
  const bcode = bsrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  t("代码里不再用 JSON.stringify 直接嵌源码（注释不算）",
    !bcode.includes("JSON.stringify(raw)"),
    (bcode.match(/JSON\.stringify\(raw\)/g) || []).length);
  t("client.js 用 atob 解码", /atob\(ARTCRAFT_SRC\)/.test(
    fs.readFileSync(path.join(AC_TAB, "client.js"), "utf8")));
}

/* ─── ⑨ 运行时抽查：真实函数行为 ────────────────────────── */
console.log("\n⑨ 运行时抽查（跑真实投影函数，不只看源码）");
{
  const mod = await import("../dsh-comfy-workbench-tab/src/timeline-projection.mjs");

  // MediaTime 是整数
  const t1 = mod.secToTime(1.5);
  t("secToTime(1.5) === 180000 且是整数",
    t1 === 180000 && Number.isInteger(t1), t1);
  t("timeToSec(180000) === 1.5", mod.timeToSec(180000) === 1.5, mod.timeToSec(180000));

  // 一个 kind=video 但 src 是 .png 的 clip → type 必须是 image
  const pngClip = {
    id: "c1", kind: "video", name: "图", src: "Krea2-x.png",
    in: 0, out: 5, speed: 1, crop: null, gain: 1,
    trim: null, shot: null, rendered: null, regenError: null,
    fromVideoClipId: null, handoff: null,
  };
  const elImg = mod.clipToElement(pngClip, {});
  t("kind=video 但 src=.png → type 是 image（按扩展名）",
    elImg?.type === "image", elImg?.type);

  // trim 影响 duration
  const trimmed = { ...pngClip, trim: { startSec: 0.5, endSec: 2 } };
  const elTrim = mod.clipToElement(trimmed, {});
  t("trim={0.5,2} → duration = 1.5 秒 = 180000 tick",
    elTrim?.duration === 180000, elTrim?.duration);
  t("trimStart = 0.5 秒 = 60000 tick", elTrim?.trimStart === 60000, elTrim?.trimStart);
  t("trimEnd = 2 秒 = 240000 tick", elTrim?.trimEnd === 240000, elTrim?.trimEnd);

  // 没 trim 时 duration = out-in
  const noTrim = mod.clipToElement({ ...pngClip, trim: null, out: 4 }, {});
  t("没 trim 时 duration = out-in = 4 秒",
    noTrim?.duration === 480000, noTrim?.duration);
  t("没 trim 时 trimEnd = 全长（不是 0）",
    noTrim?.trimEnd === 480000, noTrim?.trimEnd);

  // audio 元素必须有 sourceType
  const audioClip = {
    ...pngClip, id: "a1", kind: "audio", name: "音", src: "test.m4a", out: 8,
  };
  const elAudio = mod.clipToElement(audioClip, {});
  t("audio clip → type=audio 且 sourceType=upload",
    elAudio?.type === "audio" && elAudio?.sourceType === "upload",
    { type: elAudio?.type, sourceType: elAudio?.sourceType });

  // 双 clip 的 startTime 累加不留空隙
  const state2 = {
    version: 1, fps: 24, name: "t",
    tracks: [
      { id: "t1", kind: "video", name: "v", clips: [
        { ...pngClip, id: "a", trim: { startSec: 0, endSec: 1.5 }, out: 5 },
        { ...pngClip, id: "b", trim: null, out: 3 },
      ] },
      { id: "t2", kind: "audio", name: "a", clips: [] },
    ],
  };
  const proj = mod.toArtCraft(state2, {});
  const els = proj.scenes[0].tracks.main.elements;
  t("双 clip 都在", els.length === 2, els.length);
  t("clip2.startTime = clip1 的实际时长（1.5 秒 = 180000）",
    els[1]?.startTime === 180000, els[1]?.startTime);
  t("tracks 有 overlay 且是数组", Array.isArray(proj.scenes[0].tracks.overlay));
  t("tracks.main 是对象不是数组", !Array.isArray(proj.scenes[0].tracks.main));
}

/* ─── 汇总 ─────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  8 个静默失效点全部锁住（含运行时抽查）");
