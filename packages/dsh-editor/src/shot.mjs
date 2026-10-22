
// ★ 2026-10-19：统一的「有没有实际内容」判定。
//   不要用 String(x).trim() —— 它拦不住 "[object Object]"、数字 0、零宽字符。
const INVISIBLE_CHARS = /[\s\u200b-\u200f\u2028-\u202f\u205f\u2060-\u2064\u206a-\u206f\ufeff\u3000\u180e\u3164\u115f\u1160\uffa0\u0000-\u001f\u007f\ufff9-\ufffb]/g;
const hasVisibleText = (s) =>
  typeof s === "string" && s.replace(INVISIBLE_CHARS, "").length > 0;

export function createShot(overrides = {}) {
  return {
    modeId: overrides.modeId ?? null,       // yz / krea2 / qwen21-edit
    prompt: overrides.prompt ?? "",          // ★ 保留原提示词，可实时改
    negative: overrides.negative ?? "",
    aspect: overrides.aspect ?? "16:9",
    durationSec: overrides.durationSec ?? 5,
    steps: overrides.steps ?? null,
    seed: overrides.seed ?? null,
    toggles: overrides.toggles ?? {},
    media: overrides.media ?? {},            // 槽名 -> { filename, path, base64? }
    history: overrides.history ?? [],
  };
}

/**
 * 片段状态机。
 * idle → queued → running → done
 * ↘ failed
 * 任意 → cancelled
 * ★ 与画布节点的区别：片段的 rendered（当前成片）【永远保留】。
 * 重跑失败时，rendered 还是旧的 —— 不会出现「重跑一下整段没了」。
 */
export const CLIP_STATUS = ["idle", "queued", "running", "done", "failed", "cancelled"];

/** 能不能对这一段点「重新生成」。 */
export function canRegenerate(clip) {
  if (!clip) return { ok: false, reason: "片段不存在" };
  if (clip.status === "running" || clip.status === "queued") {
    return { ok: false, reason: "正在生成中，先停止" };
  }
  if (!clip.shot?.modeId) return { ok: false, reason: "这段没有记录生成方式（可能是导入的外部素材）" };
  if (!hasVisibleText(clip.shot?.prompt)) return { ok: false, reason: "提示词为空" };
  return { ok: true, reason: "" };
}

/** 能不能停止。 */
export function canStopClip(clip) {
  return !!(clip && (clip.status === "running" || clip.status === "queued") && clip.jobId);
}

export function shotToPayload(clip) {
  const s = clip.shot;
  if (!s?.modeId) throw new Error("这段没有生成方式，无法重跑");
  const p = {
    modeId: s.modeId,
    prompt: String(s.prompt ?? ""),
  };
  if (s.aspect) p.aspect = s.aspect;
  if (s.durationSec && s.modeId === "yz") p.durationSec = Number(s.durationSec);
  if (s.steps != null && s.steps !== "") p.steps = Number(s.steps);
  if (s.seed != null && s.seed !== "") p.seed = Number(s.seed);
  if (Object.keys(s.toggles ?? {}).length) p.toggles = { ...s.toggles };
  const files = {};
  for (const [k, v] of Object.entries(s.media ?? {})) {
    if (v?.base64) files[k] = { base64: v.base64, filename: v.filename ?? `${k}.png` };
    else if (v?.path) files[k] = { path: v.path, filename: v.filename ?? `${k}.png` };
  }
  if (Object.keys(files).length) p.files = files;
  return p;
}

/**
 * 重跑开始：记下 jobId，但【不动 rendered】。
 * 这样即使重跑失败，用户仍然有旧成片可用。
 */
export function applyRegenStart(clip, { jobId, promptId }) {
  return {
    ...clip,
    status: "queued",
    jobId,
    promptId,
    regenStartedAt: Date.now(),
    regenError: null,
  };
}

export function applyRegenProgress(clip) {
  if (clip.status !== "queued") return clip;
  return { ...clip, status: "running" };
}

/**
 * 重跑成功：替换 rendered，并把这次生成记进 history。
 * ★ 关键：只有成功才替换。失败保留旧的 —— 这是「重跑不毁片」的保证。
 */
export function applyRegenDone(clip, { outputs, jobId, promptId, elapsedMs }) {
  const first = (outputs ?? []).find((o) => /\.(mp4|webm|mov|mkv|m4v)($|\?)/i.test(o.filename ?? "")) ?? outputs?.[0];
  const entry = {
    at: Date.now(),
    prompt: clip.shot?.prompt ?? "",
    modeId: clip.shot?.modeId ?? null,
    jobId,
    promptId,
    elapsedMs: elapsedMs ?? null,
    outputPath: first?.path ?? first?.url ?? null,
    outputFilename: first?.filename ?? null,
  };
  return {
    ...clip,
    status: "done",
    jobId: null,
    rendered: first
      ? {
          path: first.path ?? null,
          url: first.url ?? null,
          filename: first.filename ?? null,
          // ★ 时长由渲染器或 probe 填；这里先记为「未知」
          durationSec: first.durationSec ?? null,
          generatedAt: Date.now(),
        }
      : clip.rendered ?? null,
    shot: { ...clip.shot, history: [...(clip.shot?.history ?? []), entry] },
    regenError: null,
    lastElapsedMs: elapsedMs ?? null,
  };
}

/** 重跑失败：保留旧成片，只记错误。 */
export function applyRegenFailed(clip, error) {
  return {
    ...clip,
    status: "failed",
    jobId: null,
    regenError: String(error ?? "生成失败"),
  };
}

export function applyRegenCancelled(clip) {
  return { ...clip, status: "cancelled", jobId: null };
}

export function replaceRendered(clip, { path, url, filename, durationSec }) {
  if (!path && !url) throw new Error("替换需要 path 或 url");
  return {
    ...clip,
    rendered: {
      path: path ?? null,
      url: url ?? null,
      filename: filename ?? null,
      durationSec: durationSec ?? null,
      generatedAt: Date.now(),
      replaced: true, // 标记：这段不是生成的，是替换来的
    },
    status: "done",
    regenError: null,
  };
}

/**
 * 单段裁剪（在成片上再裁一刀）。
 * ★ 与 clip.in/out 的区别：
 * in/out 是「从源素材取哪段」
 * trim 是「在已取出的成片上再裁」
 * 两者可以叠加：先 in/out 取，再 trim 裁
 */
export function setClipTrim(clip, { startSec, endSec }) {
  const s = Math.max(0, Number(startSec) || 0);
  const e = Number(endSec);
  if (!(e > s)) throw new Error(`裁剪终点(${e}) 必须大于起点(${s})`);
  return { ...clip, trim: { startSec: s, endSec: e } };
}

export function clipVisibleDuration(clip) {
  const raw = clip.out - clip.in;
  const speed = clip.speed > 0 ? clip.speed : 1;
  const base = raw / speed;
  if (clip.trim) {
    const t = Math.min(clip.trim.endSec, base) - Math.min(clip.trim.startSec, base);
    return Math.max(0, t);
  }
  return base;
}

export function clipLabel(clip, index) {
  const parts = [];
  parts.push(clip.name ?? clip.rendered?.filename ?? `片段 ${index + 1}`);
  if (clip.shot?.modeId) parts.push(clip.shot.modeId);
  if (clip.speed !== 1) parts.push(`${clip.speed}x`);
  if (clip.trim) parts.push("已裁");
  if (clip.rendered?.replaced) parts.push("替换");
  return parts.join(" · ");
}

export function validateClip(clip) {
  const problems = [];
  if (!clip) return { ok: false, problems: ["片段为空"] };
  if (clip.out <= clip.in) problems.push("out 必须大于 in");
  if (!(clip.speed > 0)) problems.push("speed 必须 > 0");
  if (clip.trim) {
    if (clip.trim.endSec <= clip.trim.startSec) problems.push("trim 终点必须大于起点");
    const base = (clip.out - clip.in) / clip.speed;
    if (clip.trim.endSec > base + 1e-6) problems.push(`trim 终点超出片段时长（${base.toFixed(2)}s）`);
  }
  if (!clip.rendered?.path && !clip.rendered?.url && clip.shot?.modeId) {
    problems.push("尚未生成");
  }
  return { ok: problems.filter((p) => p !== "尚未生成").length === 0, problems };
}

/** 统计：哪几段没生成 / 生成失败 / 可以导出。 */
export function clipSummary(clips) {
  const out = { total: clips.length, pending: 0, running: 0, failed: 0, ready: 0 };
  for (const c of clips) {
    if (c.status === "running" || c.status === "queued") out.running += 1;
    else if (c.status === "failed") out.failed += 1;
    else if (c.rendered?.path || c.rendered?.url) out.ready += 1;
    else out.pending += 1;
  }
  out.exportable = out.failed === 0 && out.pending === 0 && out.running === 0;
  return out;
}
