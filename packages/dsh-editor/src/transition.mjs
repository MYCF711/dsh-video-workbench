/**
 * 段间转场 —— F8（外部源调研 P0）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 解决什么问题
 *   render.mjs 现在是【硬切 concat】—— 两段之间没有任何过渡，
 *   观众看到的是「画面突然跳」。本机 ffmpeg 支持 58 种 xfade 转场，
 *   却一个没用。这是投入产出比最高的一条：改一个文件。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ★ 本机实测（2026-10-18）：
 *   `ffmpeg -h filter=xfade` 列出 58 种转场，实测 fade/dissolve/
 *   slideleft/circleopen 都能出图。
 *
 * ★ xfade 的硬约束（比 concat 多三条）：
 *   ① 所有输入必须【同尺寸、同帧率、同像素格式】—— concat 也需要，
 *      所以 render.mjs 已有的「统一尺寸/帧率」那一步可以直接复用。
 *   ② offset 是【相对第一个输入流起点】的时间，不是相对前一段末尾。
 *      链式时每加一段，offset 要累加：（前面积累时长 − 已消耗的转场时长）
 *   ③ duration 不能超过相邻两段中较短那段的时长，否则直接报错。
 *      ⇒ 必须夹取。
 *
 * ★ 为什么 xfade 会【缩短总时长】：
 *   两段各 5s、转场 0.5s，拼完是 9.5s 而不是 10s —— 转场期间两段重叠。
 *   这一点必须让调用方知道，否则时间轴上的对齐会全错。
 *   所以本模块同时返回 expectedDuration，与硬切时长并列。
 */

/** 常用转场的中文名（给 UI 用）。 */
export const TRANSITIONS = {
  fade: "淡入淡出",
  fadeblack: "过黑",
  fadewhite: "过白",
  dissolve: "溶解",
  wipeleft: "左擦除",
  wiperight: "右擦除",
  wipeup: "上擦除",
  wipedown: "下擦除",
  slideleft: "左滑入",
  slideright: "右滑入",
  slideup: "上滑入",
  slidedown: "下滑入",
  smoothleft: "平滑左",
  smoothright: "平滑右",
  circleopen: "圆形展开",
  circleclose: "圆形收拢",
  circlecrop: "圆形裁切",
  radial: "放射",
  hblur: "横向模糊",
  vblur: "纵向模糊",
  pixelize: "像素化",
  distance: "距离",
  horzopen: "水平展开",
  vertopen: "垂直展开",
  squeezeh: "水平挤压",
  squeezev: "垂直挤压",
};

/** 默认转场时长（秒）。0.4 是实测观感与时长损失都合适的值。 */
export const DEFAULT_TRANSITION_SEC = 0.4;
export const DEFAULT_TRANSITION = "fade";

/**
 * 校验并夹取转场参数。
 *
 * @param {number[]} durations  每段时长（秒）
 * @param {object} opts
 * @returns {{ok:boolean, type:string, sec:number, error?:string}}
 */
export function validateTransition(durations, opts = {}) {
  const type = String(opts.type ?? DEFAULT_TRANSITION);
  let sec = Number(opts.sec ?? DEFAULT_TRANSITION_SEC);

  if (!TRANSITIONS[type]) {
    return { ok: false, type, sec, error: `不支持的转场：${type}` };
  }
  if (!Array.isArray(durations) || durations.length < 2) {
    return { ok: false, type, sec, error: "少于两段，没有接缝可加转场" };
  }
  if (!Number.isFinite(sec) || sec <= 0) {
    return { ok: false, type, sec, error: `转场时长无效：${opts.sec}` };
  }

  // ★ 约束③：不能超过相邻两段中较短那段的一半。
  //   取一半而不是全长 —— 转场吃掉整段会让那段完全消失。
  const shortest = Math.min(...durations.filter((d) => d > 0));
  const maxSec = Math.max(0.05, shortest / 2);
  if (sec > maxSec) sec = Math.round(maxSec * 100) / 100;

  return { ok: true, type, sec };
}

/**
 * 给一组已拼接好的视频段生成 xfade 链。
 *
 * @param {object} p
 * @param {string[]} p.labels    各段的滤镜输出标签（如 ["v0","v1","v2"]）
 * @param {number[]} p.durations 各段时长（秒），顺序必须与 labels 一致
 * @param {string}   [p.type]    转场类型
 * @param {number}   [p.sec]     每处转场时长
 * @param {string}   [p.out]     最终输出标签
 * @returns {{parts:string[], out:string, expectedDuration:number, hardCutDuration:number,
 *            applied:number, type:string, sec:number, note:string, error?:string}}
 */
export function buildXfadeChain(p) {
  const { labels, durations, out = "vout" } = p ?? {};
  const hardCutDuration = (durations ?? []).reduce((a, b) => a + b, 0);

  const v = validateTransition(durations, { type: p?.type, sec: p?.sec });
  if (!v.ok) {
    // 退化成硬切 —— 宁可没转场，也不能整个导出失败
    return {
      parts: [],
      out,
      expectedDuration: hardCutDuration,
      hardCutDuration,
      applied: 0,
      type: v.type,
      sec: v.sec,
      note: `转场未启用（${v.error}），退回硬切`,
      error: v.error,
    };
  }

  const { type, sec } = v;

  if (labels.length === 2) {
    const dur0 = durations[0];
    const offset = Math.max(0, dur0 - sec);
    return {
      parts: [`[${labels[0]}][${labels[1]}]xfade=transition=${type}:duration=${sec}:offset=${num(offset)}[${out}]`],
      out,
      expectedDuration: hardCutDuration - sec,
      hardCutDuration,
      applied: 1,
      type,
      sec,
      note: `1 处 ${TRANSITIONS[type]}（${sec}s），总时长减少 ${sec}s`,
    };
  }

  // 多段：链式。每加一段，offset = 已积累时长 − 已消耗转场 − 本次转场
  const parts = [];
  let acc = durations[0];              // 当前已拼出的时长
  let prevLabel = labels[0];
  let consumed = 0;                    // 已被转场吃掉的总时长

  for (let i = 1; i < labels.length; i++) {
    const isLast = i === labels.length - 1;
    const label = isLast ? out : `vx${i}`;
    // 第 i 段的起点 = acc - sec（重叠 sec 秒）
    const offset = Math.max(0, acc - sec);
    parts.push(
      `[${prevLabel}][${labels[i]}]xfade=transition=${type}:duration=${sec}:offset=${num(offset)}[${label}]`
    );
    acc = acc + durations[i] - sec;
    consumed += sec;
    prevLabel = label;
  }

  return {
    parts,
    out,
    expectedDuration: Math.max(0, hardCutDuration - consumed),
    hardCutDuration,
    applied: labels.length - 1,
    type,
    sec,
    note: `${labels.length - 1} 处 ${TRANSITIONS[type]}（${sec}s），总时长减少 ${num(consumed)}s`,
  };
}

/**
 * 音频侧的配套处理。
 *
 * ★ 不能只给视频加转场：视频被缩短了（每处 sec 秒），音频还是原长
 *   ⇒ 音画不同步，越往后越飘。
 *
 * ★ 也不给音频加 acrossfade：人物说话时做交叉淡化会让台词叠在一起，
 *   反而更难听。正确做法是【同步缩短音频】—— 每段裁掉 sec 秒，
 *   让音轨与视频的时长一致。
 *
 * @param {string[]} labels     各段音频标签
 * @param {number[]} durations  各段音频时长
 * @param {number}   sec        每处转场吃掉的时间
 * @param {string}   [out]
 * @returns {{parts:string[], out:string, expectedDuration:number}}
 */
export function buildAudioTrimForXfade(p) {
  const { labels, durations, sec, out = "aout" } = p ?? {};
  const parts = [];
  const trimmedLabels = [];

  for (let i = 0; i < labels.length; i++) {
    // 最后一段不裁（它后面没有转场）；其他段裁掉 sec 秒
    const isLast = i === labels.length - 1;
    const len = durations[i];
    const keepEnd = isLast ? len : Math.max(0.05, len - sec);
    if (Math.abs(keepEnd - len) < 1e-6) {
      trimmedLabels.push(labels[i]);
      continue;
    }
    const lb = `at${i}`;
    parts.push(`[${labels[i]}]atrim=start=0:end=${num(keepEnd)},asetpts=PTS-STARTPTS[${lb}]`);
    trimmedLabels.push(lb);
  }

  const concatIn = trimmedLabels.map((l) => `[${l}]`).join("");
  parts.push(`${concatIn}concat=n=${trimmedLabels.length}:v=0:a=1[${out}]`);

  return {
    parts,
    out,
    expectedDuration: durations.reduce((a, b, i) => a + (i === labels.length - 1 ? b : Math.max(0.05, b - sec)), 0),
  };
}

function num(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return String(Math.round(v * 1000) / 1000);
}
