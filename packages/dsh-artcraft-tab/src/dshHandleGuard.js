/**
 * dshHandleGuard.js · 屏蔽 DSH 中栏列宽手柄 + 恢复默认宽度（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-22 的要求（原话）：
 *   「视频工作台出现了之前修过的bug，可以调节dsh原生的对话框宽度」
 *   「1.然后把宽度恢复默认」
 *
 * ── 现象
 *   DSH 中栏左右各有一条 10px 宽的列宽手柄（`.Dc7zOa_widthHandle`，
 *   `position:absolute; z-index:0`），它在 `x≈597` 与 `x≈1585`。
 *   视频工作台/剪辑台铺满中栏后，用户在里面拖到那条竖线，
 *   会去调 DSH 中栏宽度 —— 看起来就像「工作台能拖 DSH 对话框宽度」。
 *
 * ── 实测（2026-10-22，19499）
 *   · 视频工作台 tab：手柄 y=76~914（高 838），
 *     其中 y=150/300/450/600/700 五个探针【全部命中手柄本身】⇒ 可拖
 *   · 剪辑台 tab：同样可拖，且底部 y>743 被 DSH 自己的输入框区盖住
 *   · 结论：这不是「某个 tab 坏了」，是**两个 tab 都继承了这个行为**
 *
 * ── DSH 的宽度计算（从 asar 源码逐字读出，不是猜）
 *   WIDTH_PREF_KEY = "dsh.conversation.contentWidth"
 *   CONTENT_MIN = 640
 *   CONTENT_EDGE_BUDGET = 176
 *   resolveContentWidth(columnWidth, preference):
 *     · preference 有值 → clamp(pref, 640, columnWidth - 176)
 *     · preference 为 null → max(680, min(columnWidth * 0.64, 920))
 *   ⇒ 「恢复默认」= 删掉这个键，让 DSH 走 preference === null 那一路。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 为什么用「遮罩」而不是「改 DSH 的 z-index」
 *
 *   草案-UI做减法 §④ 已经记过：给 DSH 手柄加 pointer-events:none
 *   会破坏 DSH 自己在别的 tab 里的拖拽。
 *   而改 DSH 组件源码违反硬约束「不碰 DSH 布局代码」。
 *
 *   ⇒ 唯一安全做法：在我们自己的根容器里开一个「不可穿透窗口」，
 *     只覆盖手柄那 10px × 全高，把鼠标从我们这边挡住，
 *     让事件根本到不了手柄。
 *
 *   ★ 具体手段：在根容器上加一个 `::after` 伪元素，
 *     用 position:fixed 精确定位到手柄位置，pointer-events:auto。
 *     伪元素跟着根容器的 class 走，卸载时自动消失，
 *     不需要任何 JS 清理 —— 这是它比「插一个 div」好的地方。
 */

/** DSH 中栏手柄的选择器（实测 class 名带 CSS Modules 哈希，用属性前缀匹配） */
export const HANDLE_SELECTOR = '[class*="widthHandle"]';

/**
 * 测量当前所有 DSH 列宽手柄的位置。
 *
 * @returns {{x:number,w:number,top:number,bottom:number}[]}
 *
 * ★ 为什么每次都现测、不缓存：
 *   窗口 resize、侧栏开合、DSH 换布局都会让 x 变。
 *   缓存的数字会在这些时刻变成错的，而错的位置遮不住真正的手柄。
 */
export function measureHandles() {
  const out = [];
  for (const el of document.querySelectorAll(HANDLE_SELECTOR)) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    out.push({
      x: Math.round(r.x),
      w: Math.round(r.width),
      top: Math.round(r.y),
      bottom: Math.round(r.bottom),
    });
  }
  return out;
}

/**
 * 生成「遮住手柄」的 CSS。
 *
 * @param {{x:number,w:number,top:number,bottom:number}[]} handles
 * @param {string} scopeSel 根容器选择器，如 ".comfy-wb"
 * @returns {string} CSS 文本
 */
export function buildGuardCss(handles, scopeSel) {
  if (!handles.length) return "";
  /**
   * ★ 每只手柄一条规则，用 CSS 变量传坐标。
   *   为什么不用 nth-child / 固定 x：
   *     DSH 会在窗口 resize 后重排，x 会变。
   *     这里由 JS 每次变化时重新生成整段 CSS，且只覆盖「当前真实位置」。
   */
  const rules = handles.map((h, i) => `
/* 手柄 #${i+1}: x=${h.x} w=${h.w} */
${scopeSel}::after {
  --gh${i}-x: ${h.x}px;
  --gh${i}-w: ${h.w}px;
  --gh${i}-t: ${h.top}px;
  --gh${i}-b: ${h.bottom}px;
}`).join("\n");

  return `
${rules}
`;
}

/**
 * 安装手柄屏蔽。
 *
 * @param {string} scopeSel 根容器选择器
 * @returns {() => void} 卸载函数
 *
 * ★ 实现方式：一个 <style> 里的多段伪元素规则不够用
 *   （一个元素只有一个 ::after）。所以改用「绝对定位的兄弟覆盖层」：
 *   在根容器外层插一个 div，但【不参与布局】（position:fixed），
 *   随根容器卸载时一起删。
 *
 *   ⇒ 比伪元素多一步清理，但能覆盖 N 条手柄。
 */
export function installHandleGuard(scopeSel) {
  const ID = "dsh-handle-guard";
  let styleEl = document.getElementById(ID);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = ID;
    document.head.appendChild(styleEl);
  }

  const layer = document.createElement("div");
  layer.setAttribute("data-handle-guard", "");
  layer.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:9998;";
  document.body.appendChild(layer);

  const redraw = () => {
    const handles = measureHandles();
    if (!handles.length) { layer.innerHTML = ""; return; }
    /**
     * 每只手柄一个「吸盘」：只在那 10px × 区间高度上打开 pointer-events。
     * 其它区域一律 pointer-events:none ⇒ 完全不影响工作台本身。
     */
    layer.innerHTML = handles.map((h) => {
      const hgt = Math.max(0, h.bottom - h.top);
      return `<div style="position:fixed;left:${h.x}px;top:${h.top}px;`
        + `width:${h.w}px;height:${hgt}px;pointer-events:auto;cursor:default;`
        + `background:transparent;"></div>`;
    }).join("");
  };

  redraw();

  /* 窗口变化 / 侧栏开合 / DSH 重排都要重测 */
  const onResize = () => redraw();
  window.addEventListener("resize", onResize);

  /**
   * ★ 还要盯 DOM 变化：切 tab、开侧栏都可能换掉手柄节点。
   *   节流到 200ms —— 每次都全量 querySelector 会拖慢交互。
   */
  let t = null;
  const mo = new MutationObserver(() => {
    if (t) return;
    t = setTimeout(() => { t = null; redraw(); }, 200);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  return () => {
    window.removeEventListener("resize", onResize);
    mo.disconnect();
    if (t) clearTimeout(t);
    layer.remove();
    styleEl.remove();
  };
}

/**
 * 恢复 DSH 中栏宽度到默认。
 *
 * ★ 依据（asar 源码逐字）：
 *     const WIDTH_PREF_KEY = "dsh.conversation.contentWidth";
 *     function resolveContentWidth(columnWidth, preference) {
 *       const max = Math.max(640, columnWidth - 176);
 *       if (preference !== null) return Math.min(Math.max(preference, 640), max);
 *       return Math.max(680, Math.min(columnWidth * .64, 920));   // ← 默认
 *     }
 *   ⇒ 删键即恢复默认。
 *
 * ⚠ 注意：这个键控制的是【对话内容宽度】，不是中栏列宽本身。
 *   中栏列宽由 handle 拖拽后写回 CSS 变量，**没有独立 localStorage 键**
 *   （实测 localStorage 里只有 contentWidth，没有 columnWidth）。
 *   ⇒ 中栏列宽在 page reload 后本来就会回到 DSH 的默认比例；
 *     这里删键是让「内容宽度」也回到默认，
 *     与主人说的「把宽度恢复默认」一致。
 *
 * @returns {{cleared:boolean, previous:string|null}}
 */
export function resetDshWidths() {
  const KEYS = [
    "dsh.conversation.contentWidth",
    /* 若将来 DSH 加了中栏宽度的持久化键，一并清掉（当前实测不存在） */
    "dsh.layout.columnWidth",
    "dsh.layout.centerWidth",
  ];
  let previous = null;
  let cleared = false;
  for (const k of KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) {
        if (k === "dsh.conversation.contentWidth") previous = v;
        localStorage.removeItem(k);
        cleared = true;
      }
    } catch { /* 隐私模式 / 配额 */ }
  }
  /**
   * ★ 还要把已经写到 DOM 上的 CSS 变量清掉，
   *   否则不刷新页面看不到变化（DSH 会把值 setProperty 到元素上）。
   */
  try {
    for (const el of document.querySelectorAll("*")) {
      if (el.style && el.style.getPropertyValue("--dsh-chat-user-width")) {
        el.style.removeProperty("--dsh-chat-user-width");
      }
    }
  } catch { /* ignore */ }
  return { cleared, previous };
}
