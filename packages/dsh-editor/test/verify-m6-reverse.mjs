/**
 * M6 视觉反推验收。
 *
 * ★ 本模块的边界（主人第 1 轮定）
 *   「默认是走 agent 的 llm 去反推提示词」——它【不调 LLM】，
 *   只负责：组装请求 / 校验结果 / 回填节点。
 *
 * 判据：
 *   ① 三种目标的请求模板各不相同（H3 结构化，生图自然语言）
 *   ② 校验能挡住不合规的结果（漏结构段、写参数、用「第N张图」）
 *   ③ 回填只写 prompt 字段，不触发提交
 *   ④ 反推失败时给出可操作的提示，不静默
 */
import {
  REVERSE_TARGETS, buildReverseRequest, validateReverseResult,
  applyReverseResult, describeReverseFailure, targetFromModeId,
} from "../src/reverse.mjs";

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
console.log("═══ ① 三种目标的定义 ═══");

t("有 h3 / krea2 / qwen21 三种目标", () => {
  const ids = Object.keys(REVERSE_TARGETS).sort();
  return ids.join(",") === "h3,krea2,qwen21" ? true : ids.join(",");
});

t("H3 要求结构段（subject_definitions 等）", () => {
  const h = REVERSE_TARGETS.h3;
  return h.structure.includes("subject_definitions")
    && h.structure.includes("overall_soundscape")
    && h.requireKeyframeRefs === true ? true : JSON.stringify(h);
});

t("生图目标不要求参考标签", () => {
  return REVERSE_TARGETS.krea2.requireKeyframeRefs === false
    && REVERSE_TARGETS.qwen21.requireKeyframeRefs === false ? true : "要求了";
});

// ══════════════════════════════════════════════════
console.log("\n═══ ② 请求模板：H3 与生图必须不同 ═══");

t("H3 的 system 提到结构段", () => {
  const r = buildReverseRequest({ target: "h3", imageDesc: "x" });
  return r.system.includes("subject_definitions") && r.system.includes("overall_soundscape")
    ? true : "没提到";
});

t("H3 的 system 要求用 <Picture N> 标签", () => {
  const r = buildReverseRequest({ target: "h3", imageDesc: "x" });
  return r.system.includes("<Picture N>") ? true : "没要求";
});

t("★ 生图的 system 禁止用 <Picture N> 标签", () => {
  const r = buildReverseRequest({ target: "krea2", imageDesc: "x" });
  return r.system.includes("不要出现 <Picture N>") ? true : "没禁止";
});

t("两端都禁止写模型参数", () => {
  const a = buildReverseRequest({ target: "h3", imageDesc: "x" });
  const b = buildReverseRequest({ target: "krea2", imageDesc: "x" });
  return a.system.includes("不要写模型参数") && b.system.includes("不要写模型参数") ? true : "没禁止";
});

t("imageDesc / intent / existing 都进 user", () => {
  const r = buildReverseRequest({
    target: "h3", imageDesc: "一只鲸鱼", intent: "要电影感", existing: "旧的提示词",
  });
  return r.user.includes("一只鲸鱼") && r.user.includes("要电影感") && r.user.includes("旧的提示词")
    ? true : r.user.slice(0, 200);
});

t("非法目标抛错", () => {
  try { buildReverseRequest({ target: "bogus" }); } catch { return true; }
  return "没抛错";
});

// ══════════════════════════════════════════════════
console.log("\n═══ ③ 校验：挡住不合规的结果 ═══");

t("空提示词被拒", () => {
  const v = validateReverseResult("", "h3");
  return v.ok === false && v.problems.some((p) => p.includes("为空")) ? true : JSON.stringify(v);
});

t("太短的提示词被拒", () => {
  const v = validateReverseResult("一只鲸鱼", "krea2");
  return v.ok === false && v.problems.some((p) => p.includes("太短")) ? true : JSON.stringify(v);
});

t("★ H3 缺结构段被拒", () => {
  const v = validateReverseResult(
    "一只鲸鱼玩偶在白色桌面上，柔和光线，微距镜头拍摄，质感细腻，浅景深效果明显",
    "h3"
  );
  return v.ok === false && v.problems.some((p) => p.includes("缺少结构段")) ? true : JSON.stringify(v);
});

t("★ 含「第N张图」被拒（H3 必须用标签）", () => {
  const p = `subject_definitions: 鲸鱼
integrated_multimodal_description: <Subject 1> 参照第一张图的外形，在白色桌面上
overall_soundscape: 安静
non_diegetic_music: 轻柔钢琴`;
  const v = validateReverseResult(p, "h3");
  return v.ok === false && v.problems.some((x) => x.includes("第N张图")) ? true : JSON.stringify(v);
});

t("★ 提示词里写参数被拒", () => {
  const p = `subject_definitions: 鲸鱼
integrated_multimodal_description: 一只鲸鱼，steps: 10，seed: 42
overall_soundscape: 安静
non_diegetic_music: 钢琴`;
  const v = validateReverseResult(p, "h3");
  return v.ok === false && v.problems.some((x) => x.includes("模型参数")) ? true : JSON.stringify(v);
});

t("★ 合规的 H3 提示词通过", () => {
  const p = `subject_definitions:
<Subject 1> is a blue whale plush toy with soft fabric texture.

integrated_multimodal_description:
In a bright studio, <Subject 1> rests on a plain white table. Static camera, shallow depth of field, soft daylight from the upper left.

overall_soundscape:
Quiet room tone, faint fabric rustle.

non_diegetic_music:
Gentle solo piano, slow tempo.`;
  const v = validateReverseResult(p, "h3");
  return v.ok === true ? true : JSON.stringify(v.problems);
});

t("生图提示词长但不含结构词只是警告（不算错）", () => {
  const p = "一只深蓝色鲸鱼毛绒玩偶放在纯白桌面上，右上角柔和日光，微距镜头，浅景深，绒毛质感清晰，摄影棚布光";
  const v = validateReverseResult(p, "krea2");
  return v.ok === true && v.warnings.length > 0 ? true : JSON.stringify(v);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ④ 回填：只写 prompt，不触发提交 ═══");

const goodH3 = `subject_definitions:
<Subject 1> is a blue whale plush toy.

integrated_multimodal_description:
<Subject 1> sits on a white table, soft lighting.

overall_soundscape:
Quiet.

non_diegetic_music:
Piano.`;

t("回填后 prompt 变了", () => {
  const clip = { id: "c1", shot: { modeId: "yz", prompt: "旧提示词" } };
  const next = applyReverseResult(clip, { prompt: goodH3, target: "h3", meta: { model: "deepseek" } });
  return next.shot.prompt.includes("blue whale plush") ? true : next.shot.prompt.slice(0, 50);
});

t("★ 不带 status / jobId（不触发提交）", () => {
  const clip = { id: "c1", status: "idle", jobId: null, shot: { modeId: "yz", prompt: "旧" } };
  const next = applyReverseResult(clip, { prompt: goodH3, target: "h3" });
  return next.status === "idle" && next.jobId === null ? true : JSON.stringify({ s: next.status, j: next.jobId });
});

t("记下 reverseMeta（可追溯）", () => {
  const clip = { id: "c1", shot: { modeId: "yz", prompt: "旧" } };
  const next = applyReverseResult(clip, { prompt: goodH3, target: "h3", meta: { model: "deepseek-v4" } });
  return next.shot.reverseMeta?.target === "h3" && next.shot.reverseMeta?.model === "deepseek-v4"
    ? true : JSON.stringify(next.shot.reverseMeta);
});

t("★ 不合规的结果【不回填】，抛错说明原因", () => {
  const clip = { id: "c1", shot: { modeId: "yz", prompt: "旧提示词" } };
  try {
    applyReverseResult(clip, { prompt: "太短", target: "h3" });
    return "★ 没抛错 —— 废提示词被回填了";
  } catch (err) {
    return err.message.includes("不合规") && err.message.includes("太短") ? true : err.message.slice(0, 100);
  }
});

t("回填不破坏 shot 的其他字段", () => {
  const clip = {
    id: "c1",
    shot: { modeId: "yz", prompt: "旧", aspect: "9:16", durationSec: 10, seed: 42, toggles: { combat: true } },
  };
  const next = applyReverseResult(clip, { prompt: goodH3, target: "h3" });
  return next.shot.aspect === "9:16" && next.shot.durationSec === 10
    && next.shot.seed === 42 && next.shot.toggles.combat === true
    ? true : JSON.stringify(next.shot);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ⑤ 失败提示与目标推断 ═══");

t("失败提示带可操作建议", () => {
  const s = describeReverseFailure(new Error("缺结构段"), "h3");
  return s.includes("h3-production-rules") ? true : s;
});

t("targetFromModeId 映射正确", () => {
  const cases = [["yz", "h3"], ["krea2", "krea2"], ["qwen21", "qwen21"], ["qwen21-edit", "qwen21"]];
  const bad = cases.filter(([m, want]) => targetFromModeId(m) !== want);
  return bad.length === 0 ? true : JSON.stringify(bad);
});

t("未知 modeId 默认 h3", () => {
  return targetFromModeId("unknown") === "h3" ? true : targetFromModeId("unknown");
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M6 视觉反推验收全过");
