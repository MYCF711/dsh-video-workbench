/**
 * M7-b 前置验收 —— 单段裁剪（trim）在渲染器里真的生效。
 *
 * 要验的是「音画同步」：
 *   trim 只裁视频不裁音频 → 音画错位（这是最容易犯的错）
 *   判据：输出时长符合 trim 区间，且音频流仍在
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createTimeline, addClip } from "../src/timeline.mjs";
import { buildRenderCommand } from "../src/render.mjs";

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const SRC = process.env.EVIDENCE_VIDEO ?? "";
const OUT = process.env.EVIDENCE_OUT ?? "";

let pass = 0, fail = 0;
const failures = [];
async function t(desc, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${String(err.message).slice(0, 400)}`);
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

console.log("═══ 前置 ═══");
if (!fs.existsSync(SRC)) { console.error(`  ✗ 素材不存在：${SRC}`); process.exit(1); }
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const src = await probe(SRC);
console.log(`     源 ${src.durationSec}s ${src.width}x${src.height} ${src.fps}fps audio=${src.hasAudio}`);

// ══════════════════════════════════════════════════════
console.log("\n═══ ① 单段 trim ═══");

await t("取源 0~2s，再 trim 0.5~1.5 → 输出 1s", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, {
    src: SRC, in: 0, out: 2,
    trim: { startSec: 0.5, endSec: 1.5 },
  });
  const out = path.join(OUT, "trim-single.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  return Math.abs(i.durationSec - 1) < 0.3 ? true : `时长 ${i.durationSec}s，期望 ≈1s`;
});

await t("★ trim 后音频仍在（音画不能断）", async () => {
  const i = await probe(path.join(OUT, "trim-single.mp4"));
  return i.hasAudio ? true : "★ trim 把音轨弄丢了 —— 音画会错位";
});

await t("★ trim 后帧率仍是 24", async () => {
  const i = await probe(path.join(OUT, "trim-single.mp4"));
  return Math.abs(i.fps - 24) < 0.5 ? true : `帧率 ${i.fps}`;
});

// ══════════════════════════════════════════════════════
console.log("\n═══ ② trim + 变速叠加 ═══");

await t("2 倍速后再 trim：5s 源 → 2.5s → trim 1~2 得 1s", async () => {
  const tl = createTimeline(24);
  addClip(tl, tl.tracks[0].id, {
    src: SRC, in: 0, out: 2.33, speed: 2,
    trim: { startSec: 0.5, endSec: 1.0 },
  });
  const out = path.join(OUT, "trim-speed.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  return Math.abs(i.durationSec - 0.5) < 0.3 ? true : `时长 ${i.durationSec}s，期望 ≈0.5s`;
});

await t("trim + 变速后音频仍在", async () => {
  const i = await probe(path.join(OUT, "trim-speed.mp4"));
  return i.hasAudio ? true : "丢了音轨";
});

// ══════════════════════════════════════════════════════
console.log("\n═══ ③ 多段混排（部分段有 trim）═══");

await t("三段：有 trim + 无 trim + 有 trim，总时长正确", async () => {
  const tl = createTimeline(24);
  const tid = tl.tracks[0].id;
  addClip(tl, tid, { src: SRC, in: 0, out: 1, trim: { startSec: 0.2, endSec: 0.7 } });  // 0.5s
  addClip(tl, tid, { src: SRC, in: 1, out: 2 });                                          // 1.0s
  addClip(tl, tid, { src: SRC, in: 2, out: 2.33, trim: { startSec: 0.1, endSec: 0.4 } }); // 0.3s
  const out = path.join(OUT, "mixed.mp4");
  const r = buildRenderCommand(tl, { out });
  const res = await runFf(r.args);
  if (res.code !== 0) return `ffmpeg 退出 ${res.code}\n${res.output.split("\n").slice(-6).join("\n")}`;
  const i = await probe(out);
  const expect = 0.5 + 1.0 + 0.3;
  return Math.abs(i.durationSec - expect) < 0.4 ? true : `时长 ${i.durationSec}s，期望 ≈${expect}s`;
});

// ══════════════════════════════════════════════════════
console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M7-b 单段裁剪验收全过");

