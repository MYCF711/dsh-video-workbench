
/**
 * @param {string} file  本地文件路径
 * @param {Function} probeFn  file → { hasAudio, durationSec }
 */
export function shouldExtractAudio(file, probeFn) {
  if (!file) return { ok: false, reason: "没有文件" };
  const p = probeFn(file);
  if (!p?.hasAudio) return { ok: false, reason: "该文件没有音轨" };
  return { ok: true, durationSec: p.durationSec ?? null };
}

/**
 * 生成「从视频里抽音频」的 ffmpeg 参数。
 * @param {string} src       视频文件
 * @param {string} out       输出音频文件（.m4a）
 * @param {object} [opts]
 * @param {number} [opts.inSec]    起点（源时间）
 * @param {number} [opts.durSec]   时长
 * @param {number} [opts.gain]     音量倍数
 * @returns {string[]} ffmpeg args
 */
export function buildExtractAudioArgs(src, out, opts = {}) {
  const args = ["-y"];
  if (opts.inSec != null) args.push("-ss", String(opts.inSec));
  if (opts.durSec != null) args.push("-t", String(opts.durSec));
  args.push("-i", src, "-vn");

  const filters = ["aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];
  if (opts.gain != null && Math.abs(opts.gain - 1) > 1e-6) {
    filters.push(`volume=${opts.gain}`);
  }
  args.push("-af", filters.join(","));
  args.push("-c:a", "aac", "-b:a", "192k");
  args.push(out);
  return args;
}

/**
 * ★ 把「视频片段的音轨」分离成「音频片段的引用」。
 * 这个函数是纯数据变换：不改文件，只算出「应该有哪些音频片段」。
 * 实际的抽取由 host 侧执行（需要 ffmpeg）。
 * @param {object} videoClip  store 里的视频片段
 * @param {object} extracted  { path, filename, durationSec } 抽取结果
 * @returns {object} 应该放进音频轨的片段描述
 */
export function audioClipFromVideo(videoClip, extracted) {
  const dur = (videoClip.out - videoClip.in) / (videoClip.speed > 0 ? videoClip.speed : 1);
  return {
    kind: "audio",
    name: `${videoClip.name ?? "片段"} · 原声`,
    src: extracted.path,
    in: 0,
    out: extracted.durationSec ?? dur,
    speed: videoClip.speed ?? 1,
    gain: 1,
    trim: videoClip.trim ? { ...videoClip.trim } : null,
    // ★ 标记来源，便于「视频重跑后自动替换对应音频」
    fromVideoClipId: videoClip.id,
    rendered: {
      path: extracted.path,
      filename: extracted.filename ?? null,
      durationSec: extracted.durationSec ?? null,
      generatedAt: Date.now(),
    },
    status: "done",
  };
}

/**
 * 找出「哪些视频片段的音频还没分离」。
 * @param {object} state  store.snapshot()
 * @returns {Array<{videoClip, needsExtract}>}
 */
export function pendingAudioExtraction(state) {
  const vTrack = state.tracks.find((t) => t.kind === "video");
  if (!vTrack) return [];
  const audioTracks = state.tracks.filter((t) => t.kind === "audio");
  const existing = new Set(
    audioTracks.flatMap((t) => t.clips.map((c) => c.fromVideoClipId).filter(Boolean))
  );

  const out = [];
  for (const vc of vTrack.clips) {
    if (!vc.rendered?.path && !vc.rendered?.url) continue;  // 还没成片
    if (existing.has(vc.id)) continue;                       // 已分离过
    out.push({ videoClip: vc, needsExtract: true });
  }
  return out;
}

/**
 * 音频与视频的对齐检查。
 * ★ 判据：音频轨的片段累计时长应等于视频轨。
 * 不等就说明有一段的音频缺失或时长错了 —— 导出会有音画错位。
 * @returns {{ok, videoDuration, audioDuration, diff, problems[]}}
 */
export function checkAvAlignment(state) {
  const problems = [];
  const dur = (c) => {
    const base = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);
    if (c.trim) {
      return Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base));
    }
    return base;
  };
  const sum = (tr) => tr.clips.reduce((s, c) => s + dur(c), 0);

  const vTrack = state.tracks.find((t) => t.kind === "video");
  const vDur = vTrack ? sum(vTrack) : 0;

  const aTracks = state.tracks.filter((t) => t.kind === "audio" && t.clips.length > 0);
  const aDur = aTracks.length ? Math.max(...aTracks.map(sum)) : 0;

  const diff = Math.abs(vDur - aDur);
  if (vDur > 0 && aTracks.length === 0) {
    problems.push("视频轨有内容但音频轨全空 —— 导出会没有声音");
  } else if (vDur > 0 && diff > 0.35) {
    problems.push(`音画时长不一致：视频 ${vDur.toFixed(2)}s / 音频 ${aDur.toFixed(2)}s（差 ${diff.toFixed(2)}s）`);
  }

  return { ok: problems.length === 0, videoDuration: vDur, audioDuration: aDur, diff, problems };
}
