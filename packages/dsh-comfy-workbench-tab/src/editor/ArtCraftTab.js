/**
 * ArtCraftTab.js · 剪辑台主壳（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 布局（docs/布局重设计-剪辑台-20261021.md §二）
 *
 *   ┌──────────────────────────────────────────┐
 *   │  ① 预览区（空态不是黑块）                 │
 *   ├──────────────────────────────────────────┤
 *   │  ② 工具栏（紧贴时间轴上方）               │  ← 主人明确要求
 *   ├──────────────────────────────────────────┤
 *   │  ③ 时间轴（ArtCraft 渲染，占最大面积）      │
 *   └──────────────────────────────────────────┘
 *                                    ↑ 右侧检查器抽屉（覆盖，默认收起）
 *
 *   屏幕只切两刀：一横（工具栏）一竖（抽屉相对位置）
 *   ⇒ 可拖边界从 3 条降到 0 条（我们把 ArtCraft 的 PanelGroup 整个替换掉了）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 和上一版的关键差别：不再挂 <VideoEditor>，而是自己拼
 *
 *   上一版：mount(el) → root.render(<VideoEditor/>)  ← 那是 ArtCraft 的整套外壳
 *   这一版：mount(el) 之后，由本组件决定「哪块显示什么」
 *
 *   但 ArtCraft 的 mount 里 createRoot(<VideoEditor/>) —— 要改它。
 *   见 build.mjs 的说明与 dsh-entry 的新导出 mountPane()。
 *
 * ★★ 为什么照旧用 ArtCraft 的 mount 而不是自己 createRoot
 *   EditorCore 是全局单例，initialize 是 first-wins 幂等。
 *   走它的 mount 能保证 adapters / project / media 注册这条路是通的
 *   （那条路上有 8 个已踩过的坑，见 verify-regression.mjs）。
 *   ⇒ 只把「外壳」换掉，不动那条数据通路。
 */

import React from "react";
import { ui } from "./dsh-primitives.js";
import { EditorToolbar } from "./EditorToolbar.js";
import { Inspector } from "./Inspector.js";
import { PreviewPane, formatTimecode } from "./PreviewPane.js";
import { installShortcutHandler } from "./shortcuts.js";
/**
 * ★ 2026-10-22：时间轴滚动条上的滚轮缩放
 *   （主人：「为什么不把纵向也这么做？鼠标放在纵向滚动条上就缩放纵向，
 *           放在横向滚动条上就缩放横向」）
 */
import { installWheelZoom } from "./timelineZoomGestures.js";
import { getZoomApi } from "./clipboardOps.js";
/**
 * ★ 2026-10-22：屏蔽 DSH 中栏列宽手柄 + 恢复默认宽度
 *   （主人报「可以调节 dsh 原生的对话框宽度」）
 *
 *   实测：剪辑台与视频工作台**两个 tab 都能拖**那条 10px 手柄。
 *   ⇒ 两个包各装一份（两个包不能互相 import）。
 */
import { installHandleGuard, resetDshWidths } from "./dshHandleGuard.js";
/**
 * ★★ 2026-10-22：把设备监控（GPU/CPU/显存/内存 四个圆环）同步到剪辑台
 *
 *   主人报：「视频工作台有的四个圆环监控，gpucpu显存内存，在剪辑台tab会消失，
 *           做一下同步」
 *
 *   实测成因：DeviceMonitor 是 dsh-comfy-workbench-tab 包【内部组件】，
 *   只在 WorkbenchView 里渲染。剪辑台是另一个包（dsh-artcraft-tab），
 *   两个包不能互相 import（会把对方整个打进来）。
 *   ⇒ 复制一份过来。
 *
 *   ★ 为什么是「复制」而不是「抽出公共包」：
 *     抽公共包要新建第三个包并改两处 package.json 依赖，
 *     而这份文件 8KB、只依赖一个 HTTP 路由，复制成本更低。
 *     AGENTS §3.12 记过：两个执行者改同一文件会互相覆盖 —— 复制反而隔离。
 *     ⚠ 代价：将来改圆环样式要改两处。已在此注明。
 *
 *   ★ 它用的 /comfy-bridge/device 由 dsh-comfy-workbench-tab 的 host 侧提供，
 *     两个 tab 共享同一个后端路由，所以剪辑台不需要额外注册路由。
 *     实测（19499）：{"gpu":{"utilPct":0,"vramPct":5,...},"cpu":{"loadPct":8},"mem":{"pct":37}}
 */
import { DeviceMonitor, DeviceMonitorBoundary } from "./DeviceMonitor.mjs";

const h = React.createElement;

/* ══════════════════════════════════════════════════════════════════════
 * 预览 / 时间轴 之间的可拖分隔条
 *
 * ★★ 2026-10-22 新增（主人报「轨道的高度依旧无法拖动，
 *    导致上面的预览高度也跟着锁死了」）
 *
 *   上一版为了让「工具栏紧贴时间轴」，把 ArtCraft 的 ResizablePanelGroup
 *   整个换成三段 flex —— 顺手把它内置的垂直拖拽手柄也删了
 *   （实测 `[role="separator"]` = 0 个）。于是两个高度都写死。
 *
 * ── 实现要点
 *   ① pointer events（不是 mouse）：统一鼠标/触控/触控笔，
 *      且 setPointerCapture 后即使指针移出元素也能继续收到 move。
 *   ② 拖动只改 CSS 变量、不 setState：每次 move 都 setState 会整树重渲染，
 *      拖动时每秒几十次必然掉帧。松手才存一次 localStorage。
 *   ③ 上下都夹紧：预览最小 120、时间轴最小 160。
 *      不夹的话能把某一侧拖成 0，用户就找不回来了。
 *   ④ 键盘可操作（Tab 到 + 方向键），符合 a11y。
 */
export const PREVIEW_H_KEY = "artcraft.previewHeight.v1";
export const PREVIEW_MIN = 120;
export const TIMELINE_MIN = 160;

function VSplit({ rootRef }) {
  const dragRef = React.useRef(null);
  const [dragging, setDragging] = React.useState(false);

  const readH = () => {
    const root = rootRef?.current;
    if (!root) return 220;
    const v = getComputedStyle(root).getPropertyValue("--ac-preview-h").trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 220;
  };

  /**
   * 计算预览高度的上界。
   *
   * ★★ 2026-10-22 修：基准必须是【不受 --ac-preview-h 影响】的容器。
   *
   *   实测：root 高 668 时把 --ac-preview-h 设成 700px，
   *   时间轴被压到 81px（几乎看不见轨道）。
   *   根因：root 自身高度会被 --ac-preview-h 撑大，
   *   拿它当上界 ⇒ 上界跟着涨 ⇒ clamp 形同虚设。
   *
   *   ⇒ 用 .ac-scope（外层，高度由 DSH 的 viewArea 决定、不受我们变量影响）。
   *     它现在有 max-height: calc(100vh - 76px) 兜底，高度是稳定的。
   *     取不到时才退回 700（一个保守的默认）。
   */
  const hostHeight = () => {
    const root = rootRef?.current;
    const scope = root?.closest?.(".ac-scope") || root?.parentElement;
    if (scope) {
      const h = scope.getBoundingClientRect().height;
      if (h > 200) return h;
    }
    return 700;
  };

  const clamp = (h) => {
    /* 时间轴要留住：标尺 + 5 条轨道 ≈ 160；工具栏 45；分隔条 8 */
    const max = Math.max(PREVIEW_MIN, hostHeight() - TIMELINE_MIN - 60);
    return Math.round(Math.min(max, Math.max(PREVIEW_MIN, h)));
  };

  const applyH = (h) => {
    const root = rootRef?.current;
    if (root) root.style.setProperty("--ac-preview-h", h + "px");
    return h;
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: readH() };
    setDragging(true);
    rootRef?.current?.setAttribute("data-resizing", "1");
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    applyH(clamp(d.startH + (e.clientY - d.startY)));
  };

  const endDrag = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    rootRef?.current?.removeAttribute("data-resizing");
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const h = Math.round(readH());
    try { localStorage.setItem(PREVIEW_H_KEY, String(h)); } catch { /* 隐私模式 */ }
  };

  const onKeyDown = (e) => {
    const step = e.shiftKey ? 40 : 10;
    let next = null;
    if (e.key === "ArrowUp") next = readH() - step;
    else if (e.key === "ArrowDown") next = readH() + step;
    else return;
    e.preventDefault();
    const h = applyH(clamp(next));
    try { localStorage.setItem(PREVIEW_H_KEY, String(h)); } catch { /* ignore */ }
  };

  return h("div", {
    className: "ac-vsplit",
    role: "separator",
    "aria-orientation": "horizontal",
    "aria-label": "调整预览区高度（方向键可微调）",
    "aria-valuenow": Math.round(readH()),
    tabIndex: 0,
    "data-dragging": dragging ? "1" : "0",
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onKeyDown,
  });
}

/** 读回上次的预览高度（挂载时用一次）。 */
export function readSavedPreviewHeight() {
  try {
    const v = Number(localStorage.getItem(PREVIEW_H_KEY));
    return Number.isFinite(v) && v >= PREVIEW_MIN ? v : null;
  } catch {
    return null;
  }
}

/**
 * 剪辑台主壳。
 *
 * 这个组件【不负责挂载 ArtCraft】—— 挂载由 client.js 在 effect 里做。
 * 它只负责：布局、工具栏、检查器、预览条、Agent 反馈。
 * 中间的时间轴容器通过 ref 交出去（client.js 把 ArtCraft 挂进去）。
 */
export function ArtCraftTab({
  hostRequire,
  timelineRef,
  editorState,
  callbacks,
  agentMessage,
}) {
  const U = ui(hostRequire);
  const I = U.Icon;

  const rootRef = React.useRef(null);
  const [inspOpen, setInspOpen] = React.useState(false);
  const [inspTab, setInspTab] = React.useState("media");

  /**
   * 挂载时恢复上次的预览高度。
   *
   * ★ 为什么在 effect 里而不是初始 style：
   *   初始 style 要读 localStorage → 首帧会闪一下（先 220 再跳到保存值）。
   *   放 effect 里同样会闪，但至少不会在 SSR / 无 localStorage 环境报错。
   *   实测这一跳只有 1 帧，肉眼不可见。
   */
  React.useEffect(() => {
    const saved = readSavedPreviewHeight();
    if (saved !== null && rootRef.current) {
      rootRef.current.style.setProperty("--ac-preview-h", saved + "px");
    }
  }, []);

  /**
   * 安装滚动条滚轮缩放。
   *
   * 判据（主人 2026-10-22）：
   *   鼠标在【纵向滚动条】上滚 → 缩放纵向（轨道行高）
   *   鼠标在【横向滚动条】上滚 → 缩放横向（时间轴缩放）
   *   在轨道内容区里 ctrl+滚轮 → 仍走 ArtCraft 原有的横向缩放
   *
   * ★★ 这个 effect 的第一版把整个 DSH 白屏了（body 只剩一个内联脚本）。
   *   原因：installWheelZoom 内部没判空就调 el.getBoundingClientRect()，
   *   而 effect 在首次渲染后立刻跑 —— 那时 ArtCraft 的时间轴容器还没挂出来。
   *   异常穿透 React 提交阶段 ⇒ 整页崩。
   *
   *   ⇒ 现在三层保险，任一层失效都不会白屏：
   *     ① installWheelZoom 内部全部 try/catch + 可空链，绝不抛
   *     ② 它自己轮询等容器就位（最多 10 秒），不假设「渲染完就有」
   *     ③ 这里再包一层 try/catch
   *
   *   ★ 判据：往 React 的 effect 里接「手指向 DOM」的模块时，
   *     必须确认那个模块在 DOM 未就绪时【返回而不是抛】。
   */
  React.useEffect(() => {
    let dispose = null;
    try {
      dispose = installWheelZoom({
        getScrollEl: () => document.querySelector(
          "[data-ac-timeline] .scrollbar-thin.overflow-auto"
        ),
        getZoomApi,
        log: console,
      });
    } catch (e) {
      console.warn("[artcraft] 滚轮缩放安装失败（不影响其它功能）：", e?.message ?? e);
    }
    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, []);

  /**
   * ★★ 2026-10-22 补：两条打开检查器的路径
   *
   *   ① 工具栏右侧的「检查器」按钮（本组件内）
   *   ② 会话右上角的「资产库」按钮 —— 那个按钮在
   *      conversation.session.header.utilities 里，是【另一棵子树】，
   *      拿不到本组件的 setState ⇒ 走自定义事件。
   *
   *   实测踩到：最初只写了 ②，但本组件没有监听、工具栏也没有 ①，
   *   结果是检查器【一个入口都没有】，功能写了却打不开。
   *   判据：写一个「能打开的面板」必须同时验「有入口」。
   */
  React.useEffect(() => {
    const onOpen = (e) => {
      setInspOpen(true);
      const tab = e?.detail?.tab;
      if (tab === "media" || tab === "props" || tab === "caps") setInspTab(tab);
    };
    window.addEventListener("ac:open-inspector", onOpen);
    return () => window.removeEventListener("ac:open-inspector", onOpen);
  }, []);

  const st = editorState ?? {};
  const hasContent = (st.elementCount ?? 0) > 0;

  /**
   * 快捷键处理。
   *
   * ★ 只在【剪辑台可见时】生效。
   *   不可见时按 Ctrl+K 不该切片段 —— 用户在别的 tab 里。
   *   判据：交给 installShortcutHandler 的 enabled 回调。
   */
  React.useEffect(() => {
    const dispose = installShortcutHandler({
      split: () => callbacks?.onAction?.("split"),
      delete: () => callbacks?.onAction?.("delete"),
      /**
       * ★ 2026-10-22：duplicate 换成 copy / paste / cut
       *   （主人：「复制粘贴为什么不是大众习惯的 c 和 v？」「d 没必要保留吧？」）
       */
      copy: () => callbacks?.onAction?.("copy"),
      paste: () => callbacks?.onAction?.("paste"),
      cut: () => callbacks?.onAction?.("cut"),
      undo: () => callbacks?.onAction?.("undo"),
      redo: () => callbacks?.onAction?.("redo"),
      zoomIn: () => callbacks?.onAction?.("zoomIn"),
      zoomOut: () => callbacks?.onAction?.("zoomOut"),
      trackTaller: () => callbacks?.onAction?.("trackTaller"),
      trackShorter: () => callbacks?.onAction?.("trackShorter"),
      /**
       * ★★ 2026-10-25 修：这两个功能一直在 SHORTCUT_DEFS 里，
       *   却从来没在处理器里注册过 —— 按了毫无反应，而且没有任何提示。
       *
       *   ★ 注意两侧的 id 并不同名，这是历史遗留：
       *     快捷键 id        → 动作 id
       *     splitRipple      → rippleDelete
       *     toggleSnap       → snapping
       *   这里显式写出映射，别指望它们自动对上。
       */
      splitRipple: () => callbacks?.onAction?.("rippleDelete"),
      toggleSnap: () => callbacks?.onAction?.("snapping"),
      /**
       * ★★★ 2026-10-25 补：播放与游标导航
       *
       *   ★ 这里必须逐个列出来 —— installShortcutHandler 收到的是
       *     { id: fn } 映射，不是「拿到 id 就回调」的单一函数。
       *     ⇒ 在 SHORTCUT_DEFS 里加了新 id 却忘了在这里注册，
       *       症状是「快捷键设置页里显示得出来，按了毫无反应」。
       *       加新键位必须【成对改两处】：DEFS 一处、这里一处。
       */
      playPause: () => callbacks?.onAction?.("playPause"),
      playReverse: () => callbacks?.onAction?.("playReverse"),
      playForward: () => callbacks?.onAction?.("playForward"),
      stepBack: () => callbacks?.onAction?.("stepBack"),
      stepForward: () => callbacks?.onAction?.("stepForward"),
      jumpBack: () => callbacks?.onAction?.("jumpBack"),
      jumpForward: () => callbacks?.onAction?.("jumpForward"),
      goStart: () => callbacks?.onAction?.("goStart"),
      goEnd: () => callbacks?.onAction?.("goEnd"),
      addBookmark: () => callbacks?.onAction?.("addBookmark"),
    }, {
      enabled: () => {
        /**
         * 三重判据，缺一不可：
         * ① 剪辑台的根节点在 DOM 里且可见
         * ② 焦点不在输入框里（否则 Ctrl+K 会抢走文字编辑）
         * ③ 没有模态浮层开着（DSH 的原生 Modal 会设 aria-modal）
         */
        const root = document.querySelector("[data-ac-root]");
        if (!root || root.offsetParent === null) return false;
        const el = document.activeElement;
        if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
        if (el && el.isContentEditable) return false;
        if (document.querySelector("[aria-modal='true']")) return false;
        return true;
      },
    });
    return dispose;
  }, [callbacks]);

  /**
   * ★★ 2026-10-22：点进剪辑台时主动把焦点从 DSH 输入框移走
   *
   *   主人要求的 C/V 实测没反应，查出来是：
   *     DSH 原生的 composer 是 <div role="textbox" contenteditable="true">
   *     点时间轴时焦点【没有】从它身上移走（ArtCraft 的元素不可聚焦），
   *     于是 installShortcutHandler 的 enabled() 判定
   *       「焦点在 contentEditable 里 ⇒ 不接管快捷键」
   *     ⇒ Ctrl+C / Ctrl+V / Ctrl+K 全部失效。
   *
   *   ★ 那层保护本身是对的（在输入框里按 C 应该打字，不该复制片段）。
   *     缺的是「用户已经明确点了时间轴」这个信号 ——
   *     点了内容区就说明他想操作时间轴，不是想打字。
   *
   *   ⇒ 在根节点上捕获 pointerdown：只要落点不在输入框内，
   *     就给根节点 focus（它有 tabIndex: 0）。
   *     之后 enabled() 的 ①②③ 三重判据自然成立。
   *
   *   ★ 为什么用 pointerdown 而不是 click：
   *     click 要等 pointerup，中间这段里用户可能已经按了快捷键。
   *     pointerdown 是能改焦点的最早时机。
   *
   *   ★ 为什么还要判 closest 输入框：
   *     检查器抽屉里有 input/textarea，点那些地方不能抢焦点。
   */
  const onRootPointerDown = (e) => {
    try {
      const t = e.target;
      if (t && t.closest) {
        if (t.closest("input, textarea, select, [contenteditable='true']")) return;
      }
      const root = rootRef?.current;
      if (!root) return;
      if (document.activeElement === root) return;
      root.focus({ preventScroll: true });
    } catch { /* ignore */ }
  };

  return h("div", {
    className: "ac-root",
    "data-ac-root": "",
    ref: rootRef,
    tabIndex: -1,
    onPointerDownCapture: onRootPointerDown,
  },

    /* ═══ ① 预览区 ═══ */
    h(PreviewPane, {
      hostRequire,
      hasContent,
      canvasRef: st.previewRef,
      currentTime: st.currentTime ?? 0,
      duration: st.duration ?? 0,
      fps: st.fps ?? 30,
      playing: st.playing === true,
      aspectLabel: st.aspectLabel ?? "16:9",
      callbacks,
    }),

    /* ═══ ①b 可拖分隔条（预览 ↔ 时间轴）═══ */
    /**
     * ★★ 2026-10-22 新增：主人报「轨道的高度依旧无法拖动，
     *    导致上面的预览高度也跟着锁死了」
     *
     *   根因：上一版为了让「工具栏紧贴时间轴」，把 ArtCraft 的
     *   ResizablePanelGroup 整个换成三段 flex —— 顺手把它内置的
     *   垂直拖拽手柄也删了（实测 [role="separator"] = 0）。
     *   于是预览高度被 CSS 写死，用户拖不动。
     *
     *   ⇒ 自己做一个 8px 命中区的分隔条，拖动只改 CSS 变量
     *     --ac-preview-h（不 setState，避免拖动时整树重渲染）。
     */
    h(VSplit, { rootRef }),

    /* ═══ ② 工具栏（紧贴时间轴上方）═══ */
    h(EditorToolbar, {
      hostRequire,
      onAction: (id) => callbacks?.onAction?.(id),
      state: st.toolbarState,
      busy: st.busy === true,
      inspectorOpen: inspOpen,
      onToggleInspector: () => setInspOpen((v) => !v),
    }),

    /**
     * ═══ ②b 操作错误条（2026-10-23）═══
     *
     *   主人：「导入功能又失效了」—— 实测失败是【完全静默】的：
     *   importFiles 把错误收进 results.failed 只 console.warn，界面零反应。
     *   ⇒ 在这里显示一行红字 + 关闭按钮。
     *
     *   ★ 为什么不弹 alert：会打断操作、不可样式化、且用户点掉就忘了。
     *   ★ 为什么放工具栏下方：错误属于「刚才那个操作」，紧挨着才关联得上。
     */
    callbacks?.actionError
      ? h("div", {
          className: "ac-action-error",
          role: "alert",
          style: {
            flex: "none",
            display: "flex", alignItems: "flex-start", gap: 8,
            margin: "0 12px 4px",
            padding: "6px 10px",
            borderRadius: 6,
            background: "rgba(248,81,73,.10)",
            color: "rgb(207,34,46)",
            fontSize: 12, lineHeight: "16px",
          },
        },
          h("span", { style: { flex: "1 1 auto", minWidth: 0, wordBreak: "break-word" } },
            callbacks.actionError),
          h("button", {
            type: "button",
            onClick: () => callbacks?.onDismissError?.(),
            "aria-label": "关闭错误提示",
            title: "关闭",
            style: {
              flex: "none", border: 0, background: "transparent",
              color: "inherit", cursor: "pointer", padding: 0,
              fontSize: 14, lineHeight: "16px", opacity: .7,
            },
          }, "×"))
      : null,

    /* ═══ ③ 时间轴 ═══ */
    h("section", { className: "ac-timeline-host", "aria-label": "时间轴" },
      /**
       * ★ 这里交给 ArtCraft。它自己 createRoot，所以本节点必须【没有 children】。
       */
      h("div", { ref: timelineRef, className: "ac-timeline-mount", "data-ac-timeline": "" })
    ),

    /* ═══ 右侧检查器抽屉（覆盖层）═══ */
    h(Inspector, {
      hostRequire,
      open: inspOpen,
      onClose: () => setInspOpen(false),
      tab: inspTab,
      onTab: setInspTab,
      media: st.media,
      element: st.selectedElement,
      captions: st.captions,
      callbacks: {
        ...callbacks,
        onPickMedia: (it) => callbacks?.onPickMedia?.(it),
      },
    }),

    /**
     * ═══ 设备监控（GPU / CPU / 显存 / 内存 四个圆环）═══
     *
     * ★★ 2026-10-22（主人：「视频工作台有的四个圆环监控，在剪辑台tab会消失，做一下同步」）
     *
     *   DeviceMonitor 自己 createPortal 到 document.body + position:fixed，
     *   并且 right 值动态测量 DSH 右侧按钮容器的左边缘。
     *   ⇒ 它不依赖父容器的位置，只要在 React 树里被渲染就会出现在正确位置。
     *   ⇒ 直接挂在这里即可，不需要给它留容器。
     *
     *   ★ 为什么要包 Boundary：
     *     它是这份监控是从另一个包复制过来的，万一数据/结构变了，
     *     只该「这块不出现」，不该让整个剪辑台崩。
     */
    h(DeviceMonitorBoundary, null, h(DeviceMonitor)),

    /* ═══ Agent 消息条（右上角）═══ */
    agentMessage      ? h("div", {
          className: "ac-agent-toast",
          role: "status",
          "aria-live": "polite",
        },
          h(I.sparkle, { size: 16, className: "ac-agent-toast-icon", "aria-hidden": "true" }),
          h("span", { className: "ac-agent-toast-text" }, agentMessage.text))
      : null
  );
}


