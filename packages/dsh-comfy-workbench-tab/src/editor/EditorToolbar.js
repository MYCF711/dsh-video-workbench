/**
 * EditorToolbar.js · 剪辑台工具栏（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 规格来源：docs/布局重设计-剪辑台-20261021.md §四
 *   常驻 6 个：导入 / 分割 / 删除 / 复制 / 撤销 / 重做
 *   其余收进「···」，标注快捷键
 *   位置：紧贴时间轴上方（主人明确要求）
 *
 * ── 为什么「向左/向右分割」直接删掉而不是收进菜单
 *   布局文档 §四 的结论：PR 里只有一种「添加编辑」（Ctrl+K）。
 *   ArtCraft 的向左/向右分割是「从入点切到出点」的变体，
 *   但我们界面里没有入点/出点概念（那是 PR 的序列工作区功能）。
 *   ⇒ 删掉。留一个语义不清的菜单项比没有更糟。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-22 实测的两条 primitives 契约（写错会静默不显示）
 *
 *   ① Menu 的 `anchor` 是【React 节点】，不是 ref
 *      源码逐字：children: [anchor, portal ? createPortal(list, …) : list]
 *      它把 anchor 当成第一个子节点直接渲染。
 *      我第一版写 `anchor={moreBtnRef}`（传 ref 对象）—— 那会渲染出一个空 span，
 *      菜单永远定位不到、也永远不显示，而且【不报错】。
 *      正确：anchor = h("button", {…})
 *
 *   ② items 里分组用 `{ type: "label", text: "媒体" }`，分隔用 `{ type: "separator" }`
 *      源码里 isSeparator / isLabel 两个判定就在 renderEntry 里。
 *      不用自己拼 MenuGroup —— 那是给「自定义 children」留的后路。
 *
 * ── 为什么快捷键标注不用自己画
 *   MenuItemButton / Menu 的 items 都原生接受 `shortcut: { keys, aria }`，
 *   内部渲染 ShortcutKeys（DSH 设置面板里显示快捷键的就是它）。
 *   ⇒ 菜单项的快捷键标注 = 传一个 prop，不写一行样式。
 */

import React from "react";
import { ui } from "./dsh-primitives.js";
import { getChordLabel, getChord, subscribeShortcuts } from "./shortcuts.js";

/**
 * 撤销 / 重做图标（内联 SVG，2026-10-23）
 *
 * ★★ 主人（截图：「图标重复了」）：
 *   撤销和重做显示的是同一个弧形箭头 —— 因为两个按钮的 icon 都写了 "refresh"。
 *
 * ── 为什么不用 DSH 的图标集
 *   dsh-primitives.js 的 Icon 映射里【没有撤销/重做】。
 *   实测在 @deepseek-ai/dsh-client-ui-primitives 里搜
 *   /undo|redo|arrow|back|forward|history|rotate|reset/ 只命中 2 个，
 *   而且都是 IconAgentPreset*（无关）。
 *   ⇒ 用 chevronLeft/Right 语义不对（那是导航，不是历史操作）。
 *
 * ── 所以画内联 SVG
 *   规格照 DSH 图标：24×24 viewBox、stroke 1.5、currentColor、round 端帽。
 *   两个图标必须【方向相反】才读得出「撤回」和「重做」：
 *     撤销：箭头指向【左】+ 弧线在右
 *     重做：箭头指向【右】+ 弧线在左（水平镜像）
 *   这是 undo/redo 的通用视觉语言（Obsidian / Figma / VS Code 都这样）。
 */
function UndoIcon({ size = 16 }) {
  return h("svg", {
    viewBox: "0 0 24 24", width: size, height: size,
    "aria-hidden": "true", fill: "none",
    stroke: "currentColor", strokeWidth: 1.5,
    strokeLinecap: "round", strokeLinejoin: "round",
  },
    /* 左上箭头 + 向右下的弧线 */
    h("path", { d: "M9 14 4 9l5-5" }),
    h("path", { d: "M4 9h10.5a5.5 5.5 0 0 1 0 11H11" }),
  );
}

function RedoIcon({ size = 16 }) {
  return h("svg", {
    viewBox: "0 0 24 24", width: size, height: size,
    "aria-hidden": "true", fill: "none",
    stroke: "currentColor", strokeWidth: 1.5,
    strokeLinecap: "round", strokeLinejoin: "round",
  },
    /* 右上箭头 + 向左下的弧线（UndoIcon 的水平镜像） */
    h("path", { d: "M15 14l5-5-5-5" }),
    h("path", { d: "M20 9H9.5a5.5 5.5 0 0 0 0 11H13" }),
  );
}

const h = React.createElement;

/**
 * 把 shortcuts.js 的 chord 转成 primitives 要的 shape。
 *
 * ★ keys 是「一个个键帽」的数组，不是一整个字符串 ——
 *   ShortcutKeys 把数组每项渲染成一个 <kbd>。
 *   显示文案统一从 getChordLabel 取（它已处理 mac 的 ⌘ 与平台差异）。
 */
function shortcutShape(id) {
  if (!id) return undefined;
  const label = getChordLabel(id);
  if (!label) return undefined;
  return {
    keys: String(label).split("+").map((s) => s.trim()).filter(Boolean),
    aria: label,
  };
}

/**
 * 常驻在工具条上的 6 个。
 *
 * ★ 2026-10-22：复制从 duplicate 改成 copy（Ctrl+C，进剪贴板）。
 *   粘贴/剪切不常驻 —— 它们放「···」菜单里（见 TOOLBAR_MORE）。
 *   理由：常驻位只有 6 个（主人定的），粘贴的使用频率低于复制，
 *         且它有快捷键 Ctrl+V，不需要占一个常驻位。
 */
export const TOOLBAR_PRIMARY = [
  { id: "import", label: "导入", icon: "plus", primary: true },
  /**
   * ★★ 2026-10-23：导出提到常驻位，紧跟「导入」右边
   *
   *   主人：「导出按钮还是没在ui直接显示，放在导入按钮右边比较好，
   *          目前是在更多操作的二级里面」
   *
   *   上一版我把它放进「···」菜单里（理由是「低频的终点操作」），
   *   但主人找不到 = 功能不存在。
   *   ⇒ 常驻位从 6 个变 7 个。位置紧跟导入 —— 出入配对，符合心智模型。
   *
   *   ★ 这一条推翻了「常驻位只有 6 个」的旧约束（那是 2026-10-22 定的）。
   *     主人现在的明确要求优先。
   */
  { id: "export", label: "导出", icon: "download" },
  { id: "split", label: "分割", icon: "split", shortcutId: "split" },
  { id: "delete", label: "删除", icon: "trash", shortcutId: "delete" },
  { id: "copy", label: "复制", icon: "copy", shortcutId: "copy" },
];

export const TOOLBAR_HISTORY = [
  { id: "undo", label: "撤销", icon: "undo", shortcutId: "undo" },
  { id: "redo", label: "重做", icon: "redo", shortcutId: "redo" },
];

/**
 * 「···」里的项。layout 文档 §四 表格逐条对应。
 * `shortcutId` 指向 shortcuts.js 的 id；拿不到就只是不显示快捷键。
 */
export const TOOLBAR_MORE = [
  { type: "label", text: "媒体" },
  { id: "extractAudio", label: "提取音频", icon: "mic" },
  { id: "freezeFrame", label: "定格帧", icon: "copy", disabled: true },

  { type: "separator" },
  { type: "label", text: "标记" },
  { id: "addBookmark", label: "添加书签", icon: "info", shortcutId: "addBookmark" },
  { id: "addKeyframe", label: "添加关键帧", icon: "sparkle" },

  { type: "separator" },
  { type: "label", text: "剪辑" },
  /**
   * ★ 2026-10-22：粘贴 / 剪切放这里，不占常驻位。
   *   常驻位只有 6 个（导入/分割/删除/复制 + 撤销/重做），
   *   而粘贴有 Ctrl+V 快捷键，不需要占一个常驻格。
   */
  { id: "paste", label: "粘贴到播放头", icon: "copy", shortcutId: "paste" },
  { id: "cut", label: "剪切", icon: "trash", shortcutId: "cut" },
  { id: "rippleDelete", label: "波纹删除", icon: "trash", shortcutId: "splitRipple" },
  { id: "snapping", label: "自动吸附", icon: "check", shortcutId: "snap" },
  { id: "sceneSwitch", label: "场景切换", icon: "panelLeft" },

  { type: "separator" },
  { type: "label", text: "视图" },
  { id: "trackTaller", label: "增高轨道", icon: "chevronUp", shortcutId: "trackTaller" },
  { id: "trackShorter", label: "减矮轨道", icon: "chevronDown", shortcutId: "trackShorter" },
  { id: "zoomIn", label: "放大时间轴", icon: "plus", shortcutId: "zoomIn" },
  { id: "zoomOut", label: "缩小时间轴", icon: "chevronLeft", shortcutId: "zoomOut" },

  /**
   * ★ 2026-10-23：导出已提升为常驻位（见 TOOLBAR_PRIMARY）。
   *   这里不能再放一份 —— 同一功能出现在两处会让人以为是两个不同的操作。
   */
];

/**
 * 工具条。
 *
 * @param {object} p
 * @param {object} p.hostRequire
 * @param {(id:string)=>void} p.onAction
 * @param {object} p.state      { canSplit, canDelete, canDuplicate, canUndo, canRedo, snapping }
 * @param {boolean} p.busy      加载中，整体禁用（撤销/重做除外）
 */
export function EditorToolbar({
  hostRequire, onAction, state, busy,
  inspectorOpen, onToggleInspector,
}) {
  const U = ui(hostRequire);
  const I = U.Icon;

  /**
   * 订阅快捷键变更 → 「···」里的标注实时跟着改。
   * 主人要求：「让用户根据自身习惯修改各种功能的快捷键，并同步到二级菜单提示的快捷键」
   * ⇒ 不能只在挂载时读一次。
   */
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => subscribeShortcuts(() => force()), []);

  const [moreOpen, setMoreOpen] = React.useState(false);

  /** 每个按钮的可用性 —— 空工程下必须显示为禁用，不能点了没反应。 */
  const enabled = {
    import: !busy,
    split: !busy && !!state?.canSplit,
    delete: !busy && !!state?.canDelete,
    copy: !busy && !!state?.canCopy,
    paste: !busy && !!state?.canPaste,
    cut: !busy && !!state?.canCut,
    undo: !!state?.canUndo,
    redo: !!state?.canRedo,
  };

  const btn = (item) => {
    /**
     * ★ 2026-10-23：undo/redo 用内联 SVG（DSH 图标集里没有这两个语义）。
     *   见文件上方 UndoIcon / RedoIcon 的说明。
     */
    const IconComp = item.icon === "undo" ? UndoIcon
      : item.icon === "redo" ? RedoIcon
      : (I[item.icon] ?? I.info);
    const on = enabled[item.id] !== false;
    const chord = shortcutShape(item.shortcutId);
    const label = chord ? chord.aria : "";

    return h(U.Tooltip, {
      key: item.id,
      label: label ? `${item.label}（${label}）` : item.label,
      side: "bottom",
    },
      h("button", {
        type: "button",
        className: "ac-tb-btn" + (item.primary ? " ac-tb-primary" : ""),
        disabled: !on,
        onClick: () => onAction(item.id),
        "aria-label": item.label,
        /* ★ 原生滚动次要按钮的键盘提示 */
        "aria-keyshortcuts": chord ? chord.aria : undefined,
      },
        h(IconComp, { size: 16, "aria-hidden": "true" }),
        h("span", { className: "ac-tb-label" }, item.label)
      )
    );
  };

  /**
   * 「···」的 items：把 label/separator 原样透传，
   * 真实操作项补上 icon 与 shortcut。
   */
  const moreItems = TOOLBAR_MORE.map((it) => {
    if (it.type === "label" || it.type === "separator") return it;
    const IconComp = I[it.icon] ?? I.info;
    const chord = shortcutShape(it.shortcutId);
    const isToggle = it.id === "snapping";
    return {
      id: it.id,
      icon: h(IconComp, { size: 16, "aria-hidden": "true" }),
      label: isToggle
        ? it.label + (state?.snapping ? "（已开）" : "（已关）")
        : it.label,
      shortcut: chord,
      disabled: it.disabled === true,
    };
  });

  /* ★ anchor 必须是节点，不是 ref —— 见文件头注释 ① */
  const moreAnchor = h(U.Tooltip, { label: "更多操作", side: "bottom" },
    h("button", {
      type: "button",
      className: "ac-tb-btn ac-tb-icon-only",
      "aria-label": "更多操作",
      "aria-haspopup": "menu",
      "aria-expanded": moreOpen,
      onClick: () => setMoreOpen((v) => !v),
    }, h(I.ellipsis, { size: 16, "aria-hidden": "true" }))
  );

  return h("div", { className: "ac-toolbar", role: "toolbar", "aria-label": "剪辑工具" },
    h("div", { className: "ac-tb-group" },
      btn(TOOLBAR_PRIMARY[0]),
      h("div", { className: "ac-tb-sep", "aria-hidden": "true" }),
      TOOLBAR_PRIMARY.slice(1).map(btn)
    ),

    h("div", { className: "ac-tb-sep", "aria-hidden": "true" }),

    h("div", { className: "ac-tb-group" }, TOOLBAR_HISTORY.map(btn)),

    h("div", { className: "ac-tb-spacer" }),

    h("div", { className: "ac-tb-group" },
      /**
       * 检查器开关。
       * ★ 必须紧挨着「···」，两者都是「面板类」入口，位置相近才符合直觉。
       *   图标用 IconSlidersTwo —— DSH 设置里「属性/调节」的通用符号。
       */
      h(U.Tooltip, { label: inspectorOpen ? "收起检查器" : "打开检查器", side: "bottom" },
        h("button", {
          type: "button",
          className: "ac-tb-btn ac-tb-icon-only" + (inspectorOpen ? " ac-tb-active" : ""),
          "aria-label": inspectorOpen ? "收起检查器" : "打开检查器",
          "aria-pressed": inspectorOpen === true,
          onClick: () => onToggleInspector?.(),
        }, h(I.sliders, { size: 16, "aria-hidden": "true" }))
      ),

      h(U.Menu, {
        open: moreOpen,
        anchor: moreAnchor,
        align: "end",
        items: moreItems,
        onSelect: (id) => { setMoreOpen(false); onAction(id); },
        onClose: () => setMoreOpen(false),
        /**
         * ★★ 2026-10-22 修：菜单被时间轴挡住（主人报「点出来被下面的轨道挡住」）
         *
         *   实测：菜单 z-index = 100，但 5 个探针点【全部】被 ArtCraft 的
         *   时间轴元素盖住（`relative h-full min-w-full` / `scrollbar-thin overflow-auto`）。
         *
         *   根因：z-index 只在【同一个层叠上下文】里比较。
         *   菜单的祖先是 .ac-toolbar → .ac-root（position:relative, z-index:auto），
         *   而时间轴容器也在 .ac-root 里、且在 DOM 中【排在工具栏之后】。
         *   两个兄弟都 z-index:auto 时，后出现的在【绘制顺序上更晚】，
         *   于是时间轴整块压在工具栏的后代（含菜单）之上 ——
         *   菜单自己写多少 z-index 都跳不出这个上下文。
         *
         *   ⇒ 用 DSH 原生 Menu 的 portal 参数：
         *     它把菜单 createPortal 到 document.body，彻底离开剪辑台的层叠上下文。
         *     源码逐字：portal ? createPortal(list, document.body) : list
         *
         *   ★ 为什么不用「把 .ac-toolbar 加 z-index:50」：
         *     那样会盖住时间轴的【交互】（滚动、拖拽、点击命中），
         *     而 portal 只让菜单本体浮起来，不影响其它任何元素。
         */
        portal: true,
      })
    )
  );
}


