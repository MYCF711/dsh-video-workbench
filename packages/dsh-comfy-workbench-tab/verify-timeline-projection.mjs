/**
 * 工程投影层验收（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 验什么
 *
 *   我们的 timeline-state ⇄ ArtCraft 的 TProject 投影是【单向】的：
 *     toArtCraft()    只读投影，给 ArtCraft 做时间轴编辑
 *     fromArtCraft()  只回写 trim 与顺序，其余字段原样不动
 *
 *   这份验收的核心不是「能不能转」，而是：
 *     ★ 转过去再转回来，我们的 shot / handoff / rendered 有没有丢
 *
 *   因为那三个字段是 ArtCraft 的模型里【不存在】的东西 ——
 *   它们最容易在来回转换中蒸发，而且不会报错。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么用真实存档的形状
 *
 *   测试数据照抄 timeline-state.json 里的真实 clip（含 shot/handoff/rendered）。
 *   自己编一个「只有 id 和 in/out」的简化 clip 测不出问题 ——
 *   而问题恰恰出在那些「ArtCraft 不认识的字段」上。
 */

import {
  toArtCraft, fromArtCraft, clipToElement,
  secToTime, timeToSec, fpsToRate,
} from "./src/timeline-projection.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 240) : ""}`);
  }
}

console.log("═".repeat(66));
console.log("  工程投影层：我们的 timeline ⇄ ArtCraft TProject");
console.log("═".repeat(66));

/* 真实存档形状（照抄 timeline-state.json） */
const REAL_CLIP = {
  id: "c_mvcg4fvj_4",
  kind: "video",
  name: "分镜 1",
  src: "（待生成）",
  in: 0, out: 5, speed: 1, crop: null, gain: 1,
  trim: { startSec: 1, endSec: 3 },
  shot: {
    modeId: "yz", prompt: "人定的提示词 21:06:23", aspect: "16:9",
    durationSec: 5, steps: null, seed: null, toggles: {}, media: {}, history: [],
  },
  /**
   * ★★ 2026-10-20 修正：这条 clip 的 rendered 原本照抄了真实存档（有值）
   *
   *   真实存档里那个 clip 是「已经生成过」的状态（rendered 有 yz-result.mp4）。
   *   用它来测「待生成的 clip 被跳过」自相矛盾 —— 有 rendered 就说明生成过了。
   *
   *   实测抓出来：改了投影逻辑（rendered 也算有媒体）之后，
   *   这条断言立刻红了，因为它同时满足「src 待生成」和「rendered 有值」。
   *
   *   ⇒ 拆成两个 fixture：
   *     REAL_CLIP      确实还没生成过 → rendered: null
   *     RENDERED_ONLY  生成过了但 src 没改 → 靠 rendered 投影
   */
  rendered: null,
  regenError: null,
  fromVideoClipId: null,
  handoff: {
    locks: { prompt: { by: "user", at: 1792328783069, fp: "316869238" } },
    log: [{ at: 1792328783069, by: "user", field: "prompt", fp: "316869238" }],
  },
};

/**
 * 生成过、但 src 仍是「（待生成）」的 clip。
 *
 * ★ 这是我们的生成链路的真实状态：
 *   ComfyUI 出图 → /timeline/cmd/replace-clip 写 rendered，【从不改 src】。
 *   所以投影不能只看 src，必须也看 rendered，
 *   否则每一个真正生成出来的镜头在 ArtCraft 里都看不见。
 */
const RENDERED_ONLY = {
  ...REAL_CLIP,
  id: "c_rendered_only",
  name: "分镜 3",
  rendered: {
    path: "D:\\主工作区\\DSH视频工作台\\docs\\evidence\\yz-result.mp4",
    url: null, filename: "yz-result.mp4", durationSec: null,
    generatedAt: 1792248820967, replaced: true,
  },
};

/* 已生成的 clip（src 是真实文件名） */
const DONE_CLIP = {
  ...REAL_CLIP,
  id: "c_done_1",
  name: "分镜 2",
  src: "Krea2-USD-20261018_00008_.png",
  in: 0, out: 4,
  trim: { startSec: 0, endSec: 2 },
};

const STATE = {
  version: 1, savedAt: 1792000000000, fps: 24,
  name: "未命名粗剪", nextShotIndex: 5,
  tracks: [
    { id: "t_v", kind: "video", name: "视频 1", clips: [REAL_CLIP, DONE_CLIP] },
    { id: "t_a", kind: "audio", name: "音频 1", clips: [] },
  ],
};

/* ─── ① 时间换算 ────────────────────────────────────────── */
console.log("\n① 时间换算（ArtCraft 的 MediaTime 是分数，不是浮点）");
{
  /**
   * ★★ 2026-10-20 修正断言：MediaTime 是【整数 tick】，不是 {numerator, denominator}
   *
   *   证据（video-editor/src/lib/wasm/media-time.ts 逐字）：
   *     export type MediaTime = number & { readonly __mediaTime: unique symbol };
   *     export const TICKS_PER_SECOND = _TICKS_PER_SECOND();
   *     function isMediaTime(value) { return Number.isInteger(value); }
   *   TICKS_PER_SECOND 实测 = 120000（node import opencut-wasm 得到）
   *
   *   我原来断言的是 {numerator, denominator} 对象 —— 那是 FrameRate 的类型，
   *   不是时间。搞混之后 ArtCraft 报 "addMediaTime(): expected an integer tick count"。
   */
  const t1 = secToTime(1.5);
  t("1.5 秒 → 180000 tick（120000/秒）", t1 === 180000, t1);
  t("结果是整数", Number.isInteger(t1), t1);
  t("转回来还是 1.5", timeToSec(t1) === 1.5, timeToSec(t1));

  const t2 = secToTime(0.1 + 0.2);        // 浮点误差经典用例
  t("0.1+0.2 也得到整数 tick", Number.isInteger(t2), t2);
  t("且值正确（0.3 秒）", Math.abs(timeToSec(t2) - 0.3) < 1e-9, timeToSec(t2));

  t("undefined 当 0", timeToSec(undefined) === 0);
  t("裸数字按 tick 解析", timeToSec(300000) === 2.5, timeToSec(300000));

  const r = fpsToRate(24);
  t("fps 24 → {numerator:24, denominator:1}", r.numerator === 24 && r.denominator === 1, r);
  const bad = fpsToRate("abc");
  t("坏 fps 兜底 30（不产生 NaN）", bad.numerator === 30, bad);
}

/* ─── ② clip → element ──────────────────────────────────── */
console.log("\n② 单条 clip 投影");
{
  const el = clipToElement(DONE_CLIP, { fps: 24 });
  t("已生成的 clip 能投影", el !== null, el);
  t("id 保留", el?.id === "c_done_1");
  t("name 保留", el?.name === "分镜 2");
  /**
   * ★★ 2026-10-20 修正断言：duration 应等于 trim 区间长度，不是 out-in
   *
   *   DONE_CLIP 是 trim={0,2} 的素材 ⇒ 时间轴上占 2 秒，不是 4 秒。
   *   原来断言 out-in=4 是基于「duration 恒等于源素材全长」的错假设，
   *   那个假设导致 trim 改了但时间轴不变（静默失效）。
   */
  t("duration = trim 区间 = 2 秒", timeToSec(el?.duration) === 2, timeToSec(el?.duration));
  t("duration 不等于 out-in（那是源素材全长）", timeToSec(el?.duration) !== 4);
  t("trimStart = 0", timeToSec(el?.trimStart) === 0);
  t("trimEnd = 2", timeToSec(el?.trimEnd) === 2);
  t("mediaId 带 src 前缀", el?.mediaId === "output:Krea2-USD-20261018_00008_.png", el?.mediaId);

  /**
   * ★★ 核心：`src === "（待生成）"` 的 clip 必须【跳过】。
   *   ArtCraft 需要 mediaId 才能画出元素；硬投影会得到一个空白块。
   */
  const pending = clipToElement(REAL_CLIP, { fps: 24 });
  t("待生成的 clip 被跳过（返回 null）", pending === null, pending);

  /**
   * ★★ 2026-10-20 加（实测抓到的真 bug）
   *
   *   「待生成」是一个真值字符串，所以 `src || rendered.filename`
   *   会返回「（待生成）」而不是回退到 rendered。
   *
   *   而我们的生成链路（ComfyUI 出图 → replace-clip 写 rendered）
   *   【从不改 src】。所以如果只看 src，每一个真正生成出来的镜头
   *   在 ArtCraft 里都看不见。
   */
  const el2 = clipToElement(RENDERED_ONLY, { fps: 24 });
  t("只靠 rendered 也能投影（src 仍是待生成）", el2 !== null, el2);
  t("mediaId 取 rendered.filename 而不是「（待生成）」",
    el2?.mediaId === "output:yz-result.mp4", el2?.mediaId);
  t("mediaId 里不含「待生成」三个字",
    !String(el2?.mediaId ?? "").includes("待生成"), el2?.mediaId);

  t("零长度 clip 被跳过", clipToElement({ ...DONE_CLIP, in: 3, out: 3 }) === null);
  t("空输入不崩", clipToElement(null) === null && clipToElement(undefined) === null);
}

/* ─── ③ 整个工程投影 ────────────────────────────────────── */
console.log("\n③ 整个 state → TProject");
let project;
{
  project = toArtCraft(STATE, { projectId: "p1" });
  t("有 metadata", !!project.metadata);
  t("有 scenes（1 个）", project.scenes?.length === 1, project.scenes?.length);
  t("主场景 isMain=true", project.scenes[0].isMain === true);
  t("currentSceneId 指向主场景", project.currentSceneId === project.scenes[0].id);
  t("settings.fps 是分数", project.settings.fps.numerator === 24, project.settings.fps);

  const vt = project.scenes[0].tracks.main;
  t("视频轨存在", !!vt);
  t("视频轨 type=video", vt.type === "video");
  /**
   * ★ 只有 DONE_CLIP 能投影过去，REAL_CLIP（待生成）被跳过。
   *   这是设计行为，不是 bug。
   */
  t("elements 只含已生成的（1 个）", vt.elements.length === 1, vt.elements.map((e) => e.name));
  t("跳过的那个是「分镜 1」（待生成）",
    !vt.elements.some((e) => e.name === "分镜 1"));

  /**
   * ★★ 2026-10-20 修正断言：没有音频元素时，audio 轨返回【空数组】
   *
   *   语义：一条没有任何元素的轨道在 ArtCraft 里只占垂直空间、什么都不显示。
   *   投影时干脆不造它。
   *   原来断言「audio[0] 存在且 elements 为空」是基于「总是造轨」的假设。
   */
  const audioTracks = project.scenes[0].tracks.audio;
  t("没有音频元素时不造音频轨（空数组）",
    Array.isArray(audioTracks) && audioTracks.length === 0, audioTracks);

  // startTime 应该是累加的（第一条从 0 开始）
  t("startTime 从 0 开始", timeToSec(vt.elements[0].startTime) === 0);

  t("element 带 params 字段（ArtCraft 要求）", vt.elements[0].params !== undefined);
  /**
   * ★★ 2026-10-20 修正断言：type 按【实际文件扩展名】判，不是 clip.kind
   *
   *   DONE_CLIP 的 src 是 .png ⇒ type 应该是 image。
   *   原来断言 video 是基于 clip.kind（那是「在哪条轨上」不是媒体类型），
   *   那个错误导致 ArtCraft 用 <video> 加载 PNG，静默失败。
   */
  t("element 的 type 按扩展名判 = image", vt.elements[0].type === "image", vt.elements[0].type);
}

/* ─── ④ 回写：只取 trim 与顺序 ──────────────────────────── */
console.log("\n④ fromArtCraft 只回写 trim / 顺序，其余字段不许动");
{
  // 模拟用户在 ArtCraft 里改了裁切
  const mutated = JSON.parse(JSON.stringify(project));
  mutated.scenes[0].tracks.main.elements[0].trimStart = secToTime(0.5);
  mutated.scenes[0].tracks.main.elements[0].trimEnd = secToTime(1.25);

  const { next, changed } = fromArtCraft(STATE, mutated);

  const c = next.tracks[0].clips.find((x) => x.id === "c_done_1");
  t("trim.startSec 被更新成 0.5", c.trim.startSec === 0.5, c.trim.startSec);
  t("trim.endSec 被更新成 1.25", c.trim.endSec === 1.25, c.trim.endSec);
  t("changed 里记了 trim", changed.some((s) => s.includes("trim")), changed);

  /**
   * ★★ 这是整份验收最重要的一条：
   *   shot / handoff / rendered 必须【一个字节都没变】。
   *   它们是 ArtCraft 模型里不存在的东西，最容易在转换中蒸发且不报错。
   */
  const orig = STATE.tracks[0].clips;
  const keep = next.tracks[0].clips;
  const origById = Object.fromEntries(orig.map((x) => [x.id, x]));
  const lostFields = [];
  for (const k of keep) {
    const o = origById[k.id];
    if (!o) continue;
    if (JSON.stringify(o.shot) !== JSON.stringify(k.shot)) lostFields.push(`${k.id}.shot`);
    if (JSON.stringify(o.handoff) !== JSON.stringify(k.handoff)) lostFields.push(`${k.id}.handoff`);
    if (JSON.stringify(o.rendered) !== JSON.stringify(k.rendered)) lostFields.push(`${k.id}.rendered`);
  }
  t("shot / handoff / rendered 全部原样保留", lostFields.length === 0, lostFields);

  // 入参不许被改（纯函数）
  t("原 STATE 的 trim 没被改动（纯函数）",
    STATE.tracks[0].clips.find((x) => x.id === "c_done_1").trim.endSec === 2);

  // 没有变化时 changed 应该是空的
  const same = JSON.parse(JSON.stringify(project));
  const r2 = fromArtCraft(STATE, same);
  t("没有改动时 changed 为空", r2.changed.length === 0, r2.changed);

  // 待生成的 clip 不能被 ArtCraft 弄丢
  t("没投影过去的「分镜 1」仍在（末尾）",
    r2.next.tracks[0].clips.some((x) => x.id === REAL_CLIP.id),
    r2.next.tracks[0].clips.map((x) => x.name));
}

/* ─── ⑤ 顺序回写 ────────────────────────────────────────── */
console.log("\n⑤ 顺序回写");
{
  const st = JSON.parse(JSON.stringify(STATE));
  // 加两条能投影的 clip
  st.tracks[0].clips = [
    { ...DONE_CLIP, id: "a", name: "A" },
    { ...DONE_CLIP, id: "b", name: "B" },
    { ...DONE_CLIP, id: "c", name: "C" },
  ];
  const p = toArtCraft(st, {});
  t("三条都投影了", p.scenes[0].tracks.main.elements.length === 3,
    p.scenes[0].tracks.main.elements.length);

  // 模拟在 ArtCraft 里拖成 C-B-A
  const els = p.scenes[0].tracks.main.elements;
  p.scenes[0].tracks.main.elements = [els[2], els[1], els[0]];
  const { next, changed } = fromArtCraft(st, p);
  const ids = next.tracks[0].clips.map((x) => x.id);
  t("顺序变成 C,B,A", ids.join(",") === "c,b,a", ids);
  t("changed 里记了 order", changed.some((s) => s.includes("order")), changed);
}

/* ─── ⑥ 边界 ────────────────────────────────────────────── */
console.log("\n⑥ 边界与坏输入");
{
  t("空 state 不崩", toArtCraft({}, {})?.scenes?.length === 1);
  t("undefined state 不崩", toArtCraft(undefined, {})?.scenes?.length === 1);
  t("空 tracks 不崩", toArtCraft({ tracks: [] }, {}).scenes[0].tracks.main.elements.length === 0);
  t("没有 scenes 的 project 回写不崩", fromArtCraft(STATE, {}).next.tracks.length === 2);
  t("fromArtCraft 不修改入参", (() => {
    const s = JSON.parse(JSON.stringify(STATE));
    const before = JSON.stringify(s);
    fromArtCraft(s, project);
    return JSON.stringify(s) === before;
  })());
}

/* ─── 汇总 ─────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  工程投影层全过（shot / handoff / rendered 一个都没丢）");
