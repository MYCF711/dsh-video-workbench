/**
 * F6 人机分镜交接 · 单测。
 *
 * ★ 2026-10-18 落成文件：之前这批断言是用 `node -e` 临时跑的，
 *   跑完就没痕迹。复核员指出过「仓库里找不到测试文件，数字无法复现」。
 */
import {
  LOCKABLE,
  fingerprint,
  recordChange,
  checkPatch,
  unlock,
  handoffReport,
  handoffOverview,
} from "../src/handoff.mjs";

let pass = 0;
let fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`); }
}

console.log("═".repeat(58));
console.log("  F6 人机分镜交接");
console.log("═".repeat(58));

// ─── ① 常量 ────────────────────────────────────────────────
console.log("\n① 常量");
t("LOCKABLE 含 8 个字段", LOCKABLE.length === 8, LOCKABLE);
t("含 prompt / durationSec / steps",
  ["prompt", "durationSec", "steps"].every((k) => LOCKABLE.includes(k)));

// ─── ② fingerprint ────────────────────────────────────────
console.log("\n② fingerprint");
t("相同值同指纹", fingerprint("abc") === fingerprint("abc"));
t("不同值不同指纹", fingerprint("abc") !== fingerprint("abd"));
t("null 稳定", fingerprint(null) === fingerprint(null));
t("对象按键排序", fingerprint({ a: 1, b: 2 }) === fingerprint({ b: 2, a: 1 }));
t("数字与字符串不同", fingerprint(1) !== fingerprint("1"));

// ─── ③ recordChange ───────────────────────────────────────
console.log("\n③ recordChange");
{
  const clip = { id: "c1", name: "分镜1", shot: {} };
  const r1 = recordChange(clip, "prompt", "人写的", "user");
  t("人改成功", r1.ok === true);
  t("人改后上锁", clip.handoff.locks.prompt.by === "user");
  t("有日志", clip.handoff.log.length === 1);

  const r2 = recordChange(clip, "prompt", "Agent 改的", "agent");
  t("Agent 改被锁字段 → 拒", r2.ok === false, r2);
  t("原因提到 unlock", /unlock/.test(r2.reason ?? ""), r2.reason);

  const r3 = recordChange(clip, "prompt", "人写的", "agent");
  t("Agent 写相同值 → 放行", r3.ok === true, r3);

  const r4 = recordChange(clip, "steps", 8, "agent");
  t("Agent 改未锁字段 → 放行", r4.ok === true);
  t("Agent 占位记成 agent", clip.handoff.locks.steps.by === "agent");

  const r5 = recordChange(clip, "steps", 12, "user");
  t("人改 Agent 占的字段 → 放行", r5.ok === true);
  t("锁转给人", clip.handoff.locks.steps.by === "user");

  const r6 = recordChange(clip, "bogus", 1, "user");
  t("未知字段被拒", r6.ok === false);

  t("日志上限 50 条", clip.handoff.log.length <= 50);
}

// ─── ④ checkPatch ─────────────────────────────────────────
console.log("\n④ checkPatch（整体预检）");
{
  const c = { id: "c2", shot: {} };
  recordChange(c, "prompt", "人定", "user");
  const ck1 = checkPatch(c, { prompt: "Agent 想改", steps: 10 }, "agent");
  t("发现 prompt 被锁", ck1.ok === false && ck1.blocked.some((b) => b.field === "prompt"));
  t("steps 不误报", !ck1.blocked.some((b) => b.field === "steps"));
  const ck2 = checkPatch(c, { prompt: "人定", steps: 10 }, "agent");
  t("值相同时不拦", ck2.ok === true);
  const ck3 = checkPatch(c, { prompt: "随便" }, "user");
  t("人不受限", ck3.ok === true);
}

// ─── ⑤ unlock ─────────────────────────────────────────────
console.log("\n⑤ unlock");
{
  const c = { id: "c3", shot: {} };
  recordChange(c, "prompt", "人定", "user");
  const u1 = unlock(c, "prompt", "agent");
  t("Agent 不能解人的锁", u1.ok === false);
  const u2 = unlock(c, "prompt", "user");
  t("人能解", u2.ok === true && !u2.locks.prompt);
  recordChange(c, "prompt", "再定", "user");
  recordChange(c, "steps", 5, "agent");
  const u3 = unlock(c, "*", "user");
  t("* 全解", Object.keys(u3.locks).length === 0);
}

// ─── ⑥ handoffReport ──────────────────────────────────────
console.log("\n⑥ handoffReport");
{
  const c = { id: "c4", name: "段", shot: {} };
  recordChange(c, "prompt", "人", "user");
  recordChange(c, "steps", 6, "agent");
  const rep = handoffReport(c);
  t("summary 非空", typeof rep.summary === "string" && rep.summary.length > 0, rep.summary);
  t("owned.prompt = user", rep.owned.prompt === "user");
  t("owned.steps = agent", rep.owned.steps === "agent");
  t("changes 最多 10 条", rep.changes.length <= 10);
  t("空 clip 不崩", handoffReport(null).clipId === null);
}

// ─── ⑦ handoffOverview ────────────────────────────────────
console.log("\n⑦ handoffOverview（冲突检测）");
{
  const c = { id: "x", name: "冲突段", shot: {} };
  recordChange(c, "prompt", "人写", "user");
  // 模拟 Agent 绕过检查直接改（时间更晚）
  c.handoff.log.push({ at: Date.now() + 1000, by: "agent", field: "prompt", fp: "diff" });
  const ov = handoffOverview([c]);
  t("检测到冲突", ov.conflicts.length === 1, ov.conflicts);
  t("summary 提到需要确认", /需要人确认/.test(ov.summary), ov.summary);
  t("touched 计数", ov.touched === 1);

  const empty = handoffOverview([]);
  t("空数组不崩", empty.total === 0 && empty.conflicts.length === 0);

  const clean = handoffOverview([{ id: "y", shot: {} }]);
  t("无记录时 summary 说明", /还没有任何交接记录/.test(clean.summary), clean.summary);
}

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  F6 人机交接验收全过");
