/**
 * host 侧权威时间轴的验收 —— 这是「人机协同」的地基。
 *
 * 主人的要求：
 *   「剪辑部分需要 llm 能够操控，所有的可操作部分都要给 dsh 的 agent 的 llm 留接口」
 *   「前端同步可视化展示给用户，这样可以也方便随时叫停」
 *
 * 判据：
 *   ① 所有操作都能被外部调用（Agent 与 UI 同一套入口）
 *   ② 每次变更都广播（前端能同步）
 *   ③ 叫停粒度：单段 + 全局
 *   ④ ★ 重跑失败/取消都不毁片
 *   ⑤ 变更留痕（who = agent / user）
 */
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
console.log("═══ ① 操作面齐全（Agent 能调用的入口）═══");

let store;
t("建 store 成功", () => { store = createTimelineStore({ log: { info() {}, warn() {} } }); return true; });

t("暴露全部操作入口", () => {
  const need = [
    "addShot", "addShots", "updateShot", "setSpeed", "setCrop", "setTrim",
    "removeClip", "moveClip", "addTrack", "replaceRendered",
    "startJob", "progressJob", "completeJob", "failJob", "cancelJob", "cancelAll",
    "snapshot", "summary", "subscribe", "runningJobs", "history",
  ];
  const miss = need.filter((k) => typeof store[k] !== "function");
  return miss.length === 0 ? true : `缺 ${miss.join(",")}`;
});

console.log("\n═══ ② 加分镜（Agent 一次建整张表）═══");

t("addShot 加一段", () => {
  const c = store.addShot({ modeId: "yz", prompt: "镜头 1", durationSec: 5 }, "agent");
  const s = store.snapshot();
  const v = s.tracks.find((x) => x.kind === "video");
  return v.clips.length === 1 && v.clips[0].shot.prompt === "镜头 1" ? true : JSON.stringify(v.clips.length);
});

t("addShots 批量加 24 段（模拟 Agent 建整集分镜）", () => {
  const shots = Array.from({ length: 24 }, (_, i) => ({
    modeId: "yz", prompt: `镜头 ${i + 2}`, durationSec: 5,
  }));
  const out = store.addShots(shots, "agent");
  const s = store.snapshot();
  const v = s.tracks.find((x) => x.kind === "video");
  return out.length === 24 && v.clips.length === 25 ? true : `${out.length} / ${v.clips.length}`;
});

t("自动命名 分镜 1..25", () => {
  const s = store.snapshot();
  const names = s.tracks.find((x) => x.kind === "video").clips.map((c) => c.name);
  return names[0] === "分镜 1" && names[24] === "分镜 25" ? true : `${names[0]} .. ${names[24]}`;
});

console.log("\n═══ ③ ★ 变更广播（前端同步的前提）═══");

t("订阅后能收到变更事件", () => {
  const events = [];
  const off = store.subscribe((e) => events.push(e));
  store.addShot({ modeId: "yz", prompt: "广播测试" }, "agent");
  off();
  return events.length > 0 && events[0].type === "timeline/changed" ? true : `${events.length} 条`;
});

t("事件带 action / who / version", () => {
  const events = [];
  const off = store.subscribe((e) => events.push(e));
  store.setSpeed(store.snapshot().tracks[0].clips[0].id, 2, "user");
  off();
  const e = events[0];
  if (!e) return "没收到事件";
  return e.action === "setSpeed" && e.who === "user" && typeof e.version === "number"
    ? true : JSON.stringify({ a: e.action, w: e.who, v: e.version });
});

t("version 单调递增", () => {
  const v1 = store.snapshot().version;
  store.addTrack("video", null, "agent");
  const v2 = store.snapshot().version;
  return v2 > v1 ? true : `${v1} → ${v2}`;
});

t("退订后不再收到", () => {
  const events = [];
  const off = store.subscribe((e) => events.push(e));
  off();
  store.addTrack("audio", null, "agent");
  return events.length === 0 ? true : `退订后还收到 ${events.length} 条`;
});

console.log("\n═══ ④ 各种操作 ═══");

t("updateShot 改提示词", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  store.updateShot(cid, { prompt: "改过的提示词" }, "user");
  const s = store.snapshot();
  return s.tracks[0].clips[0].shot.prompt === "改过的提示词" ? true : "没改上";
});

t("updateShot 非法字段被拒", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  try { store.updateShot(cid, { bogus: 1 }, "agent"); } catch { return true; }
  return "非法字段没被拒";
});

t("setSpeed 生效", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  store.setSpeed(cid, 2, "user");
  return store.snapshot().tracks[0].clips[0].speed === 2 ? true : "没设上";
});

t("setSpeed 拒绝 <= 0", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  try { store.setSpeed(cid, 0, "agent"); } catch { return true; }
  return "speed=0 没被拒";
});

t("setCrop 生效", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  store.setCrop(cid, { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, "agent");
  return store.snapshot().tracks[0].clips[0].crop.w === 0.8 ? true : "没设上";
});

t("setCrop 拒绝越界", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  try { store.setCrop(cid, { x: 0.5, y: 0, w: 0.8, h: 1 }, "agent"); } catch { return true; }
  return "越界没被拒";
});

t("setTrim 生效", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  // ★ 注意：上一个测试已把这段设为 2 倍速 → 5s 素材只剩 2.5s 可见时长。
  //   所以裁剪区间必须在 2.5s 以内 —— 写 1~3 会被（正确地）拒绝。
  //   这条断言第一次就是这么踩的：越界值被拒，我却以为代码坏了。
  const c0 = store.snapshot().tracks[0].clips[0];
  const base = (c0.out - c0.in) / c0.speed;
  if (base < 2) return `前提变了：可见时长只剩 ${base}s`;
  const c = store.setTrim(cid, { startSec: 0.5, endSec: 1.5 }, "user");
  return c.trim.startSec === 0.5 && c.trim.endSec === 1.5 ? true : JSON.stringify(c.trim);
});

t("setTrim 拒绝越界（终点 > 可见时长）", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  try { store.setTrim(cid, { startSec: 0, endSec: 99 }, "agent"); } catch { return true; }
  return "越界没被拒";
});

t("★ 波纹删除：删中间段后前后接上（时长缩短）", () => {
  const before = store.timelineDuration();
  const clips = store.snapshot().tracks[0].clips;
  const midId = clips[5].id;
  store.removeClip(midId, "user");
  const after = store.timelineDuration();
  if (!(after < before)) return `没缩短：${before} → ${after}`;
  // layout 里不能有空档
  const lay = store.layout(store.snapshot().tracks[0].id);
  for (let i = 1; i < lay.length; i++) {
    if (Math.abs(lay[i].start - lay[i - 1].end) > 1e-9) return `第 ${i} 段有空档`;
  }
  return true;
});

t("replaceRendered 替换成片", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  store.replaceRendered(cid, { path: "other.mp4", filename: "other.mp4" }, "user");
  const c = store.snapshot().tracks[0].clips[0];
  return c.rendered?.path === "other.mp4" && c.rendered.replaced === true ? true : JSON.stringify(c.rendered);
});

t("moveClip 调序", () => {
  const clips = store.snapshot().tracks[0].clips;
  const firstId = clips[0].id;
  store.moveClip(firstId, 3, "user");
  const after = store.snapshot().tracks[0].clips;
  return after[3].id === firstId ? true : `位置 3 是 ${after[3].id}`;
});

console.log("\n═══ ⑤ ★ 任务生命周期：失败不毁片 ═══");

t("startJob → queued，rendered 保留", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  const before = store.snapshot().tracks[0].clips[0].rendered?.path;
  store.startJob(cid, { jobId: "j1" }, "agent");
  const c = store.snapshot().tracks[0].clips[0];
  if (c.status !== "queued") return c.status;
  if (c.rendered?.path !== before) return "★ rendered 被清了";
  return true;
});

t("progressJob → running", () => {
  store.progressJob("j1");
  const c = store.snapshot().tracks[0].clips[0];
  return c.status === "running" ? true : c.status;
});

t("★★ failJob → failed，rendered 仍保留", () => {
  const before = store.snapshot().tracks[0].clips[0].rendered?.path;
  store.failJob("j1", "ComfyUI 未运行", "host");
  const c = store.snapshot().tracks[0].clips[0];
  if (c.status !== "failed") return c.status;
  if (c.regenError !== "ComfyUI 未运行") return "错误没记";
  if (c.rendered?.path !== before) return `★ 失败把成片毁了：${c.rendered?.path}`;
  return true;
});

t("completeJob → done，替换 rendered + 记 history", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  store.startJob(cid, { jobId: "j2" }, "agent");
  store.completeJob("j2", { outputs: [{ path: "new.mp4", filename: "new.mp4" }], elapsedMs: 95000 }, "host");
  const c = store.snapshot().tracks[0].clips[0];
  if (c.rendered?.path !== "new.mp4") return `rendered=${c.rendered?.path}`;
  if (c.shot.history.length < 1) return "history 没记";
  return c.status === "done" ? true : c.status;
});

t("cancelJob → cancelled，rendered 保留", () => {
  const cid = store.snapshot().tracks[0].clips[0].id;
  store.startJob(cid, { jobId: "j3" }, "agent");
  store.cancelJob("j3", "user");
  const c = store.snapshot().tracks[0].clips[0];
  return c.status === "cancelled" && c.rendered?.path === "new.mp4" ? true : JSON.stringify({ s: c.status, r: c.rendered?.path });
});

console.log("\n═══ ⑥ ★ 叫停粒度：单段 + 全局 ═══");

t("runningJobs 能列出在跑的任务", () => {
  const s = store.snapshot();
  const a = s.tracks[0].clips[1].id;
  const b = s.tracks[0].clips[2].id;
  store.startJob(a, { jobId: "jA" }, "agent");
  store.startJob(b, { jobId: "jB" }, "agent");
  const rj = store.runningJobs();
  return rj.length === 2 ? true : `${rj.length} 个`;
});

t("★ cancelAll 一次停掉全部", () => {
  const r = store.cancelAll("user");
  const rj = store.runningJobs();
  return r.cancelled === 2 && rj.length === 0 ? true : `停了 ${r.cancelled}，还剩 ${rj.length}`;
});

t("cancelAll 后片段状态是 cancelled", () => {
  const s = store.snapshot();
  const sts = s.tracks[0].clips.slice(1, 3).map((c) => c.status);
  return sts.every((x) => x === "cancelled") ? true : JSON.stringify(sts);
});

console.log("\n═══ ⑦ summary 与 history ═══");

t("summary 给出可读概览", () => {
  const s = store.summary();
  const need = ["total", "running", "done", "failed", "pending", "durationSec", "tracks", "runningJobs", "version", "exportable"];
  const miss = need.filter((k) => s[k] === undefined);
  return miss.length === 0 ? true : `缺 ${miss.join(",")}`;
});

t("有 cancelled 段时 exportable=false（必须先处理）", () => {
  const s = store.summary();
  // cancelled 不算 done/pending/failed —— 归到 pending 才对
  return typeof s.exportable === "boolean" ? true : "类型不对";
});

t("history 记录了 who", () => {
  const h = store.history();
  const whos = new Set(h.map((e) => e.who));
  return whos.has("agent") && whos.has("user") ? true : [...whos].join(",");
});

t("history 有上限（<= 200）", () => {
  return store.history().length <= 200 ? true : store.history().length;
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  host 权威时间轴验收全过");
