/**
 * M6 工具的两步流验收：prepare → apply。
 *
 * 这就是主人要的「Agent 起草 + 用户修订 + 点击运行」里的【起草】环节。
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

function fakeDefineTool(def) {
  if (!def.name || !def.description || !def.parameters || typeof def.execute !== "function") {
    throw new Error(`工具定义不完整：${def.name ?? "(no name)"}`);
  }
  return def;
}

const store = createTimelineStore({ log: { info() {}, warn() {} } });
const tools = buildTimelineTools(store, { defineTool: fakeDefineTool, bridge: null });
const reverse = tools.find((x) => x.name === "timeline_reverse_prompt");
const addShots = tools.find((x) => x.name === "timeline_add_shots");
const listClips = tools.find((x) => x.name === "timeline_list_clips");

console.log("═══ ① prepare 给写作指令 ═══");

let clipId;
await t("先建一段 yz 分镜", async () => {
  const r = await addShots.execute({ shots: [{ prompt: "旧提示词", modeId: "yz", durationSec: 10 }] });
  clipId = r[0].clipId;
  return clipId ? true : "没拿到 clipId";
});

await t("★ op=prepare 返回 system/user/mustInclude", async () => {
  const r = await reverse.execute({
    op: "prepare", clipId,
    imageDesc: "一只蓝色鲸鱼毛绒玩偶放在白色桌面上，柔和日光，微距镜头",
    intent: "要电影感，突出绒毛质感",
  });
  if (r.target !== "h3") return `target=${r.target}`;
  if (!r.system?.includes("subject_definitions")) return "system 里没有结构要求";
  if (!r.user?.includes("鲸鱼")) return "user 里没有画面信息";
  if (!Array.isArray(r.mustInclude) || r.mustInclude.length !== 4) return `mustInclude=${JSON.stringify(r.mustInclude)}`;
  return true;
});

await t("target 按工作流自动推断（yz → h3）", async () => {
  const r = await reverse.execute({ op: "prepare", clipId, imageDesc: "x" });
  return r.target === "h3" ? true : r.target;
});

await t("显式传 target 可覆盖", async () => {
  const r = await reverse.execute({ op: "prepare", clipId, imageDesc: "x", target: "krea2" });
  return r.target === "krea2" && r.system.includes("不要出现 <Picture N>") ? true : r.target;
});

console.log("\n═══ ② apply 校验后回填 ═══");

const goodPrompt = `subject_definitions:
<Subject 1> is a blue whale plush toy with visible fabric fuzz, dark navy body and pale belly.

integrated_multimodal_description:
In a bright studio, <Subject 1> rests slightly off-center on a plain white table. Static camera at table height, shallow depth of field, soft daylight from the upper left casting a gentle shadow.

overall_soundscape:
Quiet room tone with a faint fabric rustle.

non_diegetic_music:
Gentle solo piano, slow tempo, sparse notes.`;

await t("★ apply 合规提示词 → 回填成功", async () => {
  const r = await reverse.execute({ op: "apply", clipId, prompt: goodPrompt });
  return r.ok === true ? true : JSON.stringify(r);
});

await t("★ 回填后 list_clips 能看到新提示词", async () => {
  const list = await listClips.execute({});
  const c = list.find((x) => x.clipId === clipId);
  return c.prompt.includes("blue whale plush") ? true : c.prompt.slice(0, 60);
});

await t("★ 回填不改变 status（仍是待生成）", async () => {
  const list = await listClips.execute({});
  const c = list.find((x) => x.clipId === clipId);
  return c.status === "idle" && c.hasRendered === false ? true : JSON.stringify({ s: c.status, h: c.hasRendered });
});

await t("★ 不合规的提示词 → 抛错且不回填", async () => {
  const before = (await listClips.execute({})).find((x) => x.clipId === clipId).prompt;
  try {
    await reverse.execute({ op: "apply", clipId, prompt: "太短" });
    return "★ 没抛错";
  } catch (err) {
    const after = (await listClips.execute({})).find((x) => x.clipId === clipId).prompt;
    if (after !== before) return "★ 被改写了";
    return err.message.includes("不合规") ? true : err.message.slice(0, 120);
  }
});

await t("失败提示里带可操作建议", async () => {
  try {
    await reverse.execute({ op: "apply", clipId, prompt: "太短" });
    return "没抛错";
  } catch (err) {
    return err.message.includes("h3-production-rules") ? true : err.message.slice(0, 150);
  }
});

console.log("\n═══ ③ 用户还能再改（Agent 起草 ≠ 锁定）═══");

const updateShot = tools.find((x) => x.name === "timeline_update_shot");
await t("★ 反推后用户仍可手改提示词", async () => {
  await updateShot.execute({ clipId, prompt: "用户自己改的：" + goodPrompt });
  const list = await listClips.execute({});
  const c = list.find((x) => x.clipId === clipId);
  return c.prompt.startsWith("用户自己改的：") ? true : c.prompt.slice(0, 40);
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M6 工具两步流验收全过");
