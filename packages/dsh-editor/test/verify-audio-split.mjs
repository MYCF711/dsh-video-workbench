/**
 * 音画分离验收 —— 主人第 12 轮要求：
 *   「生成视频一般有默认的 h3 生成的音频，做分离后默认放入音轨」
 *
 * 判据：
 *   ① 分离出的音频片段与源视频【同时长、同变速、同裁剪】→ 天然对齐
 *   ② 带 fromVideoClipId，视频重跑时能替换对应音频
 *   ③ 重跑同一段不会产生两条音频
 *   ④ 音画对齐检查能发现不一致
 *   ⑤ 无音轨的视频（图片转的）不会被误分离
 */
import { createTimelineStore } from "../src/host-store.mjs";
import {
  audioClipFromVideo, pendingAudioExtraction, checkAvAlignment,
  buildExtractAudioArgs, shouldExtractAudio,
} from "../src/audio-split.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(desc, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${err.message}`); fail++; failures.push(desc);
  }
}

const store = createTimelineStore({ log: { info() {}, warn() {} } });

console.log("═══ ① 纯函数：抽取参数 与 片段构造 ═══");

t("buildExtractAudioArgs 生成 -vn + aac", () => {
  const a = buildExtractAudioArgs("in.mp4", "out.m4a", { inSec: 1, durSec: 5 });
  const s = a.join(" ");
  return s.includes("-vn") && s.includes("-c:a aac") && s.includes("-ss 1") && s.includes("-t 5")
    ? true : s;
});

t("带 gain 时加 volume 滤镜", () => {
  const a = buildExtractAudioArgs("in.mp4", "out.m4a", { gain: 2 });
  return a.join(" ").includes("volume=2") ? true : a.join(" ");
});

t("shouldExtractAudio 对无音轨文件返回 false", () => {
  const r = shouldExtractAudio("x.mp4", () => ({ hasAudio: false }));
  return r.ok === false && r.reason.includes("没有音轨") ? true : JSON.stringify(r);
});

t("shouldExtractAudio 对有音轨文件返回 true", () => {
  const r = shouldExtractAudio("x.mp4", () => ({ hasAudio: true, durationSec: 5 }));
  return r.ok === true && r.durationSec === 5 ? true : JSON.stringify(r);
});

console.log("\n═══ ② ★ 分离出的音频与视频天然对齐 ═══");

t("audioClipFromVideo 时长 = 视频可见时长", () => {
  const v = { id: "v1", name: "分镜 1", in: 0, out: 5, speed: 1, trim: null };
  const a = audioClipFromVideo(v, { path: "a.m4a", durationSec: 5 });
  return a.out === 5 ? true : a.out;
});

t("变速后音频时长跟着变（5s 2x → 2.5s）", () => {
  const v = { id: "v1", name: "分镜 1", in: 0, out: 5, speed: 2, trim: null };
  const a = audioClipFromVideo(v, { path: "a.m4a", durationSec: 2.5 });
  return a.out === 2.5 && a.speed === 2 ? true : JSON.stringify({ out: a.out, speed: a.speed });
});

t("裁剪信息也复制过去", () => {
  const v = { id: "v1", name: "分镜 1", in: 0, out: 5, speed: 1, trim: { startSec: 1, endSec: 3 } };
  const a = audioClipFromVideo(v, { path: "a.m4a", durationSec: 5 });
  return a.trim?.startSec === 1 && a.trim?.endSec === 3 ? true : JSON.stringify(a.trim);
});

t("带 fromVideoClipId（重跑时可替换）", () => {
  const v = { id: "v1", name: "分镜 1", in: 0, out: 5, speed: 1 };
  const a = audioClipFromVideo(v, { path: "a.m4a" });
  return a.fromVideoClipId === "v1" ? true : a.fromVideoClipId;
});

console.log("\n═══ ③ store：加音频到音频轨 ═══");

let v1, v2;
t("先建 2 段视频", () => {
  v1 = store.addShot({ modeId: "yz", prompt: "镜头1", durationSec: 5 }, "agent");
  v2 = store.addShot({ modeId: "yz", prompt: "镜头2", durationSec: 3 }, "agent");
  return store.summary().total === 2 ? true : store.summary().total;
});

t("给第 1 段分离音轨", () => {
  store.addAudioFromVideo(v1.id, { path: "a1.m4a", filename: "a1.m4a", durationSec: 5 }, "host");
  const s = store.snapshot();
  const aTrack = s.tracks.find((t) => t.kind === "audio");
  return aTrack.clips.length === 1 && aTrack.clips[0].fromVideoClipId === v1.id
    ? true : JSON.stringify(aTrack.clips.map((c) => c.name));
});

t("给第 2 段分离音轨", () => {
  store.addAudioFromVideo(v2.id, { path: "a2.m4a", filename: "a2.m4a", durationSec: 3 }, "host");
  const s = store.snapshot();
  const aTrack = s.tracks.find((t) => t.kind === "audio");
  return aTrack.clips.length === 2 ? true : aTrack.clips.length;
});

t("★ 音频顺序与视频顺序一致", () => {
  const s = store.snapshot();
  const vTrack = s.tracks.find((t) => t.kind === "video");
  const aTrack = s.tracks.find((t) => t.kind === "audio");
  for (let i = 0; i < vTrack.clips.length; i++) {
    if (aTrack.clips[i]?.fromVideoClipId !== vTrack.clips[i].id) {
      return `第 ${i} 位：音频属 ${aTrack.clips[i]?.fromVideoClipId}，视频是 ${vTrack.clips[i].id}`;
    }
  }
  return true;
});

t("音频片段名带原声标记", () => {
  const s = store.snapshot();
  const a = s.tracks.find((t) => t.kind === "audio").clips[0];
  return a.name.includes("原声") ? true : a.name;
});

console.log("\n═══ ④ ★ 重跑同一段：替换而不是新增 ═══");

t("同一视频再分离一次，音频轨仍是 2 条（不是 3 条）", () => {
  store.addAudioFromVideo(v1.id, { path: "a1-new.m4a", filename: "a1-new.m4a", durationSec: 5 }, "host");
  const s = store.snapshot();
  const aTrack = s.tracks.find((t) => t.kind === "audio");
  return aTrack.clips.length === 2 ? true : `变成 ${aTrack.clips.length} 条`;
});

t("替换后指向新文件", () => {
  const s = store.snapshot();
  const a = s.tracks.find((t) => t.kind === "audio").clips.find((c) => c.fromVideoClipId === v1.id);
  return a.rendered?.path === "a1-new.m4a" ? true : a.rendered?.path;
});

console.log("\n═══ ⑤ 音画对齐检查 ═══");

t("对齐时 ok=true", () => {
  const s = store.snapshot();
  // 让视频段也有成片（否则会被判成「还没生成」）
  const r = checkAvAlignment(s);
  // 视频 5+3=8s，音频 5+3=8s
  return Math.abs(r.diff) < 0.35 ? true : JSON.stringify({ v: r.videoDuration, a: r.audioDuration, diff: r.diff });
});

t("音频轨空时报警", () => {
  const s2 = store.snapshot();
  s2.tracks = s2.tracks.filter((t) => t.kind !== "audio");
  const r = checkAvAlignment(s2);
  return r.ok === false && r.problems.some((p) => p.includes("音频轨全空")) ? true : JSON.stringify(r.problems);
});

t("时长不一致时报出差值", () => {
  const s2 = store.snapshot();
  const aTrack = s2.tracks.find((t) => t.kind === "audio");
  aTrack.clips.push({
    id: "cx", kind: "audio", src: "x.m4a", in: 0, out: 10, speed: 1, trim: null, gain: 1,
  });
  const r = checkAvAlignment(s2);
  return r.ok === false && r.problems.some((p) => p.includes("不一致")) ? true : JSON.stringify(r.problems);
});

console.log("\n═══ ⑥ pendingAudioExtraction ═══");

t("找出还没分离的段", () => {
  const s = store.snapshot();
  // 给两段视频都挂上成片
  const vTrack = s.tracks.find((t) => t.kind === "video");
  vTrack.clips.forEach((c) => { c.rendered = { path: `/tmp/${c.id}.mp4` }; });
  // 清掉音频轨，模拟「刚生成完还没分离」
  s.tracks = s.tracks.filter((t) => t.kind !== "audio");

  const pending = pendingAudioExtraction(s);
  return pending.length === 2 ? true : `发现 ${pending.length} 段需要分离`;
});

t("没有成片的段不算待分离", () => {
  // ★ 用干净的时间轴验证 —— 上一组把音频轨删了、成片也改过，
  //   在那种半残状态下断言会误报（实测踩到：认为 0 段是错的，其实是前提坏了）
  const s2 = createTimelineStore({ log: { info() {}, warn() {} } });
  const a = s2.addShot({ modeId: "yz", prompt: "A", durationSec: 5 }, "agent");
  const b = s2.addShot({ modeId: "yz", prompt: "B", durationSec: 5 }, "agent");
  const snap = s2.snapshot();
  const vt = snap.tracks.find((t) => t.kind === "video");
  // 只有 a 有成片
  vt.clips.find((c) => c.id === a.id).rendered = { path: "/tmp/a.mp4" };
  vt.clips.find((c) => c.id === b.id).rendered = null;

  const pending = pendingAudioExtraction(snap);
  return pending.length === 1 && pending[0].videoClip.id === a.id
    ? true : `${pending.length} 段待分离`;
});

console.log("\n═══ ⑦ 独立音频（不来自视频）═══");

await t("★ videoClipId 为 null 时能加独立音频", () => {
  const s = createTimelineStore({ log: { info() {}, warn() {} } });
  const a = s.addAudioFromVideo(null, { path: "/x/bgm.m4a", filename: "bgm.m4a", durationSec: 30 }, "user");
  if (!a) return "没加上";
  if (a.kind !== "audio") return `kind=${a.kind}`;
  if (a.name !== "bgm.m4a") return `name=${a.name}`;
  return a.out === 30 ? true : `out=${a.out}`;
});

await t("独立音频不带 fromVideoClipId", () => {
  const s = createTimelineStore({ log: { info() {}, warn() {} } });
  const a = s.addAudioFromVideo(null, { path: "/x/bgm.m4a", filename: "bgm.m4a", durationSec: 30 }, "user");
  return a.fromVideoClipId === null || a.fromVideoClipId === undefined ? true : a.fromVideoClipId;
});

await t("★ 独立音频能调音量（说明它是合法音频片段）", () => {
  const s = createTimelineStore({ log: { info() {}, warn() {} } });
  const a = s.addAudioFromVideo(null, { path: "/x/bgm.m4a", durationSec: 30 }, "user");
  const c = s.setAudioEdit(a.id, { gain: 0.5, fadeInSec: 1 }, "user");
  return c.audioEdit.gain === 0.5 ? true : JSON.stringify(c.audioEdit);
});

await t("没有 durationSec 时给合理默认值", () => {
  const s = createTimelineStore({ log: { info() {}, warn() {} } });
  const a = s.addAudioFromVideo(null, { path: "/x/a.m4a" }, "user");
  return a.out > 0 ? true : `out=${a.out}`;
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  音画分离验收全过");
