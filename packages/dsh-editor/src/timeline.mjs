/**
 * 时间轴模型。纯逻辑，不碰 DOM、不碰 ffmpeg。
 *
 * 两条必须遵守的约定：
 * · 时间用【秒】存，不存帧号 —— 帧号在变速后失去意义，渲染时才按 fps 换算
 * · clip.out 是【源素材内的时间】，不是时间轴时间；时间轴位置由前面片段时长累加算出，
 *   不单独存 —— 这样波纹删除只需改数组
 */

export const TRACK_KINDS = ["video", "audio"];

const CLIP_FIELDS = new Set(["id", "src", "in", "out", "speed", "crop", "gain", "name", "kind"]);

let seq = 0;
function uid(p = "c") {
  seq += 1;
  return `${p}_${Date.now().toString(36)}_${seq}`;
}

export function createTimeline(fps = 24) {
  return {
    id: uid("tl"),
    fps,
    tracks: [
      { id: uid("t"), kind: "video", name: "视频 1", clips: [] },
      { id: uid("t"), kind: "audio", name: "音频 1", clips: [] },
    ],
    version: 1,
  };
}

export function addTrack(tl, kind = "video", name) {
  if (!TRACK_KINDS.includes(kind)) throw new Error(`未知轨道类型：${kind}（只支持 ${TRACK_KINDS.join("/")}）`);
  const n = tl.tracks.filter((t) => t.kind === kind).length + 1;
  const track = { id: uid("t"), kind, name: name ?? `${kind === "video" ? "视频" : "音频"} ${n}`, clips: [] };
  tl.tracks.push(track);
  tl.version += 1;
  return track;
}

export function removeTrack(tl, trackId) {
  const before = tl.tracks.length;
  tl.tracks = tl.tracks.filter((t) => t.id !== trackId);
  if (tl.tracks.length !== before) {
    tl.version += 1;
    return true;
  }
  return false;
}

/**
 * 往轨道末尾加片段。
 * @param {object} tl
 * @param {string} trackId
 * @param {object} spec
 * { src, in, out, speed?, crop?, gain?, name?,
 * shot?,          // ★ 分镜生成信息（见 shot.mjs）—— 重跑这一段靠它
 * rendered?,      // ★ 当前成片 { path, url, filename, durationSec }
 * status?,        // ★ 生成状态
 * trim? }         // ★ 单段裁剪 { startSec, endSec }
 */
export function addClip(tl, trackId, spec) {
  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`轨道不存在：${trackId}`);

  const inSec = Number(spec.in ?? 0);
  const outSec = Number(spec.out);
  if (!Number.isFinite(outSec) || outSec <= inSec) {
    throw new Error(`片段的 out(${spec.out}) 必须大于 in(${spec.in})`);
  }

  const clip = {
    id: uid("c"),
    kind: track.kind,
    src: String(spec.src),
    in: inSec,
    out: outSec,
    speed: Number(spec.speed ?? 1),
    crop: spec.crop ?? null,
    gain: spec.gain ?? 1,
    name: spec.name ?? String(spec.src).split(/[/\\]/).pop(),
    // ★ 分镜层（M7-a）：没有 shot 的片段是「导入的外部素材」，不可重跑
    shot: spec.shot ?? null,
    rendered: spec.rendered ?? null,
    status: spec.status ?? (spec.rendered ? "done" : "idle"),
    jobId: null,
    trim: spec.trim ?? null,
  };

  if (!(clip.speed > 0)) throw new Error(`speed 必须 > 0，收到 ${spec.speed}`);

  track.clips.push(clip);
  tl.version += 1;
  return clip;
}

export function removeClip(tl, trackId, clipId) {
  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) return false;
  const before = track.clips.length;
  track.clips = track.clips.filter((c) => c.id !== clipId);
  if (track.clips.length !== before) {
    tl.version += 1;
    return true;
  }
  return false;
}

/**
 * ★ 波纹删除 —— 删掉片段后，后面的自动前移，不留空档。
 * 实现上它和普通删除【完全一样】：因为片段时间轴位置是
 * 「前面片段时长累加」算出来的，不单独存，所以删掉后自然前移。
 * 这是刻意的设计：如果时间轴位置单独存，波纹删除就要重算所有
 * 后续片段的 start，容易漏、容易错。用「累加」表示后，
 * 波纹删除退化成一次数组过滤。
 */
export function removeClipRipple(tl, trackId, clipId) {
  return removeClip(tl, trackId, clipId);
}

export function moveClip(tl, trackId, clipId, toIndex) {
  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) return false;
  const from = track.clips.findIndex((c) => c.id === clipId);
  if (from < 0) return false;
  const [clip] = track.clips.splice(from, 1);
  const idx = Math.max(0, Math.min(toIndex, track.clips.length));
  track.clips.splice(idx, 0, clip);
  tl.version += 1;
  return true;
}

export function updateClip(tl, trackId, clipId, patch) {
  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return null;

  for (const [k, v] of Object.entries(patch)) {
    if (!CLIP_FIELDS.has(k)) throw new Error(`不支持的片段字段：${k}`);
    if (k === "id" || k === "kind") continue; // 不可改
    clip[k] = v;
  }
  if (!(clip.speed > 0)) throw new Error(`speed 必须 > 0`);
  if (clip.out <= clip.in) throw new Error(`out(${clip.out}) 必须大于 in(${clip.in})`);
  if (clip.crop) {
    const { x, y, w, h } = clip.crop;
    if (![x, y, w, h].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) {
      throw new Error(`crop 四个值必须在 0~1 之间，收到 ${JSON.stringify(clip.crop)}`);
    }
    if (x + w > 1.0001 || y + h > 1.0001) {
      throw new Error(`crop 超出画面：x+w=${(x + w).toFixed(3)}, y+h=${(y + h).toFixed(3)}`);
    }
    if (w <= 0 || h <= 0) throw new Error(`crop 宽高必须 > 0`);
  }
  tl.version += 1;
  return clip;
}

export function clipDuration(clip) {
  const raw = clip.out - clip.in;
  return raw / (clip.speed > 0 ? clip.speed : 1);
}

/**
 * 算出每个片段的 [start, end]（时间轴时间）。
 * ★ 这是「不存 start」这个设计的兑现处：永远现算，永远一致。
 */
export function layoutTrack(track) {
  let t = 0;
  return track.clips.map((c) => {
    const dur = clipDuration(c);
    const seg = { clip: c, start: t, end: t + dur, duration: dur };
    t += dur;
    return seg;
  });
}

export function timelineDuration(tl) {
  let max = 0;
  for (const tr of tl.tracks) {
    const arr = layoutTrack(tr);
    const d = arr.length ? arr[arr.length - 1].end : 0;
    if (d > max) max = d;
  }
  return max;
}

/**
 * 时间轴位置 → 哪个片段、片段内偏移。
 * 给预览层用（拖动播放头时查该显示谁）。
 * @returns {{track, clip, offsetInClip, index} | null}
 */
export function clipAt(tl, trackId, timeSec) {
  const track = tl.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const segs = layoutTrack(track);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (timeSec >= s.start && timeSec < s.end) {
      return { track, clip: s.clip, offsetInClip: timeSec - s.start, index: i, seg: s };
    }
  }
  return null;
}

export function sourceTimeAt(tl, trackId, timeSec) {
  const hit = clipAt(tl, trackId, timeSec);
  if (!hit) return null;
  const { clip, offsetInClip } = hit;
  return clip.in + offsetInClip * (clip.speed > 0 ? clip.speed : 1);
}

export function validate(tl) {
  const problems = [];
  if (!Array.isArray(tl.tracks)) return { ok: false, problems: ["tracks 不是数组"] };
  if (!tl.tracks.some((t) => t.kind === "video")) problems.push("没有视频轨");

  const ids = new Set();
  for (const tr of tl.tracks) {
    if (!TRACK_KINDS.includes(tr.kind)) problems.push(`轨道 ${tr.id} 类型非法：${tr.kind}`);
    for (const c of tr.clips) {
      if (ids.has(c.id)) problems.push(`片段 id 重复：${c.id}`);
      ids.add(c.id);
      if (!c.src) problems.push(`片段 ${c.id} 没有 src`);
      if (!(c.out > c.in)) problems.push(`片段 ${c.id} out(${c.out}) <= in(${c.in})`);
      if (!(c.speed > 0)) problems.push(`片段 ${c.id} speed(${c.speed}) 非法`);
      if (c.crop) {
        const { x, y, w, h } = c.crop;
        if (x + w > 1.0001 || y + h > 1.0001) problems.push(`片段 ${c.id} crop 超出画面`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

export function serialize(tl) {
  return JSON.stringify(tl);
}

export function deserialize(json) {
  const t = typeof json === "string" ? JSON.parse(json) : json;
  if (!t || typeof t !== "object") throw new Error("时间轴数据不是对象");
  if (!Array.isArray(t.tracks)) throw new Error("时间轴缺 tracks");
  t.fps ??= 24;
  t.version ??= 1;
  // 清理坏片段（宁可丢一个片段，不要让整个编辑器崩）
  for (const tr of t.tracks) {
    if (!Array.isArray(tr.clips)) tr.clips = [];
    tr.clips = tr.clips.filter((c) => c && c.src && c.out > c.in && c.speed > 0);
  }
  return t;
}

export function stats(tl) {
  const videoClips = tl.tracks.filter((t) => t.kind === "video").reduce((s, t) => s + t.clips.length, 0);
  const audioClips = tl.tracks.filter((t) => t.kind === "audio").reduce((s, t) => s + t.clips.length, 0);
  return {
    tracks: tl.tracks.length,
    videoTracks: tl.tracks.filter((t) => t.kind === "video").length,
    audioTracks: tl.tracks.filter((t) => t.kind === "audio").length,
    videoClips,
    audioClips,
    durationSec: timelineDuration(tl),
  };
}
