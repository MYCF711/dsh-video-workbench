/**
 * 重启后的数据存活验收。
 *
 * ★ 2026-10-18 新增。为什么单独一套：
 *   当天抓到的真缺陷（AGENTS §6.18）是「重启后时间轴变空」——
 *   服务不重启时内存里一切正常，只有重启才暴露。
 *   我一天重启十几次，每次看到 video(0) 都以为是「这次没数据」，
 *   从没对照磁盘上明明有 4 段。
 *
 *   ⇒ 这个缺陷用普通单测抓不到（它需要「两次进程生命周期」）。
 *     所以做成一个独立脚本，用【两次独立子进程】验证：
 *       进程 A：建 3 段 → 落盘
 *       进程 B：新起 → 从盘恢复 → 段数必须还是 3
 *
 * 用法：
 *   node verify-persist-restart.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ★ 本文件在 test/ 下，src/ 在上一级
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");          // dsh-editor/
const STORE = path.join(PKG, "src", "host-store.mjs");
const PERSIST = path.join(PKG, "src", "persist-host.mjs");

// 用独立存档，绝不碰真实数据
const TMP_DIR = path.join(HERE, ".verify-restart");
const STATE = path.join(TMP_DIR, "timeline-state.json");

let pass = 0;
let fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? "  " + extra : ""}`); }
}

console.log("═".repeat(58));
console.log("  重启后的数据存活验收");
console.log("═".repeat(58));

// 干净开始
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * 跑一个独立子进程，返回它的 stdout。
 *
 * ★ 2026-10-18 实测坑：不能用 node -e 传多行脚本。
 *   脚本里有 JSON.stringify 出来的 file:/// 路径（含中文百分号编码），
 *   PowerShell / cmd 的引号层把内容改坏了，报 ERR_MODULE_NOT_FOUND
 *   但错误信息被截断，看不出真正原因。
 *   ⇒ 写成临时文件再 spawn，彻底避开引号问题。
 */
let phaseSeq = 0;
function runPhase(script) {
  const tmpFile = path.join(TMP_DIR, "phase-" + (++phaseSeq) + ".mjs");
  fs.writeFileSync(tmpFile, script, "utf8");
  const r = spawnSync("node", [tmpFile], {
    cwd: HERE,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (r.status !== 0) {
    return { ok: false, out: (r.stdout ?? "") + (r.stderr ?? "") };
  }
  return { ok: true, out: (r.stdout ?? "").trim() };
}

// ─── 阶段 A：建 3 段，写盘 ──────────────────────────────────
console.log("\n① 进程 A：建 3 段并落盘");
const phaseA = `
import { createTimelineStore } from ${JSON.stringify(pathToFileURL(STORE).href)};
import { createPersister } from ${JSON.stringify(pathToFileURL(PERSIST).href)};
const store = createTimelineStore({ stateFile: ${JSON.stringify(STATE)}, log: { info(){}, warn(){} } });
const p = createPersister({ file: ${JSON.stringify(STATE)}, store, log: { info(){}, warn(){} }, debounceMs: 1 });
store.addTrack("video", "视频 1", "user");
const vt = store.snapshot().tracks.find((t) => t.kind === "video");
for (let i = 0; i < 3; i++) {
  // ★ 2026-10-19 修：addShot 签名是 addShot({...}, who)，第一个参数【不是 trackId】。
  //   原来多传了 vt.id，导致解构出的 modeId = undefined ——
  //   之前没校验所以「假通过」，加了校验才暴露。
  store.addShot({ modeId: "yz", prompt: "第" + (i + 1) + "镜", durationSec: 2 }, "user");
}
// F6：给人的 prompt 上锁，验证 handoff 也能跨重启
const clips = store.snapshot().tracks.find((t) => t.kind === "video").clips;
store.updateShot(clips[0].id, { prompt: "人定的第一镜" }, "user");
p.flush();
const snap = store.snapshot();
console.log(JSON.stringify({
  clips: snap.tracks.find((t) => t.kind === "video").clips.length,
  handoff: !!snap.tracks.find((t) => t.kind === "video").clips[0].handoff,
}));
p.dispose();
`;
const a = runPhase(phaseA);
t("进程 A 执行成功", a.ok, a.ok ? "" : a.out.slice(0, 160));
if (a.ok) {
  let j = null;
  try { j = JSON.parse(a.out.split("\n").filter(Boolean).pop()); } catch { /* ignore */ }
  t("A 里有 3 段", j?.clips === 3, String(j?.clips));
  t("A 里有 handoff 记录", j?.handoff === true, String(j?.handoff));
}
t("存档文件已生成", fs.existsSync(STATE), STATE);

// ─── 阶段 B：全新进程，从盘恢复 ────────────────────────────
console.log("\n② 进程 B：全新进程从盘恢复");
const phaseB = `
import { createTimelineStore } from ${JSON.stringify(pathToFileURL(STORE).href)};
import { createPersister } from ${JSON.stringify(pathToFileURL(PERSIST).href)};
const store = createTimelineStore({ stateFile: ${JSON.stringify(STATE)}, log: { info(){}, warn(){} } });
const p = createPersister({ file: ${JSON.stringify(STATE)}, store, log: { info(){}, warn(){} }, debounceMs: 999999 });
const r = p.load();
const snap = store.snapshot();
const vt = snap.tracks.find((t) => t.kind === "video");
console.log(JSON.stringify({
  ok: r.ok,
  restored: r.clips,
  clips: vt ? vt.clips.length : 0,
  handoff: vt && vt.clips[0] ? !!vt.clips[0].handoff : false,
  lockedField: vt && vt.clips[0] && vt.clips[0].handoff ? Object.keys(vt.clips[0].handoff.locks ?? {})[0] ?? null : null,
}));
p.dispose();
`;
const b = runPhase(phaseB);
t("进程 B 执行成功", b.ok, b.ok ? "" : b.out.slice(0, 160));
if (b.ok) {
  let j = null;
  try { j = JSON.parse(b.out.split("\n").filter(Boolean).pop()); } catch { /* ignore */ }
  t("load() 报 ok", j?.ok === true);
  t("load() 报告恢复 3 段", j?.restored === 3, String(j?.restored));
  // ★ 最关键的一条：store 里真的能查到片段
  t("新进程里能查到 3 段", j?.clips === 3, String(j?.clips));
  // ★ F6 的 handoff 跨重启存活（§6.19 踩过的坑）
  t("handoff 跨重启存活", j?.handoff === true);
  t("锁的字段还是 prompt", j?.lockedField === "prompt", String(j?.lockedField));
}

// ─── 阶段 C：cwd 无关性 ───────────────────────────────────
console.log("\n③ 从别的目录启动也能找到同一个存档");
{
  // 用绝对路径 stateFile 时，cwd 换成别处也应该读到同样的东西
  const tmpC = path.join(TMP_DIR, "phaseC.mjs");
  fs.writeFileSync(tmpC, phaseB, "utf8");
  const r = spawnSync("node", [tmpC], {
    cwd: "C:\\",                       // ★ 故意换个完全无关的 cwd
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  t("换 cwd 后仍能执行", r.status === 0, (r.stderr ?? "").slice(0, 120));
  if (r.status === 0) {
    let j = null;
    try { j = JSON.parse((r.stdout ?? "").trim().split("\n").filter(Boolean).pop()); } catch { /* ignore */ }
    t("换 cwd 后仍恢复 3 段", j?.clips === 3, String(j?.clips));
  }
}

// ─── 阶段 D：存档损坏时不崩 ───────────────────────────────
console.log("\n④ 存档被改坏时不崩");
{
  const broken = path.join(TMP_DIR, "broken.json");
  fs.writeFileSync(broken, "{ this is not json", "utf8");
  const script = `
import { createTimelineStore } from ${JSON.stringify(pathToFileURL(STORE).href)};
import { createPersister } from ${JSON.stringify(pathToFileURL(PERSIST).href)};
const store = createTimelineStore({ stateFile: ${JSON.stringify(broken)}, log: { info(){}, warn(){} } });
const p = createPersister({ file: ${JSON.stringify(broken)}, store, log: { info(){}, warn(){} }, debounceMs: 999999 });
let crashed = false;
let r = null;
try { r = p.load(); } catch (e) { crashed = true; }
console.log(JSON.stringify({ crashed, ok: r ? r.ok : null, clips: store.snapshot().tracks.reduce((n, t) => n + t.clips.length, 0) }));
p.dispose();
`;
  const r = runPhase(script);
  t("坏存档不抛异常", r.ok, r.ok ? "" : r.out.slice(0, 120));
  if (r.ok) {
    let j = null;
    try { j = JSON.parse(r.out.split("\n").filter(Boolean).pop()); } catch { /* ignore */ }
    t("坏存档 → crashed=false", j?.crashed === false);
    t("坏存档 → 从空开始", j?.clips === 0, String(j?.clips));
  }
}

// 清理
try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  重启数据存活验收全过");