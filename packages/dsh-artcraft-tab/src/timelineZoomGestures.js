/**
 * timelineZoomGestures.js · 时间轴滚轮缩放（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人要求（原话）：
 *   「你的轨道部分可以支持按住ctrl然后滚动滚轮就能缩放，为什么不把纵向也这么做？
 *     鼠标放在纵向上的滑动条上面就缩放纵向，放在横向滑动条上面就缩放横向。」
 *
 * ── 现状（实测）
 *   · 横向：ArtCraft 的 ZoomController.handleWheel
 *       ctrl/meta + 滚轮 → 缩放
 *       shift 或 |deltaX|>|deltaY| → 交给浏览器横向滚动，不缩放
 *   · 纵向：**完全没有滚轮入口**，只有工具栏那两个「增高/减矮轨道」按钮。
 *
 * ── 本文件加的两条手势
 *   ① 鼠标在【纵向滚动条】（容器右边缘 8px）上滚 → 缩放纵向（轨道行高）
 *   ② 鼠标在【横向滚动条】（容器底边缘 8px）上滚 → 缩放横向（时间轴缩放）
 *
 * ★★ 2026-10-22 第一版导致整个页面白屏，原因记在这里（重要）
 *
 *   我把 installWheelZoom 放在 ArtCraftTab 的 useEffect 里，而那个 effect
 *   在【组件首次渲染后】立刻跑。此时 Rc 树还没提交完成，
 *   我在函数里访问 `el.getBoundingClientRect()`（el 为 null）抛异常，
 *   异常穿透 React 的提交阶段 ⇒ 整个 DSH 白屏（body 只剩一个内联脚本）。
 *
 *   ⇒ 修法两条：
 *     ① 所有 DOM 访问都必须先判空，用可空链 `?.`，绝不裸调
 *     ② 安装时机推迟到「容器真的存在之后」——用轮询 + 上限次数，
 *        而不是假设挂载完就有
 *
 *   ★ 这是 AGENTS §6.26 / §7.6-⑥ 那类「effect 里访问尚未就绪的 DOM」的变形。
 *     判据：effect 里第一行必须是判空或等待，不是直接用。
 */

const EDGE = 8;          // 滚动条宽度（与 CSS 的 8px 一致）
const SCALE_STEP = 1.12; // 每格滚轮的缩放倍率
const LOCKED = Symbol("ac-wheel-zoom");

/** 选择器：ArtCraft 时间轴的可滚动容器 */
export const SCROLL_SELECTOR = "[data-ac-timeline] .scrollbar-thin.overflow-auto";

/**
 * 把滚轮归一成「格数」。
 *
 * ★ 为什么不能直接乘 deltaY：
 *   Windows 标准滚轮每格 deltaY = 120（WHEEL_DELTA），
 *   触控板是 1~30，Firefox 还有 deltaMode（0=像素 1=行 2=页）。
 *   直接乘会把触控板的一次滑动放大成几十倍缩放。
 */
function wheelSteps(e) {
  const raw = e.deltaMode === 1 ? e.deltaY * 16
    : e.deltaMode === 2 ? e.deltaY * 400
      : e.deltaY;
  /* 限幅：单次最多 3 格 */
  return Math.max(-3, Math.min(3, raw / 120));
}

/**
 * 判断鼠标落在哪个滚动条区域。
 *
 * @param {HTMLElement} el 可滚动容器（不可为 null，调用方必须先判）
 * @param {WheelEvent} e
 * @returns {"x"|"y"|null}
 */
export function edgeOf(el, e) {
  if (!el || !e) return null;
  const r = el.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return null;

  const nearBottom = r.bottom - e.clientY <= EDGE;
  const nearRight = r.right - e.clientX <= EDGE;

  const canX = el.scrollWidth > el.clientWidth + 1;
  const canY = el.scrollHeight > el.clientHeight + 1;

  /*
   * ★ 右下角两者都满足时优先横向（底边更常被使用）。
   *   不能两个都触发 —— 那会同时缩放横纵，用户不知道发生了什么。
   */
  if (nearBottom && canX) return "x";
  if (nearRight && canY) return "y";
  return null;
}

/**
 * 安装滚轮缩放。
 *
 * @param {object} o
 * @param {() => HTMLElement|null} o.getScrollEl
 * @param {() => object|null} o.getZoomApi
 * @param {object} [o.log]
 * @returns {() => void} 卸载函数（永远是函数，不会 undefined）
 *
 * ★ 本函数【绝不抛异常】：安装失败最多是手势不生效，
 *   不该让整个面板崩掉。所有内部步骤各自 try/catch。
 */
export function installWheelZoom({ getScrollEl, getZoomApi, log = console } = {}) {
  let el = null;
  let disposed = false;

  const onWheel = (e) => {
    if (disposed) return;
    try {
      const api = typeof getZoomApi === "function" ? getZoomApi() : null;
      if (!api) return;

      const zone = edgeOf(el, e);
      if (zone === null) return;   // 不在滚动条上 ⇒ 不接管

      /* ★ 必须显式阻止，否则浏览器会把这次滚轮当成滚动 */
      e.preventDefault();
      e.stopPropagation();

      const steps = wheelSteps(e);
      if (steps === 0) return;
      const mag = Math.pow(SCALE_STEP, Math.abs(steps));
      const factor = steps > 0 ? 1 / mag : mag;

      if (zone === "x") {
        const next = (Number(api.zoom) || 1) * factor;
        api.setZoom?.(next);
        log.info?.(`[artcraft] 横向缩放 → ${next.toFixed(3)}`);
      } else {
        const next = (Number(api.trackScale) || 1) * factor;
        api.setTrackScale?.(next);
        log.info?.(`[artcraft] 纵向缩放 → ${next.toFixed(3)}`);
      }
    } catch (err) {
      log.warn?.("[artcraft] 滚轮缩放失败：", err?.message ?? err);
    }
  };

  const attach = () => {
    if (disposed) return false;
    let next = null;
    try {
      next = typeof getScrollEl === "function" ? getScrollEl() : null;
    } catch { next = null; }
    if (!next || !(next instanceof HTMLElement)) return false;
    if (next === el) return true;

    if (el) {
      try { el.removeEventListener("wheel", onWheel, { capture: true }); } catch { /* ignore */ }
    }
    el = next;
    /**
     * ★ passive: false 是必须的 —— 否则 preventDefault 无效。
     *   capture: true 让它在 ArtCraft 自己的 React onWheel 之前拿到事件。
     */
    try {
      el.addEventListener("wheel", onWheel, { passive: false, capture: true });
      el[LOCKED] = true;
    } catch { /* ignore */ }
    return true;
  };

  /**
   * ★ 挂载时机：容器可能还没渲染出来。
   *   轮询到它就位为止，最多 10 秒（50 × 200ms）。
   *   不用 MutationObserver 是因为它会在整页 DOM 变动时频繁触发，
   *   而这个容器的出现是可预期的（切到剪辑台时）。
   */
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (attach() || tries > 50) clearInterval(timer);
  }, 200);
  /* 立刻试一次，别等第一个 200ms */
  attach();

  return () => {
    disposed = true;
    clearInterval(timer);
    if (el) {
      try { el.removeEventListener("wheel", onWheel, { capture: true }); } catch { /* ignore */ }
      try { delete el[LOCKED]; } catch { /* ignore */ }
    }
    el = null;
  };
}
