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

/**
 * 滚动条命中带的【额外容错】（px）。
 *
 * ★ 为什么不再用固定的 EDGE = 8：
 *   实测这个容器的滚动条物理占位是 10px（rect.width - clientWidth），
 *   而 CSS 里 ::-webkit-scrollbar { width: 8px } 只是滑块【绘制】宽度，
 *   浏览器实际占位还含两侧边距 ⇒ 写死 8 会有 2px 死角，
 *   用户的鼠标差一点就「脱离」，表现为「偶尔失效」。
 *
 * ⇒ 现在：真实占位现场量（barW / barH），再向外加这个容错。
 *   6px 的依据：主人要求「范围可以稍微比滑动条的视觉宽一些，保留容错」。
 *   6px ≈ 三分之二个滚动条宽度 —— 既容得下鼠标抖动，
 *   又不会把内容区边缘误判成滚动条（内容区边缘点击是最常见的操作）。
 */
const TOLERANCE = 6;

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
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-22 主人实测（第二次改）：
 *   「目前在缩放纵向的滑动条时偶尔脱离滑动条就会失效」
 *   「不管在哪都会缩放横向的滑动条」
 *
 * ── 问题 1：容错太窄
 *   实测这个容器的滚动条物理占位是 **10px**（rect.width - clientWidth），
 *   而我原来写死 EDGE = 8 ⇒ 鼠标在 8~10px 那条边上判定失败。
 *   注意 CSS 里 ::-webkit-scrollbar { width: 8px } 说的是【滑块绘制宽度】，
 *   浏览器实际占位仍是 10px（含两侧各 1px 边距）。
 *   ⇒ 不能写死，必须现场量 rect - client，再向外加容错。
 *
 * ── 问题 2：不管在哪都缩放横向
 *   原来只有「距底 <= N」「距右 <= N」两个独立条件。
 *   而这个容器高度只有 137px —— 「距底 8px」那条带在垂直方向占了 6%，
 *   用户以为在纵向条上滚，其实已经落进底部那条带 ⇒ 走横向。
 *   ⇒ 判据必须【两条轴都限定】：
 *       · 横向条 = 贴底【且】不在右下角交汇格
 *       · 纵向条 = 贴右【且】不在右下角交汇格
 *       · 右下角交汇格 **不缩放** —— 那里语义不明确，宁可不动也别猜错方向
 *
 * ── 判据（可复跑）
 *   纵向条上滚 → 只变 trackScale；横向条上滚 → 只变 zoom；
 *   内容区 / 右下角滚 → 都不变。
 *
 * @param {HTMLElement} el 可滚动容器（不可为 null，调用方必须先判）
 * @param {WheelEvent} e
 * @returns {"x"|"y"|null}
 */
export function edgeOf(el, e) {
  if (!el || !e) return null;
  const r = el.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return null;

  /* 现场量真实占位（不写死） */
  const barW = Math.max(6, Math.round(r.width - el.clientWidth));   // 纵向条占宽
  const barH = Math.max(6, Math.round(r.height - el.clientHeight)); // 横向条占高

  const dxRight = r.right - e.clientX;   // 距右边缘
  const dyBottom = r.bottom - e.clientY; // 距下边缘

  /* 容错：向外多给 tol，向内不减（免得误判进内容区） */
  const nearRight = dxRight >= 0 && dxRight <= barW + TOLERANCE;
  const nearBottom = dyBottom >= 0 && dyBottom <= barH + TOLERANCE;

  const canX = el.scrollWidth > el.clientWidth + 1;
  const canY = el.scrollHeight > el.clientHeight + 1;

  /*
   * ★ 右下角交汇格：两条都「附近」时语义不明确
   *   ⇒ 不缩放，交回浏览器。
   *   比「一律优先横向」诚实：用户不会因为差几像素就缩放错方向。
   */
  if (nearRight && nearBottom) return null;

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

      /**
       * ★★ 2026-10-22 第三次修（关键）：必须用 stopImmediatePropagation
       *
       *   实测发现根因：ArtCraft 自己在 timelineRef 上挂了
       *     container.addEventListener("wheel", onWheel, { passive:false, capture:true })
       *   （video-editor/src/lib/timeline/components/index.tsx:349）
       *   它的 onWheel 会：
       *     · ctrl/meta → 横向缩放
       *     · 否则 → 无条件 preventDefault() 然后滚动
       *   ⇒ 只要它在，我们无论在哪儿滚都会被它接管，
       *     表现为主人说的「不管在哪都会缩放横向的滑动条」。
       *
       *   而我原来挂在【滚动容器】上（是 timelineRef 的后代），
       *   capture 阶段祖先先于后代执行 ⇒ ArtCraft 那个先跑，我们接不到。
       *
       *   ⇒ 两处一起改（见 attach）：
       *     ① 监听挂到 document 上（最顶层祖先），capture 阶段最先执行
       *     ② 命中滚动条时用 stopImmediatePropagation，
       *        把同一节点上后续的监听也一并掐断（stopPropagation 只管跨节点）
       */
      e.preventDefault();
      e.stopImmediatePropagation();
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
    /* ★ 只更新目标元素；监听挂在 document 上，不随容器变化重挂 */
    el = next;
    return true;
  };

  /**
   * ★ 监听挂在 document（最顶层），不在滚动容器上。
   *   理由见 onWheel 里那段注释：ArtCraft 在 timelineRef 上也挂了 capture 监听，
   *   挂在后代会被祖先抢先。
   *
   *   passive: false 是必须的 —— 否则 preventDefault 无效。
   */
  try {
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
  } catch { /* ignore */ }

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
    /* ★ 监听挂在 document 上，就在 document 上摘 */
    try { document.removeEventListener("wheel", onWheel, { capture: true }); } catch { /* ignore */ }
    el = null;
  };
}
