
import { EventEmitter } from "node:events";
import { checkPatch, recordChange } from "./handoff.mjs";

let seq = 0;
const uid = (p = "c") => `${p}_${Date.now().toString(36)}_${(seq += 1)}`;

/**
 * @typedef {object} TimelineStore
 * @property {object} state  时间轴状态（结构同 dsh-editor 的 timeline + clips）
 */

function emptyState(name = "未命名粗剪") {
  return {
    id: uid("tl"),
    name,
    fps: 24,
    tracks: [
      { id: uid("t"), kind: "video", name: "视频 1", clips: [] },
      { id: uid("t"), kind: "audio", name: "音频 1", clips: [] },
    ],
    nextShotIndex: 1,
    version: 0,
  };
}

// ★ 2026-10-19：统一的「有没有实际内容」判定。
//   不要用 String(x).trim() —— 它拦不住 "[object Object]"、数字 0、零宽字符。
const INVISIBLE_CHARS = /[\s\u200b-\u200f\u2028-\u202f\u205f\u2060-\u2064\u206a-\u206f\ufeff\u3000\u180e\u3164\u115f\u1160\uffa0\u0000-\u001f\u007f\ufff9-\ufffb]/g;
const hasVisibleText = (s) =>
  typeof s === "string" && s.replace(INVISIBLE_CHARS, "").length > 0;

export function createTimelineStore({ log = console } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

/** /** @type {object} 权威状态 */
  let state = emptyState();

  const jobs = new Map();

  const history = [];

  function bump(action, detail = {}, who = "unknown") {
    state.version += 1;
    const evt = {
      type: "timeline/changed",
      version: state.version,
      action,
      who,
      detail,
      at: Date.now(),
    };
    history.push(evt);
    if (history.length > 200) history.shift();
    emitter.emit("change", evt);
    return evt;
  }

/** /** 订阅变更（SSE 用）。返回退订函数。 */
  function subscribe(fn) {
    emitter.on("change", fn);
    return () => emitter.off("change", fn);
  }

  function snapshot() {
    return structuredClone(state);
  }

  function findTrack(trackId) {
    const t = state.tracks.find((x) => x.id === trackId);
    if (!t) throw new Error(`轨道不存在：${trackId}`);
    return t;
  }

  function findClip(clipId) {
    for (const t of state.tracks) {
      const c = t.clips.find((x) => x.id === clipId);
      if (c) return { track: t, clip: c };
    }
    return null;
  }

  function visibleDuration(c) {
    const base = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);
    if (c.trim) {
      const t = Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base);
      return Math.max(0, t);
    }
    return base;
  }

  function layout(track) {
    let t = 0;
    return track.clips.map((c) => {
      const d = visibleDuration(c);
      const seg = { clipId: c.id, start: t, end: t + d, duration: d };
      t += d;
      return seg;
    });
  }

  function timelineDuration() {
    let max = 0;
    for (const tr of state.tracks) {
      const arr = layout(tr);
      const d = arr.length ? arr[arr.length - 1].end : 0;
      if (d > max) max = d;
    }
    return max;
  }

/**
 * /**
 * 加一段分镜（时间轴上的空位，等生成）。
 * ★ 这是「分镜」的核心操作：Agent 可以一次加 26 段。
 */
  function addShot({ modeId, prompt, aspect = "16:9", durationSec = 5, steps = null, seed = null, toggles = {}, media = {}, name = null, trackId = null }, who = "unknown") {
    const track = trackId ? findTrack(trackId) : state.tracks.find((x) => x.kind === "video");
    if (!track) throw new Error("没有视频轨");

    // ★ 2026-10-19 加（测 Agent 工具异常输入发现）：
    //   timeline_add_shots 的 schema 里写了 required: ["prompt", "modeId"]，
    //   但那只是给 LLM 看的提示，【不是运行时拦截】。
    //   实测：传 { shots: [{ prompt: "x" }] }（缺 modeId）→
    //         建出了一个 shot.modeId = undefined 的分镜 2，
    //         等生成时才报「未知模式：undefined」—— 错误位置离原因很远。
    //   ⇒ 在入口拦住，错误信息直接说清缺什么。
    if (!modeId) {
      throw new Error("分镜缺 modeId（工作流）：yz / krea2 / qwen21-edit 之一");
    }
    if (!hasVisibleText(prompt)) {
      throw new Error("分镜缺 prompt（提示词，或只有空白/不可见字符）");
    }
    const idx = state.nextShotIndex++;
    const clip = {
      id: uid("c"),
      kind: track.kind,
      name: name ?? `分镜 ${idx}`,
      src: "（待生成）",
      in: 0,
      out: Number(durationSec),
      speed: 1,
      crop: null,
      gain: 1,
      trim: null,
      status: "idle",
      jobId: null,
      rendered: null,
      regenError: null,
      shot: {
        modeId,
        prompt: String(prompt ?? ""),
        aspect,
        durationSec: Number(durationSec),
        steps: steps === null ? null : Number(steps),
        seed: seed === null ? null : Number(seed),
        toggles: { ...toggles },
        media: { ...media },
        history: [],
      },
    };
    track.clips.push(clip);
    bump("addShot", { clipId: clip.id, modeId, name: clip.name }, who);
    return clip;
  }

  function addShots(shots, who = "unknown") {
    const out = [];
    for (const s of shots) out.push(addShot(s, who));
    return out;
  }

  function updateShot(clipId, patch, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    const allowed = ["modeId", "prompt", "aspect", "durationSec", "steps", "seed", "toggles", "media"];
    for (const [k, v] of Object.entries(patch)) {
      if (!allowed.includes(k)) throw new Error(`不支持的 shot 字段：${k}（可用 ${allowed.join("/")}）`);
    }

    // ★ 2026-10-18（F6 人机分镜交接）：
    //   Agent 改被【用户锁定】的字段要拒绝，而且要在写之前整体预检 ——
    //   边改边判会出现「改了一半被拒」，clip 处于半新半旧的状态，比直接拒更难收拾。
    //   人的改动永远放行（闸门与锁都是给 Agent 设的，不是给人设的）。
    const role = who === "user" ? "user" : "agent";
    const pre = checkPatch(f.clip, patch, role);
    if (!pre.ok) {
      const detail = pre.blocked.map((b) => `${b.field}：${b.reason}`).join("；");
      throw new Error(
        `这些字段已被用户锁定，Agent 不能覆盖：${detail}。` +
        `要覆盖请先调 timeline_handoff 的 unlock，或在返回值里说明覆盖原因。`
      );
    }

    for (const [k, v] of Object.entries(patch)) {
      f.clip.shot[k] = v;
      // 记录谁改的、改成了什么（指纹用于判断「值有没有变」）
      recordChange(f.clip, k, v, role);
    }
    if (patch.durationSec != null) f.clip.out = Number(patch.durationSec);
    bump("updateShot", { clipId, patch: Object.keys(patch) }, who);
    return f.clip;
  }

  function setSpeed(clipId, speed, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    if (!(Number(speed) > 0)) throw new Error(`speed 必须 > 0，收到 ${speed}`);
    f.clip.speed = Number(speed);
    bump("setSpeed", { clipId, speed: f.clip.speed }, who);
    return f.clip;
  }

  function setCrop(clipId, crop, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    if (crop !== null) {
      const { x, y, w, h } = crop;
      if (![x, y, w, h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
        throw new Error("crop 四个值必须在 0~1 之间");
      }
      if (x + w > 1.0001 || y + h > 1.0001) throw new Error("crop 超出画面");
      if (w <= 0 || h <= 0) throw new Error("crop 宽高必须 > 0");
    }
    f.clip.crop = crop;
    bump("setCrop", { clipId, crop }, who);
    return f.clip;
  }

  function setTrim(clipId, trim, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    if (trim === null) {
      f.clip.trim = null;
    } else {
      const s = Math.max(0, Number(trim.startSec) || 0);
      const e = Number(trim.endSec);
      if (!(e > s)) throw new Error(`裁剪终点(${e}) 必须大于起点(${s})`);
      const base = (f.clip.out - f.clip.in) / f.clip.speed;
      if (e > base + 1e-6) throw new Error(`裁剪终点(${e}) 超出片段时长(${base.toFixed(2)}s)`);
      f.clip.trim = { startSec: s, endSec: e };
    }
    bump("setTrim", { clipId, trim: f.clip.trim }, who);
    return f.clip;
  }

  function removeClip(clipId, who = "unknown") {
    for (const tr of state.tracks) {
      const i = tr.clips.findIndex((c) => c.id === clipId);
      if (i >= 0) {
        const job = tr.clips[i].jobId;
        if (job && jobs.has(job)) {
          jobs.get(job).cancelled = true;
        }
        tr.clips.splice(i, 1);
        bump("removeClip", { clipId, trackId: tr.id }, who);
        return true;
      }
    }
    return false;
  }

  function moveClip(clipId, toIndex, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    const from = f.track.clips.findIndex((c) => c.id === clipId);
    const [c] = f.track.clips.splice(from, 1);
    f.track.clips.splice(Math.max(0, Math.min(toIndex, f.track.clips.length)), 0, c);
    bump("moveClip", { clipId, toIndex }, who);
    return c;
  }

  function addTrack(kind, name = null, who = "unknown") {
    if (!["video", "audio"].includes(kind)) throw new Error(`未知轨道类型：${kind}`);
    const n = state.tracks.filter((x) => x.kind === kind).length + 1;
    const tr = {
      id: uid("t"),
      kind,
      name: name ?? `${kind === "video" ? "视频" : "音频"} ${n}`,
      clips: [],
    };
    state.tracks.push(tr);
    bump("addTrack", { trackId: tr.id, kind }, who);
    return tr;
  }

  function replaceRendered(clipId, { path = null, url = null, filename = null, durationSec = null }, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    if (!path && !url) throw new Error("替换需要 path 或 url");
    f.clip.rendered = {
      path, url, filename, durationSec,
      generatedAt: Date.now(),
      replaced: true,
    };
    f.clip.status = "done";
    f.clip.regenError = null;
    bump("replaceRendered", { clipId, filename }, who);
    return f.clip;
  }

/**
 * /**
 * ★ 把某段视频的原声分离出来，追加到音频轨。
 * H3 生成的视频自带音频（VAEDecodeAudio 已封进 mp4），
 * 做分离后默认放入音轨」
 * 规则：
 * ① 音频片段的时长/变速/裁剪与源视频一致 → 天然对齐
 * ② 带 fromVideoClipId，便于「视频重跑后替换对应音频」
 * ③ 已有同源音频时先删旧的（重跑场景）
 */
  function addAudioFromVideo(videoClipId, { path = null, url = null, filename = null, durationSec = null }, who = "unknown") {
    // ★ videoClipId 允许为 null —— 表示「加一段独立音频」（用户手动配的 BGM/配音）
    //   原实现强制要求源视频存在，导致「手动加音频」这条路径走不通（实测发现）。
    let v = null;
    let base = durationSec ?? 1;
    if (videoClipId) {
      const f = findClip(videoClipId);
      if (!f) throw new Error(`视频片段不存在：${videoClipId}`);
      if (f.track.kind !== "video") throw new Error(`片段 ${videoClipId} 不是视频轨上的`);
      v = f.clip;
      base = (v.out - v.in) / (v.speed > 0 ? v.speed : 1);
    }

    let aTrack = state.tracks.find((t) => t.kind === "audio");
    if (!aTrack) aTrack = addTrack("audio", null, who);

    if (videoClipId) {
      aTrack.clips = aTrack.clips.filter((c) => c.fromVideoClipId !== videoClipId);
    }
    const clip = {
      id: uid("c"),
      kind: "audio",
      name: videoClipId ? `${v.name ?? "片段"} · 原声` : (filename ?? "独立音频"),
      src: path ?? url ?? filename ?? "(原声)",
      in: 0,
      out: durationSec ?? base,
      // ★ v 可能为 null（独立音频）—— 必须可选链
      speed: v?.speed ?? 1,
      crop: null,
      gain: 1,
      trim: v?.trim ? { ...v.trim } : null,
      status: "done",
      jobId: null,
      rendered: {
        path, url, filename,
        durationSec: durationSec ?? base,
        generatedAt: Date.now(),
        fromVideo: true,
      },
      shot: null,
      regenError: null,
      fromVideoClipId: videoClipId,
      // ★ 保持与视频片段相同的顺序：插到音频轨里「对应视频序号」的位置
      _orderHint: indexOfClipInVideoTrack(videoClipId),
    };

    insertOrdered(aTrack, clip);

    bump("addAudioFromVideo", { videoClipId, audioClipId: clip.id, durationSec: clip.out }, who);
    return clip;
  }

/**
 * /**
 * ★ 设置音频片段的编辑参数（音量/淡入淡出/静音）。
 * 音频分离后可独立调整 —— 这是那个「调整」。
 * ★ 不改文件，只记意图（导出时才应用），随时可撤销。
 */
  function setAudioEdit(clipId, edit, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    if (f.clip.kind !== "audio") throw new Error(`片段 ${clipId} 不是音频（kind=${f.clip.kind}）`);

    const base = (f.clip.out - f.clip.in) / (f.clip.speed > 0 ? f.clip.speed : 1);
    const dur = f.clip.trim
      ? Math.max(0, Math.min(f.clip.trim.endSec, base) - Math.min(f.clip.trim.startSec, base))
      : base;

    const e = { gain: 1, fadeInSec: 0, fadeOutSec: 0, muted: false, ...edit };
    e.gain = Number(e.gain);
    e.fadeInSec = Number(e.fadeInSec);
    e.fadeOutSec = Number(e.fadeOutSec);
    if (!(e.gain >= 0 && e.gain <= 20)) throw new Error(`gain 必须在 0~20，收到 ${edit.gain}`);
    if (e.fadeInSec < 0 || e.fadeOutSec < 0) throw new Error("淡入淡出不能为负");
    if (!e.muted && e.fadeInSec + e.fadeOutSec > dur + 1e-6) {
      throw new Error(`淡入+淡出(${(e.fadeInSec + e.fadeOutSec).toFixed(2)}s) 超过片段时长(${dur.toFixed(2)}s)`);
    }

    f.clip.audioEdit = e;
    bump("setAudioEdit", { clipId, edit: e }, who);
    return f.clip;
  }

  function auditAudio() {
    const clips = state.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips);
    const durOf = (c) => {
      const base = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);
      return c.trim ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base)) : base;
    };
    const vDur = state.tracks.filter((t) => t.kind === "video")
      .reduce((s, t) => s + t.clips.reduce((n, c) => n + durOf(c), 0), 0);
    const aDur = clips.reduce((s, c) => s + durOf(c), 0);
    const problems = [];
    const warnings = [];
    if (vDur > 0 && clips.length === 0) warnings.push("音频轨为空（导出会是无声片）");
    else if (vDur > 0 && Math.abs(vDur - aDur) > 0.35) {
      problems.push(`音画时长不一致：视频 ${vDur.toFixed(2)}s / 音频 ${aDur.toFixed(2)}s`);
    }
    const mutedAll = clips.length > 0 && clips.every((c) => c.audioEdit?.muted);
    if (mutedAll) warnings.push(`全部 ${clips.length} 段都被静音`);
    return {
      ok: problems.length === 0, problems, warnings,
      audioClips: clips.length, videoDuration: vDur, audioDuration: aDur,
    };
  }

/**
 * /**
 * ★ 原样加一个片段（持久化恢复用）。
 * 与 addShot 的区别：
 * addShot   会给新 id、自动编号、建默认 shot
 * addClipRaw 保留传入的 id 与全部字段 —— 恢复时必须用它，
 * 否则 fromVideoClipId 之类的关联会断掉
 */
  function addClipRaw(trackId, clipData, who = "restore") {
    const track = findTrack(trackId);
    if (clipData.out <= clipData.in) {
      throw new Error(`片段 out(${clipData.out}) 必须大于 in(${clipData.in})`);
    }
    const clip = {
      id: clipData.id ?? uid("c"),
      kind: clipData.kind ?? track.kind,
      name: clipData.name ?? "片段",
      src: clipData.src ?? "",
      in: Number(clipData.in),
      out: Number(clipData.out),
      speed: Number(clipData.speed ?? 1),
      crop: clipData.crop ?? null,
      gain: Number(clipData.gain ?? 1),
      trim: clipData.trim ?? null,
      shot: clipData.shot ?? null,
      rendered: clipData.rendered ?? null,
      status: clipData.status ?? (clipData.rendered ? "done" : "idle"),
      jobId: null,
      regenError: clipData.regenError ?? null,
      fromVideoClipId: clipData.fromVideoClipId ?? null,
      // ★ 2026-10-18（F6）：交接记录要能被恢复。addClipRaw 是逐字段赋值的，
      //   这里漏一个字段就等于「重启后人的锁全丢」。
      handoff: clipData.handoff ?? null,
    };
    track.clips.push(clip);
    return clip;
  }
  function indexOfClipInVideoTrack(clipId) {
    const vt = state.tracks.find((t) => t.kind === "video");
    if (!vt) return 999;
    const i = vt.clips.findIndex((c) => c.id === clipId);
    return i < 0 ? 999 : i;
  }

  function insertOrdered(aTrack, clip) {
    const hint = clip._orderHint ?? 999;
    let pos = aTrack.clips.length;
    for (let i = 0; i < aTrack.clips.length; i++) {
      const c = aTrack.clips[i];
      const h = c._orderHint ?? indexOfClipInVideoTrack(c.fromVideoClipId);
      if (h > hint) { pos = i; break; }
    }
    aTrack.clips.splice(pos, 0, clip);
  }

/** /** 提交前检查：这一段能不能生成。 */
  function canRegenerate(clipId) {
    const f = findClip(clipId);
    if (!f) return { ok: false, reason: "片段不存在" };
    const c = f.clip;
    if (c.status === "running" || c.status === "queued") return { ok: false, reason: "正在生成中，先停止" };
    if (!c.shot?.modeId) return { ok: false, reason: "这段没有生成方式（外部素材）" };
    // ★ 2026-10-19：改用 hasVisibleText —— String(x).trim() 拦不住零宽字符
    if (!hasVisibleText(c.shot?.prompt)) return { ok: false, reason: "提示词为空（或只有空白/不可见字符）" };
    return { ok: true, reason: "" };
  }

/** /** 标记开始生成（★ 不动 rendered —— 失败不毁片）。 */
  function startJob(clipId, { jobId, promptId = null }, who = "unknown") {
    const f = findClip(clipId);
    if (!f) throw new Error(`片段不存在：${clipId}`);
    f.clip.status = "queued";
    f.clip.jobId = jobId;
    f.clip.regenError = null;
    jobs.set(jobId, { clipId, startedAt: Date.now(), cancelled: false });
    bump("jobStarted", { clipId, jobId }, who);
    return f.clip;
  }

  function progressJob(jobId) {
    const j = jobs.get(jobId);
    if (!j) return;
    const f = findClip(j.clipId);
    if (!f) return;
    if (f.clip.status === "queued") {
      f.clip.status = "running";
      bump("jobProgress", { clipId: j.clipId, jobId }, "host");
    }
  }

  function completeJob(jobId, { outputs = [], elapsedMs = null }, who = "host") {
    const j = jobs.get(jobId);
    if (!j) return null;
    jobs.delete(jobId);
    const f = findClip(j.clipId);
    if (!f) return null;
    const first = outputs.find((o) => /\.(mp4|webm|mov|mkv|m4v)($|\?)/i.test(o.filename ?? "")) ?? outputs[0];
    if (first) {
      f.clip.rendered = {
        path: first.path ?? null,
        url: first.url ?? null,
        filename: first.filename ?? null,
        durationSec: first.durationSec ?? null,
        generatedAt: Date.now(),
      };
    }
    f.clip.status = "done";
    f.clip.jobId = null;
    f.clip.regenError = null;
    f.clip.shot.history.push({
      at: Date.now(),
      prompt: f.clip.shot.prompt,
      modeId: f.clip.shot.modeId,
      jobId,
      elapsedMs,
      outputFilename: first?.filename ?? null,
    });
    bump("jobCompleted", { clipId: j.clipId, jobId, elapsedMs }, who);
    return f.clip;
  }

/** /** 失败：★ 保留 rendered。 */
  function failJob(jobId, error, who = "host") {
    const j = jobs.get(jobId);
    if (!j) return null;
    jobs.delete(jobId);
    const f = findClip(j.clipId);
    if (!f) return null;
    f.clip.status = "failed";
    f.clip.jobId = null;
    f.clip.regenError = String(error ?? "生成失败");
    // ★ rendered 保持原样
    bump("jobFailed", { clipId: j.clipId, jobId, error: f.clip.regenError }, who);
    return f.clip;
  }

/** /** 取消：★ 保留 rendered。 */
  function cancelJob(jobId, who = "unknown") {
    const j = jobs.get(jobId);
    if (!j) return null;
    jobs.delete(jobId);
    const f = findClip(j.clipId);
    if (!f) return null;
    f.clip.status = "cancelled";
    f.clip.jobId = null;
    bump("jobCancelled", { clipId: j.clipId, jobId }, who);
    return { clipId: j.clipId, promptId: f.clip.shot ? f.clip.jobId : null };
  }

/** /** ★ 全局叫停：停掉所有在跑的任务。 */
  function cancelAll(who = "unknown") {
    const ids = [...jobs.keys()];
    const out = [];
    for (const id of ids) {
      const r = cancelJob(id, who);
      if (r) out.push(r);
    }
    bump("cancelAll", { count: out.length }, who);
    return { cancelled: out.length, jobs: ids };
  }

  function runningJobs() {
    return [...jobs.entries()].map(([jobId, j]) => ({
      jobId,
      clipId: j.clipId,
      startedAt: j.startedAt,
      elapsedMs: Date.now() - j.startedAt,
    }));
  }

  function summary() {
    const clips = state.tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
    const out = { total: clips.length, idle: 0, running: 0, done: 0, failed: 0, pending: 0 };
    for (const c of clips) {
      if (c.status === "running" || c.status === "queued") out.running += 1;
      else if (c.status === "failed") out.failed += 1;
      else if (c.rendered?.path || c.rendered?.url) out.done += 1;
      else out.pending += 1;
    }
    return {
      ...out,
      durationSec: Math.round(timelineDuration() * 100) / 100,
      tracks: state.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, clips: t.clips.length })),
      runningJobs: runningJobs(),
      version: state.version,
      exportable: out.running === 0 && out.failed === 0 && out.pending === 0 && out.total > 0,
    };
  }

  return {
    snapshot,
    summary,
    layout: (trackId) => layout(findTrack(trackId)),
    timelineDuration,
    clipEquals: (clipId) => findClip(clipId),
    runningJobs,
    history: () => history.slice(),

    subscribe,

    addShot,
    addShots,
    updateShot,
    setSpeed,
    setCrop,
    setTrim,
    removeClip,
    moveClip,
    addTrack,
    replaceRendered,
    addAudioFromVideo,
    addClipRaw,
    setAudioEdit,
    auditAudio,

    canRegenerate,
    startJob,
    progressJob,
    completeJob,
    failJob,
    cancelJob,
    cancelAll,

    _reset(name) {
      state = emptyState(name);
      jobs.clear();
      history.length = 0;
      bump("reset", {}, "system");
    },

/**
 * /**
 * 恢复元信息（持久化层用）。
 * ★ 只允许改「不触发广播的元字段」——避免恢复时刷出一堆事件。
 */
    _restoreMeta(meta = {}) {
      if (typeof meta.nextShotIndex === "number" && meta.nextShotIndex > state.nextShotIndex) {
        state.nextShotIndex = meta.nextShotIndex;
      }
      if (meta.fps) state.fps = meta.fps;
      if (meta.name) state.name = meta.name;
    },
  };
}