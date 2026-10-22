/**
 * 端到端验收 —— 在真实 DSH 实例 + 真实 ComfyUI 上跑完整链路。
 *
 * 链路：
 *   ① POST /timeline/cmd/add-shots   建 2 段分镜（krea2 生图，最快）
 *   ② GET  /timeline/snapshot        确认 2 段都在
 *   ③ POST /timeline/cmd/generate    提交生成
 *   ④ 轮询 snapshot                  等两段都 done
 *   ⑤ POST /timeline/cmd/export      合成成片
 *   ⑥ 检查成片文件真实存在且可播放
 *
 * 用法：node test/e2e-full.mjs [--base http://127.0.0.1:19499]
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = getArg("--base", "http://127.0.0.1:19499");
const TOKEN_FILE = "C:/Users/Administrator/dsh-tok.txt";

const tok = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : "";
const cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;

let pass = 0, fail = 0;
const failures = [];
function t(desc, ok, detail = "") {
  if (ok) { console.log(`  ✅ ${desc}`); pass++; }
  else { console.log(`  ❌ ${desc}${detail ? "\n     " + detail : ""}`); fail++; failures.push(desc); }
}

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error("非 JSON：" + text.slice(0, 200)); }
  if (!res.ok) throw new Error(`HTTP ${res.status}：${body.error ?? text.slice(0, 200)}`);
  return body;
}

const snap = () => api("/timeline/snapshot");
const cmd = (p, b) => api("/timeline/cmd" + p, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(b ?? {}),
});

// ══════════════════════════════════════════════════
console.log(`═══ 目标实例 ${BASE} ═══\n`);

console.log("═══ 前置：ComfyUI 与桥 ═══");
let health;
try {
  health = await api("/comfy-bridge/health");
  console.log(`     ok=${health.ok}  v=${health.comfyuiVersion}  modes=${health.modes}`);
  t("ComfyUI 已连接", health.ok === true, health.error);
} catch (err) {
  t("ComfyUI 已连接", false, err.message);
  process.exit(1);
}

// ══════════════════════════════════════════════════
console.log("\n═══ ① 清空并建 2 段分镜（krea2 生图，快）═══");

// 先把现有片段清掉（可能有上轮测试留下的）
let s = await snap();
const existing = s.state.tracks.flatMap((tr) => tr.clips.map((c) => c.id));
for (const id of existing) {
  await cmd("/edit-clip", { clipId: id, op: "remove" });
}
s = await snap();
t("清空后为 0 段", s.summary.total === 0, `total=${s.summary.total}`);

let added;
try {
  const r = await cmd("/add-shots", {
    shots: [
      { prompt: "a single red apple on a plain white table, studio lighting, photorealistic", modeId: "krea2", aspect: "1:1", durationSec: 5, steps: 4 },
      { prompt: "a single blue whale plush toy on a plain white table, studio lighting", modeId: "krea2", aspect: "1:1", durationSec: 5, steps: 4 },
    ],
  });
  added = r.added;
  t("建了 2 段", added.length === 2, JSON.stringify(r));
} catch (err) {
  t("建了 2 段", false, err.message);
  process.exit(1);
}

s = await snap();
t("snapshot 显示 2 段 pending", s.summary.total === 2 && s.summary.pending === 2,
  `total=${s.summary.total} pending=${s.summary.pending}`);

// ══════════════════════════════════════════════════
console.log("\n═══ ② 提交生成 ═══");
let gen;
try {
  gen = await cmd("/generate", { clipIds: added.map((x) => x.clipId) });
  const okCount = gen.results.filter((r) => r.ok).length;
  t(`提交 2 段，成功 ${okCount}`, okCount === 2,
    JSON.stringify(gen.results.filter((r) => !r.ok)));
} catch (err) {
  t("提交生成", false, err.message);
  process.exit(1);
}

s = await snap();
t("提交后 running=2", s.summary.running === 2, `running=${s.summary.running}`);

// ══════════════════════════════════════════════════
console.log("\n═══ ③ 轮询等完成（最多 8 分钟）═══");
const t0 = Date.now();
let done = false;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  s = await snap();
  const sec = Math.round((Date.now() - t0) / 1000);
  if (i % 8 === 0) {
    console.log(`     ${sec}s  done=${s.summary.done} running=${s.summary.running} failed=${s.summary.failed} pending=${s.summary.pending}`);
  }
  if (s.summary.failed > 0) {
    const errs = s.state.tracks.flatMap((tr) => tr.clips.filter((c) => c.status === "failed").map((c) => `${c.name}: ${c.regenError}`));
    t("无失败段", false, errs.join("\n     "));
    break;
  }
  if (s.summary.done === 2) { done = true; break; }
}
t("两段都生成完成", done, `${Math.round((Date.now() - t0) / 1000)}s 后 done=${s.summary.done}`);

// 检查成片文件
const clips = s.state.tracks.flatMap((tr) => tr.clips);
for (const c of clips) {
  t(`「${c.name}」有成片`, !!(c.rendered?.path || c.rendered?.url),
    JSON.stringify(c.rendered));
}

// ══════════════════════════════════════════════════
console.log("\n═══ ④ 导出成片 ═══");
let exp;
try {
  exp = await cmd("/export", {});
  t("导出成功", exp.ok === true, JSON.stringify(exp));
  if (exp.path) {
    const exists = fs.existsSync(exp.path);
    const size = exists ? fs.statSync(exp.path).size : 0;
    console.log(`     ${exp.path}  ${(size / 1024).toFixed(0)} KB`);
    t("成片文件存在", exists);
    t("成片非空（>10KB）", size > 10 * 1024, `${size} 字节`);
    if (exp.expectedDuration != null) {
      console.log(`     期望时长 ${exp.expectedDuration.toFixed(2)}s`);
    }
  }
} catch (err) {
  t("导出", false, err.message);
}

// ══════════════════════════════════════════════════
console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  端到端验收全过");
