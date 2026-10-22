/**
 * 提示词闸门验收。
 *
 * 要证明的三件事：
 *   ① 规则能内嵌进工具返回（不依赖 Agent 主动读 skill）
 *   ② 绕过闸门直接改 prompt / 直接 generate → 守卫拒绝
 *   ③ 走完闸门之后放行；提示词改过则闸门失效
 */
import {
  buildPromptRequirements, checkPrompt, markPassed, hasPassed, forget,
  registerPromptGuard,
} from "../src/prompt-gate.mjs";
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
    console.log(`  ❌ ${desc}\n     ${String(err.stack ?? err.message).slice(0, 400)}`);
    fail++; failures.push(desc);
  }
}

const silent = { info() {}, warn() {} };

console.log("═══ ① 规则内嵌 ═══");

await t("buildPromptRequirements 返回 10 条（表头 + 9 条规则）", () => {
  const r = buildPromptRequirements("yz");
  // 表头「【提交前必须满足】」+ 6 条通用 + 3 条 H3 专项
  return r.mustSatisfy.length === 10 ? true : `${r.mustSatisfy.length} 条`;
});

await t("生图模式只有 7 条（表头 + 6 条通用，不含 H3 专项）", () => {
  const r = buildPromptRequirements("krea2");
  if (r.mustSatisfy.length !== 7) return `${r.mustSatisfy.length} 条`;
  return r.mustSatisfy.some((s) => s.includes("subject_definitions")) ? "混进了 H3 规则" : true;
});

await t("★ 规则里有「台词时长」这条（最容易错的）", () => {
  const r = buildPromptRequirements("yz");
  return r.mustSatisfy.some((s) => s.includes("台词字数")) ? true : "没有";
});

console.log("\n═══ ② 校验器能挡住不合规 ═══");

await t("空提示词被拒", () => {
  const r = checkPrompt("", "yz");
  return r.ok === false ? true : "放行了";
});

await t("★ H3 缺结构段被拒", () => {
  const r = checkPrompt("一只鲸鱼在游，光线柔和，浅景深，微距镜头", "yz");
  return r.ok === false && r.problems.some((p) => p.includes("结构段")) ? true : JSON.stringify(r.problems);
});

await t("★ 写参数被拒", () => {
  const r = checkPrompt("subject_definitions: x\nintegrated_multimodal_description: steps: 10\noverall_soundscape: y", "yz");
  return r.ok === false && r.problems.some((p) => p.includes("模型参数")) ? true : JSON.stringify(r.problems);
});

await t("空泛词只警告不拒", () => {
  const p = "subject_definitions:\n<Subject 1> is a beautiful whale\nintegrated_multimodal_description:\nIt swims in the ocean with soft daylight from above, shallow depth of field.\noverall_soundscape:\nQuiet water.\nnon_diegetic_music:\nPiano.";
  const r = checkPrompt(p, "yz");
  return r.ok === true && r.warnings.some((w) => w.includes("beautiful")) ? true : JSON.stringify(r);
});

await t("合规的 H3 提示词通过", () => {
  const p = `subject_definitions:
<Subject 1> is a blue whale plush toy with visible fabric fuzz.

integrated_multimodal_description:
In a bright studio, <Subject 1> rests on a plain white table. Static camera, shallow depth of field, soft daylight from the upper left.

overall_soundscape:
Quiet room tone with a faint fabric rustle.

non_diegetic_music:
Gentle solo piano.`;
  const r = checkPrompt(p, "yz");
  return r.ok === true ? true : JSON.stringify(r.problems);
});

console.log("\n═══ ③ 闸门登记与失效 ═══");

await t("markPassed 后 hasPassed 为真", () => {
  markPassed("c1", "some prompt");
  return hasPassed("c1", "some prompt") ? true : "没登记上";
});

await t("★ 提示词改过 → 闸门失效", () => {
  markPassed("c2", "prompt A");
  return hasPassed("c2", "prompt B") === false ? true : "改过了还放行";
});

await t("forget 清掉登记", () => {
  markPassed("c3", "x");
  forget("c3");
  return hasPassed("c3", "x") === false ? true : "没清掉";
});

console.log("\n═══ ④ ★ 守卫真的拦得住 ═══");

function fakeCtxWithGuard() {
  let guardFn = null;
  return {
    tools: {
      guard(fn) { guardFn = fn; return () => { guardFn = null; }; },
      get __fn() { return guardFn; },
    },
  };
}

await t("ctx.tools.guard 不可用时降级（只警告）", () => {
  let warned = false;
  const d = registerPromptGuard({}, { log: { warn: () => { warned = true; }, info() {} } });
  d();
  return warned ? true : "没警告";
});

await t("★ Agent 直接改 prompt（未过闸门）→ 拒绝", () => {
  const ctx = fakeCtxWithGuard();
  const d = registerPromptGuard(ctx, { log: silent });
  const verdict = ctx.tools.__fn({
    name: "timeline_update_shot",
    args: { clipId: "c_untouched", prompt: "随手写的一段提示词，没走校验" },
  });
  d();
  return verdict?.denied === true && verdict.reason.includes("timeline_reverse_prompt")
    ? true : JSON.stringify(verdict);
});

await t("★ 过了闸门再改 → 放行", () => {
  const ctx = fakeCtxWithGuard();
  const d = registerPromptGuard(ctx, { log: silent });
  const prompt = "subject_definitions:\n<Subject 1> is a whale\nintegrated_multimodal_description:\nIt swims.\noverall_soundscape:\nQuiet.";
  markPassed("c_ok", prompt);
  const verdict = ctx.tools.__fn({
    name: "timeline_update_shot",
    args: { clipId: "c_ok", prompt },
  });
  d();
  return verdict === undefined ? true : JSON.stringify(verdict);
});

await t("★ 未过闸门就 generate → 拒绝", () => {
  const ctx = fakeCtxWithGuard();
  const d = registerPromptGuard(ctx, { log: silent });
  const verdict = ctx.tools.__fn({
    name: "timeline_generate",
    args: { clipIds: ["c_never_gated"] },
  });
  d();
  return verdict?.denied === true && verdict.reason.includes("闸门") ? true : JSON.stringify(verdict);
});

await t("过了闸门的段可以 generate", () => {
  const ctx = fakeCtxWithGuard();
  const d = registerPromptGuard(ctx, { log: silent });
  markPassed("c_ready", "p");
  const verdict = ctx.tools.__fn({ name: "timeline_generate", args: { clipIds: ["c_ready"] } });
  d();
  return verdict === undefined ? true : JSON.stringify(verdict);
});

await t("改别的字段（非 prompt）不受拦", () => {
  const ctx = fakeCtxWithGuard();
  const d = registerPromptGuard(ctx, { log: silent });
  const verdict = ctx.tools.__fn({
    name: "timeline_update_shot",
    args: { clipId: "c_x", durationSec: 10 },   // 没带 prompt
  });
  d();
  return verdict === undefined ? true : JSON.stringify(verdict);
});

console.log("\n═══ ⑤ ★ prepare 返回里真的带规则 ═══");

const store = createTimelineStore({ log: silent });
const tools = buildTimelineTools(store, {
  defineTool: (d) => d,
  bridge: null,
});

await t("调 prepare 能看到 mustSatisfy", async () => {
  const add = tools.find((x) => x.name === "timeline_add_shots");
  const added = await add.execute({ shots: [{ prompt: "旧提示词", modeId: "yz", durationSec: 10 }] });
  const clipId = added[0].clipId;

  const rev = tools.find((x) => x.name === "timeline_reverse_prompt");
  const r = await rev.execute({ op: "prepare", clipId, imageDesc: "一只鲸鱼" });
  if (!Array.isArray(r.mustSatisfy)) return "没有 mustSatisfy";
  if (r.mustSatisfy.length < 6) return `只有 ${r.mustSatisfy.length} 条`;
  return r.mustSatisfy.some((s) => s.includes("台词")) ? true : "规则不完整";
});

await t("★ apply 成功后该段被登记为已过闸门", async () => {
  const list = tools.find((x) => x.name === "timeline_list_clips");
  const clips = await list.execute({});
  const clipId = clips[0].clipId;
  const rev = tools.find((x) => x.name === "timeline_reverse_prompt");
  const good = `subject_definitions:
<Subject 1> is a blue whale plush toy.

integrated_multimodal_description:
In a bright studio, <Subject 1> rests on a white table. Static camera, shallow depth of field.

overall_soundscape:
Quiet room tone.

non_diegetic_music:
Gentle piano.`;
  await rev.execute({ op: "apply", clipId, prompt: good });
  return hasPassed(clipId, good) ? true : "apply 后没登记";
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  提示词闸门验收全过");
