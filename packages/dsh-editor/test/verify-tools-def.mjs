/**
 * LLM 工具定义验收 —— 确认 Agent 能真正操控剪辑。
 *
 * 用一个假的 defineTool（形状与 DSH 官方一致）来测，
 * 这样不需要启动 DSH 实例就能验证工具契约。
 */
import { buildTimelineTools } from "../src/tools-def.mjs";
import { createTimelineStore } from "../src/host-store.mjs";

let pass = 0, fail = 0;
const failures = [];
async function t(desc, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${String(err.message).slice(0, 300)}`);
    fail++; failures.push(desc);
  }
}

/** 假 defineTool —— 形状照 DSH 官方：{ name, description, parameters, execute, output } */
function fakeDefineTool(def) {
  if (!def.name) throw new Error("工具必须有 name");
  if (!def.description) throw new Error(`工具 ${def.name} 必须有 description`);
  if (!def.parameters) throw new Error(`工具 ${def.name} 必须有 parameters`);
  if (typeof def.execute !== "function") throw new Error(`工具 ${def.name} 必须有 execute`);
  return def;
}

/** 假 bridge —— 记录调用。 */
function fakeBridge() {
  const calls = { generate: [], cancel: [], job: [] };
  let n = 0;
  return {
    calls,
    async generate(modeId, params) {
      calls.generate.push({ modeId, params });
      n += 1;
      return { jobId: `job_${n}`, promptId: `p_${n}` };
    },
    async cancel(jobId) { calls.cancel.push(jobId); return { ok: true }; },
    async job(jobId) { calls.job.push(jobId); return { completed: false }; },
  };
}

const store = createTimelineStore({ log: { info() {}, warn() {} } });
const bridge = fakeBridge();

console.log("═══ ① 工具定义合法 ═══");

let tools;
await t("buildTimelineTools 返回工具数组", () => {
  tools = buildTimelineTools(store, { defineTool: fakeDefineTool, bridge });
  return Array.isArray(tools) && tools.length > 0 ? true : `${typeof tools}`;
});

await t("每个工具都有 name/description/parameters/execute", () => {
  const bad = tools.filter((x) => !x.name || !x.description || !x.parameters || typeof x.execute !== "function");
  return bad.length === 0 ? true : `不合格：${bad.map((x) => x.name).join(",")}`;
});

await t("工具名不重复", () => {
  const names = tools.map((x) => x.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  return dup.length === 0 ? true : dup.join(",");
});

console.log(`     工具清单：${tools.map((x) => x.name).join(", ")}`);

console.log("\n═══ ② Agent 能建分镜（自动做剧主入口）═══");

let added;
await t("timeline_add_shots 批量加 3 段", async () => {
  const tool = tools.find((x) => x.name === "timeline_add_shots");
  added = await tool.execute({
    shots: [
      { prompt: "镜头1：女子站在窗前", modeId: "yz", durationSec: 12 },
      { prompt: "镜头2：她转过头", modeId: "yz", durationSec: 12 },
      { prompt: "镜头3：推门而出", modeId: "yz", durationSec: 10 },
    ],
  });
  return added.length === 3 ? true : added.length;
});

await t("加了之后 summary 的 total 变 3", async () => {
  const tool = tools.find((x) => x.name === "timeline_summary");
  const s = await tool.execute({});
  return s.total === 3 ? true : s.total;
});

await t("summary 报告 pending=3（都还没成片）", async () => {
  const s = await tools.find((x) => x.name === "timeline_summary").execute({});
  return s.pending === 3 ? true : JSON.stringify(s);
});

console.log("\n═══ ③ Agent 能看分镜列表 ═══");

await t("timeline_list_clips 列出 3 段，带 clipId 与提示词", async () => {
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  if (list.length !== 3) return `${list.length} 段`;
  if (!list[0].clipId) return "没有 clipId";
  if (!list[0].prompt.includes("窗前")) return `prompt=${list[0].prompt}`;
  return true;
});

await t("onlyPending 过滤生效", async () => {
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({ onlyPending: true });
  return list.length === 3 ? true : list.length;
});

console.log("\n═══ ④ Agent 能改提示词并重跑 ═══");

const cid = added[0].clipId;

await t("timeline_update_shot 改提示词", async () => {
  const tool = tools.find((x) => x.name === "timeline_update_shot");
  await tool.execute({ clipId: cid, prompt: "改过的：女子站在雪窗前" });
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  const c = list.find((x) => x.clipId === cid);
  return c.prompt.includes("雪窗前") ? true : c.prompt;
});

await t("timeline_generate 提交这一段", async () => {
  const tool = tools.find((x) => x.name === "timeline_generate");
  const res = await tool.execute({ clipIds: [cid] });
  if (!res[0].ok) return res[0].reason;
  if (!res[0].jobId) return "没返回 jobId";
  return bridge.calls.generate.length === 1 ? true : `${bridge.calls.generate.length} 次`;
});

await t("提交后 summary 报告 running=1", async () => {
  const s = await tools.find((x) => x.name === "timeline_summary").execute({});
  return s.running === 1 ? true : JSON.stringify({ r: s.running, p: s.pending });
});

await t("提交后 rendered 仍为空（还没完成）", async () => {
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  const c = list.find((x) => x.clipId === cid);
  return c.hasRendered === false ? true : "不该有成片";
});

console.log("\n═══ ⑤ ★ Agent 能叫停 ═══");

await t("timeline_stop 停单段", async () => {
  const tool = tools.find((x) => x.name === "timeline_stop");
  const r = await tool.execute({ clipId: cid });
  if (r.stopped !== 1) return r.stopped;
  return bridge.calls.cancel.length === 1 ? true : `bridge 取消 ${bridge.calls.cancel.length} 次`;
});

await t("停后 summary 报告 running=0", async () => {
  const s = await tools.find((x) => x.name === "timeline_summary").execute({});
  return s.running === 0 ? true : s.running;
});

await t("★ 停后 rendered 仍为空但状态可再跑", async () => {
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  const c = list.find((x) => x.clipId === cid);
  return c.status === "cancelled" ? true : c.status;
});

await t("停后再 generate 能成功（状态可恢复）", async () => {
  const tool = tools.find((x) => x.name === "timeline_generate");
  const res = await tool.execute({ clipIds: [cid] });
  return res[0].ok ? true : res[0].reason;
});

await t("★ timeline_stop 不传 clipId 停全部", async () => {
  // 先把三段都提交
  const gen = tools.find((x) => x.name === "timeline_generate");
  await gen.execute({ clipIds: added.map((x) => x.clipId) });
  const before = (await tools.find((x) => x.name === "timeline_summary").execute({})).running;
  if (before < 1) return `提交后 running=${before}`;
  const stop = tools.find((x) => x.name === "timeline_stop");
  const r = await stop.execute({});
  const after = (await tools.find((x) => x.name === "timeline_summary").execute({})).running;
  return r.stopped >= 1 && after === 0 ? true : `停了 ${r.stopped}，剩 ${after}`;
});

console.log("\n═══ ⑥ Agent 能剪辑 ═══");

await t("timeline_edit_clip op=speed 变速", async () => {
  const tool = tools.find((x) => x.name === "timeline_edit_clip");
  await tool.execute({ clipId: cid, op: "speed", speed: 2 });
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  const c = list.find((x) => x.clipId === cid);
  return c.speed === 2 ? true : c.speed;
});

await t("op=crop 裁画面", async () => {
  const tool = tools.find((x) => x.name === "timeline_edit_clip");
  await tool.execute({ clipId: cid, op: "crop", crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } });
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  return list.find((x) => x.clipId === cid).crop.w === 0.8 ? true : "没设上";
});

await t("op=trim 裁时长", async () => {
  const tool = tools.find((x) => x.name === "timeline_edit_clip");
  await tool.execute({ clipId: cid, op: "trim", trim: { startSec: 1, endSec: 3 } });
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  return list.find((x) => x.clipId === cid).trimmed === true ? true : "没裁上";
});

await t("op=remove 移除", async () => {
  const tool = tools.find((x) => x.name === "timeline_edit_clip");
  const before = (await tools.find((x) => x.name === "timeline_list_clips").execute({})).length;
  await tool.execute({ clipId: cid, op: "remove" });
  const after = (await tools.find((x) => x.name === "timeline_list_clips").execute({})).length;
  return after === before - 1 ? true : `${before} → ${after}`;
});

await t("非法 op 被拒", async () => {
  const tool = tools.find((x) => x.name === "timeline_edit_clip");
  try { await tool.execute({ clipId: added[1].clipId, op: "bogus" }); } catch { return true; }
  return "非法 op 没被拒";
});

console.log("\n═══ ⑦ 单段替换 ═══");

await t("timeline_replace_clip 挂文件", async () => {
  const tool = tools.find((x) => x.name === "timeline_replace_clip");
  await tool.execute({ clipId: added[1].clipId, path: "D:/x/other.mp4", filename: "other.mp4" });
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  const c = list.find((x) => x.clipId === added[1].clipId);
  return c.replaced === true && c.hasRendered === true ? true : JSON.stringify({ r: c.replaced, h: c.hasRendered });
});

await t("替换后提示词仍在（可再重跑）", async () => {
  const list = await tools.find((x) => x.name === "timeline_list_clips").execute({});
  const c = list.find((x) => x.clipId === added[1].clipId);
  return c.prompt && c.prompt.length > 0 && c.modeId === "yz" ? true : JSON.stringify({ p: c.prompt, m: c.modeId });
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  LLM 工具定义验收全过");
