/**
 * Inspector.js · 右侧检查器抽屉（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-22 决定：「三个 tab 全部自己重写」
 *
 * ── 规格（docs/布局重设计-剪辑台-20261021.md §二 右侧检查器）
 *   宽 320 / position:absolute right:0 / 16px 圆角（外侧三边）
 *   底色 --dsw-menu-surface-fill + backdrop-filter blur(40px) saturate(150%)
 *   阴影 --dsw-elevation-prominent / 距 DSH 边缘 8px
 *   进场：从右滑入 160ms ease-out + 淡入
 *   tab 行：素材 │ 属性 │ 字幕
 *   不挤压时间轴（覆盖在上层）
 *
 * ── 为什么用抽屉而不是常驻列
 *   常驻列永久吃掉 320px，时间轴变窄；
 *   抽屉覆盖在上层，需要时才看，不需要时时间轴满宽。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 三个 tab 的内容自画，但每个控件都用 DSH 原生基元 —— 这是分界
 *
 *   自己画（DSH 没有对应物）：素材网格、属性表单的行、字幕列表
 *   用原生（DSH 有）：SegmentedTabs（tab 行）、Switch、Tag、Pill、
 *                    Menu（排序/筛选）、Tooltip、ShortcutKeys、图标
 *
 *   ⇒ 判据：**凡是 DSH 里有同名概念的控件，一律用原生的**。
 *     自己画的只有「DSH 里根本没有这个东西」的容器与数据展示。
 */

import React from "react";
import { ui } from "./dsh-primitives.js";

const h = React.createElement;

/** 三个 tab。 */
const TABS = [
  { id: "insp-media", value: "media", label: "素材" },
  { id: "insp-props", value: "props", label: "属性" },
  { id: "insp-caps", value: "caps", label: "字幕" },
];

const MEDIA_VIEW_MODES = [
  { value: "grid", label: "网格", icon: "flatList" },
  { value: "list", label: "列表", icon: "compact" },
];

/**
 * 素材 tab：固定双列（主人要求），列表视图单列。
 *
 * ★ 为什么固定双列而不是 auto-fill：
 *   320 宽减去两侧留白 24 = 296，双列 gap 8 ⇒ 每列 144。
 *   用 auto-fill + minmax 会在 296 上算出 2 列，但窗口一窄就掉成 1 列，
 *   卡片尺寸跳变。固定双列 + 卡片宽度 100% 更稳。
 */
function MediaPane({ U, items, loading, onPick, emptyHint }) {
  const I = U.Icon;
  const [mode, setMode] = React.useState("grid");

  const segItems = MEDIA_VIEW_MODES.map((m) => {
    const IconComp = I[m.icon] ?? I.flatList;
    return {
      id: "mv-" + m.value,
      value: m.value,
      label: h("span", { className: "ac-seg-label" },
        h(IconComp, { size: 14, "aria-hidden": "true" }),
        h("span", null, m.label)),
    };
  });

  return h("div", { className: "ac-pane" },
    /* 头部：视图切换 */
    h("div", { className: "ac-pane-head" },
      h("span", { className: "ac-pane-title" }, `素材（${items.length}）`),
      h(U.SegmentedTabs, {
        items: segItems,
        value: mode,
        onChange: setMode,
        label: "素材视图",
        className: "ac-pane-seg",
      })
    ),

    /* 空态 —— 必须说清楚「为什么空」，不能只说没有 */
    items.length === 0
      ? h("div", { className: "ac-empty" },
          h(I.folderOpen, { size: 28, className: "ac-empty-icon", "aria-hidden": "true" }),
          h("div", { className: "ac-empty-title" }, loading ? "正在读取资产库…" : "资产库是空的"),
          h("div", { className: "ac-empty-desc" },
            loading ? "读取完成后这里会列出所有可用的图片与视频"
                    : (emptyHint || "用「导入」把视频、图片、音频加进来"))
        )
      : h("div", {
          className: "ac-media-" + mode,
          role: "list",
          "aria-label": "素材列表",
        },
        items.map((it) => h("button", {
          key: it.id,
          type: "button",
          role: "listitem",
          className: "ac-media-card",
          onClick: () => onPick?.(it),
          title: it.name,
        },
          h("span", { className: "ac-media-thumb" },
            /**
             * ★★ 2026-10-23：视频必须用 video 标签，不能用 img
             *
             *   实测（19499）：给 mp4 的 URL 套 img，naturalWidth = 0
             *   ⇒ 浏览器解码失败，缩略图空白一片。
             *
             *   mediaAssets.js:137-150 记过同一件事：
             *     「视频的 thumbnailUrl 必须是首帧图，不能是视频 URL」
             *   但它说的是「拿首帧」，而 DSH 这边没有转码能力。
             *
             *   ⇒ 直接用 video + preload="metadata"：
             *     浏览器自己取首帧渲染，零转码、零额外请求。
             *     muted 必须加 —— 否则某些浏览器不渲染首帧。
             */
            it.thumbnailUrl && it.kind === "video"
              ? h("video", {
                  src: it.thumbnailUrl,
                  muted: true,
                  playsInline: true,
                  preload: "metadata",
                  "aria-hidden": "true",
                  className: "ac-media-thumb-video",
                })
              : it.thumbnailUrl
              ? h("img", { src: it.thumbnailUrl, alt: "", loading: "lazy" })
              : h(I.download, { size: 16, "aria-hidden": "true" })),
          h("span", { className: "ac-media-meta" },
            h("span", { className: "ac-media-name" }, it.name),
            h("span", { className: "ac-media-sub" }, it.kindLabel ?? ""))
        ))
      )
  );
}

/**
 * 属性 tab。
 *
 * ★ 空态文案按 refactoring-ui §8.4：不说「没有内容」，要说「怎么才能有内容」。
 */
function PropsPane({ U, element, onChange }) {
  const I = U.Icon;

  if (!element) {
    return h("div", { className: "ac-pane" },
      h("div", { className: "ac-empty" },
        h(I.sliders, { size: 28, className: "ac-empty-icon", "aria-hidden": "true" }),
        h("div", { className: "ac-empty-title" }, "未选中片段"),
        h("div", { className: "ac-empty-desc" },
          "在时间轴上点一下片段，这里就会显示它的变换、音量、速度")
      )
    );
  }

  /** 一行：标签 + 值。值控件按 type 决定用原生 Switch 还是自画字段。 */
  const Row = ({ label, children, hint }) => h("div", { className: "ac-row" },
    h("div", { className: "ac-row-label" }, label),
    h("div", { className: "ac-row-value" }, children),
    hint ? h("div", { className: "ac-row-hint" }, hint) : null
  );

  return h("div", { className: "ac-pane" },
    h("div", { className: "ac-pane-head" },
      h("span", { className: "ac-pane-title" }, element.label || "片段"),
      h(U.Tag, { tone: "outline" }, element.kindLabel || "视频")
    ),

    h("div", { className: "ac-pane-body" },
      h(Row, { label: "名称" },
        h("input", {
          className: "ac-input",
          value: element.name ?? "",
          onChange: (e) => onChange?.({ name: e.target.value }),
          "aria-label": "片段名称",
        })),

      h(Row, { label: "起点" },
        h("span", { className: "ac-mono" }, element.startLabel ?? "00:00:00:00")),

      h(Row, { label: "时长" },
        h("span", { className: "ac-mono" }, element.durationLabel ?? "00:00:00:00")),

      h("div", { className: "ac-sec-title" }, "变换"),

      h(Row, { label: "旋转", hint: "度" },
        h("input", {
          className: "ac-input ac-input-num",
          type: "number",
          value: element.rotation ?? 0,
          onChange: (e) => onChange?.({ rotation: Number(e.target.value) }),
          "aria-label": "旋转角度",
        })),

      h("div", { className: "ac-sec-title" }, "音频与速度"),

      h(Row, { label: "音量", hint: `${element.volume ?? 0} dB` },
        h("input", {
          className: "ac-range",
          type: "range",
          min: -60, max: 12, step: 1,
          value: element.volume ?? 0,
          onChange: (e) => onChange?.({ volume: Number(e.target.value) }),
          "aria-label": "音量",
        })),

      h(Row, { label: "静音" },
        h(U.Switch, {
          checked: element.muted === true,
          onChange: (v) => onChange?.({ muted: v }),
          label: "静音",
        })),

      h(Row, { label: "速度", hint: "倍" },
        h("input", {
          className: "ac-input ac-input-num",
          type: "number",
          step: 0.1,
          min: 0.1, max: 10,
          value: element.speed ?? 1,
          onChange: (e) => onChange?.({ speed: Number(e.target.value) }),
          "aria-label": "播放速度",
        }))
    )
  );
}

/**
 * 字幕 tab。
 *
 * ★ 本机 whisper 已装（medium 模型），所以「从音轨识别」是【真入口】不是假按钮。
 *   没有音频轨时必须明确说明「这条轨上没有音频」，而不是「不可用」。
 */
function CapsPane({ U, captions, onGenerate, onRecognize, onEdit, hasAudio }) {
  const I = U.Icon;
  const [text, setText] = React.useState("");

  return h("div", { className: "ac-pane" },
    h("div", { className: "ac-pane-head" },
      h("span", { className: "ac-pane-title" }, `字幕（${captions.length}）`)
    ),

    h("div", { className: "ac-pane-body" },
      h("div", { className: "ac-sec-title" }, "贴稿生成"),
      h("div", { className: "ac-field-hint" }, "每行一条字幕"),
      h("textarea", {
        className: "ac-textarea",
        rows: 4,
        value: text,
        placeholder: "第一行字幕\n第二行字幕\n第三行字幕",
        onChange: (e) => setText(e.target.value),
        "aria-label": "字幕文本，每行一条",
      }),
      h("div", { className: "ac-btn-row" },
        h("button", {
          type: "button",
          className: "ac-btn ac-btn-primary",
          disabled: !text.trim(),
          onClick: () => { onGenerate?.(text); setText(""); },
        }, h(I.plus, { size: 16, "aria-hidden": "true" }), "生成字幕"),

        h(U.Tooltip, {
          label: hasAudio ? "用 whisper 从音轨听写" : "音频轨上还没有内容",
          side: "left",
        },
          h("button", {
            type: "button",
            className: "ac-btn",
            disabled: !hasAudio,
            onClick: () => onRecognize?.(),
          }, h(I.mic, { size: 16, "aria-hidden": "true" }), "从音轨识别"))
      ),

      captions.length > 0
        ? h("div", { className: "ac-cap-list" },
            captions.map((c, i) => h("div", { key: c.id ?? i, className: "ac-cap-row" },
              h("span", { className: "ac-cap-time" }, c.startLabel ?? ""),
              h("input", {
                className: "ac-input",
                value: c.content ?? "",
                onChange: (e) => onEdit?.(c, e.target.value),
                "aria-label": `第 ${i + 1} 条字幕`,
              })
            )))
        : h("div", { className: "ac-empty ac-empty-inline" },
            h("div", { className: "ac-empty-desc" },
              "贴一段文字后点「生成字幕」，或直接从音轨识别")
          )
    )
  );
}

/**
 * 检查器抽屉本体。
 *
 * @param {object} p
 * @param {object} p.hostRequire
 * @param {boolean} p.open
 * @param {()=>void} p.onClose
 * @param {"media"|"props"|"caps"} p.tab
 * @param {(v:string)=>void} p.onTab
 * @param {object} p.media   { items, loading }
 * @param {object} p.element 选中的片段（属性 tab 用）
 * @param {object} p.captions
 */
export function Inspector({
  hostRequire, open, onClose, tab, onTab,
  media, element, captions, callbacks,
}) {
  const U = ui(hostRequire);
  const I = U.Icon;

  /**
   * 关闭时不留 DOM。
   * ★ 用条件渲染（不是 display:none）：
   *   隐藏但挂载的组件仍会跑 effect / 订阅 —— 素材轮询与快捷键订阅会持续消耗。
   */
  if (!open) return null;

  const tabItems = TABS.map((t) => ({ ...t }));

  return h("aside", {
    className: "ac-inspector",
    "aria-label": "检查器",
    "data-ac-inspector": "",
  },
    h("div", { className: "ac-insp-head" },
      h("span", { className: "ac-insp-title" }, "检查器"),
      h(U.Tooltip, { label: "关闭检查器", side: "left" },
        h("button", {
          type: "button",
          className: "ac-tb-btn ac-tb-icon-only",
          onClick: onClose,
          "aria-label": "关闭检查器",
        }, h(I.close, { size: 16, "aria-hidden": "true" })))
    ),

    h("div", { className: "ac-insp-tabs" },
      h(U.SegmentedTabs, {
        items: tabItems,
        value: tab,
        onChange: onTab,
        label: "检查器分区",
      })
    ),

    h("div", { className: "ac-insp-body" },
      tab === "media"
        ? h(MediaPane, {
            U,
            items: media?.items ?? [],
            loading: media?.loading === true,
            onPick: callbacks?.onPickMedia,
          })
        : null,

      tab === "props"
        ? h(PropsPane, {
            U,
            element,
            onChange: (patch) => callbacks?.onElementChange?.(patch),
          })
        : null,

      tab === "caps"
        ? h(CapsPane, {
            U,
            captions: captions ?? [],
            hasAudio: callbacks?.hasAudio === true,
            onGenerate: (t) => callbacks?.onGenerateCaptions?.(t),
            onRecognize: () => callbacks?.onRecognizeCaptions?.(),
            onEdit: (c, v) => callbacks?.onEditCaption?.(c, v),
          })
        : null
    )
  );
}
