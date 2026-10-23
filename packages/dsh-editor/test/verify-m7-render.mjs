/**
 * M7 ffmpeg 渲染器验收 —— 时间轴模型 → 真实成片。
 *
 * 这是 M7 的第二层。第一层（timeline.mjs，35/35）只验数据，
 * 这一层验【生成的 ffmpeg 命令真能跑出正确的成片】。
 *
 * 六组判据：
 *   ① 命令生成器是纯函数（同输入同输出，不碰文件系统）
 *   ② 单段渲染：时长/尺寸对
 *   ③ 多段拼接（波纹删除后）：总时长 = 各段之和，且无黑场
 *   ④ 变速：时长变化对，帧率不翻倍，音频不变调（时长对即证明）
 *   ⑤ 裁剪：输出尺寸符合比例
 *   ⑥ 音频轨独立：视频轨 + 音频轨各自的内容都进了成片
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  createTimeline, addTrack, addClip, removeClipRipple, layoutTrack, timelineDuration,
} from "../src/timeline.mjs";
import { buildRenderCommand, commandLine } from "../src/render.mjs";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
/**
 * ★ 2026-10-23：原来是 ?? ""，没有环境变量就直接 exit(1) ——
 *   导致这个脚本永远无法登记进 verify-all（登记了也必红）。
 *   改成回退到仓库里的证据视频（相对本文件解析，不写死绝对路径）。
 */
const __HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.env.EVIDENCE_VIDEO
  ?? path.resolve(__HERE, "../../docs/evidence/yz-result.mp4");
const SRC2 = process.env.EVIDENCE_VIDEO2 ?? process.env.EVIDENCE_VIDEO ?? "";
const OUT = process.env.EVIDENCE_OUT ?? "";

let pass = 0, fail = 0;
const failures = [];
async function t(desc, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${String(err.message).slice(0, 500)}`);
    fail++; failures.push(desc);
  }
}

function runFf(args) {
  return new Promise((resolve, reject) => {
    const c = spawn(FFMPEG, args, { windowsHide: true });
    let out = "";
    c.stderr.on("data", (d) => { out += d.toString("utf8"); });
    c.on("error", reject);
    c.on("close", (code) => resolve({ code, output: out }));
  });
}

async function probe(file) {
  const r = await runFf(["-hide_banner", "-i", file]);
  const o = r.output;
  const d = o.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  const dur = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const vLine = (o.split("\n").find((l) => /Video:/.test(l)) ?? "").replace(/\([^)]*\)/g, " ");
  const size = /(\d{2,5})x(\d{2,5})/.exec(vLine);
  const fps = /,\s*([\d.]+)\s*fps/.exec(vLine);
  return {
    durationSec: dur,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
    hasVideo: /Video:/.test(o),
    hasAudio: /Audio:/.test(o),
    sizeBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
  };
}

// ── 前置 ──
console.log("═══ 前置 ═══");
/**
 * ★ 2026-10-23：没素材时【跳过】而不是失败。
 *
 *   跳过与失败必须分开 ——
 *     跳过 = 这条验收今天不适用（没素材）
 *     失败 = 功能坏了
 *   混在一起会让「没素材」显示成「功能坏了」，把真问题淹掉。
 */
if (!fs.existsSync(SRC)) {
  console.log(`  – 跳过：素材不存在（${SRC}）`);
  console.log("     设 EVIDENCE_VIDEO 环境变量指向一个视频即可运行本验收");
  console.log("");
  console.log("  通过 0 / 0（跳过）");
  process.exit(0);
}
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const srcInfo = await probe(SRC);
console.log(`     源素材 ${srcInfo.durationSec}s ${srcInfo.width}x${srcInfo.height} ${srcInfo.fps}fps audio=${srcInfo.hasAudio}`);
if (!srcInfo.hasAudio) { console.error("  ✗ 源素材没有音轨，无法测音频"); process.exit(1); }

// ══════════════════════════════════════════════════════
console.log("\n═══ ① 命令生成器是纯函数 ═══");

await t("同输入生成同命令（不碰文件系统）", () => {
  const mk = () => {
    const tl = createTimeline(24);
    addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 2 });
    return tl;
  };
  const a = buildRenderCommand(mk(), { out: "x.mp4" });
  const b = buildRenderCommand(mk(), { out: "x.mp4" });
  return JSON.stringify(a.args) === JSON.stringify(b.args) ? true : "两次生成不一致";
});

await t("返回 args 数组 + filter 字符串", () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 2 });
  const r = buildRenderCommand(tl, { out: "x.mp4" });
  if (!Array.isArray(r.args)) return "args 不是数组";
  if (typeof r.filter !== "string") return "filter 不是字符串";
  return r.args.includes("-filter_complex") ? true : "没有 -filter_complex";
});

await t("空时间轴会报错而不是生成坏命令", () => {
  const tl = createTimeline(24);
  try { buildRenderCommand(tl, { out: "x.mp4" }); } catch { return true; }
  return "空时间轴没报错";
});

await t("多视频轨给出警告（第一版只渲染第一条）", () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 1 });
  const t2 = addTrack(tl, "video");
  addClip(tl, t2.id, { src: SRC, in: 1, out: 2 });
  const r = buildRenderCommand(tl, { out: "x.mp4" });
  return r.warn.length > 0 && r.warn[0].includes("多轨") ? true : JSON.stringify(r.warn);
});

// ══════════════════════════════════════════════════════
console.log("\n═══ ② 单段渲染 ═══");

await t("单段 1.5 秒，输出时长对", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0.5, out: 2.0 }); // 1.5s
  const out = path.join(OUT, "single.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  if (i.sizeBytes === 0) return "输出为空";
  if (!i.hasAudio) return "丢了音轨";
  return Math.abs(i.durationSec - 1.5) < 0.3 ? true : `时长 ${i.durationSec}s，期望 ≈1.5s`;
});

// ══════════════════════════════════════════════════════
console.log("\n═══ ③ ★ 多段拼接（波纹删除后）═══");

await t("三段各 0.5s，删中间后总时长 ≈1.0s", async () => {
  const tl = createTimeline(24);
  const tid = tl.tracks[0].id;
  addClip(tl, tid, { src: SRC, in: 0.0, out: 0.5 });
  const mid = addClip(tl, tid, { src: SRC, in: 1.0, out: 1.5 });
  addClip(tl, tid, { src: SRC, in: 2.0, out: 2.5 });
  removeClipRipple(tl, tid, mid.id);

  const expect = timelineDuration(tl);
  const out = path.join(OUT, "ripple.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  if (!i.hasAudio) return "拼接后丢了音轨";
  return Math.abs(i.durationSec - expect) < 0.35 ? true : `模型说 ${expect.toFixed(2)}s，成片 ${i.durationSec}s`;
});

await t("★ 拼接无黑场（第 0.45s 与第 0.55s 都有内容）", async () => {
  // 用 ffmpeg 抽两帧，检查不是纯黑
  const f1 = path.join(OUT, "chk-a.png");
  const f2 = path.join(OUT, "chk-b.png");
  const out = path.join(OUT, "ripple.mp4");
  await runFf(["-y", "-ss", "0.45", "-i", out, "-frames:v", "1", f1]);
  await runFf(["-y", "-ss", "0.55", "-i", out, "-frames:v", "1", f2]);
  if (!fs.existsSync(f1) || !fs.existsSync(f2)) return "抽帧失败";
  // 用文件大小做粗判：纯黑 PNG 压缩后极小（< 3KB），有内容会更大
  const s1 = fs.statSync(f1).size;
  const s2 = fs.statSync(f2).size;
  if (s1 < 3000) return `第 0.45s 那帧只有 ${s1} 字节，疑似黑场`;
  if (s2 < 3000) return `第 0.55s 那帧只有 ${s2} 字节，疑似黑场`;
  return true;
});

// ══════════════════════════════════════════════════════
console.log("\n═══ ④ ★ 变速 ═══");

await t("2 倍速：1s 素材 → 0.5s 成片", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 1, speed: 2 });
  const out = path.join(OUT, "speed2x.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  return Math.abs(i.durationSec - 0.5) < 0.25 ? true : `时长 ${i.durationSec}s，期望 ≈0.5s`;
});

await t("★ 2 倍速后帧率仍是 24（不是 48）", async () => {
  const i = await probe(path.join(OUT, "speed2x.mp4"));
  if (!i.fps) return "读不到帧率";
  return Math.abs(i.fps - 24) < 0.5 ? true : `帧率 ${i.fps}，应为 24`;
});

await t("2 倍速后仍有音轨", async () => {
  const i = await probe(path.join(OUT, "speed2x.mp4"));
  return i.hasAudio ? true : "变速后丢了音轨";
});

await t("0.5 倍速：1s 素材 → 2s 成片", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 1, speed: 0.5 });
  const out = path.join(OUT, "speed05x.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  return Math.abs(i.durationSec - 2) < 0.4 ? true : `时长 ${i.durationSec}s，期望 ≈2s`;
});

// ══════════════════════════════════════════════════════
console.log("\n═══ ⑤ 裁剪 ═══");

await t("裁成 1:1，输出是正方形", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 1, crop: { x: 0, y: 0, w: 1, h: 1 } });
  // 注意：crop 的 w/h 是相对于原图的百分比，1:1 需要按原图比例算
  // 这里改用具体数值：原图 1664x928，裁中间 928x928
  const tl2 = createTimeline(24);
  addClip(tl2, tl2.tracks[0].id, {
    src: SRC, in: 0, out: 1,
    crop: { x: (1664 - 928) / 2 / 1664, y: 0, w: 928 / 1664, h: 1 },
  });
  const out = path.join(OUT, "crop1-1.mp4");
  const r = buildRenderCommand(tl2, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  if (!i.width) return "读不到尺寸";
  return Math.abs(i.width - i.height) <= 4 ? true : `${i.width}x${i.height} 不是正方形`;
});

// ══════════════════════════════════════════════════════
console.log("\n═══ ⑥ 音视频分轨 ═══");

await t("有独立音频轨时，成片有音频", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 1 });
  const aud = path.join(OUT, "aud.m4a");
  await runFf(["-y", "-i", SRC, "-vn", "-c:a", "aac", aud]);
  const aTrack = tl.tracks.find((x) => x.kind === "audio");
  addClip(tl, aTrack.id, { src: aud, in: 0, out: 1 });

  const out = path.join(OUT, "with-audio-track.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  return i.hasVideo && i.hasAudio ? true : `hasVideo=${i.hasVideo} hasAudio=${i.hasAudio}`;
});

await t("muteAudio 时成片无音轨", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 1 });
  const out = path.join(OUT, "muted.mp4");
  const r = buildRenderCommand(tl, { out, muteAudio: true });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}`;
  const i = await probe(out);
  return i.hasAudio === false ? true : "静音模式下仍有音轨";
});

// ══════════════════════════════════════════════════════
console.log("\n═══ 产物清单 ═══");
for (const f of fs.readdirSync(OUT)) {
  const st = fs.statSync(path.join(OUT, f));
  if (st.isFile()) console.log(`     ${f.padEnd(26)} ${(st.size / 1024).toFixed(0)} KB`);
}

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M7 ffmpeg 渲染器验收全过");


