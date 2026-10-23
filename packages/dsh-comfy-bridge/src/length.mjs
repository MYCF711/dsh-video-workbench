/**
 * H3 帧数网格吸附 —— H3 的 length 必须落在 17k+5 网格上，没有 24 这一档。
 *
 * 来源（本机实测，非推断）：
 *   <WORKSPACE>\ComfyUI知识库\视频生成参数表.md §三①
 *   MiniMaxH3ImageToVideo 的 length tooltip 逐字：
 *     "Frame count at 24 fps, snapped up to the model's 17k+5 grid
 *      (124 = ~5s; trained range is ~124-362, longer is untested)"
 *
 * 规则（主人 2026-10-13 判据：「只要能保证对齐，后期方便补帧就行」）：
 *   ① 向上吸到最近网格点
 *   ② 若为奇数，退到相邻偶数点（RIFE/FILM 常规 2x/4x，奇数会出半帧）
 *   ③ 超上限 362 则夹到 362
 */

export const FPS = 24;
const STEP = 17;
const OFFSET = 5;
const MAX_K = 21; // 对应 362 帧 / 15.08s

/** 全部合法帧数（k = 0..21）。实测列表，非计算推导。 */
export const LEGAL_LENGTHS = Array.from({ length: MAX_K + 1 }, (_, k) => STEP * k + OFFSET);

/**
 * 把任意帧数吸附到合法网格点。
 *
 * ⚠ 两条边界是自测（src/test-length.mjs）抓出来的，不是先验推导：
 *   ① 请求值 ≤ 最小网格点(5) 时直接给 5 —— 否则它会向上吸到 22 再因奇数退到 5，
 *      绕一圈还可能落错（原实现这里返回 22，实测 FAIL）
 *   ② k=0 时【不应用】奇数规则 —— 5 已是最小，没有更小的偶数点可退，
 *      硬退只能前进到 22，等于把「0.21 秒」变成「0.92 秒」
 */
export function snapLength(n) {
  const req = Math.max(0, Math.round(Number(n) || 0));
  if (req <= OFFSET) return OFFSET;

  // ① 向上吸到最近网格
  let k = Math.ceil((req - OFFSET) / STEP);
  k = Math.min(Math.max(k, 0), MAX_K);
  let frames = STEP * k + OFFSET;

  // ② 奇数则退到相邻偶数点（仅当退得动，见边界②）
  if (frames % 2 !== 0 && k > 0) {
    frames = STEP * (k - 1) + OFFSET;
  }
  return frames;
}

/** 秒 → 帧（先换算再吸附）。 */
export function secondsToLength(sec) {
  return snapLength((Number(sec) || 0) * FPS);
}

/** 帧 → 秒，保留 2 位。 */
export function lengthToSeconds(frames) {
  return Math.round((frames / FPS) * 100) / 100;
}

/**
 * 画幅字符串 → 像素宽高。
 * 目标像素量来自原站前端的 megapixels 默认值 0.4（逐字提取），
 * 并对齐到 32 的倍数（H3 要求）。
 *
 * ⚠ 原站前端给的值带后缀：`"16:9 (Widescreen)"` / `"9:16 (Portrait Widescreen)"`。
 *    用户从原站抄参数时会连后缀一起抄，所以这里**只取开头的比值**，忽略后缀。
 */
export function aspectToSize(aspect, megapixels = 0.4) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)/.exec(String(aspect ?? ""));
  if (!m) return null;
  const rw = Number(m[1]);
  const rh = Number(m[2]);
  if (!(rw > 0 && rh > 0)) return null;
  const ratio = rw / rh;
  const total = megapixels * 1e6;
  const w = Math.sqrt(total * ratio);
  const h = w / ratio;
  // H3 对齐到 32 的倍数
  const align = (v) => Math.max(32, Math.round(v / 32) * 32);
  return { width: align(w), height: align(h) };
}
