/**
 * editor/index.js · 剪辑台模块入口（2026-10-22 合包后新增）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 为什么有这个文件（主人点破的一个结构错误）
 *
 *   主人原话：
 *     「为什么不做到同一个包？？剪辑是视频工作台的一部分」
 *     「之前说过的，最小交付房间理论，剪辑可以作为一个独立的大模块接入插件」
 *
 *   两句话合起来 = **一个插件包，内部一个独立大模块**。
 *   而我之前把它做成了【两个独立的插件包】：
 *     · dsh-comfy-workbench-tab（视频工作台）
 *     · dsh-artcraft-tab（剪辑台）
 *   这是把「模块边界」误解成了「包边界」。
 *
 *   ⇒ 合包后：所有剪辑台代码移到 dsh-comfy-workbench-tab/src/editor/，
 *     由本文件统一export一个 mountEditorModule(ctx, deps)，交给包的 apply 调用。
 *
 * ── 为什么不直接把代码摊平
 *   摊平后 workbench 的 src 会从 20 个文件变成 40 个，
 *   两类东西（生成工作流 vs 时间轴编辑器）混在一起，排查时先要分谁是谁。
 *   ⇒ 保留 editor/ 子目录 = 模块边界看得见，包边界只有一个。
 *
 * ── 合包的真实代价（量过，不是猜）
 *   workbench 本体   0.30MB 原始 / 0.08MB gzip
 *   artcraft 产物   10.69MB 原始 / 3.41MB gzip
 *   ⇒ 合并后首屏要下 3.49MB（gzip），即使不点剪辑台。
 *     拆包时是 0.08MB 首屏 + 点剪辑台才拉 3.41MB。
 *   主人已确认选【合并】，理由是功能归属比加载优化重要。
 *
 * ── 合并必须解决的两个技术点
 *   ① workbench 的 __requireShim 只放行 react 三件套
 *      而剪辑台要 require("@deepseek-ai/dsh-client-ui-primitives")
 *      ⇒ 由本模块自己从 globalThis.__DSH_PLUGIN_REQUIRE__ 取真 require，
 *        不依赖包级 shim（见 dsh-primitives.js 的 resolveHostRequire）
 *   ② 两个包都 export 了 name / apply，合并后只能有一个
 *      ⇒ 本文件不 export apply，只 export mountEditorModule
 */

import React from "react";

/* ── 剪辑台的各个部件 ── */
import { ArtCraftTab } from "./ArtCraftTab.js";
import { ShortcutSettings } from "./ShortcutSettings.js";
import { ComfySettingsSection } from "./ComfySettings.js";
import { installHandleGuard, resetDshWidths } from "./dshHandleGuard.js";
import { ArtCraftHost, ArtCraftBoundary, NS as EDITOR_NS } from "./editorHost.js";

/**
 * 注册剪辑台的全部 slot。
 *
 * @param {object} ctx   cordis 插件上下文（来自包的 apply）
 * @param {object} deps  { locale.bind 得到的 t、包名等 }
 */
export function mountEditorModule(ctx, deps = {}) {
  const NS = EDITOR_NS || "artcraft-tab";

  /* ① 剪辑台的字典（与包的字典分开命名空间，互不干扰） */
  ctx.effect(
    () => ctx.locale.register(NS, {
      zh: {
        "view.label": "剪辑台",
        "settings.shortcuts": "剪辑台快捷键",
        "settings.environment": "ComfyUI 与环境",
      },
      en: {
        "view.label": "Editor",
        "settings.shortcuts": "Editor shortcuts",
        "settings.environment": "ComfyUI & environment",
      },
    }),
    "comfy-workbench-tab/editor: dictionaries"
  );

  /**
   * ② ★★ 2026-10-23 改成「纯 CSS 变量跟随」（主人：能做成实时动效吗？）
   *
   *   和视频工作台用完全相同的做法（见 WorkbenchView 里那段长注释）。
   *
   * ── 之前为什么慢半拍
   *   原来是 500ms 轮询 localStorage + 复刻 clamp 公式。
   *   算得对，但：
   *     · 慢半拍（最多 500ms 滞后）
   *     · 实测 DSH 拖动时【根本不读 localStorage】——
   *       改 localStorage 后 DSH 卡片宽度完全不变（1486 → 1486）
   *
   * ── 真相
   *   .RlGAzG_card { max-width: var(--dsh-composer-card-max-width) }
   *   DSH 拖动时只改这个变量，浏览器原生重绘（无 React 重渲染）⇒ 所以实时。
   *
   * ── 所以这里只补一个兜底，实际跟随由 CSS 完成
   *   --ac-follow-w = var(--dsh-composer-card-max-width, 100%)
   *   变量一变，两个 tab 的内容同帧跟着变。
   */
  ctx.effect(() => {
    /**
     * ★★ 2026-10-23 第二次修：元素重建后必须重新设置
     *
     * ── 第一版的 bug（主人：「切换到剪辑台有时候宽度会卡成顶格最宽」）
     *   setFallback() 一旦成功就 clearInterval(timer)，
     *   但【切 tab 再切回来时组件是重建的】——
     *   .ac-scope 是【新元素】，inline style 是空的，
     *   而定时器已经被清掉 ⇒ 永远不会再设 ⇒ 宽度卡在满宽不恢复。
     *
     *   实测：切回剪辑台后
     *     inlineFollow = "(未设置)"
     *     computedFollow = "100%"
     *     宽度 1633（满宽），一直不恢复
     *
     * ── 修法：用 MutationObserver 盯住，元素出现就设
     *   比定时器准（元素一挂载就设，无延迟），
     *   且能感知「元素被替换」——这才是真正的需求。
     *
     *   ★ 为什么不每次全量扫描：observer 回调里只查一次 querySelector，
     *     有则设、无则跳过，开销可忽略（DSH 的 DOM 变动不频繁）。
     */
    const setOn = (el) => {
      if (!el) return false;
      if (el.style.getPropertyValue("--ac-follow-w")) return false;
      el.style.setProperty("--ac-follow-w", "var(--dsh-composer-card-max-width, 100%)");
      return true;
    };

    const tick = () => setOn(document.querySelector(".ac-scope"));

    tick();

    const obs = new MutationObserver(() => { tick(); });
    obs.observe(document.body, { childList: true, subtree: true });

    return () => obs.disconnect();
  }, "comfy-workbench-tab/editor: follow contentWidth");

  /**
   * ②b ~~DSH 中栏列宽手柄屏蔽 + 恢复默认宽度~~ 【2026-10-22 撤销】
   *
   *   主人改口了，原话：
   *     「dsh的对话栏确实可以调节，不过是整个tab一起调节的，
   *       你可以让我们的tab里面的对话框自适应最宽就行了」
   *
   *   ⇒ 手柄是该用的，不该挡。正确做法是【内容跟着列宽自适应】，
   *     而不是【禁止用户调节】。
   *
   *   ★ 代码保留为注释而不是删掉：万一以后要重新屏蔽，知道原样。
   */
  // ctx.effect(() => {
  //   let dispose = null;
  //   try {
  //     dispose = installHandleGuard(".comfy-wb, .ac-root");
  //   } catch (e) {
  //     console.warn("[comfy-wb/editor] 列宽手柄屏蔽安装失败（不影响其它功能）：", e?.message ?? e);
  //   }
  //   return () => { try { dispose?.(); } catch { /* ignore */ } };
  // }, "comfy-workbench-tab/editor: dsh width handle guard");
  //
  // try {
  //   const rd = resetDshWidths();
  //   if (rd.cleared) {
  //     console.info(`[comfy-wb/editor] DSH 内容宽度已恢复默认（原值 ${rd.previous ?? "(未知)"}）`);
  //   }
  // } catch (e) {
  //   console.warn("[comfy-wb/editor] 恢复默认宽度失败：", e?.message ?? e);
  // }

  /* ③ 剪辑台视图 */
  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "artcraft",
        order: 30,               // 排在视频工作台(20)之后
        locale: NS,
        label: () => ctx.locale.bind(NS)("view.label"),
        children: {},
        inject: (sessionId) => ({
          sessionId,
          t: ctx.locale.bind(NS),
          hostRequire: null,     // ★ 由 resolveHostRequire() 从全局桥兜底取
        }),
      },
      function EditorView(props) {
        return React.createElement(ArtCraftBoundary, null,
          React.createElement(ArtCraftHost, props));
      }
    )
  );

  /* ④ 快捷键设置（复用 DSH 设置面板外壳） */
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "artcraft-shortcuts",
        order: 60,
        label: () => ctx.locale.bind(NS)("settings.shortcuts"),
        inject: () => ({ hostRequire: null }),
      },
      function ArtCraftShortcutSection(props) {
        return React.createElement(ArtCraftBoundary, null,
          React.createElement(ShortcutSettings, {
            hostRequire: props.hostRequire,
            embedded: true,
          }));
      }
    )
  );

  /**
   * ⑤ ComfyUI 与环境配置（2026-10-23 新增）
   *
   *   主人：「需要增加一个模型配置页面，填模型放置目录，comfy ui目录，
   *          然后模型需求清单列出来让用户去下载」
   *
   *   ★ order 50 —— 排在快捷键（60）之前。
   *     判据：环境配置是「装完插件第一件事」，快捷键是「用熟之后才改」。
   *     设置列表按 order 升序显示，所以小的在前。
   */
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "comfy-environment",
        order: 50,
        label: () => ctx.locale.bind(NS)("settings.environment"),
        inject: () => ({ hostRequire: null }),
      },
      function ComfyEnvironmentSection() {
        return React.createElement(ArtCraftBoundary, null,
          React.createElement(ComfySettingsSection, null));
      }
    )
  );
}

