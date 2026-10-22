/**
 * 命令式弹出 React 组件（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 解决什么问题
 *
 *   ArtCraft 的 assetGallery.openPicker() 是一个【命令式异步调用】：
 *     const picks = await openPicker({ kinds })   ← 要等用户点完
 *
 *   而 AssetPicker 是 React 组件，得有人渲染它。
 *   ArtCraft 内部是它自己的 React root，我们插不进去。
 *
 *   ⇒ 用一个独立 root 把组件挂到 document.body，
 *     用户点「确认」时 resolve 这个 Promise，然后卸载 root。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么不能挂在 ArtCraft 的 root 里
 *
 *   ArtCraft 的 root 是它用自己那份 React 建的（见第 1 期门槛验证）。
 *   如果我们往那个 root 里 render，用的是【我们这份 React】——
 *   两个 React 实例各自管理 tree，context / 事件冒泡都不通。
 *
 *   ⇒ 独立 root + portal 到 body 是最稳的：
 *     · 不依赖 ArtCraft 的内部结构
 *     · z-index 可以直接压到最上层（body 直属）
 *     · 卸载干净，不留残余 DOM
 *
 * ★ 注意：这里 createRoot 用的必须是【我们这份 ReactDOM】，
 *   与 AssetPicker 组件用的是同一份 React ——
 *   否则会 "Invalid hook call"。
 */

import React from "react";
import { createRoot } from "react-dom/client";

/**
 * 弹出一个组件，等它调用 resolve。
 *
 * @param {React.ComponentType} Comp   组件类型
 * @param {object} props               传给组件的 props（会追加 onConfirm / onCancel）
 * @returns {Promise<any>}             用户在组件里 resolve 的值
 */
export function showModal(Comp, props) {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    // 标记出来，便于排查残留
    host.id = "artcraft-modal-host";
    document.body.appendChild(host);

    const root = createRoot(host);

    const cleanup = () => {
      // 先卸载 React，再移除 DOM —— 顺序反了会警告
      try { root.unmount(); } catch { /* ignore */ }
      try { host.remove(); } catch { /* ignore */ }
    };

    const finish = (val) => {
      cleanup();
      resolve(val);
    };

    root.render(
      React.createElement(Comp, {
        ...props,
        onConfirm: (v) => finish(v),
        onCancel: () => finish(null),
      })
    );
  });
}
