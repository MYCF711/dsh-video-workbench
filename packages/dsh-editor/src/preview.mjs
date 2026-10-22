
/**
 * 把片段的 rendered 解析成浏览器能直接用的 URL。
 * @param {object} clip
 * @param {object} opts
 * @param {string} opts.comfyOrigin   ComfyUI 的 origin（如 http://127.0.0.1:8188）
 * @param {string} [opts.assetPrefix] 素材库的 URL 前缀（本地文件走这里）
 * @returns {{url:string|null, kind:'video'|'image'|'audio'|null, reason?:string}}
 */
export function resolvePreviewUrl(clip, opts = {}) {
  const r = clip?.rendered;
  if (!r) {
    if (clip?.src && /^[a-zA-Z]:[\\/]/.test(clip.src)) {
      return { url: fileUrl(clip.src, opts), kind: guessKind(clip.src) };
    }
    return { url: null, kind: null, reason: "这段还没有成片" };
  }
  const ref = r.url ?? r.path;
  if (!ref) return { url: null, kind: null, reason: "没有可用的文件引用" };

  let url;
  if (/^https?:\/\//.test(ref)) {
    url = ref;
  } else if (/^file:\/\//.test(ref)) {
    url = ref;
  } else if (/^[a-zA-Z]:[\\/]/.test(ref)) {
    // ★ Windows 盘符路径（D:\...）—— 一定是本地文件
    url = fileUrl(ref, opts);
  } else if (ref.startsWith("/") && !ref.startsWith("/api/")) {
    // ★ 以 / 开头但不是 ComfyUI 的 /api/ —— 当本地绝对路径（Unix 风格）
    //   注意：/api/view?filename=... 是 ComfyUI 的接口，必须走 origin 拼接。
    //   第一版把 / 开头的一律当本地路径，导致 /api/view 被当成文件（实测踩到）。
    url = fileUrl(ref, opts);
  } else {
    url = String(opts.comfyOrigin ?? "").replace(/\/+$/, "") + (ref.startsWith("/") ? ref : "/" + ref);
  }
  return { url, kind: guessKind(ref || r.filename || "") };
}

/**
 * 本地绝对路径 → 浏览器可用的 URL。
 * ★ 优先用宿主的本地文件路由（如果有 assetPrefix），
 * 否则退化成 file:///（浏览器可能因安全策略拒绝，但至少是个 URL）。
 */
function fileUrl(p, opts = {}) {
  const norm = String(p).replace(/\\/g, "/");
  if (opts.assetPrefix) {
    return `${String(opts.assetPrefix).replace(/\/+$/, "")}/file?path=${encodeURIComponent(norm)}`;
  }
  if (/^[a-zA-Z]:/.test(norm)) return "file:///" + norm;
  return "file://" + (norm.startsWith("/") ? norm : "/" + norm);
}

function guessKind(name) {
  const e = String(name ?? "").toLowerCase();
  if (/\.(mp4|webm|mov|mkv|m4v)($|\?)/.test(e)) return "video";
  if (/\.(png|jpe?g|webp|bmp|gif)($|\?)/.test(e)) return "image";
  if (/\.(m4a|mp3|wav|aac|flac|ogg)($|\?)/.test(e)) return "audio";
  return null;
}

/**
 * ★ 生成「整条时间轴预览」的播放序列。
 * 每个元素是一个「可播放单元」：起点、时长、URL。
 * 前端按顺序切 src 播放。
 * @param {object} state  store.snapshot()
 * @param {object} opts   { comfyOrigin }
 * @returns {{ok, segments:[], totalSec, problems:[]}}
 */
export function buildPreviewSequence(state, opts = {}) {
  const problems = [];
  const vTrack = state.tracks.find((t) => t.kind === "video");
  if (!vTrack) return { ok: false, segments: [], totalSec: 0, problems: ["没有视频轨"] };

  const segments = [];
  let cursor = 0;

  for (const c of vTrack.clips) {
    const base = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);
    const dur = c.trim
      ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base))
      : base;

    const r = resolvePreviewUrl(c, opts);
    if (!r.url) {
      problems.push(`「${c.name}」${r.reason ?? "无预览地址"}`);
      // ★ 仍然占位（保持时间轴对齐），但标记不可播
      segments.push({
        clipId: c.id, name: c.name, start: cursor, duration: dur,
        url: null, kind: null, playable: false, reason: r.reason,
      });
    } else {
      const trimStart = c.trim ? Math.min(c.trim.startSec, base) : 0;
      segments.push({
        clipId: c.id,
        name: c.name,
        start: cursor,
        duration: dur,
        url: r.url,
        kind: r.kind,
        // ★ 播放起点 = 源内起点 + 变速换算 + 裁剪起点
        seekTo: c.in + trimStart * (c.speed > 0 ? c.speed : 1),
        playbackRate: c.speed > 0 ? c.speed : 1,
        playable: true,
      });
    }
    cursor += dur;
  }

  return {
    ok: problems.length === 0,
    segments,
    totalSec: cursor,
    problems,
  };
}

export function segmentAt(sequence, t) {
  if (!sequence?.segments?.length) return null;
  const time = Math.max(0, Math.min(t, sequence.totalSec));
  for (const s of sequence.segments) {
    if (time >= s.start && time < s.start + s.duration) {
      return { ...s, offsetInSegment: time - s.start };
    }
  }
  const last = sequence.segments[sequence.segments.length - 1];
  return { ...last, offsetInSegment: last.duration };
}

/** ★ 判断「能不能连播」—— 有不可播的段时提前告诉用户。 */
export function canPreviewAll(sequence) {
  if (!sequence?.segments?.length) {
    return { ok: false, reason: "时间轴是空的" };
  }
  const bad = sequence.segments.filter((s) => !s.playable);
  if (bad.length) {
    return {
      ok: false,
      reason: `${bad.length} 段还不能预览：${bad.slice(0, 3).map((s) => s.name).join("、")}${bad.length > 3 ? " 等" : ""}`,
      badSegments: bad.map((s) => s.clipId),
    };
  }
  return { ok: true, reason: "" };
}

export function describePreviewState({ playing, t, totalSec, segmentName }) {
  const mm = (s) => {
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${String(ss).padStart(2, "0")}`;
  };
  const pos = `${mm(t)} / ${mm(totalSec ?? 0)}`;
  if (playing) return `播放中 ${pos}${segmentName ? " · " + segmentName : ""}`;
  return `已暂停 ${pos}`;
}
