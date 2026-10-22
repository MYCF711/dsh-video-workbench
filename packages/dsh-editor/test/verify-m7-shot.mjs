/**
 * M7-a 分镜片段验收 —— 「重跑这一段」的完整状态机。
 *
 * 主人的要求：
 *   「单段保留原本提示词，并且可以实时修改并重新生成」
 *   「支持单段分镜剪辑，画面裁剪，单段分镜替换」
 *
 * 核心不变式（本轮最重要）：
 *   ★ 重跑失败时，旧的成片必须保留 —— 不能「重跑一下整段没了」。
 */
import {
  createShot, canRegenerate, canStopClip, shotToPayload,
  applyRegenStart, applyRegenProgress, applyRegenDone,
  applyRegenFailed, applyRegenCancelled,
  replaceRendered, setClipTrim, clipVisibleDuration, clipLabel,
  validateClip, clipSummary, CLIP_STATUS,
} from "../src/shot.mjs";

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

/** 造一个「已生成过一次」的片段。 */
function mkRenderedClip(overrides = {}) {
  return {
    id: "c1",
    kind: "video",
    src: "old.mp4",
    in: 0,
    out: 5,
    speed: 1,
    status: "done",
    jobId: null,
    rendered: { path: "old.mp4", filename: "old.mp4", durationSec: 5, generatedAt: 1000 },
    shot: createShot({ modeId: "yz", prompt: "原始提示词", durationSec: 5 }),
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════
console.log("═══ ① createShot 保留生成信息 ═══");

t("createShot 带齐所有字段", () => {
  const s = createShot({ modeId: "yz", prompt: "测试" });
  const need = ["modeId", "prompt", "aspect", "durationSec", "steps", "seed", "toggles", "media", "history"];
  const miss = need.filter((k) => s[k] === undefined);
  return miss.length === 0 ? true : `缺 ${miss.join(",")}`;
});

t("history 初始为空数组", () => createShot().history.length === 0 ? true : "不为空");

console.log("\n═══ ② canRegenerate 判断 ═══");

t("有 modeId + prompt 可重跑", () => {
  const r = canRegenerate(mkRenderedClip());
  return r.ok === true ? true : r.reason;
});

t("没有 modeId 不可重跑（外部导入素材）", () => {
  const c = mkRenderedClip({ shot: createShot({ prompt: "x" }) });
  const r = canRegenerate(c);
  return r.ok === false && r.reason.includes("没有记录生成方式") ? true : JSON.stringify(r);
});

t("提示词为空不可重跑", () => {
  const c = mkRenderedClip({ shot: createShot({ modeId: "yz", prompt: "   " }) });
  const r = canRegenerate(c);
  return r.ok === false && r.reason.includes("提示词") ? true : JSON.stringify(r);
});

t("running 状态不可重跑", () => {
  const c = mkRenderedClip({ status: "running" });
  const r = canRegenerate(c);
  return r.ok === false && r.reason.includes("正在生成") ? true : JSON.stringify(r);
});

t("running + 有 jobId 才能停止", () => {
  const c = mkRenderedClip({ status: "running", jobId: "j1" });
  if (canStopClip(c) !== true) return "有 jobId 却停不了";
  return canStopClip(mkRenderedClip()) === false ? true : "idle 竟然能停";
});

console.log("\n═══ ③ shotToPayload 与画布同构 ═══");

t("yz 的 payload 含关键字段", () => {
  const c = mkRenderedClip();
  const p = shotToPayload(c);
  const need = ["modeId", "prompt", "aspect", "durationSec"];
  const miss = need.filter((k) => p[k] === undefined);
  return miss.length === 0 ? true : `缺 ${miss.join(",")}`;
});

t("生图模式不带 durationSec", () => {
  const c = mkRenderedClip({ shot: createShot({ modeId: "krea2", prompt: "x", durationSec: 5 }) });
  const p = shotToPayload(c);
  return p.durationSec === undefined ? true : `发了 durationSec=${p.durationSec}`;
});

t("素材 base64 能带进去", () => {
  const c = mkRenderedClip({
    shot: createShot({
      modeId: "qwen21-edit", prompt: "x",
      media: { ref_image_0: { base64: "AAA", filename: "a.png" } },
    }),
  });
  const p = shotToPayload(c);
  return p.files?.ref_image_0?.base64 === "AAA" ? true : JSON.stringify(p.files);
});

t("没 modeId 时抛错而不是发坏请求", () => {
  const c = mkRenderedClip({ shot: createShot({ prompt: "x" }) });
  try { shotToPayload(c); } catch { return true; }
  return "没抛错";
});

console.log("\n═══ ④ ★ 重跑状态机：失败不毁片 ═══");

t("regen start → queued，rendered 不变", () => {
  const before = mkRenderedClip();
  const after = applyRegenStart(before, { jobId: "j9", promptId: "p9" });
  if (after.status !== "queued") return `status=${after.status}`;
  if (after.jobId !== "j9") return "jobId 没记下";
  if (after.rendered?.path !== "old.mp4") return "★ rendered 被清掉了 —— 这会毁掉已有成片";
  return true;
});

t("regen progress → running，rendered 仍不变", () => {
  let c = applyRegenStart(mkRenderedClip(), { jobId: "j9" });
  c = applyRegenProgress(c);
  return c.status === "running" && c.rendered?.path === "old.mp4" ? true : JSON.stringify({ s: c.status, r: c.rendered?.path });
});

t("★ regen done → 替换 rendered，旧路径进 history", () => {
  let c = applyRegenStart(mkRenderedClip(), { jobId: "j9", promptId: "p9" });
  c = applyRegenDone(c, {
    outputs: [{ path: "new.mp4", filename: "new.mp4", url: "/api/view?new" }],
    jobId: "j9", promptId: "p9", elapsedMs: 95000,
  });
  if (c.rendered?.path !== "new.mp4") return `rendered 没换：${c.rendered?.path}`;
  if (c.shot.history.length !== 1) return `history ${c.shot.history.length} 条`;
  if (c.shot.history[0].prompt !== "原始提示词") return "history 没记下提示词";
  if (c.status !== "done") return c.status;
  return true;
});

t("★★ regen failed → rendered 保留旧片（这是最关键的一条）", () => {
  let c = applyRegenStart(mkRenderedClip(), { jobId: "j9" });
  c = applyRegenFailed(c, "ComfyUI 未运行");
  if (c.status !== "failed") return `status=${c.status}`;
  if (c.regenError !== "ComfyUI 未运行") return "错误没记下";
  if (c.rendered?.path !== "old.mp4") {
    return `★ rendered 变成 ${c.rendered?.path} —— 重跑失败把成片毁了`;
  }
  return true;
});

t("cancelled 也保留 rendered", () => {
  let c = applyRegenStart(mkRenderedClip(), { jobId: "j9" });
  c = applyRegenCancelled(c);
  return c.status === "cancelled" && c.rendered?.path === "old.mp4" ? true : JSON.stringify({ s: c.status, r: c.rendered?.path });
});

t("所有状态值都在 CLIP_STATUS 里", () => {
  const used = ["queued", "running", "done", "failed", "cancelled"];
  const bad = used.filter((s) => !CLIP_STATUS.includes(s));
  return bad.length === 0 ? true : `未登记 ${bad.join(",")}`;
});

console.log("\n═══ ⑤ 单段替换（不生成，直接挂文件）═══");

t("replaceRendered 挂上新文件并标记", () => {
  const c = replaceRendered(mkRenderedClip(), {
    path: "other.mp4", filename: "other.mp4", durationSec: 3.2,
  });
  if (c.rendered?.path !== "other.mp4") return "没换上";
  if (c.rendered.replaced !== true) return "没标记为替换";
  if (c.status !== "done") return c.status;
  return true;
});

t("替换后 shot 不变（原生成信息还在，可再重跑）", () => {
  const before = mkRenderedClip();
  const c = replaceRendered(before, { path: "x.mp4" });
  return c.shot.prompt === before.shot.prompt && c.shot.modeId === "yz" ? true : "shot 被改了";
});

t("不给 path 也不给 url 会报错", () => {
  try { replaceRendered(mkRenderedClip(), {}); } catch { return true; }
  return "没抛错";
});

console.log("\n═══ ⑥ 单段裁剪 ═══");

t("setClipTrim 生效", () => {
  const c = setClipTrim(mkRenderedClip(), { startSec: 1, endSec: 3 });
  return c.trim.startSec === 1 && c.trim.endSec === 3 ? true : JSON.stringify(c.trim);
});

t("裁剪后可见时长 = 裁剪区间", () => {
  const c = setClipTrim(mkRenderedClip(), { startSec: 1, endSec: 3 });
  return clipVisibleDuration(c) === 2 ? true : clipVisibleDuration(c);
});

t("★ 裁剪与变速叠加：5s 素材 2x 速 → 2.5s，再裁 1~2s → 1s", () => {
  const c = setClipTrim(mkRenderedClip({ speed: 2 }), { startSec: 1, endSec: 2 });
  const d = clipVisibleDuration(c);
  return Math.abs(d - 1) < 1e-9 ? true : `${d}`;
});

t("裁剪终点大于起点才算合法", () => {
  try { setClipTrim(mkRenderedClip(), { startSec: 3, endSec: 1 }); } catch { return true; }
  return "倒置区间没被拒";
});

console.log("\n═══ ⑦ 标签与校验 ═══");

t("clipLabel 拼出关键信息", () => {
  const c = mkRenderedClip({ speed: 2, trim: { startSec: 0, endSec: 1 } });
  const s = clipLabel(c, 0);
  return s.includes("yz") && s.includes("2x") && s.includes("已裁") ? true : s;
});

t("validateClip 对正常片段通过", () => {
  const v = validateClip(mkRenderedClip());
  return v.ok === true ? true : v.problems.join("; ");
});

t("validateClip 报出 trim 越界", () => {
  const c = setClipTrim(mkRenderedClip(), { startSec: 0, endSec: 99 });
  const v = validateClip(c);
  return v.ok === false && v.problems.some((p) => p.includes("超出")) ? true : JSON.stringify(v);
});

console.log("\n═══ ⑧ clipSummary ═══");

t("全部就绪时 exportable=true", () => {
  const s = clipSummary([mkRenderedClip(), mkRenderedClip({ id: "c2" })]);
  return s.ready === 2 && s.exportable === true ? true : JSON.stringify(s);
});

t("有失败时 exportable=false", () => {
  const s = clipSummary([mkRenderedClip(), mkRenderedClip({ id: "c2", status: "failed" })]);
  return s.failed === 1 && s.exportable === false ? true : JSON.stringify(s);
});

t("有未生成时 exportable=false", () => {
  const pending = mkRenderedClip({ id: "c3", status: "idle", rendered: null });
  const s = clipSummary([mkRenderedClip(), pending]);
  return s.pending === 1 && s.exportable === false ? true : JSON.stringify(s);
});

t("有在跑时 exportable=false", () => {
  const s = clipSummary([mkRenderedClip({ status: "running" })]);
  return s.running === 1 && s.exportable === false ? true : JSON.stringify(s);
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M7-a 分镜片段验收全过");
