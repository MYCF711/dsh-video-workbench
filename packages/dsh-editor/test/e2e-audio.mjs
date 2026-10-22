/**
 * H3 视频的音频分离真机验证 —— 这是唯一还没在真机上跑过的部分。
 *
 * 要验的：
 *   ① 用 yz 工作流生成一段真视频（带 H3 自带音轨）
 *   ② 生成完成后，host 的轮询器自动分离音频
 *   ③ 音频轨上真的出现了「XX · 原声」片段
 *   ④ 该音频片段与视频片段时长一致
 *   ⑤ 音画对齐检查通过
 *
 * 用法：node test/e2e-audio.mjs [--duration 5]
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg("--base", "http://127.0.0.1:19499");
const DURATION = Number(getArg("--duration", "5"));
const TOKEN_FILE = "C:/Users/Administrator/dsh-tok.txt";
const MAX_WAIT_MS = Number(getArg("--maxwait", "900000")); // 15 分钟

const tok = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "";
const cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;

let pass = 0, fail = 0;
const failures = [];
function t(desc, ok, detail = "") {
  if (ok) { console.log(`  ✅ ${desc}`); pass++; }
  else { console.log(`  ❌ ${desc}${detail ? "\n     " + detail : ""}`); fail++; failures.push(desc); }
}

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { Cookie: cookie, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error("非 JSON：" + text.slice(0, 200)); }
  if (!res.ok) throw new Error(`HTTP ${res.status}：${body.error ?? text.slice(0, 300)}`);
  return body;
}
const snap = () => api("/timeline/snapshot");
const cmd = (p, b) => api("/timeline/cmd" + p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}),
});

console.log(`═══ H3 音频分离真机验证 ═══\n`);

// ── 前置：查合法的帧数 ──
console.log("═══ 前置：H3 帧网格 ═══");
let lengths;
try {
  lengths = await api("/comfy-bridge/lengths");
  // ★ 桥返回的是 { legal: [...], fps }，不是 { values }
  const vals = lengths.legal ?? lengths.values ?? [];
  console.log(`     合法值 ${vals.length} 个：${vals.slice(0, 8).join(", ")}${vals.length > 8 ? "..." : ""}`);
  console.log(`     帧率 ${lengths.fps ?? "?"}`);
  t("拿到帧网格", vals.length > 0, JSON.stringify(lengths).slice(0, 200));
  t("帧网格是 17k+5 序列", vals.length === 22 && vals[0] === 5, `${vals.length} 个，首值 ${vals[0]}`);
} catch (err) {
  t("拿到帧网格", false, err.message);
}

// ── 清空 ──
console.log("\n═══ ① 清空并建 1 段 yz 分镜 ═══");
let s = await snap();
for (const id of s.state.tracks.flatMap((tr) => tr.clips.map((c) => c.id))) {
  await cmd("/edit-clip", { clipId: id, op: "remove" });
}
s = await snap();
t("清空到 0 段", s.summary.total === 0, `total=${s.summary.total}`);

let added;
try {
  const r = await cmd("/add-shots", {
    shots: [{
      prompt: "a whale swimming slowly in deep blue ocean, sunlight rays from above, cinematic",
      modeId: "yz",
      aspect: "16:9",
      durationSec: DURATION,
    }],
  });
  added = r.added;
  t("建了 1 段 yz", added.length === 1, JSON.stringify(r));
} catch (err) {
  t("建了 1 段 yz", false, err.message);
  process.exit(1);
}

const clipId = added[0].clipId;

// ── 提交 ──
console.log("\n═══ ② 提交生成（H3 会跑几分钟）═══");
try {
  const g = await cmd("/generate", { clipIds: [clipId] });
  const ok = g.results?.[0]?.ok;
  t("提交成功", ok === true, JSON.stringify(g.results));
  if (!ok) process.exit(1);
} catch (err) {
  t("提交成功", false, err.message);
  process.exit(1);
}

// ── 等生成 + 音频分离 ──
console.log("\n═══ ③ 等生成 + 自动分离音频 ═══");
const t0 = Date.now();
let done = false;
let lastLog = 0;
while (Date.now() - t0 < MAX_WAIT_MS) {
  await new Promise((r) => setTimeout(r, 3000));
  s = await snap();
  const sec = Math.round((Date.now() - t0) / 1000);

  const vClips = s.state.tracks.filter((x) => x.kind === "video").flatMap((x) => x.clips);
  const aClips = s.state.tracks.filter((x) => x.kind === "audio").flatMap((x) => x.clips);
  const st = s.summary;

  if (sec - lastLog >= 15) {
    console.log(`     ${sec}s  done=${st.done} running=${st.running} failed=${st.failed} | 视频 ${vClips.length} 段 / 音频 ${aClips.length} 段`);
    lastLog = sec;
  }

  if (st.failed > 0) {
    const e = vClips.find((c) => c.status === "failed");
    t("生成成功", false, `失败：${e?.regenError ?? "未知"}`);
    break;
  }
  if (st.done === 1 && aClips.length >= 1) { done = true; break; }
  if (st.done === 1 && sec > 60 && aClips.length === 0) {
    // 生成完了但音频没分离 —— 再等 30 秒
    if (sec > 90) { done = true; break; }
  }
}
t("生成完成", done, `${Math.round((Date.now() - t0) / 1000)}s`);

// ── 检查结果 ──
console.log("\n═══ ④ 检查音频轨 ═══");
s = await snap();
const vClips = s.state.tracks.filter((x) => x.kind === "video").flatMap((x) => x.clips);
const aClips = s.state.tracks.filter((x) => x.kind === "audio").flatMap((x) => x.clips);

const vc = vClips[0];
const ac = aClips[0];

t("视频段有成片", !!(vc?.rendered?.path || vc?.rendered?.url), JSON.stringify(vc?.rendered));
t(`★ 音频轨自动出现 ${aClips.length} 段`, aClips.length >= 1,
  `音频轨片段：${JSON.stringify(aClips.map((c) => ({ name: c.name, src: c.src?.slice(0, 60) })))}`);

if (ac) {
  console.log(`     音频：${ac.name}  时长 ${ac.out?.toFixed(2)}s  源 ${String(ac.src).slice(0, 70)}`);
  t("音频片段名带「原声」", String(ac.name).includes("原声"), ac.name);
  t("★ 带 fromVideoClipId（可追踪来源）", ac.fromVideoClipId === vc.id, `${ac.fromVideoClipId} vs ${vc.id}`);

  const vDur = (vc.out - vc.in) / (vc.speed || 1);
  const aDur = ac.out;
  t("音画时长一致", Math.abs(vDur - aDur) < 0.5, `视频 ${vDur.toFixed(2)}s / 音频 ${aDur.toFixed(2)}s`);
  t("音频有 rendered.path", !!ac.rendered?.path, JSON.stringify(ac.rendered));

  // 检查文件真实存在
  if (ac.rendered?.path && fs.existsSync(ac.rendered.path)) {
    const size = fs.statSync(ac.rendered.path).size;
    console.log(`     音频文件 ${size} 字节`);
    t("音频文件非空", size > 1000, `${size} 字节`);
  } else {
    t("音频文件存在", false, ac.rendered?.path ?? "(无路径)");
  }
}

// ── 对齐检查 ──
console.log("\n═══ ⑤ 音画对齐 ═══");
try {
  const align = await api("/timeline/align", { method: "GET" }).catch(() => null);
  if (align) {
    console.log(`     视频 ${align.videoDuration?.toFixed(2)}s / 音频 ${align.audioDuration?.toFixed(2)}s`);
    t("对齐检查通过", align.ok === true, JSON.stringify(align.problems));
  } else {
    // 路由可能没注册，用 snapshot 自己算
    const vSum = vClips.reduce((n, c) => n + (c.out - c.in) / (c.speed || 1), 0);
    const aSum = aClips.reduce((n, c) => n + (c.out - c.in) / (c.speed || 1), 0);
    console.log(`     （自行计算）视频 ${vSum.toFixed(2)}s / 音频 ${aSum.toFixed(2)}s`);
    t("音画总长接近", Math.abs(vSum - aSum) < 0.5, `${vSum} vs ${aSum}`);
  }
} catch (err) {
  t("对齐检查", false, err.message);
}

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  H3 音频分离真机验证全过");
