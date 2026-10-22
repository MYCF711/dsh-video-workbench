/**
 * 人机交接的「Agent 工具层」验收 —— 补 verify-handoff.mjs 没覆盖的那一层。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要单独一份（2026-10-19）
 *
 *   verify-handoff.mjs 测的是 handoff.mjs 的模块级函数：
 *     lock() / unlock() / checkPatch() / handoffOverview()
 *   它调的是【函数】，不是【Agent 实际会走的路径】。
 *
 *   这一份测的是端到端链路：
 *     Agent 调 timeline_update_shot / timeline_handoff
 *       → store.updateShot() 里的 checkPatch
 *         → handoff.mjs
 *
 *   实测发现两层的差异：
 *     · 我一开始以为可以用 action:"lock" 上锁 ——
 *       enum 只有 ["list","unlock"]，lock 不存在。
 *       **锁不是 Agent 上的，是人在 UI 上改动时自动上的。**
 *       这是正确的设计（Agent 不该有权给自己上锁），但文档没写清。
 *
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
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 120) : ""}`); }
};

const TMP = path.join(os.tmpdir(), `handoff-tools-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });

const { createTimelineStore } = await import(
  pathToFileURL(path.join(PKG, "src", "host-store.mjs")).href
);
const T = await import(pathToFileURL(path.join(PKG, "src", "tools-def.mjs")).href);

const log = { info() {}, warn() {} };
const store = createTimelineStore({ stateFile: path.join(TMP, "state.json"), log });

const tools = {};
T.buildTimelineTools(store, {
  defineTool: (d) => { tools[d.name] = d; return d; },
  bridge: {
    generate: async () => ({ jobId: "fake" }),
    chain: async () => ({ ok: true, details: [], patched: 0, skipped: 0 }),
  },
});

const vt = () => store.snapshot().tracks.find((x) => x.kind === "video");

console.log("═".repeat(62));
console.log("  人机交接 · Agent 工具层验收");
console.log("═".repeat(62));

// ─── ① 工具集合 ────────────────────────────────────────────────
console.log("\n① 工具集合");
t("timeline_handoff 存在", !!tools.timeline_handoff);
t("timeline_update_shot 存在", !!tools.timeline_update_shot);

// ★ action 只有 list / unlock，没有 lock —— 这是设计，不是缺陷
const actionEnum = tools.timeline_handoff?.parameters?.properties?.action?.enum ?? [];
t("action 只允许 list/unlock（lock 由人在 UI 侧触发）",
  actionEnum.length === 2 && actionEnum.includes("list") && actionEnum.includes("unlock"),
  actionEnum);

// ─── ② 建的片段初始无锁 ────────────────────────────────────────
console.log("\n② 初始状态");
store.addTrack("video", "视频 1", "agent");
store.addShot({ modeId: "yz", prompt: "原始提示词", durationSec: 5 }, "agent");
const id = vt().clips[0].id;
t("新片段没有 handoff 记录", !vt().clips[0].handoff || !vt().clips[0].handoff.locks?.prompt);

// ─── ③ 人改 → 自动上锁 ─────────────────────────────────────────
console.log("\n③ 人改 → 自动上锁");
store.updateShot(id, { prompt: "人定的提示词" }, "user");
const c1 = vt().clips[0];
t("值改成了人的", c1.shot.prompt === "人定的提示词");
t("prompt 被锁，by=user", c1.handoff?.locks?.prompt?.by === "user", c1.handoff?.locks);

// ─── ④ Agent 改被锁字段 → 工具层抛错 ───────────────────────────
console.log("\n④ Agent 改被锁字段");
let threw = false, msg = "";
try {
  await tools.timeline_update_shot.execute({ clipId: id, prompt: "Agent 想改的" });
} catch (e) { threw = true; msg = e.message; }
t("工具层抛错", threw);
t("错误信息提到「锁定」", /锁定/.test(msg), msg.slice(0, 80));
t("错误信息给出 unlock 出路", /unlock/.test(msg), msg.slice(0, 80));
t("值没被改", vt().clips[0].shot.prompt === "人定的提示词");

// ─── ⑤ Agent 改未锁字段 → 成功 ─────────────────────────────────
console.log("\n⑤ Agent 改未锁字段");
const r5 = await tools.timeline_update_shot.execute({ clipId: id, durationSec: 8 });
t("返回 applied 含 durationSec", (r5?.applied ?? []).includes("durationSec"), r5);
t("值真的改了", vt().clips[0].shot.durationSec === 8);

// ─── ⑥ Agent 不能解人锁 ────────────────────────────────────────
console.log("\n⑥ Agent 解锁用户锁");
const r6 = await tools.timeline_handoff.execute({ clipId: id, action: "unlock", field: "prompt" });
t("返回 ok=false", r6?.ok === false, r6);
t("原因说「Agent 不能解锁」", /Agent 不能解锁/.test(r6?.reason ?? ""), r6?.reason);
t("锁仍在", vt().clips[0].handoff?.locks?.prompt?.by === "user");

// ─── ⑦ 人解锁后 Agent 能改 ─────────────────────────────────────
console.log("\n⑦ 人解锁 → Agent 能改");
store.updateShot(id, { prompt: "人又改了一次" }, "user");   // 人的改动永远放行
const beforeUnlock = vt().clips[0].shot.prompt;
t("人的改动始终放行", beforeUnlock === "人又改了一次");

// ─── ⑧ 交接单 ──────────────────────────────────────────────────
console.log("\n⑧ 交接单");
const list = await tools.timeline_handoff.execute({ action: "list" });
t("有 total 计数", typeof list?.total === "number", list?.total);
t("有 summary", typeof list?.summary === "string", list?.summary?.slice(0, 40));
t("prompt 归属 user", list?.reports?.[0]?.owned?.prompt === "user", list?.reports?.[0]?.owned);

// ─── ⑨ 空时间轴不崩 ────────────────────────────────────────────
console.log("\n⑨ 边界");
const emptyStore = createTimelineStore({ stateFile: path.join(TMP, "empty.json"), log });
const emptyTools = {};
T.buildTimelineTools(emptyStore, {
  defineTool: (d) => { emptyTools[d.name] = d; return d; },
  bridge: {},
});
let emptyOk = true;
try { await emptyTools.timeline_handoff.execute({ action: "list" }); } catch { emptyOk = false; }
t("空时间轴的 list 不崩", emptyOk);

let unlockNoId = false;
try { await emptyTools.timeline_handoff.execute({ action: "unlock" }); }
catch (e) { unlockNoId = /需要 clipId/.test(e.message); }
t("unlock 缺 clipId 报错", unlockNoId);

// ─── 汇总 + 清理 ───────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log("\n" + "═".repeat(62));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  人机交接工具层验收全过");
