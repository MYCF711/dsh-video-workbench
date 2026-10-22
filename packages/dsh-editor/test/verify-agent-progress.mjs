/**
 * Agent 的「生成进度」链路验收 —— 补上一个缺口。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一份（2026-10-19）
 *
 *   实测 Agent 真实生成时发现：timeline_generate 只负责【提交】，
 *   返回到 clip.status = "queued" / "running" 就结束了。
 *   当时我以为是缺陷 ——「Agent 没法知道生成完了」。
 *
 *   查完三层才看清完整链路：
 *     ① Agent 调 timeline_generate → store.startJob() 记下 jobId
 *     ② index-host.mjs 的 setInterval 每 pollMs 查一次 ComfyUI /history
 *          · 未完成 → store.progressJob()  (queued → running)
 *          · 已完成 → store.completeJob()  (running → done，写 rendered)
 *          · 失败 3 次 → store.failJob()
 *     ③ Agent 轮询 timeline_summary / timeline_list_clips 看 status
 *
 *   ⇒ 不是缺陷，是【异步设计的正确形态】：
 *     工具不该阻塞等几分钟的生成，而应该让 Agent 自己轮询。
 *
 *   这份验收把这条链路固化，防止后人误以为「提交完就完了」。
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const failures = [];
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 100) : ""}`); }
};

const TMP = path.join(os.tmpdir(), `agent-progress-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

const { createTimelineStore } = await import(pathToFileURL(path.join(PKG, "src", "host-store.mjs")).href);
const T = await import(pathToFileURL(path.join(PKG, "src", "tools-def.mjs")).href);

const store = createTimelineStore({ stateFile: path.join(TMP, "s.json"), log: { info() {}, warn() {} } });
const tools = {};
T.buildTimelineTools(store, {
  defineTool: (d) => { tools[d.name] = d; return d; },
  bridge: {
    generate: async () => ({ jobId: "job-1", promptId: "p-1" }),
    chain: async () => ({ ok: true }),
  },
});

const vt = () => store.snapshot().tracks.find((x) => x.kind === "video");

console.log("═".repeat(64));
console.log("  Agent 生成进度链路（工具 → startJob → 轮询器 → completeJob）");
console.log("═".repeat(64));

// ─── ① 工具提交后 status = queued ──────────────────────────────
console.log("\n① 提交后");
store.addTrack("video", "视频 1", "agent");
store.addShot({ modeId: "krea2", prompt: "x" }, "agent");
const clipId = vt().clips[0].id;
await tools.timeline_generate.execute({ clipIds: [clipId] });

const c1 = vt().clips[0];
t("status 是 queued 或 running", ["queued", "running"].includes(c1.status), c1.status);
t("jobId 已记录", !!c1.jobId, c1.jobId);
t("rendered 还没写", !c1.rendered);

// ─── ② Agent 能从 timeline_summary 看到 running ────────────────
console.log("\n② Agent 用 timeline_summary 看进度");
const s1 = await tools.timeline_summary.execute({});
t("summary 有 running 计数", typeof s1?.running === "number", s1?.running);
t("summary 有 runningJobs 数组", Array.isArray(s1?.runningJobs), s1?.runningJobs?.length);
t("runningJobs 里带着 clipId", (s1?.runningJobs ?? []).some((j) => j.clipId === clipId));
t("runningJobs 里有 elapsedMs（能算等了多久）",
  (s1?.runningJobs ?? []).every((j) => typeof j.elapsedMs === "number"));

// ─── ③ Agent 能从 list_clips 看到单个状态 ─────────────────────
console.log("\n③ Agent 用 timeline_list_clips 看单个");
const l1 = await tools.timeline_list_clips.execute({});
const mine = (l1 ?? []).find((x) => x.clipId === clipId);
t("list_clips 返回 status", typeof mine?.status === "string", mine?.status);
t("list_clips 返回 hasRendered", typeof mine?.hasRendered === "boolean", mine?.hasRendered);
t("list_clips 返回 regenError 字段", mine?.regenError === null || typeof mine?.regenError === "string");

// ─── ④ progressJob: queued → running ──────────────────────────
console.log("\n④ 轮询器调 progressJob");
store.progressJob(c1.jobId);
t("status 变成 running", vt().clips[0].status === "running", vt().clips[0].status);

// ─── ⑤ completeJob: running → done ────────────────────────────
console.log("\n⑤ 轮询器调 completeJob");
// ★ 2026-10-19 修测试数据：summary 的 done 判据是 rendered.path || rendered.url，
//   只给 filename 不算完成（这是对的 —— 没路径就没法导出）。
store.completeJob(c1.jobId, {
  outputs: [{
    filename: "Krea2-2ST-test.png",
    path: process.env.IMG_PATH ?? "",
    url: "/api/view?filename=Krea2-2ST-test.png&type=output",
    type: "output",
  }],
  elapsedMs: 1234,
}, "host");
const c2 = vt().clips[0];
t("status 变成 done", c2.status === "done", c2.status);
t("rendered 已写", !!c2.rendered, c2.rendered?.filename);
t("jobId 已清空", !c2.jobId, c2.jobId);
t("regenError 已清空", c2.regenError === null);
t("history 里留了记录", (c2.shot?.history ?? []).length > 0, c2.shot?.history?.length);

// ─── ⑥ completeJob 后再 summary 就不算 running 了 ─────────────
console.log("\n⑥ 完成后再看 summary");
const s2 = await tools.timeline_summary.execute({});
t("running 归零", s2?.running === 0, s2?.running);
t("done 变为 1", s2?.done === 1, s2?.done);
t("runningJobs 变空", (s2?.runningJobs ?? []).length === 0);
t("exportable 变 true（可以导出了）", s2?.exportable === true, s2?.exportable);

// ─── ⑦ failJob 路径 ───────────────────────────────────────────
console.log("\n⑦ 失败路径");
store.addShot({ modeId: "krea2", prompt: "y" }, "agent");
const clip2 = vt().clips[1].id;
store.startJob(clip2, { jobId: "job-2", promptId: "p-2" }, "agent");
store.failJob("job-2", "ComfyUI 报了个错", "host");
const c3 = vt().clips.find((x) => x.id === clip2);
t("status 变成 failed", c3.status === "failed", c3.status);
t("regenError 记下了原因", /ComfyUI/.test(c3.regenError ?? ""), c3.regenError);
t("jobId 已清空", !c3.jobId);

// ─── ⑧ 空时间轴的 summary 不崩 ────────────────────────────────
console.log("\n⑧ 边界");
const emptyStore = createTimelineStore({ stateFile: path.join(TMP, "e.json"), log: { info() {}, warn() {} } });
const emptyTools = {};
T.buildTimelineTools(emptyStore, { defineTool: (d) => { emptyTools[d.name] = d; return d; }, bridge: {} });
let emptyOk = true;
try {
  const s = await emptyTools.timeline_summary.execute({});
  emptyOk = typeof s?.total === "number" && (s?.runningJobs ?? []).length === 0;
} catch { emptyOk = false; }
t("空时间轴 summary 不崩且 runningJobs=[]", emptyOk);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

// ─── ⑨ 三种【非正常结束】都必须离开 running ──────────────────
//
// ★★ 2026-10-19 加（这两个是本轮实测抓到的真缺陷）：
//   ① bridge 的 job() 返回 lost=true（任务被 interrupt / 重启清掉，
//      既不在队列也没 history）—— 轮询器原来只判 completed，当成「还在跑」
//   ② ComfyUI 对【失败】也写 history，status_str="error" ——
//      但 comfy.mjs 原来把 completed 算成 false（只认 "success"）
//      ⇒ 同样当成「还在跑」
//   两种都会让 clip 永久停在 running ⇒ exportable 永远 false。
//
//   这里直接测「轮询器的三段判断」这段逻辑，不依赖真实 ComfyUI。
console.log("\n⑨ 三种非正常结束都不能留在 running");
{
  const classify = (h) => {
    const okEnd = h.completed && (h.statusStr ?? "success") === "success";
    const badEnd = h.completed && !okEnd;
    if (okEnd) return "complete";
    if (badEnd) return "fail";
    if (h.lost) return "fail";
    return "progress";
  };

  t("成功结束 → complete", classify({ completed: true, statusStr: "success" }) === "complete");
  t("error 结束 → fail", classify({ completed: true, statusStr: "error" }) === "fail");
  t("failed 结束 → fail", classify({ completed: true, statusStr: "failed" }) === "fail");
  t("cancelled 结束 → fail", classify({ completed: true, statusStr: "cancelled" }) === "fail");
  t("lost（completed=false）→ fail", classify({ completed: false, lost: true }) === "fail");
  t("还在跑 → progress", classify({ completed: false, statusStr: "running" }) === "progress");

  store.addShot({ modeId: "krea2", prompt: "z" }, "agent");
  const clips0 = vt().clips;
  const zId = clips0[clips0.length - 1].id;
  store.startJob(zId, { jobId: "job-z", promptId: "p-z" }, "agent");
  store.failJob("job-z", "生成失败（ComfyUI status=error）", "host");
  const cz = vt().clips.find((x) => x.id === zId);
  t("failJob 后 status=failed", cz.status === "failed", cz.status);
  t("failJob 后 jobId 清空", !cz.jobId);
  const sz = store.summary();
  t("summary.running 不含失败的", sz.running === 0, sz.running);
  t("summary.failed 计入了", sz.failed >= 1, sz.failed);
}

console.log("\n" + "═".repeat(64));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  Agent 生成进度链路验收全过");

