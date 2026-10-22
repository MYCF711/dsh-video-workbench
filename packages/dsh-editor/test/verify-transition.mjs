/**
 * F8 段间转场 · 单测。
 *
 * ★ 顺带记录一条本机实测铁律（2026-10-18）：
 *   xfade 的两路输入【不能】带 setpts=PTS-STARTPTS，
 *   否则报 "The inputs needs to be a constant frame rate; current rate of 1/0 is invalid"。
 *   而 concat 恰恰要求每段必须 setpts。
 *   ⇒ 两条路的要求相反，render.mjs 里按「用不用转场」分叉。
 */
import {
  TRANSITIONS,
  DEFAULT_TRANSITION,
  DEFAULT_TRANSITION_SEC,
  validateTransition,
  buildXfadeChain,
  buildAudioTrimForXfade,
} from "../src/transition.mjs";

let pass = 0;
let fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`); }
}

console.log("═".repeat(58));
console.log("  F8 段间转场");
console.log("═".repeat(58));

// ─── ① 转场表 ──────────────────────────────────────────────
console.log("\n① 转场表");
t("至少 20 种有中文名", Object.keys(TRANSITIONS).length >= 20, Object.keys(TRANSITIONS).length);
t("默认 fade", DEFAULT_TRANSITION === "fade");
t("默认时长 0.4", DEFAULT_TRANSITION_SEC === 0.4);
for (const k of ["fade", "dissolve", "slideleft", "circleopen", "fadeblack"]) {
  t(`含 ${k}`, !!TRANSITIONS[k]);
}

// ─── ② validateTransition ────────────────────────────────
console.log("\n② validateTransition");
{
  t("两段 5s 正常", validateTransition([5, 5]).ok === true);
  t("段数不足 → 拒", validateTransition([5]).ok === false);
  t("空数组 → 拒", validateTransition([]).ok === false);
  t("不支持的转场 → 拒", validateTransition([5, 5], { type: "bogus" }).ok === false);
  t("时长无效 → 拒", validateTransition([5, 5], { sec: 0 }).ok === false);
  t("负数时长 → 拒", validateTransition([5, 5], { sec: -1 }).ok === false);

  // 夹取：最短 1s → 上限 0.5s
  const v = validateTransition([1, 5], { sec: 2 });
  t("超长被夹到最短段一半", v.sec === 0.5, v);
  t("夹取后仍 ok", v.ok === true);
  const v2 = validateTransition([10, 10], { sec: 3 });
  t("长段不夹", v2.sec === 3, v2);
}

// ─── ③ buildXfadeChain 两段 ───────────────────────────────
console.log("\n③ buildXfadeChain（2 段）");
{
  const r = buildXfadeChain({ labels: ["v0", "v1"], durations: [5, 5] });
  t("applied=1", r.applied === 1);
  t("expectedDuration = 9.6", Math.abs(r.expectedDuration - 9.6) < 0.01, r.expectedDuration);
  t("hardCutDuration = 10", r.hardCutDuration === 10);
  t("offset = 4.6", r.parts[0].includes("offset=4.6"), r.parts[0]);
  t("输出标签 vout", r.out === "vout");
  t("含 transition=fade", r.parts[0].includes("transition=fade"));
}

// ─── ④ 多段链式 ──────────────────────────────────────────
console.log("\n④ 多段链式");
{
  const r = buildXfadeChain({ labels: ["v0", "v1", "v2", "v3"], durations: [2, 2, 2, 2] });
  t("applied=3", r.applied === 3);
  t("expectedDuration = 6.8", Math.abs(r.expectedDuration - 6.8) < 0.01, r.expectedDuration);
  t("生成 3 条 xfade", r.parts.length === 3);
  t("offset 链式累加", r.parts[0].includes("offset=1.6") && r.parts[1].includes("offset=3.2"), r.parts);
  t("最后一条输出到 vout", r.parts[2].includes("[vout]"), r.parts[2]);
  t("中间标签是 vxi", r.parts[0].includes("[vx1]") && r.parts[1].includes("[vx2]"));
}

// ─── ⑤ 退化 ──────────────────────────────────────────────
console.log("\n⑤ 退化（宁可没转场，也不能导出失败）");
{
  const r = buildXfadeChain({ labels: ["v0"], durations: [5] });
  t("单段 → applied=0", r.applied === 0);
  t("单段 → expectedDuration = 硬切时长", r.expectedDuration === 5);
  t("单段 → 有 note", /转场未启用/.test(r.note ?? ""), r.note);
  t("单段 → parts 为空", r.parts.length === 0);

  const bad = buildXfadeChain({ labels: ["v0", "v1"], durations: [5, 5], type: "bogus" });
  t("非法转场 → 退化", bad.applied === 0);
  t("非法转场 → note 说明", /转场未启用/.test(bad.note ?? ""), bad.note);
}

// ─── ⑥ buildAudioTrimForXfade ────────────────────────────
console.log("\n⑥ 音频同步裁短");
{
  const r = buildAudioTrimForXfade({ labels: ["a0", "a1", "a2"], durations: [2, 2, 2], sec: 0.4 });
  const trimmed = r.parts.filter((p) => p.includes("atrim"));
  t("前两段各裁 1.6", trimmed.length === 2 && trimmed.every((p) => p.includes("end=1.6")), trimmed);
  t("最后一段不裁", !r.parts.some((p) => p.startsWith("[a2]atrim")));
  t("最后一段直接进 concat", r.parts[r.parts.length - 1].includes("[a2]"));
  t("expectedDuration = 5.2", Math.abs(r.expectedDuration - 5.2) < 0.01, r.expectedDuration);
  t("concat 输入数 = 3", /concat=n=3/.test(r.parts[r.parts.length - 1]));

  const one = buildAudioTrimForXfade({ labels: ["a0"], durations: [2], sec: 0.4 });
  t("单段 → 不裁", !one.parts.some((p) => p.includes("atrim")));
}

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  F8 段间转场验收全过");
