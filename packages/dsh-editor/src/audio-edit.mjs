
export const DEFAULT_AUDIO_EDIT = {
  gain: 1,          // 音量倍数
  fadeInSec: 0,     // 淡入
  fadeOutSec: 0,    // 淡出
  muted: false,     // 静音
};

export function normalizeAudioEdit(edit = {}) {
  const out = { ...DEFAULT_AUDIO_EDIT };
  if (Number.isFinite(edit.gain) && edit.gain >= 0 && edit.gain <= 20) out.gain = edit.gain;
  if (Number.isFinite(edit.fadeInSec) && edit.fadeInSec >= 0) out.fadeInSec = edit.fadeInSec;
  if (Number.isFinite(edit.fadeOutSec) && edit.fadeOutSec >= 0) out.fadeOutSec = edit.fadeOutSec;
  if (typeof edit.muted === "boolean") out.muted = edit.muted;
  return out;
}

/**
 * 校验编辑参数。
 * @returns {{ok:boolean, problems:string[]}}
 */
export function validateAudioEdit(edit, durationSec) {
  const problems = [];
  const e = normalizeAudioEdit(edit);
  if (e.muted) return { ok: true, problems: [] }; // 静音时其它参数无所谓

  if (e.gain === 0) problems.push("gain=0 等于静音，用 muted=true 更明确");
  if (e.gain > 8) problems.push(`gain=${e.gain} 过大（>8 倍约 +18dB），会严重削波`);
  if (durationSec != null) {
    if (e.fadeInSec + e.fadeOutSec > durationSec) {
      problems.push(`淡入(${e.fadeInSec}s)+淡出(${e.fadeOutSec}s) 超过片段时长(${durationSec.toFixed(2)}s)`);
    }
    if (e.fadeInSec > durationSec) problems.push(`淡入(${e.fadeInSec}s) 超过片段时长`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * ★ 生成音频滤镜链。
 * 顺序有讲究：
 * ① 先裁（trim）—— 后面算淡出位置要用裁剪后的时长
 * ② 再淡入淡出
 * ③ 最后音量
 * 反过来的话，淡出位置会算错。
 * @param {object} edit
 * @param {number} durationSec  这一段应用滤镜后的时长
 * @returns {string[]} 滤镜名数组（不带选择器）
 */
export function buildAudioFilters(edit, durationSec) {
  const e = normalizeAudioEdit(edit);
  if (e.muted) return ["volume=0"];

  const f = [];
  // ★ 淡入淡出必须在 volume 之前 —— 否则淡出时音量会被再放大，
  if (e.fadeInSec > 0) f.push(`afade=t=in:st=0:d=${num(e.fadeInSec)}`);
  if (e.fadeOutSec > 0 && durationSec > 0) {
    const st = Math.max(0, durationSec - e.fadeOutSec);
    f.push(`afade=t=out:st=${num(st)}:d=${num(e.fadeOutSec)}`);
  }
  if (Math.abs(e.gain - 1) > 1e-6) f.push(`volume=${num(e.gain)}`);
  return f;
}

/** 数字格式化（去掉多余的 0，避免 ffmpeg 见到 1.00000000001）。 */
function num(n) {
  const v = Math.round(Number(n) * 1e6) / 1e6;
  return String(v);
}

/**
 * 把编辑应用到片段，得到一个可直接渲染的音频片段。
 * @param {object} clip     store 里的音频片段
 * @param {object} edit     编辑参数
 * @returns {object} 渲染用的片段描述（含 filter 链）
 */
export function applyAudioEditToClip(clip, edit) {
  const base = (clip.out - clip.in) / (clip.speed > 0 ? clip.speed : 1);
  const trimmed = clip.trim
    ? Math.max(0, Math.min(clip.trim.endSec, base) - Math.min(clip.trim.startSec, base))
    : base;
  const filters = buildAudioFilters(edit, trimmed);
  return {
    src: clip.rendered?.path ?? clip.src,
    in: clip.in,
    out: clip.out,
    speed: clip.speed ?? 1,
    trim: clip.trim ?? null,
    filters,
    muted: normalizeAudioEdit(edit).muted,
  };
}

/**
 * ★ 音频轨的「一致性检查」—— 找出会导致导出出问题的配置。
 * @param {object} state  store.snapshot()
 * @returns {{ok, problems[], warnings[], audioClips, silentCount, soloCount}}
 */
export function auditAudioTrack(state) {
  const problems = [];
  const warnings = [];
  const aTracks = state.tracks.filter((t) => t.kind === "audio");
  const clips = aTracks.flatMap((t) => t.clips);

  let silentCount = 0;
  let soloCount = 0;

  for (const c of clips) {
    const e = normalizeAudioEdit(c.audioEdit ?? {});
    if (e.muted) silentCount += 1;
    if (Math.abs(e.gain - 1) > 1e-6) soloCount += 1;

    if (c.rendered?.path) {
    } else if (!c.src) {
      problems.push(`「${c.name}」没有音频文件`);
    }

    const base = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);
    const dur = c.trim
      ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base))
      : base;
    const v = validateAudioEdit(c.audioEdit ?? {}, dur);
    for (const p of v.problems) problems.push(`「${c.name}」${p}`);
  }

  const vTracks = state.tracks.filter((t) => t.kind === "video");
  const videoDur = vTracks.reduce((s, t) => s + t.clips.reduce((n, c) => {
    const base = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);
    return n + (c.trim ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base)) : base);
  }, 0), 0);
  const audioDur = clips.reduce((s, c) => {
    const base = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);
    return s + (c.trim ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base)) : base);
  }, 0);

  if (videoDur > 0 && clips.length === 0) {
    warnings.push("音频轨为空 —— 导出会是无声片（如果你本来就要无声，忽略这条）");
  } else if (videoDur > 0 && Math.abs(videoDur - audioDur) > 0.35) {
    problems.push(`音画时长不一致：视频 ${videoDur.toFixed(2)}s / 音频 ${audioDur.toFixed(2)}s`);
  }
  if (silentCount === clips.length && clips.length > 0) {
    warnings.push(`全部 ${clips.length} 段都被静音了 —— 导出会没有声音`);
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    audioClips: clips.length,
    silentCount,
    soloCount,
    videoDuration: videoDur,
    audioDuration: audioDur,
  };
}

export function describeAudioEdit(edit) {
  const e = normalizeAudioEdit(edit);
  if (e.muted) return "静音";
  const parts = [];
  if (Math.abs(e.gain - 1) > 1e-6) {
    const db = 20 * Math.log10(Math.max(e.gain, 1e-6));
    parts.push(`${e.gain}x（${db >= 0 ? "+" : ""}${db.toFixed(1)}dB）`);
  }
  if (e.fadeInSec > 0) parts.push(`淡入 ${e.fadeInSec}s`);
  if (e.fadeOutSec > 0) parts.push(`淡出 ${e.fadeOutSec}s`);
  return parts.length ? parts.join(" · ") : "原样";
}
