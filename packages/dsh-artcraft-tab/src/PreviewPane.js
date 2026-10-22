/**
 * PreviewPane.js · 预览区（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-21 报的问题：「预览窗口在没导入东西的时候总是全黑…
 *                          在浅色主题就是一个大黑块」
 *
 * ── 根因（实测数据，见 docs/架构决策-自建UI与Agent反馈-20261021.md §二）
 *   project.settings.background = { type:"color", color:"transparent" }
 *   canvas 的 computed 背景      = rgba(0,0,0,0)      ← 透明
 *   预览容器背景                 = rgb(255,255,255)   ← 白色
 *   ⇒ 画布透明 + 每帧没画东西 ⇒ 浏览器把离屏 canvas 的初始透明像素显示为黑
 *   ⇒ 空项目 = 一块纯黑
 *
 * ── 修法（采用 C + A）
 *   C. 空状态【不渲染 canvas】，改显示占位
 *      —— 最符合 DSH 风格（refactoring-ui §8.4：空态要当功能的一部分设计）
 *   A. 有内容时给 canvas 浅灰底，透明像素透出浅灰而不是黑
 *
 * ── 为什么预览画面仍然用 ArtCraft 的 canvas
 *   docs/架构决策 §七：**外壳自己写，引擎继续用**
 *   保留：CanvasRenderer / audio / export / command / 关键帧数据层
 *   ⇒ 预览区是一个「容器 + 播放条」，中间那层 canvas 仍由 ArtCraft 渲染。
 *     本组件负责：空态、播放条、时间码、画面留白。
 */

import React from "react";
import { ui } from "./dsh-primitives.js";

const h = React.createElement;

/** MediaTime（整数 tick，120000/秒）→ "00:00:02:08" */
export function formatTimecode(ticks, fps) {
  const TICKS_PER_SEC = 120000;
  const t = Math.max(0, Number(ticks) || 0);
  const totalSec = t / TICKS_PER_SEC;
  const f = Math.max(1, Number(fps) || 30);
  const totalFrames = Math.round(totalSec * f);
  const ff = totalFrames % f;
  const totalWhole = Math.floor(totalFrames / f);
  const ss = totalWhole % 60;
  const mm = Math.floor(totalWhole / 60) % 60;
  const hh = Math.floor(totalWhole / 3600);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${p2(hh)}:${p2(mm)}:${p2(ss)}:${p2(ff)}`;
}

/**
 * 预览区。
 *
 * @param {object} p
 * @param {object} p.hostRequire
 * @param {boolean} p.hasContent  工程里是否有任何元素
 * @param {object}  p.canvasRef   ArtCraft 挂载画布的容器 ref（有内容时才挂）
 * @param {number}  p.currentTime MediaTime tick
 * @param {number}  p.duration
 * @param {number}  p.fps
 * @param {boolean} p.playing
 * @param {object}  p.callbacks   { onPlayPause, onSeek, onImport }
 * @param {string}  p.aspectLabel 例如 "16:9"
 */
export function PreviewPane({
  hostRequire, hasContent, canvasRef,
  currentTime, duration, fps, playing, aspectLabel, callbacks,
}) {
  const U = ui(hostRequire);
  const I = U.Icon;

  const cur = formatTimecode(currentTime, fps);
  const dur = formatTimecode(duration, fps);
  const pct = duration > 0 ? Math.min(100, (Number(currentTime) / Number(duration)) * 100) : 0;

  return h("section", { className: "ac-preview", "aria-label": "预览" },
    /* ── 画面区 ── */
    h("div", { className: "ac-preview-stage" },
      hasContent
        /**
         * ★ 有内容：把 ArtCraft 的 canvas 容器交出去。
         *   ArtCraft 的 mount() 会往这个节点里 createRoot，
         *   ⇒ 这里【不能有任何 children】（会与它的 React root 打架）。
         */
        ? h("div", {
            ref: canvasRef,
            className: "ac-preview-canvas",
            "data-ac-canvas": "",
          })
        /**
         * ★ 空态：不渲染 canvas。
         *   这是「黑块」的根治 —— 没有 canvas 就没有黑块。
         */
        : h("div", { className: "ac-preview-empty" },
            h(I.play, { size: 32, className: "ac-preview-empty-icon", "aria-hidden": "true" }),
            h("div", { className: "ac-preview-empty-title" }, "这里还没有内容"),
            h("div", { className: "ac-preview-empty-desc" },
              "把视频、图片或音频拖进来，或者点下面的「导入」"),
            h("button", {
              type: "button",
              className: "ac-btn ac-btn-primary",
              onClick: () => callbacks?.onImport?.(),
            }, h(I.plus, { size: 16, "aria-hidden": "true" }), "导入素材"))
    ),

    /* ── 播放条 ── */
    h("div", { className: "ac-preview-bar" },
      h("button", {
        type: "button",
        className: "ac-preview-play",
        disabled: !hasContent,
        onClick: () => callbacks?.onPlayPause?.(),
        "aria-label": playing ? "暂停" : "播放",
      }, playing
        ? h(I.pause, { size: 18, "aria-hidden": "true" })
        : h(I.play, { size: 18, "aria-hidden": "true" })),

      h("span", { className: "ac-timecode" }, cur),

      /**
       * 进度条。
       * ★ 布局文档 §三：高 2px，hover 变 4px，不用滑块圆点（DSH 风格是细线）。
       *   用 range 是为了原生可拖动 + 键盘可操作；
       *   视觉上把 thumb 做成透明、track 做成细线。
       */
      h("input", {
        className: "ac-scrub",
        type: "range",
        min: 0,
        max: Math.max(1, Number(duration) || 1),
        value: Number(currentTime) || 0,
        disabled: !hasContent,
        onChange: (e) => callbacks?.onSeek?.(Number(e.target.value)),
        "aria-label": "播放进度",
        style: { "--ac-scrub-pct": pct + "%" },
      }),

      h("span", { className: "ac-timecode ac-timecode-total" }, dur),

      aspectLabel
        ? h(U.Tag, { tone: "outline", className: "ac-aspect-tag" }, aspectLabel)
        : null
    )
  );
}
