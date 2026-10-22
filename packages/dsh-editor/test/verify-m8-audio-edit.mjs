/**
 * M8 音频编辑验收。
 *
 * ★ 本轮的认知纠正（写在这里防忘）
 *   我一开始以为「配音要装 TTS 模型」，查实后发现：
 *   yz 工作流的 VHS_VideoCombine 把 VAEDecode(audio) 一并封装进 mp4，
 *   H3 自己就生成音频。所以 M8 不是「生成音频」，是「编辑已有音频」。
 *
 * 判据：
 *   ① 滤镜顺序正确（淡入淡出必须在 volume 之前）
 *   ② 参数校验挡住不合理配置
 *   ③ 编辑只记意图，不改文件（可撤销）
 *   ④ 音频轨体检能发现「会出无声片」
 */
import {
  DEFAULT_AUDIO_EDIT, normalizeAudioEdit, validateAudioEdit,
  buildAudioFilters, applyAudioEditToClip, auditAudioTrack, describeAudioEdit,
} from "../src/audio-edit.mjs";
import { createTimelineStore } from "../src/host-store.mjs";

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

// ══════════════════════════════════════════════════
console.log("═══ ① 归一化 ═══");

t("默认值是原样", () => {
  const e = normalizeAudioEdit();
  return e.gain === 1 && e.fadeInSec === 0 && e.fadeOutSec === 0 && e.muted === false
    ? true : JSON.stringify(e);
});

t("非法 gain 被夹回默认", () => {
  const e = normalizeAudioEdit({ gain: 999 });
  return e.gain === 1 ? true : e.gain;
});

t("合法值保留", () => {
  const e = normalizeAudioEdit({ gain: 2.5, fadeInSec: 0.3, muted: true });
  return e.gain === 2.5 && e.fadeInSec === 0.3 && e.muted === true ? true : JSON.stringify(e);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ② ★ 滤镜顺序（关键）═══");

t("★ 淡入淡出在 volume 之前", () => {
  const f = buildAudioFilters({ gain: 2, fadeInSec: 0.5, fadeOutSec: 0.5 }, 5);
  const iFade = f.findIndex((x) => x.includes("afade"));
  const iVol = f.findIndex((x) => x.includes("volume"));
  if (iFade < 0) return "没有 afade";
  if (iVol < 0) return "没有 volume";
  return iFade < iVol ? true : `顺序错了：${f.join(", ")}`;
});

t("淡入从 0 开始", () => {
  const f = buildAudioFilters({ fadeInSec: 0.5 }, 5);
  return f.some((x) => x.includes("afade=t=in:st=0:d=0.5")) ? true : f.join(", ");
});

t("★ 淡出起点 = 时长 - 淡出长度", () => {
  const f = buildAudioFilters({ fadeOutSec: 1 }, 5);
  return f.some((x) => x.includes("afade=t=out:st=4:d=1")) ? true : f.join(", ");
});

t("静音时只出 volume=0", () => {
  const f = buildAudioFilters({ muted: true, gain: 3, fadeInSec: 1 }, 5);
  return f.length === 1 && f[0] === "volume=0" ? true : JSON.stringify(f);
});

t("原样时不出任何滤镜", () => {
  const f = buildAudioFilters({}, 5);
  return f.length === 0 ? true : JSON.stringify(f);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ③ 校验 ═══");

t("淡入+淡出超过时长被拒", () => {
  const v = validateAudioEdit({ fadeInSec: 3, fadeOutSec: 3 }, 4);
  return v.ok === false && v.problems.some((p) => p.includes("超过片段时长")) ? true : JSON.stringify(v);
});

t("gain 过大给出警告级问题", () => {
  const v = validateAudioEdit({ gain: 10 }, 5);
  return v.ok === false && v.problems.some((p) => p.includes("削波")) ? true : JSON.stringify(v);
});

t("静音时忽略其它参数", () => {
  const v = validateAudioEdit({ muted: true, fadeInSec: 99, fadeOutSec: 99 }, 2);
  return v.ok === true ? true : JSON.stringify(v);
});

t("正常配置通过", () => {
  const v = validateAudioEdit({ gain: 1.5, fadeInSec: 0.2, fadeOutSec: 0.2 }, 5);
  return v.ok === true ? true : JSON.stringify(v.problems);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ④ 应用到片段 ═══");

t("applyAudioEditToClip 带上 filters", () => {
  const clip = { src: "a.m4a", in: 0, out: 5, speed: 1, trim: null, rendered: { path: "/x/a.m4a" } };
  const r = applyAudioEditToClip(clip, { gain: 2, fadeInSec: 0.3 });
  return Array.isArray(r.filters) && r.filters.length === 2 && r.src === "/x/a.m4a"
    ? true : JSON.stringify(r);
});

t("★ 有 trim 时淡出按 trim 后时长算", () => {
  const clip = { src: "a.m4a", in: 0, out: 10, speed: 1, trim: { startSec: 2, endSec: 6 } };
  const r = applyAudioEditToClip(clip, { fadeOutSec: 1 });
  // trim 后时长 = 4，淡出应从 3 开始
  return r.filters.some((x) => x.includes("st=3:d=1")) ? true : JSON.stringify(r.filters);
});

t("muted 标记带出来", () => {
  const clip = { src: "a.m4a", in: 0, out: 5, speed: 1 };
  const r = applyAudioEditToClip(clip, { muted: true });
  return r.muted === true ? true : "没带出来";
});

// ══════════════════════════════════════════════════
console.log("\n═══ ⑤ store：只记意图不改文件 ═══");

const store = createTimelineStore({ log: { info() {}, warn() {} } });
let vc, ac;

t("建视频 + 分离音频", () => {
  vc = store.addShot({ modeId: "yz", prompt: "镜头1", durationSec: 5 }, "agent");
  store.replaceRendered(vc.id, { path: "/x/v.mp4", filename: "v.mp4", durationSec: 5 }, "user");
  ac = store.addAudioFromVideo(vc.id, { path: "/x/a.m4a", filename: "a.m4a", durationSec: 5 }, "host");
  return ac ? true : "没建上";
});

t("★ setAudioEdit 只写 audioEdit，不动 rendered", () => {
  const before = store.snapshot().tracks.find((t) => t.kind === "audio").clips[0].rendered.path;
  store.setAudioEdit(ac.id, { gain: 2, fadeInSec: 0.5 }, "user");
  const after = store.snapshot().tracks.find((t) => t.kind === "audio").clips[0];
  if (after.rendered.path !== before) return "★ rendered 被改了（不该）";
  return after.audioEdit?.gain === 2 ? true : JSON.stringify(after.audioEdit);
});

t("非音频片段拒绝 setAudioEdit", () => {
  try { store.setAudioEdit(vc.id, { gain: 2 }); } catch { return true; }
  return "没被拒";
});

t("淡入淡出超时长被拒", () => {
  try { store.setAudioEdit(ac.id, { fadeInSec: 5, fadeOutSec: 5 }); } catch { return true; }
  return "没被拒";
});

t("可撤销（设回默认）", () => {
  store.setAudioEdit(ac.id, { gain: 1, fadeInSec: 0, fadeOutSec: 0 }, "user");
  const a = store.snapshot().tracks.find((t) => t.kind === "audio").clips[0];
  return a.audioEdit.gain === 1 ? true : JSON.stringify(a.audioEdit);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ⑥ 音频轨体检 ═══");

t("音画一致时 ok", () => {
  const r = store.auditAudio();
  return r.ok === true && r.audioClips === 1 ? true : JSON.stringify(r);
});

t("★ 音频轨清空时警告「无声片」", () => {
  const s = store.snapshot();
  s.tracks = s.tracks.filter((t) => t.kind !== "audio");
  const r = auditAudioTrack(s);
  return r.warnings.some((w) => w.includes("无声片")) ? true : JSON.stringify(r);
});

t("★ 全静音时警告", () => {
  const s2 = createTimelineStore({ log: { info() {}, warn() {} } });
  const v = s2.addShot({ modeId: "yz", prompt: "x", durationSec: 5 }, "agent");
  s2.replaceRendered(v.id, { path: "/x/v.mp4" }, "user");
  const a = s2.addAudioFromVideo(v.id, { path: "/x/a.m4a", durationSec: 5 }, "host");
  s2.setAudioEdit(a.id, { muted: true }, "user");
  const r = auditAudioTrack(s2.snapshot());
  return r.warnings.some((w) => w.includes("都被静音")) ? true : JSON.stringify(r);
});

t("时长不一致报错", () => {
  const s3 = createTimelineStore({ log: { info() {}, warn() {} } });
  const v = s3.addShot({ modeId: "yz", prompt: "x", durationSec: 10 }, "agent");
  s3.replaceRendered(v.id, { path: "/x/v.mp4" }, "user");
  s3.addAudioFromVideo(v.id, { path: "/x/a.m4a", durationSec: 3 }, "host");
  const r = auditAudioTrack(s3.snapshot());
  return r.ok === false && r.problems.some((p) => p.includes("不一致")) ? true : JSON.stringify(r);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ⑦ 人话描述 ═══");

t("2 倍增益显示成 +6dB", () => {
  const s = describeAudioEdit({ gain: 2 });
  return s.includes("+6.0dB") ? true : s;
});

t("静音显示成「静音」", () => {
  return describeAudioEdit({ muted: true }) === "静音" ? true : describeAudioEdit({ muted: true });
});

t("原样显示成「原样」", () => {
  return describeAudioEdit({}) === "原样" ? true : describeAudioEdit({});
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M8 音频编辑验收全过");
